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
  sessionCookie,
} = await import("../gateway.ts");
const {
  DeepSeekHost, deepseekConfig, deepseekEnvironment, withoutDeepseekKey,
  assertDeepseekConfig, constrainDeepseekRequest,
} = await import("../deepseek.ts");
const { reconcileSubmission, resolveModelEffort } = await import("../public/pocket-logic.js");

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
    saveLocalSettings(settings, { localName: "Renamed" }, undefined, false);
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
  assert.ok(gateway.runtimes.get("local:deepseek").deepseek);
  assert.equal(gateway.runtimes.get("local").deepseek, undefined, "the OpenAI runtime stays unisolated");
  assert.equal(gateway.runtimes.get("ssh:remote").deepseek, undefined);
  assert.equal(gateway.runtimes.get("local").machineSummary().provider, "openai");
  for (const payload of [gateway.snapshot(), gateway.listMachines(), gateway.runtimes.get("local:deepseek").diagnostics()]) {
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

test("the session cookie is Secure only for a same-origin HTTPS login", () => {
  const base = "codex_pocket_session=sid; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400";
  // Direct HTTP/LAN login: the Origin cannot prove HTTPS, so no Secure attribute is added.
  const http = { headers: { host: "192.168.1.10:4173", origin: "http://192.168.1.10:4173" } };
  assert.equal(sessionCookie(http, "sid"), base);
  // The browser itself reports the same-origin HTTPS login.
  const https = { headers: { host: "pocket.example.lan", origin: "https://pocket.example.lan" } };
  assert.equal(sessionCookie(https, "sid"), `${base}; Secure`);
  // A mismatched (or missing) Origin is never trusted even when the page is served over a proxy.
  assert.equal(sessionCookie({ headers: { host: "pocket.example.lan", origin: "https://other.example" } }, "sid"), base);
  assert.equal(sessionCookie({ headers: { host: "pocket.example.lan" } }, "sid"), base);
});
