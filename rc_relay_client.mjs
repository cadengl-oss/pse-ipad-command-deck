export class RelayClient {
  constructor({
    baseUrl,
    internalToken,
    ownerId,
    fetchImpl=fetch,
    defaultWaitMs=30_000,
    defaultTtlMs=90_000,
    maxTtlMs=180_000,
    now=()=>Date.now()
  }) {
    if (!baseUrl) throw new Error("relay base URL required");
    if (!internalToken||internalToken.length<32) throw new Error("relay internal token required");
    if (!ownerId) throw new Error("ownerId required");
    this.baseUrl=baseUrl.replace(/\/$/,"");
    this.internalToken=internalToken;
    this.ownerId=ownerId;
    this.fetchImpl=fetchImpl;
    this.defaultWaitMs=defaultWaitMs;
    this.defaultTtlMs=defaultTtlMs;
    this.maxTtlMs=maxTtlMs;
    this.now=now;
  }

  headers(extra={}) {
    return {
      Authorization:`Bearer ${this.internalToken}`,
      "x-pse-owner":this.ownerId,
      ...extra
    };
  }

  async listDevices() {
    const response=await this.fetchImpl(`${this.baseUrl}/internal/devices`,{headers:this.headers()});
    if (!response.ok) throw new Error(`relay device listing failed (${response.status})`);
    return (await response.json()).devices??[];
  }

  async resolveDevice(deviceId) {
    const devices=await this.listDevices();
    if (deviceId) {
      const found=devices.find((device)=>device.deviceId===deviceId);
      if (!found) throw new Error("device not found");
      if (found.state!=="ONLINE") throw new Error(`device is ${found.state}`);
      return found.deviceId;
    }
    const online=devices.filter((device)=>device.state==="ONLINE");
    if (online.length===1) return online[0].deviceId;
    if (online.length===0) throw new Error("no PSE Remote Commander device is online");
    throw new Error("deviceId required when multiple PSE devices are online");
  }

  inferTtlMs(args={},explicit) {
    if (explicit!==undefined) {
      if (!Number.isInteger(explicit)||explicit<1000||explicit>this.maxTtlMs) throw new Error("invalid remote call ttl");
      return explicit;
    }
    const requested=Number(args?.timeout_ms);
    if (Number.isFinite(requested)&&requested>0) {
      return Math.min(this.maxTtlMs,Math.max(45_000,Math.floor(requested)+10_000));
    }
    return this.defaultTtlMs;
  }

  async callTool(toolName,args={},options={}) {
    const {deviceId,...toolArgs}=args??{};
    const resolved=await this.resolveDevice(deviceId);
    const ttlMs=this.inferTtlMs(toolArgs,options.ttlMs);

    const response=await this.fetchImpl(`${this.baseUrl}/internal/calls`,{
      method:"POST",
      headers:this.headers({"content-type":"application/json"}),
      body:JSON.stringify({
        device_id:resolved,
        tool_name:toolName,
        arguments:toolArgs,
        ttl_ms:ttlMs
      })
    });
    if (!response.ok) {
      const body=await response.json().catch(()=>({}));
      throw new Error(body.error??`relay call rejected (${response.status})`);
    }

    const created=await response.json();
    const deadline=this.now()+ttlMs;
    const preferredWait=options.waitMs??this.defaultWaitMs;
    if (!Number.isInteger(preferredWait)||preferredWait<0||preferredWait>60_000) {
      throw new Error("invalid relay wait interval");
    }

    while (true) {
      const remaining=deadline-this.now();
      if (remaining<=0) throw new Error(`remote call did not complete before ttl (call_id=${created.call_id})`);
      const waitMs=Math.min(Math.max(preferredWait,1),60_000,remaining);
      const completed=await this.fetchImpl(
        `${this.baseUrl}/internal/calls/${encodeURIComponent(created.call_id)}?wait_ms=${waitMs}`,
        {headers:this.headers()}
      );
      if (!completed.ok) throw new Error(`relay result lookup failed (${completed.status})`);
      const body=await completed.json();

      if (body.result) {
        if (body.result.state==="FAILED") {
          throw new Error(body.result.error_code??body.error_code??"remote execution failed");
        }
        return {deviceId:resolved,callId:created.call_id,result:body.result.result};
      }

      if (["FAILED","CANCELLED","EXPIRED"].includes(body.state)) {
        throw new Error(body.error_code??`remote call ended in ${body.state}`);
      }
      if (body.state==="SUCCEEDED") {
        throw new Error("remote call result is no longer available");
      }
    }
  }
}
