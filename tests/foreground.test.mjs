// Run with POCKET_TEST_BROWSER pointing to an installed Chromium/Edge executable.
// Uses the real browser app and native DOM without adding a browser-driver dependency.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

test("native controls and foreground transcript recovery", { skip: !process.env.POCKET_TEST_BROWSER }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pocket-foreground-"));
  const thread = { id: "fixture-task", name: "Fixture", cwd: "/fixture/project", status: "idle" };
  const machine = { id: "local", name: "Fixture Machine", provider: "openai", connected: true, catalogAvailable: true, tasks: [thread] };
  const message = (id, text, createdAt) => ({ id, text, createdAt, role: "assistant", complete: true });
  const selectedMessage = message("selected", "Selected answer before refresh", 100);
  let messages = [selectedMessage, ...Array.from({ length: 24 }, (_, i) => message(`m${i}`, `Paragraph ${i}: ${"Readable content. ".repeat(24)}`, 200 + i))];
  let liveMessages = [selectedMessage];
  const snapshot = () => ({ machineId: "local", machine: machine.name, provider: "openai", platform: "windows", connected: true,
    thread, threadStatus: "idle", phase: "done", pending: [], plan: [], activities: [], liveMessages,
    models: [], model: "fixture", reasoningEffort: "high", message: { allowed: true, mode: "start" }, machines: [machine],
    access: { mode: "full", choices: Object.fromEntries(["ask", "auto", "full"].map(k => [k, { available: true }])) } });
  const connections = new Set();
  const requests = [];
  let eventConnections = 0, historyReads = 0, blockedPage = null, pendingMaterialization = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://fixture");
    requests.push({ method: req.method, path: url.pathname });
    const json = value => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname === "/events") {
      eventConnections++;
      connections.add(res);
      req.on("close", () => connections.delete(res));
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
      res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
    } else if (url.pathname === "/api/auth") json({ required: false, authenticated: true });
    else if (url.pathname === "/api/state") json(snapshot());
    else if (url.pathname === "/api/settings") json({ settings: { localName: machine.name, machines: [] } });
    else if (url.pathname === "/api/machines") json({ machines: [machine] });
    else if (url.pathname === "/api/threads") json({ threads: [thread] });
    else if (url.pathname === "/api/navigation") json({ machines: [machine] });
    else if (url.pathname === "/api/history") {
      historyReads++;
      const pageMessages = structuredClone(messages);
      const cursor = url.searchParams.get("cursor");
      const nextCursor = pendingMaterialization ? null : cursor === null ? "older-1" : cursor === "older-1" ? "older-2" : null;
      const reply = () => { if (!res.destroyed) json({ machineId: "local", threadId: thread.id, turns: [{ id: "fixture-turn", messages: pageMessages, activities: [] }], nextCursor, pendingMaterialization }); };
      if (url.searchParams.get("cursor") === "blocked") blockedPage = reply;
      else reply();
    } else {
      try {
        const path = url.pathname === "/" ? "public/index.html" : url.pathname === "/vendor/markdown-it.min.js"
          ? "node_modules/markdown-it/dist/markdown-it.min.js" : `public${url.pathname}`;
        let body = readFileSync(new URL(`../${path}`, import.meta.url));
        if (url.pathname === "/app.js") body = Buffer.concat([body, Buffer.from("\nwindow.fixtureApp = { loadHistory, selectionHold, get nextCursor() { return nextCursor; }, get historyLoading() { return Boolean(historyRequest); } };\n")]);
        res.writeHead(200, { "Content-Type": path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html" });
        res.end(body);
      } catch { res.writeHead(404); res.end(); }
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const child = spawn(process.env.POCKET_TEST_BROWSER, ["--headless", "--disable-gpu", "--no-first-run", "--disable-background-networking", "--remote-debugging-port=0", `--user-data-dir=${dir}`], { stdio: ["ignore", "ignore", "pipe"] });
  let socket;
  t.after(async () => {
    socket?.close();
    child.kill();
    for (const res of connections) res.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (child.exitCode === null) await once(child, "exit");
    rmSync(dir, { recursive: true, force: true });
  });
  const debuggerUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Browser did not start")), 10000);
    child.on("error", reject);
    child.stderr.on("data", chunk => { const match = /DevTools listening on (ws:\/\/\S+)/.exec(String(chunk)); if (match) { clearTimeout(timer); resolve(match[1]); } });
  });
  const target = await (await fetch(`http://${new URL(debuggerUrl).host}/json/new?about:blank`, { method: "PUT" })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, "open");
  let id = 0;
  const pending = new Map(), exceptions = [];
  socket.addEventListener("message", ({ data }) => {
    const value = JSON.parse(data);
    if (value.method === "Runtime.exceptionThrown") exceptions.push(value.params.exceptionDetails);
    const p = pending.get(value.id);
    if (p) { pending.delete(value.id); clearTimeout(p.timer); value.error ? p.reject(new Error(value.error.message)) : p.resolve(value.result); }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${method} timed out`)); }, 5000);
    pending.set(requestId, { resolve, reject, timer });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  const evaluate = async expression => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const waitFor = async (condition, label) => {
    for (let i = 0; i < 100; i++) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
    throw new Error(`Timed out: ${label}; browser errors: ${JSON.stringify(exceptions)}`);
  };
  await call("Runtime.enable");
  await call("Page.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await call("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.fixtureVisibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { get: () => window.fixtureVisibility });
    document.addEventListener('selectionchange', e => { if (window.suppressSelectionChange) e.stopImmediatePropagation(); }, true);
    window.setFixtureVisibility = value => { window.fixtureVisibility = value; document.dispatchEvent(new Event('visibilitychange')); };
  ` });
  await call("Page.navigate", { url: `http://127.0.0.1:${server.address().port}` });
  await waitFor(() => evaluate("Boolean(window.fixtureApp && document.querySelector('[data-message-id=m23]'))"), "initial transcript");
  await waitFor(() => eventConnections >= 1, "initial SSE connection");
  await new Promise(resolve => setTimeout(resolve, 100));

  await t.test("foreground refresh preserves the deeper older-history cursor", async () => {
    assert.equal(await evaluate("fixtureApp.nextCursor"), "older-1", "initial history establishes pagination");
    await evaluate("fixtureApp.loadHistory(fixtureApp.nextCursor)");
    assert.equal(await evaluate("fixtureApp.nextCursor"), "older-2");
    const reads = historyReads;
    await evaluate("setFixtureVisibility('hidden'); setFixtureVisibility('visible')");
    await waitFor(() => historyReads === reads + 1, "recent history refresh");
    await waitFor(() => evaluate("!fixtureApp.historyLoading"), "recent history response");
    assert.equal(await evaluate("fixtureApp.nextCursor"), "older-2");
  });

  await t.test("foreground refresh keeps exhausted history exhausted", async () => {
    await evaluate("fixtureApp.loadHistory('older-2')");
    assert.equal(await evaluate("fixtureApp.nextCursor"), null);
    const reads = historyReads;
    await evaluate("setFixtureVisibility('hidden'); setFixtureVisibility('visible')");
    await waitFor(() => historyReads === reads + 1, "exhausted history refresh");
    await waitFor(() => evaluate("!fixtureApp.historyLoading"), "exhausted history response");
    assert.equal(await evaluate("fixtureApp.nextCursor"), null);
    await evaluate("document.scrollingElement.scrollTop = 0");
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(historyReads, reads + 1, "upward scrolling must not fetch already-loaded pages");
  });

  await t.test("Full Access warning stays on the native select, not its options; only the path is selectable", async () => {
    for (const theme of ["dark", "light"]) {
      const values = await evaluate(`(() => {
        document.documentElement.dataset.theme = '${theme}';
        const css = id => getComputedStyle(document.querySelector(id));
        return { native: document.querySelector('#access-select') instanceof HTMLSelectElement,
          warning: css('#access-select').color, option: css('#access-select option').color,
          text: css('#project').color, machine: css('#machine').userSelect, provider: css('#provider').userSelect,
          project: css('#project').userSelect, transcript: css('.message-body').userSelect, draft: css('#message-text').userSelect };
      })()`);
      assert.equal(values.native, true);
      assert.notEqual(values.warning, values.text);
      assert.equal(values.option, values.text);
      assert.deepEqual([values.machine, values.provider, values.project, values.transcript], ["none", "none", "text", "text"]);
    }
    await call("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "active" }] });
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#access-select')).appearance"), "auto");
    await call("Emulation.setEmulatedMedia", { features: [] });
  });

  await t.test("foreground replaces an OPEN but stale stream and preserves selection, draft and reading position", async () => {
    await evaluate(`(() => {
      const textarea = document.querySelector('#message-text'); textarea.value = 'Unsent draft'; textarea.dispatchEvent(new Event('input'));
      const node = document.querySelector('[data-message-id=selected] .message-body p').firstChild;
      const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 8);
      window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
      window.selectedNodeBefore = node; document.scrollingElement.scrollTop = 400;
    })()`);
    const top = await evaluate("document.scrollingElement.scrollTop");
    await waitFor(() => evaluate("fixtureApp.selectionHold.active"), "selection hold");
    await evaluate("setFixtureVisibility('hidden')");
    liveMessages = [];
    messages = [...messages.filter(m => m.id !== "selected"), message("selected", "Selected answer after refresh", 100), message("missed", "Durable content missed while away", 1000)];
    const count = eventConnections;
    await evaluate("setFixtureVisibility('visible')");
    await waitFor(() => evaluate("document.querySelector('#conversation').textContent.includes('Durable content missed while away')"), "fresh durable history");
    assert.equal(eventConnections, count + 1);
    assert.equal(await evaluate("window.getSelection().toString()"), "Selected");
    assert.equal(await evaluate("window.getSelection().anchorNode === selectedNodeBefore"), true);
    assert.equal(await evaluate("document.querySelector('#message-text').value"), "Unsent draft");
    assert.equal(await evaluate("document.scrollingElement.scrollTop"), top);
    await evaluate("window.getSelection().removeAllRanges()");
    await waitFor(() => evaluate("document.querySelector('[data-message-id=selected]').textContent.includes('after refresh')"), "deferred selection render");
  });

  await t.test("a native selection lost silently in the background releases its obsolete hold", async () => {
    await evaluate(`(() => {
      const node = document.querySelector('[data-message-id=selected] .message-body p').firstChild;
      const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 8);
      window.getSelection().addRange(range);
    })()`);
    await waitFor(() => evaluate("fixtureApp.selectionHold.active"), "second selection hold");
    const updated = message("selected", "Selection hold finally released", 100);
    liveMessages = [updated];
    messages = messages.map(m => m.id === "selected" ? updated : m);
    for (const res of connections) res.write(`event: message\ndata: ${JSON.stringify(updated)}\n\n`);
    await new Promise(resolve => setTimeout(resolve, 50));
    await evaluate("setFixtureVisibility('hidden'); suppressSelectionChange = true; window.getSelection().removeAllRanges()");
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(await evaluate("fixtureApp.selectionHold.active"), true);
    await evaluate("setFixtureVisibility('visible'); suppressSelectionChange = false");
    await waitFor(() => evaluate("document.querySelector('[data-message-id=selected]').textContent.includes('finally released')"), "obsolete hold release");
    assert.equal(await evaluate("fixtureApp.selectionHold.active"), false);
  });

  await t.test("foreground cancels a suspended history read; BFCache events do not open duplicate streams", async () => {
    await evaluate("void fixtureApp.loadHistory('blocked')");
    await waitFor(() => Boolean(blockedPage), "blocked page read");
    const reads = historyReads, count = eventConnections;
    await evaluate("setFixtureVisibility('hidden'); dispatchEvent(new PageTransitionEvent('pagehide')); fixtureVisibility = 'visible'; dispatchEvent(new PageTransitionEvent('pageshow', {persisted:true})); document.dispatchEvent(new Event('visibilitychange'))");
    await waitFor(() => eventConnections === count + 1, "BFCache reconnect");
    await new Promise(resolve => setTimeout(resolve, 50));
    await waitFor(() => historyReads === reads + 1, "replacement history read despite a hung old page");
    blockedPage(); blockedPage = null;
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(eventConnections, count + 1);
    assert.equal(historyReads, reads + 1);
  });

  await t.test("ordinary reconnect snapshots defer one history refresh until the current read finishes", async () => {
    await evaluate("void fixtureApp.loadHistory('blocked')");
    await waitFor(() => Boolean(blockedPage), "second blocked page read");
    const reads = historyReads;
    for (const res of connections) res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(historyReads, reads);
    blockedPage(); blockedPage = null;
    await waitFor(() => historyReads === reads + 1, "deferred one-shot history refresh");
  });

  await t.test("late history cannot overwrite a newer live update", async () => {
    await evaluate("void fixtureApp.loadHistory('blocked')");
    await waitFor(() => Boolean(blockedPage), "third blocked page read");
    const updated = message("selected", "Newer live update survives older history", 100);
    for (const res of connections) res.write(`event: message\ndata: ${JSON.stringify(updated)}\n\n`);
    await waitFor(() => evaluate("document.querySelector('[data-message-id=selected]').textContent.includes('Newer live update')"), "new live event");
    blockedPage(); blockedPage = null;
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await evaluate("document.querySelector('[data-message-id=selected]').textContent.includes('Newer live update')"), true);
  });

  await t.test("foreground history keeps the current viewport even when it was following the bottom", async () => {
    await evaluate("document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight");
    await new Promise(resolve => setTimeout(resolve, 50));
    const top = await evaluate("document.scrollingElement.scrollTop");
    await evaluate("setFixtureVisibility('hidden')");
    liveMessages = [];
    messages.push(message("new-bottom", "New background content. ".repeat(120), 2000));
    await evaluate("setFixtureVisibility('visible')");
    await waitFor(() => evaluate("Boolean(document.querySelector('[data-message-id=new-bottom]'))"), "new bottom content");
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await evaluate("document.scrollingElement.scrollTop"), top);
  });
  await t.test("a new task initializes pagination when its history finishes materializing", async () => {
    thread.id = "fixture-task-two";
    pendingMaterialization = true;
    const reads = historyReads;
    for (const res of connections) res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
    await waitFor(() => historyReads === reads + 1, "new task history");
    await waitFor(() => evaluate("!fixtureApp.historyLoading"), "pending history response");
    assert.equal(await evaluate("fixtureApp.nextCursor"), null);
    pendingMaterialization = false;
    await evaluate("fixtureApp.loadHistory()");
    assert.equal(await evaluate("fixtureApp.nextCursor"), "older-1");
  });
  assert.deepEqual(exceptions, []);
  assert.equal(requests.filter(r => r.method !== "GET").length, 0, "foreground recovery must never submit a mutation");
});
