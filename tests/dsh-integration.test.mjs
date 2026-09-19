// Destructive/transactional DSH bridge coverage against one isolated real DSH
// process and a local fake Messages endpoint. Skips when the separately locked
// DSH dependencies are not installed. No credentials, no external network.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { deflateSync } from "node:zlib";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DSH_BIN = join(ROOT, "dsh/node_modules/@deepseek-ai/dsh/package.json");
const LAUNCHER = join(ROOT, "dsh/launch.mjs");

// A minimal valid 8x8 red PNG, generated rather than copied so the test keeps
// a real image through the same admission/normalization path Pocket uses.
function tinyPng() {
  let table;
  const crc32 = (buf) => {
    if (!table) {
      table = [];
      for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
      }
    }
    let c = 0xffffffff;
    for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([len, typed, crc]);
  };
  const width = 8;
  const height = 8;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * (width * 3 + 1) + 1 + x * 3;
      raw[at] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

function startFakeEndpoint() {
  const bodies = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      if (request.url.endsWith("/messages")) {
        try { bodies.push(JSON.parse(raw)); } catch { bodies.push(null); }
        const events = [
          ["message_start", { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } }],
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "canned reply" } }],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }],
          ["message_stop", { type: "message_stop" }],
        ];
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(events.map(([name, event]) => `event: ${name}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { type: "not_found_error", message: "unsupported" } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, bodies }));
  });
}

class BridgeDriver {
  constructor(home) {
    this.home = home;
    this.buffer = "";
    this.pending = new Map();
    this.waiters = [];
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
  call(method, params = {}, timeout = 30000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`${method} timed out${this.stderr ? `: ${this.stderr.slice(-300)}` : ""}`));
      }, timeout);
      timer.unref();
    });
  }
  waitFor(match, timeout = 30000) {
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
  async stop() {
    if (!this.child) return;
    this.child.stdin.end();
    await new Promise((resolve) => {
      this.child.once("exit", resolve);
      const timer = setTimeout(() => { this.child.kill("SIGKILL"); resolve(); }, 4000);
      timer.unref();
    });
  }
}

const installed = existsSync(DSH_BIN);

// The durable machine-side runtime outlives a carrier; stopping it explicitly gives the next
// driver a genuinely fresh DSH process, which is what these persistence checks want to observe.
function stopRuntime(home) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "dsh/runtime.mjs"), "--stop"], {
      env: { ...process.env, POCKET_DSH_HOME: home, DEEPSEEK_API_KEY: "sk-dummy-test-key-000000000000" },
      stdio: "ignore",
    });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve(); }, 5000);
    timer.unref();
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

test("a persisted DSH task deletes for real and a Project Folder relocation preserves history", { skip: !installed && "install dsh/node_modules with npm ci --prefix dsh" }, async () => {
  const home = mkdtempSync(join(tmpdir(), "pocket-dsh-it-"));
  const projectA = join(home, "project-a");
  const projectB = join(home, "project-b");
  mkdirSync(projectA, { recursive: true });
  mkdirSync(projectB, { recursive: true });
  const fake = await startFakeEndpoint();
  writeFileSync(join(home, "settings.yaml"), `llm-deepseek:\n  baseURL: http://127.0.0.1:${fake.port}\n`, { mode: 0o600 });
  const png = tinyPng();
  let first;
  let second;
  try {
    first = new BridgeDriver(home);
    await first.start();
    const started = (await first.call("thread/start", { cwd: projectA })).result;
    const originalId = started.thread.id;
    assert.equal(started.thread.cwd, projectA);
    await first.call("thread/name/set", { threadId: originalId, name: "Relocate Me" });

    for (const [index, text] of [[1, "first"], [2, "second"]]) {
      const completed = first.waitFor((message) => message.method === "turn/completed" && message.params.threadId === originalId, 45000);
      const input = index === 1
        ? [{ type: "text", text }, { type: "image", url: `data:image/png;base64,${png}` }]
        : [{ type: "text", text }];
      const result = await first.call("turn/start", { threadId: originalId, requestId: `req-${index}`, input });
      assert.equal(result.error, undefined, JSON.stringify(result.error));
      await completed;
    }

    // Bounded turn/item history with cursors rather than the whole session.
    const turnsPage = (await first.call("thread/turns/list", { threadId: originalId, cursor: null, limit: 1, sortDirection: "desc", itemsView: "summary" })).result;
    assert.equal(turnsPage.data.length, 1);
    assert.ok(turnsPage.nextCursor, "turn page carries a cursor");
    assert.equal("items" in turnsPage.data[0], false, "summary omits items");
    const olderTurns = (await first.call("thread/turns/list", { threadId: originalId, cursor: turnsPage.nextCursor, limit: 1, sortDirection: "desc", itemsView: "summary" })).result;
    assert.equal(olderTurns.data.length, 1);
    assert.notEqual(olderTurns.data[0].id, turnsPage.data[0].id);
    const itemsPage = (await first.call("thread/items/list", { threadId: originalId, cursor: null, limit: 1, sortDirection: "asc" })).result;
    assert.equal(itemsPage.data.length, 1);
    assert.ok(itemsPage.nextCursor, "item page carries a cursor");
    const olderItems = (await first.call("thread/items/list", { threadId: originalId, cursor: itemsPage.nextCursor, limit: 1, sortDirection: "asc" })).result;
    assert.equal(olderItems.data.length, 1);

    // A persisted user image reads back through DSH's session attachment API.
    const full = (await first.call("thread/read", { threadId: originalId, includeTurns: true })).result.thread;
    const imageContent = full.turns.flatMap((turn) => turn.items)
      .find((item) => item.type === "userMessage" && item.content?.some((part) => part.type === "image"))
      ?.content.find((part) => part.type === "image");
    assert.ok(imageContent?.attachment?.attachmentId, "image is a durable attachment");
    const stored = (await first.call("pocket/attachment", { threadId: originalId, attachmentId: imageContent.attachment.attachmentId })).result;
    assert.equal(stored.mimeType, "image/png");
    assert.equal(stored.data, png);

    // Non-default access and effort must ride the seeded prefix too.
    const presetChange = await first.call("thread/settings/update", { threadId: originalId, permissions: ":danger-full-access", approvalPolicy: "never", effort: "low" });
    assert.equal(presetChange.error, undefined, JSON.stringify(presetChange.error));

    // Relocation: replacement created and verified, original removed, new id adopted.
    const relocationWaiter = first.waitFor((message) => message.method === "thread/settings/updated" && message.params.relocatedFrom === originalId, 30000);
    const relocationResponse = await first.call("thread/settings/update", { threadId: originalId, cwd: projectB });
    assert.equal(relocationResponse.error, undefined, JSON.stringify(relocationResponse.error));
    const relocated = (await relocationWaiter).params;
    const relocatedId = relocated.threadId;
    assert.notEqual(relocatedId, originalId);
    assert.equal(relocated.threadSettings.cwd, projectB);
    assert.equal(relocated.threadSettings.activePermissionProfile.id, ":danger-full-access");
    assert.equal(relocated.threadSettings.reasoningEffort, "low");
    const replacement = (await first.call("thread/read", { threadId: relocatedId, includeTurns: true })).result.thread;
    assert.equal(replacement.cwd, projectB);
    assert.equal(replacement.name, "Relocate Me");
    assert.equal(replacement.turns.length, full.turns.length);
    const liveList = (await first.call("thread/list", {})).result.data.map((task) => task.id);
    assert.equal(liveList.includes(originalId), false);
    assert.equal(liveList.includes(relocatedId), true);

    // The replacement keeps running with the preserved live selection, not just
    // a matching event log: the next model request carries the low effort.
    const relocatedTurn = first.waitFor((message) => message.method === "turn/completed" && message.params.threadId === relocatedId, 45000);
    await first.call("turn/start", { threadId: relocatedId, requestId: "req-3", input: [{ type: "text", text: "after relocation" }] });
    await relocatedTurn;
    const lastBody = fake.bodies.at(-1);
    assert.equal(lastBody.model, "deepseek-flash");
    assert.equal(lastBody.output_config?.effort, "low", JSON.stringify(lastBody.output_config));

    // Delete removes the persisted session, not a tombstone.
    const deleted = await first.call("thread/delete", { threadId: relocatedId });
    assert.equal(deleted.error, undefined, JSON.stringify(deleted.error));
    assert.ok((await first.call("thread/read", { threadId: relocatedId })).error, "deleted session is gone");
    assert.deepEqual((await first.call("thread/list", {})).result.data, []);
    await first.stop();
    first = null;
    await stopRuntime(home);

    // A fresh DSH process must not resurrect it.
    second = new BridgeDriver(home);
    await second.start();
    assert.deepEqual((await second.call("thread/list", {})).result.data, []);
  } finally {
    await first?.stop();
    await second?.stop();
    await stopRuntime(home);
    fake.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a forced relocation failure leaves the original DSH task intact", { skip: !installed && "install dsh/node_modules with npm ci --prefix dsh" }, async () => {
  const home = mkdtempSync(join(tmpdir(), "pocket-dsh-it-fail-"));
  const projectA = join(home, "project-a");
  const projectB = join(home, "project-b");
  mkdirSync(projectA, { recursive: true });
  mkdirSync(projectB, { recursive: true });
  const fake = await startFakeEndpoint();
  writeFileSync(join(home, "settings.yaml"), `llm-deepseek:\n  baseURL: http://127.0.0.1:${fake.port}\n`, { mode: 0o600 });
  let driver;
  try {
    driver = new BridgeDriver(home);
    await driver.start();
    const started = (await driver.call("thread/start", { cwd: projectA })).result;
    const originalId = started.thread.id;
    await driver.call("thread/name/set", { threadId: originalId, name: "Stays Put" });
    const completed = driver.waitFor((message) => message.method === "turn/completed" && message.params.threadId === originalId, 45000);
    await driver.call("turn/start", { threadId: originalId, requestId: "req-1", input: [{ type: "text", text: "hello" }] });
    await completed;

    // An invalid folder is rejected before any replacement is created.
    const rejected = await driver.call("thread/settings/update", { threadId: originalId, cwd: "relative/folder" });
    assert.ok(rejected.error);
    let after = (await driver.call("thread/read", { threadId: originalId, includeTurns: true })).result.thread;
    assert.equal(after.id, originalId);
    assert.equal(after.cwd, projectA);

    // A valid folder plus an unsupported effort gets all the way to a live
    // replacement and then fails while applying its settings, exercising the
    // post-create rollback. The original task must still be the only one.
    const rolledBack = await driver.call("thread/settings/update", { threadId: originalId, cwd: projectB, effort: "not-a-real-effort" });
    assert.ok(rolledBack.error, "invalid effort is rejected");
    after = (await driver.call("thread/read", { threadId: originalId, includeTurns: true })).result.thread;
    assert.equal(after.id, originalId);
    assert.equal(after.cwd, projectA);
    assert.equal(after.name, "Stays Put");
    assert.equal(after.turns.length, 1);
    const tasks = (await driver.call("thread/list", {})).result.data.map((task) => task.id);
    assert.deepEqual(tasks, [originalId]);

    // The surviving original still runs.
    const followUp = driver.waitFor((message) => message.method === "turn/completed" && message.params.threadId === originalId, 45000);
    const followUpStart = await driver.call("turn/start", { threadId: originalId, requestId: "req-2", input: [{ type: "text", text: "still here" }] });
    assert.equal(followUpStart.error, undefined, JSON.stringify(followUpStart.error));
    await followUp;
  } finally {
    await driver?.stop();
    await stopRuntime(home);
    fake.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});
