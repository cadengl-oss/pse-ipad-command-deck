import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT=process.env.PSE_RC_LIVE_ROOT??"/live";
const EXPECTED_HEAD="5cdc1fb25dae72ecbfd7dea45e44ae08cd91ce80";
const EXPECTED=[
  {
    "path": "apps/mcp-http/config.example.env",
    "sha": "b0ef87d4727d6d096b967afc29ac16d836fb64db",
    "size": 241
  },
  {
    "path": "apps/mcp-http/main.mjs",
    "sha": "f55b8b87450ccccbae73c96ebf838041391e8992",
    "size": 4232
  },
  {
    "path": "apps/relay/config.example.env",
    "sha": "57f50706991af7b9ae03f2ab35d44404380fa355",
    "size": 191
  },
  {
    "path": "apps/relay/main.mjs",
    "sha": "90219027e895ff013c934dfcac3facbe327748dc",
    "size": 915
  },
  {
    "path": "package-lock.json",
    "sha": "0de9d7937802980b03034920da575b1d6b714c42",
    "size": 337688
  },
  {
    "path": "package.json",
    "sha": "5a9ad855b310551296a53fee62c2e29ce6ececb4",
    "size": 3906
  },
  {
    "path": "packages/mcp-facade/src/public-plugin.mjs",
    "sha": "32f9eacbbd85ff417d034ba0027beabb1ca07c9d",
    "size": 1464
  },
  {
    "path": "packages/mcp-facade/src/relay-client.mjs",
    "sha": "ca982c5c14be65a952169919129d6c99f1ded782",
    "size": 4261
  },
  {
    "path": "packages/mcp-facade/src/server.mjs",
    "sha": "6166e5d35eb3359e0088e1b38c980be5da099488",
    "size": 4780
  },
  {
    "path": "packages/mcp-facade/src/tool-specs.mjs",
    "sha": "cd7cafc26a62097801e093e00d431a209144d13e",
    "size": 9385
  },
  {
    "path": "packages/mcp-facade/test/http-entrypoint.test.mjs",
    "sha": "ca6bff2fd6a2071b7bc5a21ec480fd7f12468286",
    "size": 1144
  },
  {
    "path": "packages/mcp-facade/test/mcp-facade.test.mjs",
    "sha": "ebdcbd3061eb9f7013fcec74764eb1ba567cc725",
    "size": 9716
  },
  {
    "path": "packages/mcp-facade/test/public-edge.test.mjs",
    "sha": "06e250dc5d2b019ee7b2c25843024bc9d4619937",
    "size": 4030
  },
  {
    "path": "packages/policy/src/tools.mjs",
    "sha": "97f141321225fc70392bf13aa00ba4132b386700",
    "size": 1736
  },
  {
    "path": "packages/policy/test/tools.test.mjs",
    "sha": "d422428c080cfca6875e06f3e43d7e1e9a5eba02",
    "size": 747
  },
  {
    "path": "packages/protocol/protocol-v1.json",
    "sha": "939127dadb670ec46e2932fb9dafb9d9f74d06bf",
    "size": 666
  },
  {
    "path": "packages/protocol/src/index.mjs",
    "sha": "6f23ab134892362ceb5567d10638a423ffcb8db2",
    "size": 2215
  },
  {
    "path": "packages/protocol/test/protocol.test.mjs",
    "sha": "1391aea974775a4a2ca4b3e1cb1d188a30a6746f",
    "size": 2256
  },
  {
    "path": "packages/relay-core/schema/postgres.sql",
    "sha": "1a5b5af054167b35b003444cca33d14305424c0d",
    "size": 1848
  },
  {
    "path": "packages/relay-core/src/call-store.mjs",
    "sha": "c42f8ca2eab57e288271a9e0b75aaf17728b1582",
    "size": 930
  },
  {
    "path": "packages/relay-core/src/relay-core.mjs",
    "sha": "dfa37cffc822d6d1f770f8c288bf8f76e575cbb3",
    "size": 2121
  },
  {
    "path": "packages/relay-core/src/result-cache.mjs",
    "sha": "a3ceeec5b537c3132917c52f5de87c52bb5763a7",
    "size": 2651
  },
  {
    "path": "packages/relay-core/src/session-registry.mjs",
    "sha": "939ef96d3bbfe0f977c174195f739bf6d4581a74",
    "size": 2756
  },
  {
    "path": "packages/relay-core/test/relay-core.test.mjs",
    "sha": "0ffa4b41ee96318addeb83a7b99aa947c21c577c",
    "size": 1787
  },
  {
    "path": "packages/relay-core/test/result-cache.test.mjs",
    "sha": "a25292c4807acf8c5ee41ce5715008624ed31395",
    "size": 1479
  },
  {
    "path": "packages/relay-core/test/session-registry.test.mjs",
    "sha": "3a27731873799ed1f5c389ecede2d1237d15d37c",
    "size": 1664
  },
  {
    "path": "packages/relay-server/src/auth.mjs",
    "sha": "d5b2a6db854f61ce5a22147c69db719e49046108",
    "size": 744
  },
  {
    "path": "packages/relay-server/src/config.mjs",
    "sha": "7a672fa4727cc8f91eb6ce6dcce4e053c9dce9d8",
    "size": 1299
  },
  {
    "path": "packages/relay-server/src/postgres-store.mjs",
    "sha": "bb5db0ed802762be8e05b355e4e65e3292208af8",
    "size": 2323
  },
  {
    "path": "packages/relay-server/src/server.mjs",
    "sha": "486a76be928a799fea0a5e36b2f8b7709c85758b",
    "size": 9585
  },
  {
    "path": "packages/relay-server/test/auth-config.test.mjs",
    "sha": "2a050203fda64616358cfb85bdaf1b64fb6db1e5",
    "size": 1091
  },
  {
    "path": "packages/relay-server/test/relay-network.test.mjs",
    "sha": "5a8d1ec03051330d40a1692ac0bac8de72be044f",
    "size": 10162
  }
];

function gitBlobSha(data){
  const header=Buffer.from(`blob ${data.length}\0`);
  return crypto.createHash("sha1").update(header).update(data).digest("hex");
}

let match=0, drift=0, missing=0;
const drifted=[], absent=[];
let bytes=0;

for(const item of EXPECTED){
  const full=path.join(ROOT,item.path);
  let data;
  try{
    data=fs.readFileSync(full);
  }catch(error){
    if(error?.code==="ENOENT"||error?.code==="ENOTDIR"){
      missing++;
      absent.push(item.path);
      continue;
    }
    throw new Error(`unable to read ${item.path}: ${error?.code??error}`);
  }
  bytes+=data.length;
  const actual=gitBlobSha(data);
  if(actual===item.sha){
    match++;
  }else{
    drift++;
    drifted.push({path:item.path,expected:item.sha,actual,size:data.length});
  }
}

console.log(`EXPECTED_HEAD=${EXPECTED_HEAD}`);
console.log(`EXPECTED_FILES=${EXPECTED.length}`);
console.log(`MATCH=${match}`);
console.log(`DRIFT=${drift}`);
console.log(`MISSING=${missing}`);
console.log(`READ_BYTES=${bytes}`);

for(const item of drifted){
  console.log(`DRIFT_FILE=${item.path} expected=${item.expected} actual=${item.actual} size=${item.size}`);
}
for(const file of absent){
  console.log(`MISSING_FILE=${file}`);
}

if(match+drift+missing!==EXPECTED.length) throw new Error("audit accounting mismatch");
console.log("PSE_RC_V1_LIVE_DRIFT_AUDIT=PASS");
