import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { MachineRuntime } from '../gateway.ts';
const normal = new MachineRuntime({}, { id: 'local', name: 'Mac mini', ssh: null }, () => {});
const fallback = new MachineRuntime({}, { id: 'local:deepseek', name: 'Mac mini · DeepSeek', ssh: null, deepseek: true }, () => {});
const task = { id: 'same-thread', name: 'Same task ID', cwd: '/disposable', status: 'idle' };
for (const runtime of [normal, fallback]) {
  Object.assign(runtime.state, { connected: true, thread: task, threadStatus: 'idle', phase: 'ready', model: runtime === fallback ? 'deepseek-flash' : 'openai-model' });
  runtime.canAcceptDirectInput = true; runtime.rpc = {};
}
let selected = normal;
const clients = new Set();
const snapshot = () => ({ ...selected.snapshot(), quota: { available: false, windows: [] }, submissionEpoch: selected === normal ? 'normal' : 'deepseek' });
const push = () => { for (const response of clients) response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`); };
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const json = value => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
  if (url.pathname === '/events') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }); clients.add(response); push();
    request.on('close', () => clients.delete(response)); return;
  }
  if (url.pathname === '/api/state') return json(snapshot());
  if (url.pathname === '/api/navigation') return json({ machines: [normal, fallback].map(r => ({ ...r.machineSummary(), local: true, catalogAvailable: r.state.connected, tasks: r.state.connected ? [task] : [] })) });
  if (url.pathname === '/api/history') return json({ machineId: selected.state.machineId, threadId: task.id, turns: [], nextCursor: null });
  if (url.pathname === '/api/machines') return json({ machines: [normal.machineSummary(), fallback.machineSummary()] });
  if (url.pathname.startsWith('/api/')) return json({});
  try {
    const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (path.includes('..')) throw Error('Invalid path');
    const body = await readFile(new URL(path === 'vendor/markdown-it.min.js' ? '../node_modules/markdown-it/dist/markdown-it.min.js' : '../public/' + path, import.meta.url));
    response.writeHead(200, { 'Content-Type': path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.html') ? 'text/html' : 'image/svg+xml' }); response.end(body);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const input = page.locator('#message-text');
  await input.fill('OpenAI draft');
  selected = fallback; push();
  await page.waitForFunction(() => document.querySelector('#message-text').value === '');
  await input.fill('DeepSeek draft');
  selected = normal; push();
  await page.waitForFunction(() => document.querySelector('#message-text').value === 'OpenAI draft');
  selected = fallback; push();
  await page.waitForFunction(() => document.querySelector('#message-text').value === 'DeepSeek draft');
  fallback.state.connected = false;
  fallback.state.connectionError = 'DeepSeek needs DEEPSEEK_API_KEY in the Pocket host environment.';
  push();
  await page.getByText(fallback.state.connectionError, { exact: true }).first().waitFor();
  assert.match(await page.locator('#quota-chip').textContent(), /—/);
  assert.equal(await input.inputValue(), 'DeepSeek draft');
  console.log('PASS: DeepSeek/OpenAI same-ID drafts stay separate; missing-key setup message is visible; no subscription quota is shown');
} finally { await browser.close(); server.closeAllConnections(); for (const response of clients) response.end(); await new Promise(resolve => server.close(resolve)); }
