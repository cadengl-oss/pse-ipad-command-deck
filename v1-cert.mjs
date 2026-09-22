import fs from "node:fs";
import { createRequire } from "node:module";

const APP_ROOT=process.env.PSE_RC_APP_ROOT ?? "/opt/pse-remote-commander/current";
const ENV_FILE=process.env.PSE_RC_MCP_ENV_FILE ?? "/etc/pse/remote-commander-mcp.env";
const EXPECTED_TOOLS=[
  "list_devices","who_am_i","ping","shutdown","get_config","set_config_value",
  "read_file","read_multiple_files","write_file","write_pdf","create_directory",
  "list_directory","move_file","start_search","get_more_search_results","stop_search",
  "list_searches","get_file_info","edit_block","start_process","read_process_output",
  "interact_with_process","force_terminate","list_sessions","list_processes",
  "kill_process","get_usage_stats","get_recent_tool_calls"
];
const DEVICES=["forge","atlas"];
const REQUIRE_FULL_ANNOTATIONS=process.env.PSE_RC_REQUIRE_FULL_ANNOTATIONS==="1";
const CANARY_PATH={
  forge:process.env.PSE_RC_CANARY_FORGE ?? "/home/president/.local/state/pse-remote-commander/pse-v1-certification.txt",
  atlas:process.env.PSE_RC_CANARY_ATLAS ?? "/Users/Shared/PSE/state/remote-commander/pse-v1-certification.txt"
};

function fail(message){ throw new Error(message); }
function parseEnv(path){
  const out={};
  if(!fs.existsSync(path)) return out;
  for(const raw of fs.readFileSync(path,"utf8").split(/\r?\n/)){
    const line=raw.trim();
    if(!line||line.startsWith("#")) continue;
    const i=line.indexOf("=");
    if(i<1) continue;
    const k=line.slice(0,i).trim();
    let v=line.slice(i+1).trim();
    if((v.startsWith("'")&&v.endsWith("'"))||(v.startsWith('"')&&v.endsWith('"'))) v=v.slice(1,-1);
    out[k]=v;
  }
  return out;
}
function allText(value){
  const parts=[];
  const seen=new Set();
  const walk=(v)=>{
    if(v===null||v===undefined) return;
    if(typeof v==="string"){parts.push(v);return;}
    if(typeof v!=="object") return;
    if(seen.has(v)) return; seen.add(v);
    if(Array.isArray(v)){for(const x of v) walk(x);return;}
    for(const x of Object.values(v)) walk(x);
  };
  walk(value);
  return parts.join("\n");
}
function findPid(value){
  const seen=new Set();
  const walk=(v)=>{
    if(v===null||v===undefined) return null;
    if(typeof v==="string"){
      try { return walk(JSON.parse(v)); } catch {}
      const m=v.match(/\bpid\D{0,8}(\d{1,10})\b/i);
      return m?Number(m[1]):null;
    }
    if(typeof v!=="object") return null;
    if(seen.has(v)) return null; seen.add(v);
    if(!Array.isArray(v)&&Number.isInteger(v.pid)&&v.pid>0) return v.pid;
    for(const x of Object.values(v)){const p=walk(x);if(p) return p;}
    return null;
  };
  return walk(value);
}
function shellQuote(s){return "'"+String(s).replaceAll("'","'\\''")+"'";}
function assertToolOk(name,device,result){
  if(result?.isError) fail(`${name} failed on ${device}: ${allText(result).slice(0,500)}`);
  return result;
}
async function processCanary(client,device){
  const command="printf 'PSE_RC_HOST='; hostname; printf 'PSE_RC_UPTIME='; uptime";
  const started=assertToolOk("start_process",device,await client.callTool({
    name:"start_process",arguments:{deviceId:device,command,timeout_ms:5000}
  }));
  let text=allText(started);
  if(!text.includes("PSE_RC_HOST=")||!text.includes("PSE_RC_UPTIME=")){
    const pid=findPid(started);
    if(!pid) fail(`start_process on ${device} returned neither output nor pid`);
    const output=assertToolOk("read_process_output",device,await client.callTool({
      name:"read_process_output",arguments:{deviceId:device,pid,offset:0,length:200,timeout_ms:5000}
    }));
    text+="\n"+allText(output);
  }
  if(!text.includes("PSE_RC_HOST=")||!text.includes("PSE_RC_UPTIME=")) fail(`hostname/uptime markers missing on ${device}`);
  const host=(text.match(/PSE_RC_HOST=([^\n\r]+)/)||[])[1]?.trim()??"observed";
  console.log(`PROCESS_${device.toUpperCase()}=PASS host=${host}`);
}
async function fileCanary(client,device){
  const path=CANARY_PATH[device];
  const marker=`PSE_RC_V1_${device}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  assertToolOk("write_file",device,await client.callTool({
    name:"write_file",arguments:{deviceId:device,path,content:marker+"\n",mode:"rewrite"}
  }));
  const read=assertToolOk("read_file",device,await client.callTool({
    name:"read_file",arguments:{deviceId:device,path,offset:0,length:50}
  }));
  if(!allText(read).includes(marker)) fail(`file read-back marker mismatch on ${device}`);
  const cleanup=await client.callTool({
    name:"start_process",arguments:{deviceId:device,command:`rm -f -- ${shellQuote(path)}`,timeout_ms:5000}
  });
  assertToolOk("cleanup",device,cleanup);
  console.log(`FILE_${device.toUpperCase()}=PASS`);
}

const env=parseEnv(ENV_FILE);
const tokenFile=process.env.PSE_RC_MCP_TOKEN_FILE ?? env.PSE_RC_MCP_TOKEN_FILE ?? "/etc/pse/remote-commander-mcp-token";
const host=process.env.PSE_RC_MCP_HOST ?? env.PSE_RC_MCP_HOST ?? "127.0.0.1";
const port=process.env.PSE_RC_MCP_PORT ?? env.PSE_RC_MCP_PORT ?? "18751";
if(!fs.existsSync(tokenFile)) fail("MCP token file missing");
const token=fs.readFileSync(tokenFile,"utf8").trim();
if(token.length<32) fail("MCP token is invalid");

const requireFromApp=createRequire(`${APP_ROOT}/package.json`);
const clientPkg=requireFromApp.resolve("@modelcontextprotocol/client");
const {Client,StreamableHTTPClientTransport}=await import(clientPkg);
const client=new Client({name:"pse-remote-commander-v1-certifier",version:"1.0.0"});
const transport=new StreamableHTTPClientTransport(new URL(`http://${host}:${port}/mcp`),{
  requestInit:{headers:{Authorization:`Bearer ${token}`}}
});

try{
  await client.connect(transport);
  console.log("MCP_CONNECT=PASS");
  const listed=await client.listTools();
  const names=listed.tools.map(t=>t.name).sort();
  const expected=[...EXPECTED_TOOLS].sort();
  if(JSON.stringify(names)!==JSON.stringify(expected)) fail(`tool surface mismatch: got ${names.length}`);
  const annotationGaps=[];
  for(const tool of listed.tools){
    for(const key of ["readOnlyHint","openWorldHint","destructiveHint"]){
      if(typeof tool.annotations?.[key]!=="boolean") annotationGaps.push(`${tool.name}.${key}`);
    }
  }
  if(annotationGaps.length && REQUIRE_FULL_ANNOTATIONS){
    fail(`missing required annotations: ${annotationGaps.slice(0,12).join(", ")}${annotationGaps.length>12?" ...":""}`);
  }
  if(annotationGaps.length){
    console.log(`TOOL_ANNOTATIONS=LEGACY gaps=${annotationGaps.length}`);
  }else{
    console.log("TOOL_ANNOTATIONS=PASS");
  }
  console.log("TOOL_SURFACE_28=PASS");

  const devicesResult=assertToolOk("list_devices","nexus",await client.callTool({name:"list_devices",arguments:{}}));
  const raw=devicesResult.structuredContent?.devices ?? (()=>{try{return JSON.parse(allText(devicesResult)).devices}catch{return null}})();
  if(!Array.isArray(raw)) fail("list_devices did not return a device array");
  for(const device of DEVICES){
    const row=raw.find(x=>String(x.deviceId).toLowerCase()===device);
    if(!row) fail(`${device} missing from list_devices`);
    if(row.state!=="ONLINE") fail(`${device} is ${row.state}, expected ONLINE`);
    console.log(`DEVICE_${device.toUpperCase()}=ONLINE`);
  }

  for(const device of DEVICES){
    const ping=assertToolOk("ping",device,await client.callTool({name:"ping",arguments:{deviceId:device}}));
    if(!/pong/i.test(allText(ping))) fail(`ping response missing pong on ${device}`);
    console.log(`PING_${device.toUpperCase()}=PASS`);
    await processCanary(client,device);
    await fileCanary(client,device);
  }

  console.log("PSE_RC_V1_LIVE_CERTIFICATION=PASS");
  console.log("RDC_USED=no");
} finally {
  await client.close().catch(()=>{});
}
