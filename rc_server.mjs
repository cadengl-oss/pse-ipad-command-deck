import { McpServer } from "@modelcontextprotocol/server";

import { RelayClient } from "./relay-client.mjs";
import { TOOL_SPECS } from "./tool-specs.mjs";
import { LIST_DEVICES_OUTPUT_SCHEMA, PROFILE_SCHEMA, hasRequiredScopes, publicToolMeta, scopesForTool } from "./public-plugin.mjs";

function normalizeRemoteResult(value,{includeStructuredContent=true}={}) {
  if (value && typeof value==="object" && Array.isArray(value.content)) {
    return {
      content:value.content,
      ...(includeStructuredContent&&value.structuredContent!==undefined?{structuredContent:value.structuredContent}:{}),
      ...(value.isError?{isError:true}:{})
    };
  }
  return {
    content:[{
      type:"text",
      text:typeof value==="string"?value:JSON.stringify(value,null,2)
    }]
  };
}

function errorResult(error,{resourceMetadataUrl,requiredScopes=[]}={}) {
  const result={
    isError:true,
    content:[{
      type:"text",
      text:error instanceof Error?error.message:"PSE Remote Commander error"
    }]
  };
  if (resourceMetadataUrl && error?.code==="PSE_AUTH_REQUIRED") {
    const scope=requiredScopes.join(" ");
    let challenge=`Bearer resource_metadata="${resourceMetadataUrl}", error="insufficient_scope", error_description="Additional PSE Remote Commander authorization is required"`;
    if (scope) challenge+=`, scope="${scope}"`;
    result._meta={"mcp/www_authenticate":[challenge]};
  }
  return result;
}

export function createPseRemoteCommanderServer({
  ownerId,
  relayBaseUrl,
  internalToken,
  fetchImpl=fetch,
  publicMode=false,
  grantedScopes=[],
  profile=null,
  resourceMetadataUrl=null
}) {
  const relay=new RelayClient({baseUrl:relayBaseUrl,internalToken,ownerId,fetchImpl});
  const server=new McpServer({name:"pse-remote-commander",version:"1.0.0"});

  for (const spec of TOOL_SPECS) {
    const descriptor={
      title:spec.title,
      description:spec.description,
      inputSchema:spec.schema,
      annotations:spec.annotations
    };
    if (publicMode && spec.name==="list_devices") descriptor.outputSchema=LIST_DEVICES_OUTPUT_SCHEMA;
    if (publicMode && spec.name==="who_am_i") descriptor.outputSchema=PROFILE_SCHEMA;
    const meta=publicMode?publicToolMeta(spec.name):undefined;
    if (meta) {
      descriptor.securitySchemes=meta.securitySchemes;
      descriptor._meta=meta;
    }

    server.registerTool(
      spec.name,
      descriptor,
      async (args)=>{
        const requiredScopes=publicMode?scopesForTool(spec.name):[];
        try {
          if (publicMode && !hasRequiredScopes(grantedScopes,requiredScopes)) {
            const error=new Error("PSE Remote Commander authorization scope required");
            error.code="PSE_AUTH_REQUIRED";
            throw error;
          }

          if (spec.name==="list_devices") {
            const devices=await relay.listDevices();
            return {
              content:[{type:"text",text:JSON.stringify(devices,null,2)}],
              structuredContent:{devices}
            };
          }

          if (spec.name==="who_am_i") {
            const devices=await relay.listDevices();
            if (publicMode) {
              const currentProfile=PROFILE_SCHEMA.parse(profile??{id:ownerId});
              const summary={
                profile:currentProfile,
                service:"pse-remote-commander",
                vendorQuota:false,
                devices:{
                  total:devices.length,
                  online:devices.filter((device)=>device.state==="ONLINE").length,
                  degraded:devices.filter((device)=>device.state==="DEGRADED").length,
                  offline:devices.filter((device)=>device.state==="OFFLINE").length
                }
              };
              return {
                content:[{type:"text",text:JSON.stringify(summary,null,2)}],
                structuredContent:currentProfile
              };
            }
            const identity={
              ownerId,
              service:"pse-remote-commander",
              vendorQuota:false,
              devices:{
                total:devices.length,
                online:devices.filter((device)=>device.state==="ONLINE").length,
                degraded:devices.filter((device)=>device.state==="DEGRADED").length,
                offline:devices.filter((device)=>device.state==="OFFLINE").length
              }
            };
            return {
              content:[{type:"text",text:JSON.stringify(identity,null,2)}],
              structuredContent:identity
            };
          }

          const {result}=await relay.callTool(spec.name,args);
          return normalizeRemoteResult(result,{includeStructuredContent:!publicMode});
        } catch (error) {
          return errorResult(error,{resourceMetadataUrl,requiredScopes});
        }
      }
    );
  }

  return server;
}
