import test from "node:test";
import assert from "node:assert/strict";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { createPseRemoteCommanderServer } from "../src/server.mjs";
import { RelayClient } from "../src/relay-client.mjs";

function jsonResponse(value,status=200) {
  return new Response(JSON.stringify(value),{
    status,
    headers:{"content-type":"application/json"}
  });
}

test("MCP facade exposes 28 PSE tools and strips routing metadata before local execution", async () => {
  const seen=[];
  const fakeFetch=async (url,init={})=>{
    const parsed=new URL(url);
    seen.push({url:parsed.pathname+parsed.search,method:init.method??"GET",body:init.body?JSON.parse(init.body):null});

    if (parsed.pathname==="/internal/devices") {
      return jsonResponse({devices:[
        {deviceId:"forge",state:"ONLINE"},
        {deviceId:"atlas",state:"OFFLINE"}
      ]});
    }

    if (parsed.pathname==="/internal/calls" && init.method==="POST") {
      return jsonResponse({call_id:"c1",state:"PENDING"},202);
    }

    if (parsed.pathname==="/internal/calls/c1") {
      return jsonResponse({
        call_id:"c1",
        state:"SUCCEEDED",
        error_code:null,
        result:{
          state:"SUCCEEDED",
          result:{content:[{type:"text",text:"hello from forge"}],isError:false}
        }
      });
    }

    return jsonResponse({error:"not found"},404);
  };

  const server=createPseRemoteCommanderServer({
    ownerId:"caden",
    relayBaseUrl:"http://127.0.0.1:18750",
    internalToken:"internal-secret-1234567890-abcdef",
    fetchImpl:fakeFetch
  });
  const client=new Client({name:"pse-test-client",version:"1.0.0"});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport)
  ]);

  try {
    const tools=await client.listTools();
    assert.equal(tools.tools.length,28);
    assert.equal(tools.tools.some(t=>t.name==="give_feedback_to_desktop_commander"),false);
    assert.equal(tools.tools.some(t=>t.name==="get_prompts"),false);

    const devices=await client.callTool({name:"list_devices",arguments:{}});
    assert.match(devices.content[0].text,/forge/);

    const identity=await client.callTool({name:"who_am_i",arguments:{}});
    assert.match(identity.content[0].text,/pse-remote-commander/);
    assert.match(identity.content[0].text,/vendorQuota/);

    const read=await client.callTool({
      name:"read_file",
      arguments:{deviceId:"forge",path:"/tmp/canary.txt",offset:0,length:20}
    });
    assert.equal(read.content[0].text,"hello from forge");

    const post=seen.find(item=>item.url==="/internal/calls"&&item.method==="POST");
    assert.equal(post.body.device_id,"forge");
    assert.equal(post.body.tool_name,"read_file");
    assert.deepEqual(post.body.arguments,{path:"/tmp/canary.txt",offset:0,length:20});
    assert.equal(Object.hasOwn(post.body.arguments,"deviceId"),false);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP facade requires device selection when multiple PSE devices are online", async () => {
  const fakeFetch=async (url)=>{
    const parsed=new URL(url);
    if (parsed.pathname==="/internal/devices") {
      return jsonResponse({devices:[
        {deviceId:"forge",state:"ONLINE"},
        {deviceId:"atlas",state:"ONLINE"}
      ]});
    }
    return jsonResponse({error:"unexpected"},500);
  };

  const server=createPseRemoteCommanderServer({
    ownerId:"caden",
    relayBaseUrl:"http://127.0.0.1:18750",
    internalToken:"internal-secret-1234567890-abcdef",
    fetchImpl:fakeFetch
  });
  const client=new Client({name:"pse-test-client",version:"1.0.0"});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport),client.connect(clientTransport)]);
  try {
    const result=await client.callTool({name:"ping",arguments:{}});
    assert.equal(result.isError,true);
    assert.match(result.content[0].text,/deviceId required/);
  } finally {
    await client.close();
    await server.close();
  }
});


test("RelayClient polls bounded waits and derives ttl from process timeout", async () => {
  const seen=[];
  let resultReads=0;
  const fakeFetch=async (url,init={})=>{
    const parsed=new URL(url);
    seen.push({path:parsed.pathname,search:parsed.search,body:init.body?JSON.parse(init.body):null});
    if (parsed.pathname==="/internal/devices") {
      return jsonResponse({devices:[{deviceId:"forge",state:"ONLINE"}]});
    }
    if (parsed.pathname==="/internal/calls"&&init.method==="POST") {
      return jsonResponse({call_id:"long-1",state:"PENDING"},202);
    }
    if (parsed.pathname==="/internal/calls/long-1") {
      resultReads++;
      if (resultReads===1) return jsonResponse({call_id:"long-1",state:"RUNNING",result:null});
      return jsonResponse({
        call_id:"long-1",
        state:"SUCCEEDED",
        result:{state:"SUCCEEDED",result:{content:[{type:"text",text:"done"}]}}
      });
    }
    return jsonResponse({error:"unexpected"},500);
  };

  const relay=new RelayClient({
    baseUrl:"http://127.0.0.1:18750",
    internalToken:"internal-secret-1234567890-abcdef",
    ownerId:"caden",
    fetchImpl:fakeFetch,
    defaultWaitMs:30_000,
    now:()=>0
  });

  const completed=await relay.callTool("start_process",{
    deviceId:"forge",
    command:"example",
    timeout_ms:120_000
  });

  assert.equal(completed.result.content[0].text,"done");
  assert.equal(resultReads,2);
  const post=seen.find((item)=>item.path==="/internal/calls"&&item.body);
  assert.equal(post.body.ttl_ms,130_000);
  assert.deepEqual(post.body.arguments,{command:"example",timeout_ms:120_000});
});


test("public plugin facade advertises OAuth, safety annotations, and authenticated profile", async () => {
  const fakeFetch=async (url)=>{
    const parsed=new URL(url);
    if (parsed.pathname==="/internal/devices") {
      return jsonResponse({devices:[{deviceId:"forge",state:"ONLINE"}]});
    }
    return jsonResponse({error:"unexpected"},500);
  };

  const server=createPseRemoteCommanderServer({
    ownerId:"caden",
    relayBaseUrl:"http://127.0.0.1:18750",
    internalToken:"internal-secret-1234567890-abcdef",
    fetchImpl:fakeFetch,
    publicMode:true,
    grantedScopes:["pse.read","pse.write","pse.execute","pse.admin"],
    profile:{id:"prf_caden",name:"Caden",nickname:"PSE owner"},
    resourceMetadataUrl:"https://commander.example.com/.well-known/oauth-protected-resource"
  });
  const client=new Client({name:"pse-public-test",version:"1.0.0"});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport),client.connect(clientTransport)]);

  try {
    const listed=await client.listTools();
    assert.equal(listed.tools.length,28);

    for (const tool of listed.tools) {
      assert.equal(typeof tool.annotations?.readOnlyHint,"boolean",tool.name);
      assert.equal(typeof tool.annotations?.openWorldHint,"boolean",tool.name);
      assert.equal(typeof tool.annotations?.destructiveHint,"boolean",tool.name);
      const standardSchemes=tool.securitySchemes;
      assert.ok(Array.isArray(standardSchemes),tool.name);
      assert.equal(standardSchemes[0]?.type,"oauth2",tool.name);
      assert.ok(standardSchemes[0]?.scopes?.length>=1,tool.name);
      const compatibilitySchemes=tool._meta?.securitySchemes;
      assert.deepEqual(compatibilitySchemes,standardSchemes,tool.name);
    }

    const who=listed.tools.find(tool=>tool.name==="who_am_i");
    assert.equal(who?._meta?.["openai/profile"],true);
    assert.ok(who?.outputSchema);

    const identity=await client.callTool({name:"who_am_i",arguments:{}});
    assert.deepEqual(identity.structuredContent,{
      id:"prf_caden",
      name:"Caden",
      nickname:"PSE owner"
    });
    assert.match(identity.content[0].text,/PSE owner/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("public plugin facade returns an OAuth challenge when a tool lacks scope", async () => {
  const fakeFetch=async (url)=>{
    const parsed=new URL(url);
    if (parsed.pathname==="/internal/devices") {
      return jsonResponse({devices:[{deviceId:"forge",state:"ONLINE"}]});
    }
    return jsonResponse({error:"unexpected"},500);
  };

  const server=createPseRemoteCommanderServer({
    ownerId:"caden",
    relayBaseUrl:"http://127.0.0.1:18750",
    internalToken:"internal-secret-1234567890-abcdef",
    fetchImpl:fakeFetch,
    publicMode:true,
    grantedScopes:["pse.read"],
    profile:{id:"prf_caden"},
    resourceMetadataUrl:"https://commander.example.com/.well-known/oauth-protected-resource"
  });
  const client=new Client({name:"pse-public-test",version:"1.0.0"});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport),client.connect(clientTransport)]);

  try {
    const result=await client.callTool({
      name:"write_file",
      arguments:{path:"/tmp/nope.txt",content:"x",mode:"rewrite",deviceId:"forge"}
    });
    assert.equal(result.isError,true);
    assert.match(result.content[0].text,/authorization scope required/);
    assert.ok(Array.isArray(result._meta?.["mcp/www_authenticate"]));
    assert.match(result._meta["mcp/www_authenticate"][0],/pse\.write/);
  } finally {
    await client.close();
    await server.close();
  }
});
