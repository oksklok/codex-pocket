// DSH runtime survival across a gateway connection loss, against one isolated real DSH process and
// a local fake Messages endpoint. Skips when the separately locked DSH dependencies are absent.
// No credentials, no external network, no production state.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DSH_BIN = join(ROOT, "dsh/node_modules/@deepseek-ai/dsh/package.json");
const LAUNCHER = join(ROOT, "dsh/launch.mjs");
const installed = existsSync(DSH_BIN);

// A controllable Messages endpoint: each request streams a short reply and then waits for the test
// to release it, so a turn stays in progress across a gateway restart.
function startHeldEndpoint() {
  const bodies = [];
  const releases = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      if (!request.url.endsWith("/messages")) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { type: "not_found_error", message: "unsupported" } }));
        return;
      }
      try { bodies.push(JSON.parse(raw)); } catch { bodies.push(null); }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (name, event) => response.write(`event: ${name}\ndata: ${JSON.stringify(event)}\n\n`);
      send("message_start", { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } });
      send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "working" } });
      let released = false;
      releases.push(() => {
        if (released) return;
        released = true;
        send("content_block_stop", { type: "content_block_stop", index: 0 });
        send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } });
        send("message_stop", { type: "message_stop" });
        response.end();
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      server,
      bodies,
      releaseAll: () => { for (const release of releases.splice(0)) release(); },
      port: server.address().port,
    }));
  });
}

// First model response asks a structured question through DSH's ask_user_question tool; the model
// response after the tool result is held so the turn can be inspected before it completes.
function startQuestionEndpoint() {
  const bodies = [];
  const releases = [];
  let releaseAllRequested = false;
  let call = 0;
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      if (!request.url.endsWith("/messages")) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { type: "not_found_error", message: "unsupported" } }));
        return;
      }
      try { bodies.push(JSON.parse(raw)); } catch { bodies.push(null); }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (name, event) => response.write(`event: ${name}\ndata: ${JSON.stringify(event)}\n\n`);
      call += 1;
      send("message_start", { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } });
      if (call === 1) {
        send("content_block_start", { type: "content_block_start", index: 0, content_block: {
          type: "tool_use", id: "toolu_q1", name: "ask_user_question",
          input: { questions: [{ id: "q1", header: "Choose", question: "Pick one", options: [{ label: "A", description: "" }] }] },
        } });
        send("content_block_stop", { type: "content_block_stop", index: 0 });
        send("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } });
        send("message_stop", { type: "message_stop" });
        response.end();
        return;
      }
      send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "answered" } });
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        send("content_block_stop", { type: "content_block_stop", index: 0 });
        send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
        send("message_stop", { type: "message_stop" });
        response.end();
      };
      releases.push(release);
      if (releaseAllRequested) release();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      server,
      bodies,
      releaseAll: () => {
        releaseAllRequested = true;
        for (const release of releases.splice(0)) release();
      },
      port: server.address().port,
    }));
  });
}

class Connection {
  constructor(home) {
    this.home = home;
    this.buffer = "";
    this.pending = new Map();
    this.waiters = [];
    this.received = [];
    this.id = 0;
    this.stderr = "";
  }
  async start() {
    this.child = spawn(process.execPath, ["--experimental-strip-types", LAUNCHER], {
      cwd: ROOT,
      env: { ...process.env, POCKET_DSH_HOME: this.home, DEEPSEEK_API_KEY: "sk-dummy-test-key-000000000000" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      let at;
      while ((at = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        this.received.push(message);
        if (message.id !== undefined && this.pending.has(message.id)) {
          const resolve = this.pending.get(message.id);
          this.pending.delete(message.id);
          resolve(message);
          continue;
        }
        for (const waiter of [...this.waiters]) {
          if (!waiter.match(message)) continue;
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk; });
    await this.call("initialize");
  }
  // Answer a server request (an approval or structured question) by its wire id.
  respond(id, result) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }
  call(method, params = {}, timeout = 30000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`${method} timed out${this.stderr ? `: ${this.stderr.slice(-200)}` : ""}`));
      }, timeout);
      timer.unref();
    });
  }
  waitFor(match, timeout = 45000) {
    // A durable runtime can replay a pending request immediately on attach, before the caller
    // registers its waiter; the received log keeps that replay observable.
    const existing = this.received.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve };
      this.waiters.push(waiter);
      const timer = setTimeout(() => {
        const at = this.waiters.indexOf(waiter);
        if (at >= 0) this.waiters.splice(at, 1);
        reject(new Error("notification wait timed out"));
      }, timeout);
      timer.unref();
    });
  }
  // Simulate losing the gateway/SSH connection without a graceful shutdown: the remote runtime must
  // survive a killed carrier process.
  kill() {
    try { this.child.kill("SIGKILL"); } catch {}
  }
  async stop() {
    if (!this.child || this.child.exitCode !== null) return;
    this.child.stdin.end();
    await new Promise((resolve) => {
      this.child.once("exit", resolve);
      const timer = setTimeout(() => { try { this.child.kill("SIGKILL"); } catch {} resolve(); }, 4000);
      timer.unref();
    });
  }
}

const ownerPid = (home) => {
  try { return Number(readFileSync(join(home, "pocket-owner"), "utf8")); } catch { return NaN; }
};
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
};

test("a running DSH turn survives the gateway connection and reattaches without duplicate input", { skip: !installed && "install dsh/node_modules with npm ci --prefix dsh" }, async () => {
  const home = mkdtempSync(join(tmpdir(), "pocket-dsh-life-"));
  const fake = await startHeldEndpoint();
  writeFileSync(join(home, "settings.yaml"), `llm-deepseek:\n  baseURL: http://127.0.0.1:${fake.port}\n`, { mode: 0o600 });
  let first;
  let second;
  try {
    first = new Connection(home);
    await first.start();
    const started = (await first.call("thread/start", { cwd: home })).result;
    const threadId = started.thread.id;
    const startedNotice = first.waitFor((message) => message.method === "turn/started" && message.params.threadId === threadId);
    await first.call("turn/start", { threadId, requestId: "req-1", input: [{ type: "text", text: "hold" }] });
    await startedNotice;
    const daemonPid = ownerPid(home);
    assert.equal(alive(daemonPid), true, "the runtime owns the home");

    // The gateway connection dies hard while the model stream is still open.
    first.kill();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(alive(daemonPid), true, "the runtime survives the lost connection");
    assert.equal(ownerPid(home), daemonPid, "reattach reuses the same runtime owner");

    // A new gateway connection attaches to the same runtime and recovers the in-flight turn.
    second = new Connection(home);
    await second.start();
    const completed = second.waitFor((message) => message.method === "turn/completed" && message.params.threadId === threadId, 60000);
    const read = (await second.call("thread/read", { threadId, includeTurns: true })).result.thread;
    assert.equal(read.turns.length, 1, "the same turn is still the only turn");
    assert.equal(read.turns[0].status, "inProgress", "the accepted turn is still running");
    fake.releaseAll();
    await completed;

    const full = (await second.call("thread/read", { threadId, includeTurns: true })).result.thread;
    const userTexts = full.turns.flatMap((turn) => turn.items).filter((item) => item.type === "userMessage").length;
    assert.equal(full.turns.length, 1, "reconnection did not create a second turn");
    assert.equal(userTexts, 1, "the input was never duplicated");
    assert.equal((await second.call("thread/read", { threadId, includeTurns: true })).result.thread.turns[0].status, "completed");
  } finally {
    await first?.stop();
    await second?.stop();
    // The daemon is detached; stop it explicitly so the isolated home is not left running.
    const pid = ownerPid(home);
    if (alive(pid)) { try { process.kill(pid, "SIGTERM"); } catch {} }
    fake.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("explicit Stop interrupts the intended turn on the durable runtime", { skip: !installed && "install dsh/node_modules with npm ci --prefix dsh" }, async () => {
  const home = mkdtempSync(join(tmpdir(), "pocket-dsh-stop-"));
  const fake = await startHeldEndpoint();
  writeFileSync(join(home, "settings.yaml"), `llm-deepseek:\n  baseURL: http://127.0.0.1:${fake.port}\n`, { mode: 0o600 });
  let connection;
  try {
    connection = new Connection(home);
    await connection.start();
    const started = (await connection.call("thread/start", { cwd: home })).result;
    const threadId = started.thread.id;
    const turnNotice = connection.waitFor((message) => message.method === "turn/started" && message.params.threadId === threadId);
    await connection.call("turn/start", { threadId, requestId: "req-1", input: [{ type: "text", text: "stop me" }] });
    const active = await turnNotice;
    const turnId = String(active.params.turn.id);
    const completed = connection.waitFor((message) => message.method === "turn/completed" && message.params.threadId === threadId);
    await connection.call("turn/interrupt", { threadId, turnId });
    const done = await completed;
    assert.equal(done.params.turn.status, "interrupted");
    fake.releaseAll();
  } finally {
    await connection?.stop();
    const pid = ownerPid(home);
    if (alive(pid)) { try { process.kill(pid, "SIGTERM"); } catch {} }
    fake.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a runtime that owns the home refuses a duplicate owner", { skip: !installed && "install dsh/node_modules with npm ci --prefix dsh" }, async () => {
  const home = mkdtempSync(join(tmpdir(), "pocket-dsh-owner-"));
  const fake = await startHeldEndpoint();
  writeFileSync(join(home, "settings.yaml"), `llm-deepseek:\n  baseURL: http://127.0.0.1:${fake.port}\n`, { mode: 0o600 });
  let first;
  let second;
  try {
    first = new Connection(home);
    await first.start();
    const daemonPid = ownerPid(home);
    second = new Connection(home);
    await second.start();
    assert.equal(ownerPid(home), daemonPid, "a second attach reuses the existing runtime");
    const victims = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "dsh/runtime.mjs")], {
      env: { ...process.env, POCKET_DSH_HOME: home, DEEPSEEK_API_KEY: "sk-dummy-test-key-000000000000" },
      stdio: "ignore",
    });
    await new Promise((resolve) => victims.once("exit", resolve));
    assert.equal(ownerPid(home), daemonPid, "a racing runtime exits without stealing ownership");
  } finally {
    await first?.stop();
    await second?.stop();
    const pid = ownerPid(home);
    if (alive(pid)) { try { process.kill(pid, "SIGTERM"); } catch {} }
    fake.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("status inspection and idle-only stop never evict the attached gateway", { skip: !installed && "install dsh/node_modules with npm ci --prefix dsh" }, async () => {
  const home = mkdtempSync(join(tmpdir(), "pocket-dsh-inspect-"));
  const fake = await startQuestionEndpoint();
  writeFileSync(join(home, "settings.yaml"), `llm-deepseek:\n  baseURL: http://127.0.0.1:${fake.port}\n`, { mode: 0o600 });
  const runtime = join(ROOT, "dsh/runtime.mjs");
  const control = (mode) => spawnSync(process.execPath, [runtime, mode], {
    env: { ...process.env, POCKET_DSH_HOME: home, DEEPSEEK_API_KEY: "sk-dummy-test-key-000000000000" },
    encoding: "utf8",
    timeout: 10_000,
  });
  let connection;
  try {
    connection = new Connection(home);
    await connection.start();
    const started = (await connection.call("thread/start", { cwd: home })).result;
    const threadId = started.thread.id;
    const question = connection.waitFor((message) => message.method === "item/tool/requestUserInput");
    await connection.call("turn/start", { threadId, requestId: "q-1", input: [{ type: "text", text: "ask me" }] });
    const request = await question;

    // A deployment status check must not connect to the attach endpoint, so the gateway keeps its
    // connection and its pending question and the runtime reports itself busy.
    const status = control("--status");
    const reported = JSON.parse(status.stdout.trim());
    assert.equal(reported.ok, true, status.stderr);
    assert.equal(reported.result.busy, true);
    assert.equal(reported.result.attached, true);
    assert.equal(connection.received.filter((message) => message.method === "item/tool/requestUserInput").length, 1, "the question is not evicted or replayed");
    assert.equal((await connection.call("thread/read", { threadId, includeTurns: true })).result.thread.turns[0].status, "inProgress");

    // Idle-only shutdown refuses while the turn is active and leaves the connection working.
    const stopped = control("--stop");
    assert.notEqual(stopped.status, 0);
    assert.equal(JSON.parse(stopped.stdout.trim()).reason, "busy");
    assert.equal((await connection.call("thread/read", { threadId, includeTurns: true })).result.thread.turns[0].status, "inProgress");

    const completed = connection.waitFor((message) => message.method === "turn/completed" && message.params.threadId === threadId, 60000);
    connection.respond(request.id, { answers: { q1: { answers: ["A"] } } });
    await new Promise((resolve) => setTimeout(resolve, 600));
    fake.releaseAll();
    await completed;
  } finally {
    await connection?.stop();
    const pid = ownerPid(home);
    if (alive(pid)) { try { process.kill(pid, "SIGTERM"); } catch {} }
    fake.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a pending structured question stays pending and is replayed after reattach", { skip: !installed && "install dsh/node_modules with npm ci --prefix dsh" }, async () => {
  const home = mkdtempSync(join(tmpdir(), "pocket-dsh-question-"));
  const fake = await startQuestionEndpoint();
  writeFileSync(join(home, "settings.yaml"), `llm-deepseek:\n  baseURL: http://127.0.0.1:${fake.port}\n`, { mode: 0o600 });
  let first;
  let second;
  try {
    first = new Connection(home);
    await first.start();
    const started = (await first.call("thread/start", { cwd: home })).result;
    const threadId = started.thread.id;
    const questionA = first.waitFor((message) => message.method === "item/tool/requestUserInput");
    await first.call("turn/start", { threadId, requestId: "q-1", input: [{ type: "text", text: "ask me" }] });
    const requestA = await questionA;
    assert.ok(requestA.id !== undefined, "the question is a server request");
    assert.equal(requestA.params.isBlocking, true);
    // The UI disconnects without answering: the question must remain pending, never auto-approved.
    first.kill();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    second = new Connection(home);
    await second.start();
    const replayed = await second.waitFor((message) => message.method === "item/tool/requestUserInput");
    assert.equal(replayed.id, requestA.id, "the same pending request identity is replayed");
    const mid = (await second.call("thread/read", { threadId, includeTurns: true })).result.thread;
    assert.equal(mid.turns[0].status, "inProgress", "the turn waits on the unanswered question");
    const completed = second.waitFor((message) => message.method === "turn/completed" && message.params.threadId === threadId, 60000);
    second.respond(replayed.id, { answers: { q1: { answers: ["A"] } } });
    await new Promise((resolve) => setTimeout(resolve, 600));
    fake.releaseAll();
    await completed;
    const full = (await second.call("thread/read", { threadId, includeTurns: true })).result.thread;
    assert.equal(full.turns.length, 1, "answering the replayed question continued the same turn");
  } finally {
    await first?.stop();
    await second?.stop();
    const pid = ownerPid(home);
    if (alive(pid)) { try { process.kill(pid, "SIGTERM"); } catch {} }
    fake.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});
