// A deliberately small suite for regressions that could duplicate work, lose state, break
// startup/config, or weaken provider isolation. No browser, network, SSH or credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// The gateway reads its host-data directory at import time; keep every test write out of the repo.
const dataDir = mkdtempSync(join(tmpdir(), "pocket-critical-"));
process.env.CODEX_POCKET_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const {
  MachineRuntime, MessageSubmissions, PocketGateway, RpcClient,
  isMessageNotSent, parseArgs, saveLocalSettings, settingsNeedRestart,
  sessionCookie, isAuthenticated, machineConfigurationsDiffer,
} = await import("../gateway.ts");
const {
  DeepSeekHost, deepseekConfig, deepseekEnvironment, withoutDeepseekKey,
  assertDeepseekConfig, constrainDeepseekRequest,
} = await import("../deepseek.ts");
const { reconcileSubmission, resolveModelEffort, machineCatalogAlias, sidebarMachineCatalog, cwdResponseApplies } = await import("../public/pocket-logic.js");

const selectionPath = join(dataDir, ".codex-pocket.selection.json");
const clearRememberedSelection = () => rmSync(selectionPath, { force: true });

// A connected runtime with one active turn; only the RPC surface is faked.
function activeRuntime() {
  const runtime = new MachineRuntime({}, { id: "local", name: "Local", ssh: null }, () => {});
  runtime.rpc = { request: async () => ({}) };
  runtime.canAcceptDirectInput = true;
  Object.assign(runtime.state, { connected: true, thread: { id: "thread-1" }, threadStatus: "active" });
  runtime.handleNotification({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } } });
  return runtime;
}

test("an accepted submission with a lost response reconciles once without sending again", async () => {
  const receipts = new MessageSubmissions();
  const id = `${receipts.epoch}-accepted`;
  let runs = 0;
  const operation = async () => { runs += 1; return { accepted: true, turnId: "turn-1" }; };
  const result = await receipts.run(id, operation);
  // A repeated POST after a lost response returns the receipt instead of dispatching again.
  assert.deepEqual(await receipts.run(id, operation), result);
  assert.equal(runs, 1);
  const receipt = await receipts.recover(id);
  assert.equal(receipt.status, "accepted");
  assert.equal(receipt.turnId, "turn-1");
  assert.equal(reconcileSubmission(id, { submission: receipt }), "accepted");
});

test("a New Task model switch keeps the current effort when possible", () => {
  // Sol/Medium -> Astra keeps Medium when Astra supports it; switching back keeps it too.
  assert.equal(resolveModelEffort(["low", "medium", "high"], "medium", "high"), "medium");
  assert.equal(resolveModelEffort(["low", "medium"], "medium", "low"), "medium");
  // An unsupported effort falls back to the target model's catalog default.
  assert.equal(resolveModelEffort(["low", "high"], "medium", "high"), "high");
  // No usable default falls back to the first supported effort, and nothing supported stays empty.
  assert.equal(resolveModelEffort(["low", "high"], "medium", "xhigh"), "low");
  assert.equal(resolveModelEffort([], "medium", "high"), "");
});

test("a definite not-sent rejection stays retryable", async () => {
  const receipts = new MessageSubmissions();
  const id = `${receipts.epoch}-rejected`;
  await assert.rejects(receipts.run(id, async () => { throw new Error("Message did not reach Pocket"); }));
  assert.equal((await receipts.recover(id)).status, "rejected");
  // A definitive failure never locks the conversation: a fresh submission still sends.
  let runs = 0;
  await receipts.run(`${receipts.epoch}-retry`, async () => { runs += 1; return { accepted: true }; });
  assert.equal(runs, 1);
});

test("post-dispatch uncertainty stays uncertain and is never re-dispatched automatically", async () => {
  const receipts = new MessageSubmissions();
  const id = `${receipts.epoch}-unknown`;
  let runs = 0;
  const failing = async () => { runs += 1; throw new Error("turn/start timed out"); };
  await assert.rejects(receipts.run(id, failing), /timed out/);
  assert.equal((await receipts.recover(id)).status, "unknown");
  // Repeating the POST uses the existing outcome; the operation is not dispatched again.
  await assert.rejects(receipts.run(id, failing));
  assert.equal(runs, 1);
  assert.equal((await receipts.recover(id)).status, "unknown", "uncertainty is not upgraded without evidence");
  // A late authoritative confirmation only resolves a receipt that registered recovery while pending.
  const lateId = `${receipts.epoch}-late`;
  let failLate;
  const pending = receipts.run(lateId, () => new Promise((_, reject) => { failLate = () => reject(new Error("turn/start timed out")); }));
  receipts.setRecovery(lateId, () => ({ accepted: true, turnId: "turn-1" }));
  failLate();
  await assert.rejects(pending, /timed out/);
  const recovered = await receipts.recover(lateId);
  assert.equal(recovered.status, "accepted");
  assert.equal(recovered.turnId, "turn-1");
});

test("a queued Start/Steer receipt cannot retire or resend a different replacement queue", async () => {
  for (const action of ["start", "steer"]) {
    const runtime = activeRuntime();
    const receipts = new MessageSubmissions();
    if (action === "start") { runtime.state.turn = null; runtime.state.threadStatus = "idle"; }
    const queued = { id: "original-queue", threadId: "thread-1", text: "Deliver this once", createdAt: 1 };
    runtime.state.queuedMessage = queued;
    let sends = 0;
    runtime.rpc = { request: async (method) => {
      if (method !== `turn/${action}`) return { data: [] };
      sends += 1;
      throw new Error(`turn/${action} timed out`);
    } };
    const id = `${receipts.epoch}-queued`;
    await assert.rejects(receipts.run(id, () => runtime.sendQueuedMessage(action, "thread-1", queued.id, { id, receipts })), /timed out/);
    assert.equal(runtime.state.queuedMessage.deliveryUnknown, true);
    assert.equal((await receipts.recover(id)).status, "unknown");
    // A later queue must survive the older receipt's recovery.
    const replacement = { ...queued, id: "replacement-queue", deliveryUnknown: false };
    runtime.state.queuedMessage = replacement;
    const turnId = action === "steer" ? "turn-1" : "new-turn";
    runtime.state.turn = { id: turnId, status: "inProgress" };
    runtime.state.liveMessages = [{ id: "delivered-item", role: "user", text: queued.text, turnId }];
    assert.equal((await receipts.recover(id)).status, "accepted");
    assert.equal(runtime.state.queuedMessage.id, "replacement-queue", "the older receipt cannot clear a newer queue");
    assert.equal(sends, 1, "an uncertain send is never repeated");
  }
});

test("a failed task selection leaves the original task attached and authoritative", async () => {
  clearRememberedSelection();
  const gateway = new PocketGateway({ machines: [] });
  const runtime = gateway.runtimes.get("local");
  Object.assign(runtime.state, {
    connected: true, thread: { id: "thread-1" }, threadStatus: "active",
    queuedMessage: { threadId: "thread-1", text: "Keep queued" },
  });
  const before = structuredClone(runtime.state);
  const calls = [];
  runtime.rpc = { request: async (method) => {
    calls.push(method);
    if (method === "thread/list") return { data: [{ id: "owned", name: "Owned", cwd: "/tmp", status: "idle" }] };
    if (method === "thread/resume") throw new Error("already has an active writer");
    return { data: [] };
  } };
  await assert.rejects(gateway.selectDestination("local", "owned", "local", "thread-1"), /another Codex runtime/);
  assert.deepEqual(runtime.state, before, "the current task stays authoritative");
  assert.equal(calls.includes("thread/unsubscribe"), false, "the current attachment is never released");
  assert.equal(gateway.snapshot().thread.id, "thread-1");
});

test("cross-machine selection releases the previous task only after the destination attaches", async () => {
  clearRememberedSelection();
  const gateway = new PocketGateway({ machines: [{ name: "B", ssh: "b" }] });
  const a = gateway.runtimes.get("local"), b = gateway.runtimes.get("ssh:b");
  const calls = [];
  let rejectB = true;
  for (const [label, runtime] of [["A", a], ["B", b]]) {
    Object.assign(runtime.state, { connected: true, thread: label === "A" ? { id: "a" } : null, threadStatus: "idle" });
    runtime.rpc = { request: async (method) => {
      calls.push(`${label}:${method}`);
      if (method === "thread/list") return { data: [{ id: label.toLowerCase(), name: label, cwd: "/tmp", status: "idle" }] };
      if (method === "thread/resume") {
        if (label === "B" && rejectB) throw new Error("already has an active writer");
        return { thread: { id: label.toLowerCase(), name: label, cwd: "/tmp", status: "idle" } };
      }
      return { data: [] };
    } };
  }
  const before = structuredClone(a.state);
  await assert.rejects(gateway.selectDestination("ssh:b", "b", "local", "a"), /another Codex runtime/);
  assert.deepEqual(a.state, before);
  assert.equal(calls.includes("A:thread/unsubscribe"), false);
  rejectB = false;
  calls.length = 0;
  await gateway.selectDestination("ssh:b", "b", "local", "a");
  assert(calls.indexOf("A:thread/unsubscribe") > calls.indexOf("B:thread/resume"), "release happens after the destination attaches");
  assert.equal(a.state.thread, null);
  assert.equal(b.state.thread.id, "b");
  assert.equal(gateway.snapshot().machineId, "ssh:b");
});

test("a zero-turn new task cannot be silently abandoned before its first accepted message", async () => {
  clearRememberedSelection();
  const gateway = new PocketGateway({ machines: [] });
  const runtime = gateway.runtimes.get("local");
  Object.assign(runtime.state, { connected: true, thread: { id: "fresh" }, threadStatus: "idle", turn: null });
  runtime.pendingTaskNames.set("fresh", { name: "Fresh", firstMessageAccepted: false });
  const calls = [];
  runtime.rpc = { request: async (method) => { calls.push(method); return { data: [] }; } };
  await assert.rejects(gateway.selectDestination("local", "other", "local", "fresh"), /first message/);
  assert.deepEqual(calls, [], "nothing is attached or released while the guard holds");
  assert.equal(gateway.snapshot().thread.id, "fresh");
  runtime.pendingTaskNames.set("fresh", { name: "Fresh", firstMessageAccepted: true });
  assert.doesNotThrow(() => runtime.assertCanLeaveNewTask());
});

test("a pure machine reorder needs no restart while add/edit/remove still does", () => {
  const machines = [{ name: "One", ssh: "one" }, { name: "Two", ssh: "two", wakeMac: "AA:BB:CC:DD:EE:FF" }];
  const options = parseArgs([], { host: "127.0.0.1", port: 4173, localName: "", machines });
  const auth = { pin: null };
  const settings = { config: { lanEnabled: false, host: "127.0.0.1", port: 4173, pin: null, localName: "", machines: [...machines].reverse() } };
  assert.equal(settingsNeedRestart(settings, options, auth, [], undefined), false);
  settings.config.machines = [...machines, { name: "Three", ssh: "three" }];
  assert.equal(settingsNeedRestart(settings, options, auth, [], undefined), true, "an added machine restarts");
  settings.config.machines = [{ name: "One renamed", ssh: "one" }, machines[1]];
  assert.equal(settingsNeedRestart(settings, options, auth, [], undefined), true, "an edited machine restarts");
  settings.config.machines = [machines[0]];
  assert.equal(settingsNeedRestart(settings, options, auth, [], undefined), true, "a removed machine restarts");
});

test("partial settings saves preserve unrelated saved values", () => {
  const dir = mkdtempSync(join(tmpdir(), "pocket-settings-"));
  try {
    const settings = { path: join(dir, "config.json"), loaded: true, config: {
      lanEnabled: true, host: "0.0.0.0", port: 4173, pin: "1234", localName: "", machines: [{ name: "Remote", ssh: "remote" }],
    } };
    saveLocalSettings(settings, { accessUrls: ["http://pocket.lan:4173/", "https://pocket.lan:8443", "https://pocket.lan:8443/"] }, undefined, false);
    saveLocalSettings(settings, { localName: "Renamed" }, undefined, false);
    assert.deepEqual(settings.config.accessUrls, ["http://pocket.lan:4173", "https://pocket.lan:8443"]);
    for (const url of ["javascript:alert(1)", "https://user:secret@pocket.lan", "https://pocket.lan/path", "https://pocket.lan/?query=1", "https://pocket.lan/#fragment"]) {
      assert.throws(() => saveLocalSettings(settings, { accessUrls: [url] }, undefined, false), /accessUrls/);
    }
    assert.equal(settings.config.localName, "Renamed");
    const disk = JSON.parse(readFileSync(settings.path, "utf8"));
    assert.deepEqual([disk.pin, disk.host, disk.port, disk.lanEnabled, disk.machines], ["1234", "0.0.0.0", 4173, true, [{ name: "Remote", ssh: "remote" }]]);
    // A container save keeps the deployment network but must still have a machine.
    saveLocalSettings(settings, { lanEnabled: false, host: "127.0.0.1", port: 5000, machines: [{ name: "Renamed", ssh: "renamed" }] }, null, true);
    assert.deepEqual([settings.config.lanEnabled, settings.config.host, settings.config.port, settings.config.pin], [true, "0.0.0.0", 4173, "1234"]);
    assert.deepEqual(settings.config.machines, [{ name: "Renamed", ssh: "renamed" }]);
    const before = readFileSync(settings.path, "utf8");
    assert.throws(() => saveLocalSettings(settings, { machines: [] }, null, true), /at least one SSH machine/);
    assert.equal(readFileSync(settings.path, "utf8"), before, "a rejected save leaves the file untouched");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("startup remembered selection obeys --thread and falls back cleanly when stale", () => {
  const machines = [{ name: "Studio", ssh: "studio" }];
  const base = { host: "127.0.0.1", port: 4173, localName: "Host", machines };
  writeFileSync(selectionPath, JSON.stringify({ machineId: "ssh:studio", threadId: "task-1" }));
  assert.equal(new PocketGateway(base).snapshot().machineId, "ssh:studio");
  // An explicit --thread override always wins.
  assert.equal(new PocketGateway({ ...base, thread: "override" }).snapshot().machineId, "local");
  writeFileSync(selectionPath, JSON.stringify({ machineId: "ssh:gone", threadId: "task-1" }));
  assert.equal(new PocketGateway(base).snapshot().machineId, "local", "a stale machine falls back to the first runtime");
  writeFileSync(selectionPath, "{not json");
  assert.equal(new PocketGateway(base).snapshot().machineId, "local", "a corrupt hint falls back cleanly");
  clearRememberedSelection();
});

test("DeepSeek configuration fails closed on provider, endpoint, auth and shell reinjection", () => {
  const home = "/isolated";
  const values = deepseekConfig(home);
  const good = {
    ...values,
    model_providers: { deepseek: values["model_providers.deepseek"] },
    shell_environment_policy: { exclude: values["shell_environment_policy.exclude"] },
  };
  assert.doesNotThrow(() => assertDeepseekConfig(good, home));
  for (const change of [
    { model_provider: "openai" },
    { model: "gpt-5" },
    { model_providers: { deepseek: { ...good.model_providers.deepseek, base_url: "https://example.invalid" } } },
    { model_providers: { deepseek: { ...good.model_providers.deepseek, experimental_bearer_token: "other" } } },
    { shell_environment_policy: { ...good.shell_environment_policy, exclude: [] } },
    { shell_environment_policy: { ...good.shell_environment_policy, set: { DEEPSEEK_API_KEY: "synthetic-value" } } },
    { shell_environment_policy: { ...good.shell_environment_policy, set: { OPENAI_API_KEY: "synthetic-value" } } },
  ]) assert.throws(() => assertDeepseekConfig({ ...good, ...change }, home), /isolation check failed/);
  assert.throws(() => constrainDeepseekRequest("thread/settings/update", { model: "gpt-5" }), /only supports/);
  assert.equal(constrainDeepseekRequest("thread/start", {}).modelProvider, "deepseek");
  assert.equal(constrainDeepseekRequest("command/exec", {}).env.DEEPSEEK_API_KEY, null);
});

test("the DeepSeek credential never leaks into child config, other runtimes or snapshots", () => {
  const key = randomBytes(32).toString("hex");
  const env = { PATH: "/bin", CODEX_HOME: "/normal", OPENAI_API_KEY: "unrelated", DEEPSEEK_API_KEY: key };
  const original = { ...env };
  const child = deepseekEnvironment(env, "/isolated");
  assert.equal(child.CODEX_HOME, "/isolated");
  assert.equal(child.DEEPSEEK_API_KEY, key);
  assert.equal(child.OPENAI_API_KEY, undefined);
  assert.equal(withoutDeepseekKey(env).DEEPSEEK_API_KEY, undefined);
  assert.deepEqual(env, original, "the parent environment is never mutated");
  assert.equal(JSON.stringify(deepseekConfig("/isolated")).includes(key), false);
  const host = new DeepSeekHost("/isolated", env);
  assert.equal(host.redact(`failure ${key} ${key}`), "failure [REDACTED] [REDACTED]");
  assert.equal(host.proxyOptions().env.CODEX_HOME, "/isolated");
  clearRememberedSelection();
  const gateway = new PocketGateway({ machines: [{ name: "Remote", ssh: "remote" }], deepseek: { enabled: true, key } });
  assert.ok(gateway.runtimes.get("local:dsh").deepseek);
  assert.equal(gateway.runtimes.get("local").deepseek, undefined, "the OpenAI runtime stays unisolated");
  assert.equal(gateway.runtimes.get("ssh:remote").deepseek, undefined);
  assert.equal(gateway.runtimes.get("local").machineSummary().provider, "openai");
  for (const payload of [gateway.snapshot(), gateway.listMachines(), gateway.runtimes.get("local:dsh").diagnostics()]) {
    assert.equal(JSON.stringify(payload).includes(key), false, "browser-facing payloads never carry the key");
  }
});

const isolatedRpc = (send) => {
  const rpc = new RpcClient(new DeepSeekHost("/isolated", { DEEPSEEK_API_KEY: randomBytes(32).toString("hex") }));
  rpc.wire = { close() {}, send };
  return rpc;
};

test("a DeepSeek preflight failure is definitively not-sent", async () => {
  const sent = [];
  const rpc = isolatedRpc((message) => {
    sent.push(message.method);
    if (message.method === "config/read") queueMicrotask(() => rpc.receive({ id: message.id, result: { config: { model_provider: "openai" } } }));
  });
  let failure;
  await assert.rejects(rpc.request("turn/start", { cwd: "/project", input: [] }, 2_000), (error) => { failure = error; return true; });
  assert.equal(isMessageNotSent(failure), true);
  assert.match(failure.message, /isolation check/);
  assert.deepEqual(sent, ["config/read"], "turn/start never reaches the wire");
  const receipts = new MessageSubmissions();
  const id = `${receipts.epoch}-preflight`;
  await assert.rejects(receipts.run(id, async () => { throw failure; }));
  assert.equal((await receipts.recover(id)).status, "rejected", "a preflight failure stays retryable");
});

test("a DeepSeek timeout after dispatch stays uncertain and cannot duplicate the send", async () => {
  const values = deepseekConfig("/isolated");
  const good = { ...values, model_providers: { deepseek: values["model_providers.deepseek"] }, shell_environment_policy: { exclude: values["shell_environment_policy.exclude"] } };
  const sent = [];
  const rpc = isolatedRpc((message) => {
    sent.push(message.method);
    // The preflight passes, then the dispatched mutation is accepted by the wire but never answered.
    if (message.method === "config/read") queueMicrotask(() => rpc.receive({ id: message.id, result: { config: good } }));
  });
  let failure;
  await assert.rejects(rpc.request("turn/start", { cwd: "/project", input: [] }, 50), (error) => { failure = error; return true; });
  assert.equal(isMessageNotSent(failure), false);
  assert.match(failure.message, /turn\/start timed out/);
  assert.equal(sent.filter((method) => method === "turn/start").length, 1);
  const receipts = new MessageSubmissions();
  const id = `${receipts.epoch}-postsend`;
  await assert.rejects(receipts.run(id, async () => { throw failure; }));
  assert.equal((await receipts.recover(id)).status, "unknown", "a post-dispatch timeout must not be reported as sent");
});

test("HTTP and HTTPS sessions coexist without overwriting Secure cookies", () => {
  const base = "codex_pocket_session_http=sid; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400";
  // Direct HTTP/LAN login: the Origin cannot prove HTTPS, so no Secure attribute is added.
  const http = { headers: { host: "192.168.1.10:4173", origin: "http://192.168.1.10:4173" } };
  assert.equal(sessionCookie(http, "sid"), base);
  // The browser itself reports the same-origin HTTPS login.
  const https = { headers: { host: "pocket.example.lan", origin: "https://pocket.example.lan" } };
  assert.equal(sessionCookie(https, "sid"), `${base.replace("_http=", "=")}; Secure`);
  // A mismatched (or missing) Origin is never trusted even when the page is served over a proxy.
  assert.equal(sessionCookie({ headers: { host: "pocket.example.lan", origin: "https://other.example" } }, "sid"), base);
  assert.equal(sessionCookie({ headers: { host: "pocket.example.lan" } }, "sid"), base);
  const auth = { required: true, sessionId: "sid" };
  const accepts = (cookie) => isAuthenticated({ headers: { cookie } }, auth);
  assert.equal(accepts("codex_pocket_session_http=sid"), true);
  assert.equal(accepts("codex_pocket_session=sid"), true, "existing HTTPS sessions remain valid");
  assert.equal(accepts("codex_pocket_session=stale; codex_pocket_session_http=sid"), true);
  assert.equal(accepts("codex_pocket_session_http=stale; codex_pocket_session=sid"), true);
  assert.equal(accepts("codex_pocket_session=stale; codex_pocket_session_http=wrong"), false);
  assert.equal(accepts(""), false);
  assert.equal(sessionCookie({ headers: { host: "pocket.example.lan", "x-forwarded-proto": "https" } }, "sid"), base);
});

test("DSH permissions fail closed and legacy session identities cannot be adopted", async () => {
  const { permission, sessionId } = await import('../dsh/projection.mjs');
  assert.equal(permission({ permissions: ':workspace', approvalPolicy: 'on-request' }, 'danger-full-access'), 'workspace-write');
  assert.equal(permission({ permissions: ':danger-full-access', approvalPolicy: 'never' }), 'danger-full-access');
  assert.throws(() => permission({ approvalPolicy: 'never' }), /Refusing/);
  assert.throws(() => permission({ permissions: ':danger-full-access', approvalPolicy: 'on-request' }), /Refusing/);
  assert.throws(() => permission({ approvalsReviewer: 'auto_review' }), /not configured/);
  assert.throws(() => permission({ permissions: ':unknown' }), /Unsupported/);
  assert.throws(() => sessionId('01900000-0000-0000-0000-000000000000'), /legacy/);
  assert.equal(sessionId('dsh-12345678-1234-1234-1234-123456789abc'), 'dsh-12345678-1234-1234-1234-123456789abc');
});

test("DSH reattach does not resend an uncertain mutation or accept its late response for a new request", async () => {
  const { DshRpcClient } = await import('../dsh.ts');
  const sent=[];
  const host={nextId:1,requests:new Map(),start:async()=>{},receiver:null,closed:null,child:{stdin:{writable:true,write:()=>{}}},write:(child,payload)=>sent.push(JSON.parse(payload))};
  const first=new DshRpcClient(host);
  await first.connect();
  const mutation=first.request('turn/start',{threadId:'dsh-test'},1000);
  const rejected=assert.rejects(mutation,/delivery may be unknown/);
  first.close();await rejected;
  const next=new DshRpcClient(host);await next.connect();
  const query=next.request('thread/read',{threadId:'dsh-test'},1000);
  assert.notEqual(sent[0].id,sent[1].id);
  host.receiver({id:sent[0].id,result:{wrong:true}});
  host.receiver({id:sent[1].id,result:{thread:{id:'dsh-test'}}});
  assert.deepEqual(await query,{thread:{id:'dsh-test'}});
  assert.equal(sent.filter(m=>m.method==='turn/start').length,1);
  next.close();
});

test("DSH receipt stores stay distinct across providers and execution machines", () => {
  clearRememberedSelection();
  const gateway=new PocketGateway({machines:[{name:'Remote',ssh:'remote',dshPath:'/opt/pocket/dsh/launch.mjs'}],deepseek:{enabled:true}},true);
  assert.notEqual(gateway.submissionStore('ssh:remote:dsh'),gateway.submissionStore('ssh:remote'));
  assert.notEqual(gateway.submissionStore('ssh:remote:dsh'),gateway.submissionStore('local:dsh'));
  assert.equal(gateway.runtimes.get('ssh:remote:dsh').machineSummary().provider,'deepseek');
  assert.equal(gateway.runtimes.get('ssh:remote').machineSummary().provider,'openai');
  assert.equal(machineConfigurationsDiffer([{name:'Remote',ssh:'remote',dshPath:'/new'}],[{name:'Remote',ssh:'remote',dshPath:'/old'}]),true);
});

test("DSH cancellation is a stopped turn and native tool results retain their call identity", async () => {
  const {projectEvents}=await import('../dsh/projection.mjs');
  const turns=projectEvents([
    {type:'turn/start',time:1,data:{turn:1}},
    {type:'tool/call',time:2,data:{turn:1,step:1,callId:'call',name:'web_fetch',arguments:'{"url":"https://example.org"}'}},
    {type:'tool/result',time:3,data:{turn:1,step:1,message:{content:[{type:'tool-result',toolCallId:'call',isError:true,content:[{type:'text',text:'blocked'}]}]}}},
    {type:'turn/end',time:4,data:{turn:1,reason:{kind:'aborted',reason:{kind:'user'}}}},
  ]);
  assert.equal(turns[0].status,'interrupted');
  assert.equal(turns[0].items.length,1);
  assert.equal(turns[0].items[0].status,'failed');
  assert.equal(turns[0].items[0].aggregatedOutput,'blocked');
});

test("an unavailable DSH balance stays unknown or stale without failing the runtime", async () => {
  const runtime=new MachineRuntime({machines:[]},{id:'local:dsh',name:'DSH',ssh:null,deepseek:true,provider:'deepseek'},()=>{});
  runtime.state.connected=true;
  runtime.rpc={request:async()=>null};
  await runtime.refreshBalance();
  assert.equal(runtime.balanceSnapshot().available,false);
  runtime.dshBalance={available:true,stale:false,isAvailable:true,entries:[{currency:'CNY',total:'1.23'}],updatedAt:123};
  runtime.rpc={request:async()=>{throw Error('balance service unavailable');}};
  await runtime.refreshBalance();
  assert.equal(runtime.balanceSnapshot().stale,true);
  assert.equal(runtime.balanceSnapshot().entries[0].total,'1.23');
  assert.equal(runtime.state.connected,true);
});

test("an SSH physical machine keeps every provider runtime under one alias", () => {
  // One alias exposing both OpenAI and DeepSeek must keep both runtimes; the
  // old catalog collapsed them to a single entry and lost one provider.
  const openai = { id: "ssh:mac", group: "ssh:mac", name: "Mac", local: false, provider: "openai", tasks: [] };
  const dsh = { id: "ssh:mac:dsh", group: "ssh:mac", name: "Mac", local: false, provider: "deepseek", tasks: [] };
  const local = { id: "local", group: "local", name: "Host", local: true, provider: "openai", tasks: [] };
  const localDsh = { id: "local:dsh", group: "local", name: "Host", local: true, provider: "deepseek", tasks: [] };
  assert.equal(machineCatalogAlias(openai), "mac");
  assert.equal(machineCatalogAlias(dsh), "mac");
  assert.equal(machineCatalogAlias(localDsh), "");
  const ordered = sidebarMachineCatalog([local, localDsh, openai, dsh], [{ name: "Saved Mac", ssh: "mac" }], "My Host");
  const ssh = ordered.filter((machine) => machine.id.startsWith("ssh:mac"));
  assert.deepEqual(ssh.map((machine) => machine.id).sort(), ["ssh:mac", "ssh:mac:dsh"]);
  assert.ok(ssh.every((machine) => machine.name === "Saved Mac" && machine.savedIndex === 0));
  assert.equal(ordered.filter((machine) => machine.local).length, 2);
  // An alias that is no longer running still yields its saved placeholder.
  const missing = sidebarMachineCatalog([local], [{ name: "Gone", ssh: "gone" }], "My Host");
  assert.ok(missing.some((machine) => machine.pending && machine.id === "ssh:gone"));
});

test("a broken DSH stdin pipe disconnects through the transport path instead of crashing", async () => {
  const { DshHost } = await import("../dsh.ts");
  const script = join(dataDir, "dsh-keepalive.mjs");
  writeFileSync(script, "process.stdin.resume();\n");
  const host = new DshHost(null, script);
  const closed = new Promise((resolve) => { host.closed = resolve; });
  await host.start();
  assert.ok(host.child && host.child.stdin.writable);
  // An EPIPE error on the child's stdin is a transport closure, not an
  // unhandled stream error that could terminate the gateway process.
  host.child.stdin.emit("error", new Error("EPIPE"));
  const error = await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("no disconnect")), 5000))]);
  assert.match(error.message, /DSH connection ended/);
  assert.equal(host.child, null);
  assert.throws(() => host.write({ stdin: { writable: true } }, "x"), /DSH disconnected/);
  await host.stop();
});

test("a persisted DSH user image is served through the session attachment API", async () => {
  const threadId = "dsh-12345678-1234-1234-1234-123456789abc";
  const runtime = new MachineRuntime({ machines: [] }, { id: "local:dsh", name: "DSH", ssh: null, deepseek: true, provider: "deepseek" }, () => {});
  runtime.state.connected = true;
  runtime.state.thread = { id: threadId, name: "Task", cwd: "/tmp" };
  runtime.itemCache.set("msg-1", { turnId: "1", item: { type: "userMessage", id: "msg-1", content: [{ type: "image", attachment: { attachmentId: "sha256:abc", mediaType: "image/png" } }] } });
  const calls = [];
  runtime.rpc = { request: async (method, params) => { calls.push({ method, params }); return { mimeType: "image/png", data: Buffer.from("hi").toString("base64") }; } };
  const image = await runtime.messageImage(threadId, "msg-1", 0);
  assert.equal(calls[0].method, "pocket/attachment");
  assert.equal(calls[0].params.threadId, threadId);
  assert.equal(calls[0].params.attachmentId, "sha256:abc");
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.data.toString(), "hi");
});

test("a marked DSH relocation notification re-keys only the selected task", () => {
  const oldId = "dsh-11111111-1111-1111-1111-111111111111";
  const newId = "dsh-22222222-2222-2222-2222-222222222222";
  const runtime = new MachineRuntime({ machines: [] }, { id: "local:dsh", name: "DSH", ssh: null, deepseek: true, provider: "deepseek" }, () => {});
  runtime.state.connected = true;
  runtime.state.thread = { id: oldId, name: "Task", cwd: "/old" };
  runtime.options.thread = oldId;
  runtime.pendingTaskNames.set(oldId, { name: "Task", firstMessageAccepted: true });
  runtime.rpc = { request: async () => ({ data: [], nextCursor: null }) };
  runtime.handleNotification({
    method: "thread/settings/updated",
    params: { threadId: newId, relocatedFrom: oldId, threadSettings: { cwd: "/new", model: "deepseek-flash", reasoningEffort: "high", activePermissionProfile: { id: ":workspace" }, approvalsReviewer: "user", approvalPolicy: "on-request", sandbox: { type: "workspaceWrite" } } },
  });
  assert.equal(runtime.state.thread.id, newId);
  assert.equal(runtime.state.thread.cwd, "/new");
  assert.equal(runtime.options.thread, newId);
  assert.equal(runtime.pendingTaskNames.has(oldId), false);
  assert.equal(runtime.pendingTaskNames.has(newId), true);
  // A settings event without the relocation marker never moves the identity,
  // so a new task's start or an unrelated settings push cannot steal selection.
  runtime.handleNotification({ method: "thread/settings/updated", params: { threadId: "dsh-33333333-3333-3333-3333-333333333333", threadSettings: { cwd: "/elsewhere" } } });
  assert.equal(runtime.state.thread.id, newId);
});

test("a confirmed DSH relocation response is accepted as the same dialog task", () => {
  const machineId = "local:dsh";
  const oldId = "dsh-11111111-1111-1111-1111-111111111111";
  const newId = "dsh-22222222-2222-2222-2222-222222222222";
  const target = { machineId, threadId: oldId };
  // Normal update: state and response stay on the target id.
  assert.equal(cwdResponseApplies(target, { machineId, thread: { id: oldId } }, { thread: { id: oldId } }), true);
  // Confirmed relocation: the browser already adopted the replacement id, or
  // has not yet, and the marked response ties it back to the old id.
  assert.equal(cwdResponseApplies(target, { machineId, thread: { id: newId } }, { relocatedFrom: oldId, thread: { id: newId } }), true);
  assert.equal(cwdResponseApplies(target, { machineId, thread: { id: oldId } }, { relocatedFrom: oldId, thread: { id: newId } }), true);
  // An unrelated task/id change is never consumed, and neither is another
  // machine's response.
  assert.equal(cwdResponseApplies(target, { machineId, thread: { id: "dsh-33333333-3333-3333-3333-333333333333" } }, { relocatedFrom: oldId, thread: { id: newId } }), false);
  assert.equal(cwdResponseApplies(target, { machineId, thread: { id: newId } }, { thread: { id: newId } }), false);
  assert.equal(cwdResponseApplies(target, { machineId: "ssh:other:dsh", thread: { id: newId } }, { relocatedFrom: oldId, thread: { id: newId } }), false);
  assert.equal(cwdResponseApplies(null, { machineId, thread: { id: oldId } }, { thread: { id: oldId } }), false);
});

test("the Project Folder response marks a confirmed DSH relocation", async () => {
  const oldId = "dsh-11111111-1111-1111-1111-111111111111";
  const newId = "dsh-22222222-2222-2222-2222-222222222222";
  const runtime = new MachineRuntime({ machines: [] }, { id: "local:dsh", name: "DSH", ssh: null, deepseek: true, provider: "deepseek" }, () => {});
  runtime.state.connected = true;
  runtime.state.thread = { id: oldId, name: "Task", cwd: "/old" };
  runtime.rpc = { request: async (method) => {
    if (method === "thread/settings/update") {
      runtime.handleNotification({ method: "thread/settings/updated", params: { threadId: newId, relocatedFrom: oldId, threadSettings: { cwd: "/new", model: "deepseek-flash", reasoningEffort: "low", activePermissionProfile: { id: ":workspace" }, approvalsReviewer: "user", approvalPolicy: "on-request", sandbox: { type: "workspaceWrite" } } } });
      return {};
    }
    return { data: [], nextCursor: null };
  } };
  const result = await runtime.updateWorkingPath(oldId, "/new");
  assert.equal(result.thread.id, newId);
  assert.equal(result.thread.cwd, "/new");
  assert.equal(result.relocatedFrom, oldId);
  assert.equal(cwdResponseApplies({ machineId: "local:dsh", threadId: oldId }, { machineId: "local:dsh", thread: runtime.state.thread }, result), true);
});

test("DSH remote launch quotes POSIX and Windows paths without shell interpolation", async () => {
  const { dshRemoteCommand } = await import('../dsh.ts');
  assert.equal(dshRemoteCommand("/home/a'b/launch.mjs"), "node '/home/a'\\''b/launch.mjs'");
  const path = "C:/Users/A O'Brien/$literal/launch.mjs";
  const command = dshRemoteCommand(path);
  assert.match(command, /^powershell -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
  assert.equal(Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le'),
    "& node 'C:/Users/A O''Brien/$literal/launch.mjs'; exit $LASTEXITCODE");
  const config = { lanEnabled: false, host:'127.0.0.1', port:4173, pin:null, localName:'', machines: [{name:'PC',ssh:'pc',dshPath:path}] };
  const settings = {path:join(dataDir,'windows-config.json'),loaded:true,config};
  assert.equal(saveLocalSettings(settings,{machines:config.machines},null,false).machines[0].dshPath, path);
  assert.throws(() => saveLocalSettings(settings,{machines:[{name:'PC',ssh:'pc',dshPath:'C:relative.mjs'}]},null,false), /absolute/);
});

test("DSH projects applied file diffs, keeps failures provisional, and never treats reads as file changes", async () => {
  const { projectEvents } = await import('../dsh/projection.mjs');
  const result = (callId, isError = false, content = []) => ({
    type: 'tool/result', time: 3,
    data: { turn: 1, step: 1, message: { content: [{ type: 'tool-result', toolCallId: callId, isError, content }] } },
  });
  const turns = projectEvents([
    { type: 'turn/start', time: 1, data: { turn: 1 } },
    { type: 'tool/call', time: 2, data: { turn: 1, step: 1, callId: 'edit-1', name: 'edit', arguments: JSON.stringify({ file_path: 'a.ts', old_string: 'x', new_string: 'y' }) } },
    { ...result('edit-1', false, [{ type: 'text', text: 'ok' }]), data: { turn: 1, step: 1, meta: { diffs: [{ path: 'a.ts', oldText: 'x', newText: 'y' }] }, message: { content: [{ type: 'tool-result', toolCallId: 'edit-1', isError: false, content: [{ type: 'text', text: 'ok' }] }] } } },
    { type: 'tool/call', time: 4, data: { turn: 1, step: 1, callId: 'write-1', name: 'write', arguments: JSON.stringify({ file_path: 'new.ts', content: 'one\ntwo' }) } },
    { ...result('write-1'), data: { turn: 1, step: 1, meta: { operation: 'create', diffs: [] }, message: { content: [{ type: 'tool-result', toolCallId: 'write-1', isError: false, content: [{ type: 'text', text: 'created' }] }] } } },
    { type: 'tool/call', time: 6, data: { turn: 1, step: 1, callId: 'edit-2', name: 'edit', arguments: JSON.stringify({ file_path: 'b.ts', old_string: 'p', new_string: 'q' }) } },
    result('edit-2', true, [{ type: 'text', text: 'failed' }]),
    { type: 'tool/call', time: 7, data: { turn: 1, step: 1, callId: 'write-2', name: 'write', arguments: JSON.stringify({ file_path: 'same.ts', content: 'unchanged' }) } },
    { ...result('write-2'), data: { turn: 1, step: 1, meta: { operation: 'update', diffs: [] }, message: { content: [{ type: 'tool-result', toolCallId: 'write-2', isError: false, content: [{ type: 'text', text: 'updated' }] }] } } },
    { type: 'tool/call', time: 8, data: { turn: 1, step: 1, callId: 'read-1', name: 'read', arguments: JSON.stringify({ file_path: 'c.ts' }) } },
    result('read-1', false, [{ type: 'text', text: 'contents' }]),
  ]);
  const items = turns[0].items;
  const edit = items.find((item) => item.id === 'edit-1');
  assert.equal(edit.type, 'fileChange');
  assert.equal(edit.status, 'completed');
  assert.equal(edit.applied, true);
  assert.equal(edit.changes[0].path, 'a.ts');
  assert.match(edit.changes[0].diff, /-x/);
  assert.match(edit.changes[0].diff, /\+y/);
  const write = items.find((item) => item.id === 'write-1');
  assert.equal(write.type, 'fileChange');
  assert.equal(write.applied, true);
  assert.equal(write.changes[0].kind, 'add');
  assert.match(write.changes[0].diff, /\+one/);
  // A failed edit keeps its provisional call-time changes but never claims they were applied.
  const failed = items.find((item) => item.id === 'edit-2');
  assert.equal(failed.type, 'fileChange');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.applied, false);
  assert.match(failed.changes[0].diff, /-p/);
  // An authoritative update with no hunks is unchanged: provisional additions are dropped.
  const unchanged = items.find((item) => item.id === 'write-2');
  assert.equal(unchanged.type, 'fileChange');
  assert.equal(unchanged.applied, true);
  assert.equal(unchanged.unchanged, true);
  assert.deepEqual(unchanged.changes, []);
  // A read is never File Changes.
  const read = items.find((item) => item.id === 'read-1');
  assert.equal(read.type, 'dynamicToolCall');
  assert.equal(read.changes, undefined);
});

test("DSH coalesces per-hunk diffs into one File Changes entry per path", async () => {
  const { projectEvents } = await import('../dsh/projection.mjs');
  const turns = projectEvents([
    { type: 'turn/start', time: 1, data: { turn: 1 } },
    { type: 'tool/call', time: 2, data: { turn: 1, step: 1, callId: 'e', name: 'edit', arguments: JSON.stringify({ file_path: 'a.ts', old_string: 'x\ny', new_string: 'x\nz' }) } },
    { type: 'tool/result', time: 3, data: { turn: 1, step: 1, meta: { diffs: [
      { path: 'a.ts', oldText: 'x\ny', newText: 'x\nz' },
      { path: 'a.ts', oldText: 'p', newText: 'q' },
    ] }, message: { content: [{ type: 'tool-result', toolCallId: 'e', isError: false, content: [] }] } } },
  ]);
  const item = turns[0].items[0];
  assert.equal(item.type, 'fileChange');
  assert.equal(item.changes.length, 1);
  assert.equal(item.changes[0].path, 'a.ts');
});

test("DSH maps search tools and subagents while unknown tools stay Tool", async () => {
  const { projectEvents } = await import('../dsh/projection.mjs');
  const turns = projectEvents([
    { type: 'turn/start', time: 1, data: { turn: 1 } },
    { type: 'tool/call', time: 2, data: { turn: 1, step: 1, callId: 'g', name: 'grep', arguments: JSON.stringify({ pattern: 'needle' }) } },
    { type: 'tool/call', time: 3, data: { turn: 1, step: 1, callId: 's', name: 'subagent', arguments: JSON.stringify({ prompt: 'help' }) } },
    { type: 'tool/call', time: 4, data: { turn: 1, step: 1, callId: 'u', name: 'mystery_tool', arguments: '{}' } },
  ]);
  const byId = (id) => turns[0].items.find((item) => item.id === id);
  assert.equal(byId('g').type, 'webSearch');
  assert.equal(byId('g').query, 'needle');
  assert.equal(byId('s').type, 'collabAgentToolCall');
  assert.equal(byId('u').type, 'dynamicToolCall');
});

test("model display names and ordering prefer V4.1 Flash over V4 Pro without guessing unknown versions", async () => {
  const { modelDisplayName, sortModelsForDisplay } = await import('../public/pocket-logic.js');
  const flash = { id: 'deepseek-flash', model: 'deepseek-flash', displayName: 'DeepSeek-V41-Flash' };
  const pro = { id: 'deepseek-v4-pro', model: 'deepseek-v4-pro', displayName: 'DeepSeek-V4-Pro' };
  assert.equal(modelDisplayName(flash), 'DeepSeek V4.1 Flash');
  assert.equal(modelDisplayName(pro), 'DeepSeek V4 Pro');
  assert.deepEqual(sortModelsForDisplay([pro, flash]).map((model) => model.model), ['deepseek-flash', 'deepseek-v4-pro']);
  // An unknown model keeps its catalog name; no version is inferred.
  assert.equal(modelDisplayName({ model: 'future-v9', displayName: 'Future V9' }), 'Future V9');
});

test("unsupported paginated history falls back per thread and pages a legacy read", async () => {
  clearRememberedSelection();
  const runtime = new MachineRuntime({ machines: [] }, { id: 'local', name: 'Local', ssh: null }, () => {});
  runtime.state.connected = true;
  runtime.state.thread = { id: 'thread-1', name: 'T', cwd: '/tmp', source: 'appServer', historyMode: 'paginated' };
  const turns = Array.from({ length: 5 }, (_, index) => ({ id: `t${index + 1}`, status: 'completed', items: [] }));
  const calls = [];
  runtime.rpc = { request: async (method) => {
    calls.push(method);
    if (method === 'thread/turns/list') throw new Error('paginated_threads is not supported yet (-32601)');
    if (method === 'thread/read') return { thread: { id: 'thread-1', turns } };
    throw new Error(`unexpected ${method}`);
  } };
  const first = await runtime.history(null, 2);
  assert.equal(calls.includes('thread/read'), true);
  assert.equal(first.turns.length, 2);
  assert.equal(first.turns.at(-1).id, 't5');
  assert.equal(first.nextCursor, '3');
  assert.equal(runtime.historyThreadModes.get('thread-1'), 'legacy');
  // An older page is sliced from the cached full read, not re-fetched whole.
  calls.length = 0;
  const older = await runtime.history('3', 2);
  assert.deepEqual(calls, []);
  assert.deepEqual(older.turns.map((turn) => turn.id), ['t2', 't3']);
  assert.equal(older.nextCursor, '1');
  // A thread the runtime marks legacy never calls the paginated method.
  runtime.state.thread = { ...runtime.state.thread, historyMode: 'legacy' };
  calls.length = 0;
  await runtime.history(null, 2);
  assert.deepEqual(calls, ['thread/read']);
  clearRememberedSelection();
});

test("legacy history mode is tracked per thread, not across the runtime", async () => {
  clearRememberedSelection();
  const runtime = new MachineRuntime({ machines: [] }, { id: 'local', name: 'Local', ssh: null }, () => {});
  runtime.state.connected = true;
  runtime.state.thread = { id: 'legacy-thread', name: 'L', cwd: '/tmp', source: 'appServer', historyMode: 'paginated' };
  runtime.rpc = { request: async (method) => {
    if (method === 'thread/turns/list') throw new Error('paginated_history is not supported yet');
    if (method === 'thread/read') return { thread: { id: 'legacy-thread', turns: [] } };
    throw new Error(`unexpected ${method}`);
  } };
  await runtime.history(null, 2);
  assert.equal(runtime.historyThreadModes.get('legacy-thread'), 'legacy');
  // A second thread still uses the paginated interface.
  runtime.state.thread = { id: 'paginated-thread', name: 'P', cwd: '/tmp', source: 'appServer', historyMode: 'paginated' };
  let paginated = false;
  runtime.rpc = { request: async (method) => {
    if (method === 'thread/turns/list') { paginated = true; return { data: [], nextCursor: null }; }
    throw new Error(`unexpected ${method}`);
  } };
  await runtime.history(null, 2);
  assert.equal(paginated, true);
  assert.equal(runtime.historyThreadModes.has('paginated-thread'), false);
  clearRememberedSelection();
});

test("a blocked goal resumes while a completed goal does not", async () => {
  clearRememberedSelection();
  const runtime = new MachineRuntime({ machines: [] }, { id: 'local', name: 'Local', ssh: null }, () => {});
  runtime.state.connected = true;
  runtime.state.thread = { id: 'thread-1', name: 'T', cwd: '/tmp', source: 'appServer' };
  runtime.state.goal = { objective: 'Ship it', status: 'blocked', blockedReason: 'needs input' };
  runtime.rpc = { request: async (method, params) => {
    if (method === 'thread/goal/set') return { goal: { objective: 'Ship it', status: params.status } };
    throw new Error(`unexpected ${method}`);
  } };
  const result = await runtime.goalAction({ threadId: 'thread-1', action: 'resume' });
  assert.equal(result.goal.status, 'active');
  runtime.state.goal = { objective: 'Ship it', status: 'complete' };
  await assert.rejects(runtime.goalAction({ threadId: 'thread-1', action: 'resume' }), /cannot be resumed/);
  clearRememberedSelection();
});

test("withdrawing a queued message returns its original file bytes and refuses while sending", () => {
  const runtime = new MachineRuntime({ machines: [] }, { id: 'local', name: 'Local', ssh: null }, () => {});
  runtime.state.connected = true;
  runtime.state.thread = { id: 'thread-1', name: 'T', cwd: '/tmp', source: 'appServer' };
  runtime.state.turn = { id: 'turn-1', status: 'inProgress' };
  const uploads = [{ name: 'notes.txt', data: 'aGk=', size: 2 }];
  runtime.queuedFileUploads.set('q1', uploads);
  runtime.state.queuedMessage = { id: 'q1', threadId: 'thread-1', text: '', files: [{ name: 'notes.txt', path: '/tmp/1-notes.txt', size: 2 }], createdAt: 1 };
  const withdrawn = runtime.cancelQueuedMessage('thread-1', 'q1');
  assert.equal(withdrawn.cancelled, true);
  assert.deepEqual(withdrawn.files, uploads);
  assert.equal(runtime.state.queuedMessage, null);
  // A delivery already in flight is never withdrawn or duplicated.
  runtime.startingQueuedMessage = true;
  runtime.state.queuedMessage = { id: 'q2', threadId: 'thread-1', text: 'x', createdAt: 2 };
  assert.deepEqual(runtime.cancelQueuedMessage('thread-1', 'q2'), { cancelled: false, reason: 'in-flight' });
  assert.equal(runtime.state.queuedMessage.id, 'q2');
});

test("queued attachment bytes survive a task switch and block an unsafe withdraw", () => {
  const runtime = new MachineRuntime({ machines: [] }, { id: 'local', name: 'Local', ssh: null }, () => {});
  runtime.state.connected = true;
  runtime.state.thread = { id: 'thread-1', name: 'T', cwd: '/tmp', source: 'appServer' };
  runtime.state.turn = { id: 'turn-1', status: 'inProgress' };
  const uploads = [{ name: 'notes.txt', data: 'aGk=', size: 2 }];
  runtime.queuedFileUploads.set('q1', uploads);
  runtime.state.queuedMessage = { id: 'q1', threadId: 'thread-1', text: '', files: [{ name: 'notes.txt', path: '/tmp/1-notes.txt', size: 2 }], createdAt: 1 };
  // Park the queue the way a task switch does, then reset the live task state.
  runtime.taskQueues.set('thread-1', runtime.state.queuedMessage);
  runtime.resetThreadState();
  runtime.state.thread = { id: 'thread-2', name: 'Other', cwd: '/tmp', source: 'appServer' };
  // Returning to the first task restores its parked queue with the retained bytes intact.
  runtime.state.thread = { id: 'thread-1', name: 'T', cwd: '/tmp', source: 'appServer' };
  runtime.state.queuedMessage = runtime.taskQueues.get('thread-1');
  const restored = runtime.cancelQueuedMessage('thread-1', 'q1');
  assert.equal(restored.cancelled, true);
  assert.deepEqual(restored.files, uploads);
  // Without retained bytes the server refuses rather than withdrawing a lossy draft.
  runtime.state.thread = { id: 'thread-2', name: 'Other', cwd: '/tmp', source: 'appServer' };
  runtime.state.queuedMessage = { id: 'q3', threadId: 'thread-2', text: '', files: [{ name: 'a.txt', path: '/tmp/a', size: 1 }], createdAt: 3 };
  assert.deepEqual(runtime.cancelQueuedMessage('thread-2', 'q3'), { cancelled: false, reason: 'attachments' });
  assert.equal(runtime.state.queuedMessage.id, 'q3');
  // Uncertain delivery is refused server-side too.
  runtime.state.queuedMessage = { id: 'q4', threadId: 'thread-2', text: 'x', deliveryUnknown: true, createdAt: 4 };
  assert.deepEqual(runtime.cancelQueuedMessage('thread-2', 'q4'), { cancelled: false, reason: 'uncertain' });
  assert.equal(runtime.state.queuedMessage.id, 'q4');
});

test("gateway and execution-side adapter protocol versions stay in sync", async () => {
  const { DSH_ADAPTER_PROTOCOL } = await import('../dsh/projection.mjs');
  const gateway = await import('../gateway.ts');
  assert.equal(gateway.DSH_ADAPTER_PROTOCOL, DSH_ADAPTER_PROTOCOL);
});

test("a request replayed before its thread attaches is delivered after attach", async () => {
  clearRememberedSelection();
  const runtime = new MachineRuntime({ machines: [] }, { id: 'local', name: 'Local', ssh: null }, () => {});
  runtime.state.connected = true;
  const request = { id: 41, method: 'item/tool/requestUserInput', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'q', isBlocking: true, questions: [{ id: 'q1', header: 'H', question: 'Pick', isOther: true, options: [{ label: 'A', description: '' }] }] } };
  // The durable runtime replays this before the gateway has selected a task.
  runtime.handleServerRequest(request);
  assert.equal(runtime.deferredServerRequests.get('thread-1').length, 1);
  assert.equal(runtime.state.pending.length, 0);
  runtime.loadedThreads = [{ id: 'thread-1', name: 'T', preview: '', cwd: '/tmp', project: 'tmp', status: 'idle', loaded: true, updatedAt: 0 }];
  runtime.rpc = { request: async (method) => {
    if (method === 'thread/resume') return { thread: { id: 'thread-1', name: 'T', cwd: '/tmp', status: 'idle' } };
    if (method === 'thread/goal/get') return { goal: null };
    if (method === 'permissionProfile/list') return { data: [], nextCursor: null };
    return {};
  } };
  await runtime.attachLoadedThread('thread-1', false);
  assert.equal(runtime.deferredServerRequests.size, 0);
  assert.equal(runtime.state.pending.length, 1);
  assert.equal(runtime.state.pending[0].id, '41');
  assert.equal(runtime.state.pending[0].questions[0].question, 'Pick');
  clearRememberedSelection();
});

test("a deferred request settled before attach is never surfaced later", async () => {
  clearRememberedSelection();
  const runtime = new MachineRuntime({ machines: [] }, { id: 'local', name: 'Local', ssh: null }, () => {});
  runtime.state.connected = true;
  const request = { id: 42, method: 'item/tool/requestUserInput', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'q', isBlocking: true, questions: [{ id: 'q1', header: 'H', question: 'Pick', isOther: true, options: [{ label: 'A', description: '' }] }] } };
  runtime.handleServerRequest(request);
  assert.equal(runtime.deferredServerRequests.get('thread-1').length, 1);
  // The runtime later reports the question resolved or cancelled while no task is selected.
  runtime.settlePendingRequest('42');
  assert.equal(runtime.deferredServerRequests.size, 0, 'the held copy is retired with the request');
  runtime.loadedThreads = [{ id: 'thread-1', name: 'T', preview: '', cwd: '/tmp', project: 'tmp', status: 'idle', loaded: true, updatedAt: 0 }];
  runtime.rpc = { request: async (method) => {
    if (method === 'thread/resume') return { thread: { id: 'thread-1', name: 'T', cwd: '/tmp', status: 'idle' } };
    if (method === 'thread/goal/get') return { goal: null };
    if (method === 'permissionProfile/list') return { data: [], nextCursor: null };
    return {};
  } };
  await runtime.attachLoadedThread('thread-1', false);
  assert.equal(runtime.state.pending.length, 0, 'attaching does not resurrect the dead request');
  clearRememberedSelection();
});

test("an authoritative thread-name update replaces a stale pending name", () => {
  clearRememberedSelection();
  const runtime = new MachineRuntime({ machines: [] }, { id: 'local', name: 'Local', ssh: null }, () => {});
  runtime.state.connected = true;
  runtime.state.thread = { id: 'thread-1', name: 'Local Name', cwd: '/tmp', source: 'appServer' };
  runtime.pendingTaskNames.set('thread-1', { name: 'Local Name', firstMessageAccepted: false });
  runtime.handleNotification({ method: 'thread/name/updated', params: { threadId: 'thread-1', threadName: 'Renamed Elsewhere' } });
  assert.equal(runtime.state.thread.name, 'Renamed Elsewhere');
  assert.equal(runtime.pendingTaskNames.get('thread-1').saved, true);
  clearRememberedSelection();
});
