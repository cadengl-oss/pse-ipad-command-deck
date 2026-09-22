import * as z from "zod/v4";

const deviceId = z.string().min(1).max(128).optional();
const deviceOnly = z.object({ deviceId }).strict();

const pdfInsert = z.object({
  type:z.literal("insert"),
  pageIndex:z.number().int().min(0),
  markdown:z.string().optional(),
  sourcePdfPath:z.string().optional(),
  pdfOptions:z.record(z.string(),z.unknown()).optional()
}).strict();
const pdfDelete = z.object({
  type:z.literal("delete"),
  pageIndexes:z.array(z.number().int().min(0)).min(1)
}).strict();

const RAW_TOOL_SPECS = [
  {
    name:"list_devices",
    description:"List PSE Remote Commander devices available to the authenticated owner, including ONLINE/DEGRADED/OFFLINE state.",
    local:true,
    schema:z.object({}).strict(),
    annotations:{readOnlyHint:true}
  },
  {
    name:"who_am_i",
    description:"Show the authenticated PSE Remote Commander owner and current PSE connection summary.",
    local:true,
    schema:z.object({}).strict(),
    annotations:{readOnlyHint:true}
  },
  {name:"ping",description:"Ping a PSE-controlled device.",schema:deviceOnly,annotations:{readOnlyHint:true}},
  {name:"shutdown",description:"Gracefully shut down the PSE Remote Commander device agent after returning confirmation.",schema:deviceOnly,annotations:{readOnlyHint:false,destructiveHint:true}},
  {name:"get_config",description:"Get the local PSE Commander configuration for a device.",schema:deviceOnly,annotations:{readOnlyHint:true}},
  {
    name:"set_config_value",
    description:"Set one local PSE Commander configuration value.",
    schema:z.object({
      key:z.string().min(1),
      value:z.union([z.string(),z.number(),z.boolean(),z.array(z.string()),z.null()]),
      deviceId
    }).strict(),
    annotations:{readOnlyHint:false}
  },
  {
    name:"read_file",
    description:"Read a local file or supported URL/document with RDC-compatible pagination and format options.",
    schema:z.object({
      path:z.string().min(1),
      isUrl:z.boolean().optional(),
      offset:z.number().int().optional(),
      length:z.number().int().positive().optional(),
      sheet:z.string().optional(),
      range:z.string().optional(),
      options:z.record(z.string(),z.unknown()).optional(),
      deviceId
    }).strict(),
    annotations:{readOnlyHint:true}
  },
  {
    name:"read_multiple_files",
    description:"Read multiple local files in one call.",
    schema:z.object({paths:z.array(z.string().min(1)).min(1),deviceId}).strict(),
    annotations:{readOnlyHint:true}
  },
  {
    name:"write_file",
    description:"Write or append file content on a PSE-controlled device.",
    schema:z.object({
      mode:z.enum(["rewrite","append"]).optional(),
      path:z.string().min(1),
      content:z.string(),
      deviceId
    }).strict(),
    annotations:{readOnlyHint:false}
  },
  {
    name:"write_pdf",
    description:"Create or modify a PDF through the local PSE Commander engine.",
    schema:z.object({
      path:z.string().min(1),
      outputPath:z.string().optional(),
      content:z.union([z.string(),z.array(z.union([pdfInsert,pdfDelete]))]),
      options:z.record(z.string(),z.unknown()).optional(),
      deviceId
    }).strict(),
    annotations:{readOnlyHint:false}
  },
  {
    name:"create_directory",
    description:"Create a directory, including nested directories.",
    schema:z.object({path:z.string().min(1),deviceId}).strict(),
    annotations:{readOnlyHint:false,idempotentHint:true}
  },
  {
    name:"list_directory",
    description:"List a directory recursively with bounded depth.",
    schema:z.object({path:z.string().min(1),depth:z.number().int().min(1).max(20).optional(),deviceId}).strict(),
    annotations:{readOnlyHint:true}
  },
  {
    name:"move_file",
    description:"Move or rename a file or directory.",
    schema:z.object({source:z.string().min(1),destination:z.string().min(1),deviceId}).strict(),
    annotations:{readOnlyHint:false}
  },
  {
    name:"start_search",
    description:"Start a progressive file-name or file-content search.",
    schema:z.object({
      path:z.string().min(1),
      pattern:z.string(),
      searchType:z.enum(["files","content"]).optional(),
      literalSearch:z.boolean().optional(),
      ignoreCase:z.boolean().optional(),
      includeHidden:z.boolean().optional(),
      filePattern:z.string().optional(),
      maxResults:z.number().int().positive().optional(),
      timeout_ms:z.number().int().positive().optional(),
      contextLines:z.number().int().min(0).optional(),
      earlyTermination:z.boolean().optional(),
      deviceId
    }).strict(),
    annotations:{readOnlyHint:false}
  },
  {
    name:"get_more_search_results",
    description:"Read a bounded range of results from an active search.",
    schema:z.object({
      sessionId:z.string().min(1),
      offset:z.number().int().optional(),
      length:z.number().int().positive().optional(),
      deviceId
    }).strict(),
    annotations:{readOnlyHint:true}
  },
  {
    name:"stop_search",
    description:"Stop an active search session.",
    schema:z.object({sessionId:z.string().min(1),deviceId}).strict(),
    annotations:{readOnlyHint:false,idempotentHint:true}
  },
  {name:"list_searches",description:"List active search sessions.",schema:deviceOnly,annotations:{readOnlyHint:true}},
  {
    name:"get_file_info",
    description:"Read file or directory metadata.",
    schema:z.object({path:z.string().min(1),deviceId}).strict(),
    annotations:{readOnlyHint:true}
  },
  {
    name:"edit_block",
    description:"Apply a surgical text/DOCX edit or Excel range update.",
    schema:z.object({
      file_path:z.string().min(1),
      old_string:z.string().optional(),
      new_string:z.string().optional(),
      expected_replacements:z.number().int().positive().optional(),
      range:z.string().optional(),
      content:z.array(z.array(z.unknown())).optional(),
      deviceId
    }).passthrough(),
    annotations:{readOnlyHint:false}
  },
  {
    name:"start_process",
    description:"Start a local process or interactive terminal session.",
    schema:z.object({
      command:z.string().min(1),
      timeout_ms:z.number().int().positive(),
      verbose_timing:z.boolean().optional(),
      shell:z.string().optional(),
      deviceId
    }).strict(),
    annotations:{readOnlyHint:false}
  },
  {
    name:"read_process_output",
    description:"Read bounded output from a running process.",
    schema:z.object({
      pid:z.number().int(),
      offset:z.number().int().optional(),
      length:z.number().int().positive().optional(),
      timeout_ms:z.number().int().min(0).optional(),
      verbose_timing:z.boolean().optional(),
      deviceId
    }).strict(),
    annotations:{readOnlyHint:true}
  },
  {
    name:"interact_with_process",
    description:"Send input to a running process or REPL and receive its response.",
    schema:z.object({
      pid:z.number().int(),
      input:z.string(),
      timeout_ms:z.number().int().min(0).optional(),
      wait_for_prompt:z.boolean().optional(),
      verbose_timing:z.boolean().optional(),
      deviceId
    }).strict(),
    annotations:{readOnlyHint:false}
  },
  {
    name:"force_terminate",
    description:"Force terminate a PSE Commander terminal session.",
    schema:z.object({pid:z.number().int(),deviceId}).strict(),
    annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true}
  },
  {name:"list_sessions",description:"List active local terminal sessions.",schema:deviceOnly,annotations:{readOnlyHint:true}},
  {name:"list_processes",description:"List running OS processes.",schema:deviceOnly,annotations:{readOnlyHint:true}},
  {
    name:"kill_process",
    description:"Terminate a running OS process by PID.",
    schema:z.object({pid:z.number().int(),deviceId}).strict(),
    annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true}
  },
  {name:"get_usage_stats",description:"Get local PSE Commander tool usage and performance statistics.",schema:deviceOnly,annotations:{readOnlyHint:true}},
  {
    name:"get_recent_tool_calls",
    description:"Get recent local tool-call history from a PSE-controlled device.",
    schema:z.object({
      maxResults:z.number().int().min(1).max(1000).optional(),
      toolName:z.string().optional(),
      since:z.string().datetime().optional(),
      deviceId
    }).strict(),
    annotations:{readOnlyHint:true}
  }
];

const OPEN_WORLD_TOOLS=new Set(["read_file","write_pdf","start_process","interact_with_process"]);
const DESTRUCTIVE_TOOLS=new Set([
  "shutdown","set_config_value","write_file","write_pdf","move_file",
  "edit_block","start_process","interact_with_process","force_terminate","kill_process"
]);

function titleFor(name) {
  return name.split("_").map(part=>part.charAt(0).toUpperCase()+part.slice(1)).join(" ");
}

export const TOOL_SPECS = Object.freeze(RAW_TOOL_SPECS.map((spec)=>Object.freeze({
  ...spec,
  title:spec.title??titleFor(spec.name),
  annotations:Object.freeze({
    readOnlyHint:Boolean(spec.annotations?.readOnlyHint),
    openWorldHint:OPEN_WORLD_TOOLS.has(spec.name),
    destructiveHint:DESTRUCTIVE_TOOLS.has(spec.name),
    ...(spec.annotations?.idempotentHint!==undefined
      ? {idempotentHint:Boolean(spec.annotations.idempotentHint)}
      : {})
  })
})));

export const TOOL_SPEC_BY_NAME = Object.freeze(Object.fromEntries(TOOL_SPECS.map((spec)=>[spec.name,spec])));
