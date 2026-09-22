import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import {
  createPublicMcpHttpServer,
  protectedResourceMetadata,
  verifyAccessToken
} from "../../../apps/mcp-public/main.mjs";

function baseConfig() {
  return {
    host:"127.0.0.1",
    port:18752,
    publicResource:"https://commander.example.com",
    publicHostname:"commander.example.com",
    oauthIssuer:"https://auth.example.com",
    introspectionUrl:"https://auth.example.com/oauth/introspect",
    expectedAudience:"https://commander.example.com",
    introspectionClientId:"pse-introspector",
    introspectionClientSecret:"secret-secret-secret",
    relayBaseUrl:"http://127.0.0.1:18750",
    internalToken:"internal-secret-1234567890-abcdef",
    ownerMap:new Map([[
      "subject-1",
      {ownerId:"caden",profile:{id:"prf_caden",name:"Caden",nickname:"PSE owner"}}
    ]]),
    challenge:"openai-verification-token",
    documentationUrl:"https://commander.example.com/docs"
  };
}

test("protected resource metadata advertises PSE OAuth scopes",()=>{
  const metadata=protectedResourceMetadata(baseConfig());
  assert.equal(metadata.resource,"https://commander.example.com");
  assert.deepEqual(metadata.authorization_servers,["https://auth.example.com"]);
  assert.ok(metadata.scopes_supported.includes("pse.read"));
  assert.ok(metadata.scopes_supported.includes("pse.write"));
  assert.ok(metadata.scopes_supported.includes("pse.execute"));
  assert.ok(metadata.scopes_supported.includes("pse.admin"));
});

test("OAuth introspection binds token subject to a provisioned PSE owner", async ()=>{
  const config=baseConfig();
  const fakeFetch=async(url,init)=>{
    assert.equal(url,config.introspectionUrl);
    assert.match(init.headers.authorization,/^Basic /);
    return new Response(JSON.stringify({
      active:true,
      sub:"subject-1",
      iss:config.oauthIssuer,
      aud:config.publicResource,
      scope:"pse.read pse.write"
    }),{status:200,headers:{"content-type":"application/json"}});
  };
  const identity=await verifyAccessToken("opaque-token",config,{fetchImpl:fakeFetch});
  assert.equal(identity.ownerId,"caden");
  assert.equal(identity.profile.id,"prf_caden");
  assert.equal(identity.scopes.has("pse.read"),true);
  assert.equal(identity.scopes.has("pse.write"),true);
});

test("OAuth introspection rejects a token for another resource", async ()=>{
  const config=baseConfig();
  const fakeFetch=async()=>new Response(JSON.stringify({
    active:true,
    sub:"subject-1",
    iss:config.oauthIssuer,
    aud:"https://other.example.com",
    scope:"pse.read"
  }),{status:200,headers:{"content-type":"application/json"}});
  await assert.rejects(
    verifyAccessToken("wrong-audience",config,{fetchImpl:fakeFetch}),
    /resource mismatch/
  );
});

test("OAuth introspection accepts RFC8707 resource indicator without aud", async ()=>{
  const config=baseConfig();
  const fakeFetch=async()=>new Response(JSON.stringify({
    active:true,
    sub:"subject-1",
    iss:config.oauthIssuer,
    resource:config.publicResource,
    scope:"pse.read"
  }),{status:200,headers:{"content-type":"application/json"}});
  const identity=await verifyAccessToken("resource-token",config,{fetchImpl:fakeFetch});
  assert.equal(identity.ownerId,"caden");
  assert.equal(identity.scopes.has("pse.read"),true);
});

test("public edge exposes discovery/challenge and rejects unauthenticated MCP", async ()=>{
  const config=baseConfig();
  const {server}=createPublicMcpHttpServer(config,{
    fetchImpl:async()=>{throw new Error("introspection should not run");}
  });
  server.listen(0,"127.0.0.1");
  await once(server,"listening");
  const address=server.address();
  const base=`http://127.0.0.1:${address.port}`;

  try {
    const health=await fetch(`${base}/health`);
    assert.equal(health.status,200);
    assert.equal((await health.json()).service,"pse-remote-commander-public-mcp");

    const metadata=await fetch(`${base}/.well-known/oauth-protected-resource`);
    assert.equal(metadata.status,200);
    assert.equal((await metadata.json()).resource,config.publicResource);

    const challenge=await fetch(`${base}/.well-known/openai-apps-challenge`);
    assert.equal(challenge.status,200);
    assert.equal(await challenge.text(),config.challenge);

    const website=await fetch(`${base}/`);
    assert.equal(website.status,200);
    assert.match(await website.text(),/PSE Remote Commander/);

    const docs=await fetch(`${base}/docs`);
    assert.equal(docs.status,200);
    assert.match(await docs.text(),/Documentation/);

    const privacy=await fetch(`${base}/privacy`);
    assert.equal(privacy.status,200);

    const terms=await fetch(`${base}/terms`);
    assert.equal(terms.status,200);

    const mcp=await fetch(`${base}/mcp`,{method:"POST"});
    assert.equal(mcp.status,401);
    assert.match(mcp.headers.get("www-authenticate"),/oauth-protected-resource/);
  } finally {
    await new Promise(resolve=>server.close(()=>resolve()));
  }
});


test("OAuth wildcard fallback routes unknown authenticated subjects only to canary owner", async ()=>{
  const config=baseConfig();
  config.ownerMap.set("*",{ownerId:"openai-review-canary",profile:{id:"prf_review",nickname:"Review canary"}});
  const fakeFetch=async()=>new Response(JSON.stringify({
    active:true,
    sub:"new-subject-42",
    iss:config.oauthIssuer,
    aud:config.publicResource,
    scope:"pse.read"
  }),{status:200,headers:{"content-type":"application/json"}});
  const identity=await verifyAccessToken("opaque-token",config,{fetchImpl:fakeFetch});
  assert.equal(identity.ownerId,"openai-review-canary");
  assert.equal(identity.profile.id,"new-subject-42");
  assert.equal(identity.profile.nickname,"Review canary");
});

test("exact owner mapping overrides wildcard fallback", async ()=>{
  const config=baseConfig();
  config.ownerMap.set("*",{ownerId:"openai-review-canary",profile:{id:"prf_review"}});
  const fakeFetch=async()=>new Response(JSON.stringify({
    active:true,
    sub:"subject-1",
    iss:config.oauthIssuer,
    aud:config.publicResource,
    scope:"pse.read"
  }),{status:200,headers:{"content-type":"application/json"}});
  const identity=await verifyAccessToken("opaque-token",config,{fetchImpl:fakeFetch});
  assert.equal(identity.ownerId,"caden");
  assert.equal(identity.profile.id,"prf_caden");
});
