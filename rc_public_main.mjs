import fs from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";

import { createPseRemoteCommanderServer } from "../../packages/mcp-facade/src/server.mjs";
import { PUBLIC_SCOPES } from "../../packages/mcp-facade/src/public-plugin.mjs";

function readOwnerOnly(filePath,label,{min=1,max=16384}={}) {
  const stat=fs.statSync(filePath);
  if (!stat.isFile() || (stat.mode & 0o077)!==0) throw new Error(`${label} must be owner-only`);
  const value=fs.readFileSync(filePath,"utf8").trim();
  if (value.length<min || value.length>max) throw new Error(`invalid ${label}`);
  return value;
}

function httpsUrl(value,label) {
  const parsed=new URL(value);
  if (parsed.protocol!=="https:") throw new Error(`${label} must use https`);
  parsed.hash="";
  return parsed;
}

function parseOwnerMap(raw) {
  const parsed=JSON.parse(raw);
  if (!parsed || typeof parsed!=="object" || Array.isArray(parsed)) throw new Error("owner map must be an object");
  const result=new Map();
  for (const [subject,value] of Object.entries(parsed)) {
    if (!subject.trim()) throw new Error("owner map subject required");
    const entry=typeof value==="string"?{ownerId:value}:value;
    if (!entry || typeof entry!=="object" || typeof entry.ownerId!=="string" || !entry.ownerId.trim()) {
      throw new Error("owner map entries require ownerId");
    }
    const profile={
      id:typeof entry.profile?.id==="string"&&entry.profile.id.trim()?entry.profile.id:subject,
      ...(typeof entry.profile?.name==="string"?{name:entry.profile.name}:{}),
      ...(typeof entry.profile?.email==="string"?{email:entry.profile.email}:{}),
      ...(typeof entry.profile?.nickname==="string"?{nickname:entry.profile.nickname}:{})
    };
    result.set(subject,{ownerId:entry.ownerId,profile});
  }
  if (result.size<1) throw new Error("owner map must contain at least one subject");
  return result;
}

export function loadPublicMcpConfig(env=process.env) {
  const host=env.PSE_RC_PUBLIC_MCP_HOST??"127.0.0.1";
  if (!["127.0.0.1","::1","localhost"].includes(host)) throw new Error("public MCP process must bind to loopback behind TLS");
  const port=Number(env.PSE_RC_PUBLIC_MCP_PORT??18752);
  if (!Number.isInteger(port)||port<1||port>65535) throw new Error("invalid public MCP port");

  const resource=httpsUrl(env.PSE_RC_PUBLIC_RESOURCE??"","PSE_RC_PUBLIC_RESOURCE");
  const issuer=httpsUrl(env.PSE_RC_OAUTH_ISSUER??"","PSE_RC_OAUTH_ISSUER");
  const introspection=httpsUrl(env.PSE_RC_OAUTH_INTROSPECTION_URL??"","PSE_RC_OAUTH_INTROSPECTION_URL");

  const relayBaseUrl=env.PSE_RC_RELAY_BASE_URL??"http://127.0.0.1:18750";
  const internalToken=readOwnerOnly(env.PSE_RC_INTERNAL_TOKEN_FILE??"","relay token",{min:32,max:512});
  const introspectionClientId=env.PSE_RC_OAUTH_INTROSPECTION_CLIENT_ID;
  if (!introspectionClientId) throw new Error("PSE_RC_OAUTH_INTROSPECTION_CLIENT_ID required");
  const introspectionClientSecret=readOwnerOnly(
    env.PSE_RC_OAUTH_INTROSPECTION_CLIENT_SECRET_FILE??"",
    "OAuth introspection client secret",
    {min:16,max:4096}
  );
  const ownerMap=parseOwnerMap(readOwnerOnly(env.PSE_RC_PUBLIC_OWNER_MAP_FILE??"","public owner map",{min:2,max:65536}));

  const challengeFile=env.PSE_RC_OPENAI_APPS_CHALLENGE_FILE||null;
  const documentationUrl=env.PSE_RC_RESOURCE_DOCUMENTATION_URL
    ? httpsUrl(env.PSE_RC_RESOURCE_DOCUMENTATION_URL,"PSE_RC_RESOURCE_DOCUMENTATION_URL").toString()
    : undefined;

  const publicResource=resource.toString().replace(/\/$/,"");
  const expectedAudience=env.PSE_RC_OAUTH_EXPECTED_AUDIENCE??publicResource;

  return {
    host,port,
    publicResource,
    publicHostname:resource.host,
    oauthIssuer:issuer.toString().replace(/\/$/,""),
    introspectionUrl:introspection.toString(),
    expectedAudience,
    introspectionClientId,
    introspectionClientSecret,
    relayBaseUrl,
    internalToken,
    ownerMap,
    challengeFile,
    documentationUrl
  };
}

export function protectedResourceMetadata(config) {
  return {
    resource:config.publicResource,
    authorization_servers:[config.oauthIssuer],
    scopes_supported:[...PUBLIC_SCOPES],
    ...(config.documentationUrl?{resource_documentation:config.documentationUrl}:{})
  };
}

function bearer(req) {
  const value=req.headers.authorization;
  return typeof value==="string"&&value.startsWith("Bearer ")?value.slice(7).trim():null;
}

function resourceMatches(value,resource) {
  if (typeof value==="string") return value===resource;
  return Array.isArray(value)&&value.includes(resource);
}

export async function verifyAccessToken(token,config,{fetchImpl=fetch}={}) {
  if (!token) throw new Error("missing access token");
  const auth=Buffer.from(`${config.introspectionClientId}:${config.introspectionClientSecret}`).toString("base64");
  const body=new URLSearchParams({token,token_type_hint:"access_token"});
  const response=await fetchImpl(config.introspectionUrl,{
    method:"POST",
    headers:{
      authorization:`Basic ${auth}`,
      "content-type":"application/x-www-form-urlencoded",
      accept:"application/json"
    },
    body,
    signal:AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error("OAuth token introspection failed");
  const data=await response.json();
  if (data.active!==true) throw new Error("inactive access token");
  if (typeof data.sub!=="string"||!data.sub.trim()) throw new Error("access token subject missing");
  if (data.iss!==undefined && data.iss!==config.oauthIssuer) throw new Error("access token issuer mismatch");
  if (!resourceMatches(data.aud,config.expectedAudience) && !resourceMatches(data.resource,config.expectedAudience)) {
    throw new Error("access token resource mismatch");
  }

  const exact=config.ownerMap.get(data.sub);
  const username=typeof data.username==="string"&&data.username.trim()
    ? config.ownerMap.get(`username:${data.username.trim()}`)
    : null;
  const wildcard=config.ownerMap.get("*");
  const mapping=exact??username??wildcard;
  if (!mapping) throw new Error("authenticated profile is not provisioned for PSE Remote Commander");
  const effectiveProfile={
    ...mapping.profile,
    id:(exact??username)?mapping.profile.id:data.sub
  };
  const scopes=new Set(
    Array.isArray(data.scope)
      ? data.scope
      : typeof data.scope==="string"
        ? data.scope.split(/\s+/).filter(Boolean)
        : []
  );
  return {subject:data.sub,ownerId:mapping.ownerId,profile:effectiveProfile,scopes};
}

function writeJson(res,status,value,headers={}) {
  res.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store",...headers});
  res.end(JSON.stringify(value));
}

function writeHtml(res,status,title,body) {
  const safeTitle=String(title).replace(/[<>&"]/g,"");
  res.writeHead(status,{"content-type":"text/html; charset=utf-8","cache-control":"no-store"});
  res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle}</title></head><body><main><h1>${safeTitle}</h1>${body}</main></body></html>`);
}


function writeText(res,status,value,contentType="text/plain; charset=utf-8") {
  res.writeHead(status,{"content-type":contentType,"cache-control":"no-store"});
  res.end(value);
}

const PUBLIC_PAGES=Object.freeze({
  "/": "<!doctype html><meta charset=utf-8><title>PSE Remote Commander</title><h1>PSE Remote Commander</h1><p>Authenticated remote computer control for PSE-linked devices through ChatGPT.</p><p><a href='/docs'>Documentation</a> · <a href='/support'>Support</a> · <a href='/privacy'>Privacy</a> · <a href='/terms'>Terms</a></p>",
  "/about": "<!doctype html><meta charset=utf-8><title>PSE Remote Commander</title><h1>PSE Remote Commander</h1><p>Authenticated remote computer control for PSE-linked devices through ChatGPT.</p>",
  "/docs": "<!doctype html><meta charset=utf-8><title>PSE Remote Commander Documentation</title><h1>Documentation</h1><p>Authenticate through ChatGPT, then use the MCP tools available to your owner-scoped PSE account. Device routing is enforced by the authenticated owner mapping.</p>",
  "/support": "<!doctype html><meta charset=utf-8><title>PSE Remote Commander Support</title><h1>Support</h1><p>Support for PSE Remote Commander is provided by Pilot Sales Enterprise. Contact the publisher through the account that provisioned this plugin.</p>",
  "/privacy": "<!doctype html><meta charset=utf-8><title>PSE Remote Commander Privacy</title><h1>Privacy</h1><p>PSE Remote Commander processes authenticated tool requests only to operate devices explicitly linked to the authenticated PSE owner. Authentication secrets are not included in tool responses. Operational call records may be retained for security, auditing, and troubleshooting.</p>",
  "/terms": "<!doctype html><meta charset=utf-8><title>PSE Remote Commander Terms</title><h1>Terms</h1><p>Use is limited to computers and accounts you are authorized to control. Users are responsible for commands they request and for maintaining account credentials. Access may be suspended when misuse or unauthorized access is detected.</p>"
});

function unauthorized(res,config) {
  const metadataUrl=`${config.publicResource}/.well-known/oauth-protected-resource`;
  writeJson(res,401,{error:"PSE Remote Commander authentication required"},{
    "www-authenticate":`Bearer resource_metadata="${metadataUrl}", scope="pse.read"`
  });
}

export function createPublicMcpHttpServer(config=loadPublicMcpConfig(),{fetchImpl=fetch}={}) {
  const handlers=new Map();
  const metadataUrl=`${config.publicResource}/.well-known/oauth-protected-resource`;

  const handlerFor=(identity)=>{
    const scopeKey=[...identity.scopes].sort().join(" ");
    const key=`${identity.ownerId}\0${identity.profile.id}\0${scopeKey}`;
    let found=handlers.get(key);
    if (found) return found.nodeHandler;

    const handler=createMcpHandler(
      ()=>createPseRemoteCommanderServer({
        ownerId:identity.ownerId,
        relayBaseUrl:config.relayBaseUrl,
        internalToken:config.internalToken,
        fetchImpl,
        publicMode:true,
        grantedScopes:[...identity.scopes],
        profile:identity.profile,
        resourceMetadataUrl:metadataUrl
      }),
      {responseMode:"json"}
    );
    found={handler,nodeHandler:toNodeHandler(handler)};
    handlers.set(key,found);
    return found.nodeHandler;
  };

  const server=createServer(async(req,res)=>{
    try {
      const url=new URL(req.url??"/",config.publicResource);
      if (req.method==="GET" && url.pathname==="/health") {
        writeJson(res,200,{ok:true,service:"pse-remote-commander-public-mcp"});
        return;
      }
      if (req.method==="GET" && url.pathname==="/.well-known/oauth-protected-resource") {
        writeJson(res,200,protectedResourceMetadata(config));
        return;
      }
      if (req.method==="GET" && url.pathname==="/.well-known/openai-apps-challenge") {
        let challenge=typeof config.challenge==="string"?config.challenge:null;
        if (!challenge && config.challengeFile) {
          try {
            challenge=readOwnerOnly(config.challengeFile,"OpenAI apps challenge",{min:8,max:2048});
          } catch {}
        }
        if (!challenge) { res.writeHead(404); res.end(); return; }
        res.writeHead(200,{"content-type":"text/plain; charset=utf-8","cache-control":"no-store"});
        res.end(challenge);
        return;
      }
      if (req.method==="GET" && PUBLIC_PAGES[url.pathname]) {
        writeText(res,200,PUBLIC_PAGES[url.pathname],"text/html; charset=utf-8");
        return;
      }
      if (url.pathname!=="/mcp") {
        writeJson(res,404,{error:"not found"});
        return;
      }

      const token=bearer(req);
      if (!token) { unauthorized(res,config); return; }
      let identity;
      try {
        identity=await verifyAccessToken(token,config,{fetchImpl});
      } catch {
        unauthorized(res,config);
        return;
      }
      const nodeHandler=handlerFor(identity);
      await nodeHandler(req,res);
    } catch {
      if (!res.headersSent) writeJson(res,500,{error:"PSE public MCP request failed"});
      else res.end();
    }
  });

  server.once("close",()=>{
    for (const {handler} of handlers.values()) void handler.close();
    handlers.clear();
  });
  return {server,handlers};
}

export function isMainModule(metaUrl,argv1) {
  if (!metaUrl||!argv1) return false;
  try {
    return fs.realpathSync(fileURLToPath(metaUrl))===fs.realpathSync(argv1);
  } catch {
    return false;
  }
}

async function main() {
  const config=loadPublicMcpConfig();
  const {server}=createPublicMcpHttpServer(config);
  await new Promise((resolve,reject)=>{
    server.once("error",reject);
    server.listen(config.port,config.host,resolve);
  });
  console.error(`PSE Remote Commander public MCP listening on http://${config.host}:${config.port}/mcp behind ${config.publicResource}`);

  let closing=false;
  const close=()=>{
    if (closing) return;
    closing=true;
    server.close(()=>{});
  };
  process.once("SIGINT",close);
  process.once("SIGTERM",close);
}

if (isMainModule(import.meta.url,process.argv[1])) {
  main().catch(()=>{console.error("PSE Remote Commander public MCP failed.");process.exitCode=1;});
}
