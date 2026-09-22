import * as z from "zod/v4";

export const PUBLIC_SCOPES=Object.freeze([
  "pse.read",
  "pse.write",
  "pse.execute",
  "pse.admin"
]);

const WRITE_TOOLS=new Set([
  "write_file","write_pdf","create_directory","move_file","edit_block"
]);
const EXECUTE_TOOLS=new Set([
  "start_process","interact_with_process","force_terminate","kill_process"
]);
const ADMIN_TOOLS=new Set(["shutdown","set_config_value","stop_search"]);

export function scopesForTool(name) {
  if (ADMIN_TOOLS.has(name)) return ["pse.admin"];
  if (EXECUTE_TOOLS.has(name)) return ["pse.execute"];
  if (WRITE_TOOLS.has(name)) return ["pse.write"];
  return ["pse.read"];
}

export function securitySchemesForTool(name) {
  return [{type:"oauth2",scopes:scopesForTool(name)}];
}

export const LIST_DEVICES_OUTPUT_SCHEMA=z.object({
  devices:z.array(z.object({
    deviceId:z.string().min(1),
    state:z.string().min(1)
  }).passthrough())
}).strict();

export const PROFILE_SCHEMA=z.object({
  id:z.string().min(1).regex(/\S/),
  name:z.string().optional(),
  email:z.string().optional(),
  nickname:z.string().optional()
}).strict();

export function publicToolMeta(name) {
  const securitySchemes=securitySchemesForTool(name);
  return {
    securitySchemes,
    ...(name==="who_am_i"?{"openai/profile":true}:{})
  };
}

export function hasRequiredScopes(granted,required) {
  const set=granted instanceof Set?granted:new Set(granted??[]);
  return required.every(scope=>set.has(scope));
}
