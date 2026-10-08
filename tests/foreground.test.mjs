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
  const allTasks = [thread, ...Array.from({ length: 40 }, (_, i) => ({ id: `task-${i}`, name: `Task ${i}`, status: "idle", cwd: thread.cwd }))];
  let navigationTasks = allTasks, holdNavigation = false, queuedMessage = null;
  const navigationReplies = [];
  const snapshot = () => ({ machineId: "local", machine: machine.name, provider: "openai", platform: "windows", connected: true,
    thread, threadStatus: "idle", phase: "done", pending: [], plan: [], activities: [], liveMessages, queuedMessage,
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
    else if (url.pathname === "/api/navigation") {
      const value = structuredClone({ machines: [{ ...machine, tasks: navigationTasks }] });
      const reply = () => json(value);
      if (holdNavigation) navigationReplies.push(reply);
      else reply();
    }
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
        if (url.pathname === "/app.js") body = Buffer.concat([body, Buffer.from("\nwindow.fixtureApp = { loadHistory, selectionHold, refreshTaskSurface, get nextCursor() { return nextCursor; }, get historyLoading() { return Boolean(historyRequest); } };\n")]);
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

  await t.test("Tasks reopening and unchanged refreshes keep rows and scroll position", async () => {
    for (const width of [1280, 390]) {
      await call("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: width < 1100 });
      await evaluate("if (!document.body.classList.contains('destination-open')) document.querySelector('#tasks-toggle').click()");
      await waitFor(() => evaluate("document.querySelectorAll('.destination-task').length === 41 && !document.querySelector('#destination-refresh').disabled"), "task catalog");
      const top = await evaluate("document.querySelector('#destination-list').scrollTop = 350");
      await evaluate("window.savedTaskRow = document.querySelector('.destination-task'); document.querySelector('#tasks-toggle').click()");
      await waitFor(() => evaluate("document.querySelector('#destination-switcher').hidden"), "Tasks closed");
      holdNavigation = true;
      await evaluate("document.querySelector('#tasks-toggle').click()");
      await waitFor(() => navigationReplies.length === 1, "reopen refresh started");
      try {
        assert.equal(await evaluate("document.querySelector('.destination-task') === savedTaskRow"), true);
        assert.equal(await evaluate("document.querySelector('#destination-list').scrollTop"), top);
      } finally {
        holdNavigation = false;
        navigationReplies.shift()();
        await waitFor(() => evaluate("!document.querySelector('#destination-refresh').disabled"), "reopen refresh complete");
      }
      assert.equal(await evaluate("document.querySelector('.destination-task') === savedTaskRow"), true);
      assert.equal(await evaluate("document.querySelector('#destination-list').scrollTop"), top);
    }
  });

  await t.test("Tasks retain rows during reconnect refresh and keep scroll when updated tasks arrive", async () => {
    const top = await evaluate("document.querySelector('#destination-list').scrollTop");
    navigationTasks = [...allTasks.map(task => task.id === "task-2" ? { ...task, status: "active" } : task), { id: "added", name: "Added Task", status: "idle" }];
    holdNavigation = true;
    await evaluate("fixtureApp.refreshTaskSurface()");
    await waitFor(() => navigationReplies.length === 2, "both reconnect catalogs loading");
    try {
      assert.equal(await evaluate("document.querySelector('.destination-task') === savedTaskRow"), true);
      assert.equal(await evaluate("document.querySelectorAll('.destination-task').length"), 41);
    } finally {
      holdNavigation = false;
      navigationReplies.splice(0).forEach(reply => reply());
      await waitFor(() => evaluate("document.querySelectorAll('.destination-task').length === 42 && !document.querySelector('#destination-refresh').disabled"), "new task catalog");
    }
    assert.equal(await evaluate("document.querySelector('#destination-list').scrollTop"), top);
    assert.equal(await evaluate("document.querySelector('.destination-task[aria-current=true] .destination-task-text').textContent"), "Fixture");
    assert.equal(await evaluate("[...document.querySelectorAll('.destination-task')].find(row => row.querySelector('.destination-task-text').textContent === 'Task 2').querySelector('.destination-task-status').textContent"), "Working");
  });

  await t.test("Tasks search, expansion and shorter catalogs still clamp scroll normally", async () => {
    await evaluate("const search = document.querySelector('#destination-search'); search.value = 'Added Task'; search.dispatchEvent(new Event('input'))");
    assert.equal(await evaluate("document.querySelectorAll('.destination-task').length"), 1);
    assert.equal(await evaluate("document.querySelector('#destination-list').scrollTop"), 0);
    await evaluate("document.querySelector('#destination-search-clear').click(); document.querySelector('.machine-toggle').click()");
    await evaluate("document.querySelector('#destination-refresh').click()");
    await waitFor(() => evaluate("!document.querySelector('#destination-refresh').disabled"), "collapsed catalog refreshed");
    assert.equal(await evaluate("document.querySelector('.machine-toggle').getAttribute('aria-expanded')"), "false");
    await evaluate("document.querySelector('.machine-toggle').click(); document.querySelector('#destination-list').scrollTop = 350");
    navigationTasks = [thread];
    await evaluate("document.querySelector('#destination-refresh').click()");
    await waitFor(() => evaluate("document.querySelectorAll('.destination-task').length === 1 && !document.querySelector('#destination-refresh').disabled"), "shorter catalog");
    assert.equal(await evaluate("document.querySelector('#destination-list').scrollTop"), 0);
    await evaluate("document.querySelector('#destination-close').click()");
  });

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
  await t.test("Queued Next adapts compact geometry to attachments and keeps selectable text on mobile and desktop", async () => {
    const image = { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" };
    for (const width of [320, 390, 1280]) {
      await call("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: width < 1100 });
      for (const [images, files] of [[[image], [{ name: "notes.txt", size: 25 }]], [[image], []], [[], [{ name: "notes.txt", size: 25 }]], [[], []]]) {
        const text = `Queued text ${width}: ${images.length} images, ${files.length} files`;
        queuedMessage = { id: "queued", threadId: thread.id, text, images, files };
        for (const res of connections) res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
        await waitFor(() => evaluate(`document.querySelector('#queue-text').textContent === ${JSON.stringify(text)}`), "queued attachments rendered");
        const layout = await evaluate(`(() => {
          const card = document.querySelector('#queue-banner');
          const rect = node => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; };
          const css = getComputedStyle(card);
          return { order: [...card.children].map(node => node.id || node.tagName.toLowerCase()), card: rect(card),
            inset: ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce((sum, key) => sum + parseFloat(css[key]), 0), gap: parseFloat(css.rowGap),
            heading: rect(card.querySelector('strong')), actions: rect(card.querySelector('.queue-actions')),
            images: ${images.length} ? rect(card.querySelector('#queue-images')) : null,
            files: ${files.length} ? rect(card.querySelector('#queue-files')) : null,
            thumb: ${images.length} ? rect(card.querySelector('img')) : null, text: rect(card.querySelector('#queue-text')),
            selection: [getComputedStyle(card.querySelector('#queue-text')).userSelect,
              getComputedStyle(card.querySelector('#queue-text')).webkitUserSelect, getComputedStyle(card.querySelector('strong')).userSelect],
            editEnabled: !card.querySelector('#edit-queue').disabled, cancelEnabled: !card.querySelector('#cancel-queue').disabled,
            composerOrder: Boolean(document.querySelector('#composer-images').compareDocumentPosition(document.querySelector('#message-text')) & Node.DOCUMENT_POSITION_FOLLOWING)
              && Boolean(document.querySelector('#composer-files').compareDocumentPosition(document.querySelector('#message-text')) & Node.DOCUMENT_POSITION_FOLLOWING) };
        })()`);
        assert.deepEqual(layout.order, ["strong", "span", "queue-images", "queue-files", "queue-text"]);
        assert.deepEqual(layout.selection, ["text", "text", "none"]);
        const rows = [layout.images, layout.files, layout.text].filter(Boolean);
        const headerHeight = Math.max(layout.heading.height, layout.actions.height);
        let expectedHeight = headerHeight + layout.inset;
        if (images.length || files.length) {
          assert.ok(layout.gap <= 8, "attachment rows keep tight spacing");
          let previousBottom = Math.max(layout.heading.bottom, layout.actions.bottom);
          for (const row of rows) {
            assert.ok(Math.abs(row.top - previousBottom - layout.gap) <= 1, "visible rows are consecutive without empty tracks");
            previousBottom = row.bottom;
          }
          expectedHeight += rows.reduce((sum, row) => sum + row.height, 0) + layout.gap * rows.length;
        } else {
          const center = row => row.top + row.height / 2;
          assert.ok(Math.abs(center(layout.heading) - center(layout.text)) <= 1, "text-only preview shares the heading row");
          assert.ok(Math.abs(center(layout.actions) - center(layout.text)) <= 1, "text-only actions share the preview row");
          assert.ok(layout.heading.right <= layout.text.left && layout.text.right <= layout.actions.left);
          assert.ok(layout.text.width > 0, "narrow text-only previews retain available space");
          assert.ok(layout.card.height <= 48, "text-only card is no taller than one action row plus its insets");
        }
        assert.ok(Math.abs(layout.card.height - expectedHeight) <= 1, "card height contains only visible rows, gaps and insets");
        if (layout.thumb) assert.deepEqual([layout.thumb.width, layout.thumb.height], [36, 36]);
        assert.equal(layout.editEnabled && layout.cancelEnabled && layout.composerOrder, true);
      }
    }
    await evaluate("document.querySelector('#cancel-queue').click()");
    assert.equal(await evaluate("document.querySelector('#queue-dialog').open"), true);
    await evaluate("document.querySelector('#queue-dialog-cancel').click()");
    queuedMessage = null;
    for (const res of connections) res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
  });
  assert.deepEqual(exceptions, []);
  assert.equal(requests.filter(r => r.method !== "GET").length, 0, "foreground recovery must never submit a mutation");
});
