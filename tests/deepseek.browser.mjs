import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { MachineRuntime } from '../gateway.ts';
const normal = new MachineRuntime({}, { id: 'local', name: 'Mac mini', ssh: null, provider: 'openai' }, () => {});
const fallback = new MachineRuntime({}, { id: 'local:deepseek', name: 'Mac mini', ssh: null, deepseek: true, provider: 'deepseek' }, () => {});
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
  if (url.pathname === '/api/settings') return json({ settings: { headless: false, lanEnabled: false, host: '127.0.0.1', port: 4173, pinConfigured: false, localName: 'Mac mini', machines: [], phoneUrls: [], deepseekEnabled: true, deepseekSupported: true }, effective: { host: '127.0.0.1', port: 4173, pinRequired: false }, restartRequired: true });
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

  // The top selector carries provider metadata without renaming the machine.
  assert.match(await page.locator('#destination-label').textContent(), /Mac mini\s*DeepSeek/);
  assert.equal(await page.locator('#destination-label .machine-provider-badge').textContent(), 'DeepSeek');
  assert.match(await page.locator('#machine').textContent(), /Mac mini/);
  assert.equal(await page.locator('#machine .machine-provider-badge').textContent(), 'DeepSeek');

  // Task switcher: provider first, then the host badge, names unchanged and identities separate.
  fallback.state.connected = true; fallback.state.connectionError = null;
  selected = fallback; push();
  await page.locator('#destination-button').click();
  await page.locator('.destination-group').first().waitFor();
  assert.deepEqual(await page.locator('#destination-list .machine-provider-badge').allTextContents(), ['OpenAI', 'DeepSeek']);
  assert.deepEqual(await page.locator('#destination-list .machine-host-badge').allTextContents(), ['Host', 'Host']);
  const headings = await page.locator('#destination-list .machine-toggle strong').allTextContents();
  assert.deepEqual(headings.map(text => text.replace(/\s+/g, ' ').trim()), ['Mac mini OpenAI Host', 'Mac mini DeepSeek Host']);
  assert.equal(headings.some(text => text.includes('·')), false);
  assert.deepEqual(await page.locator('.machine-toggle').evaluateAll(nodes => nodes.map(node => node.dataset.machineId)), ['local', 'local:deepseek']);
  // A provider name is searchable and stays accessible.
  await page.locator('#destination-search').fill('deepseek');
  await page.waitForFunction(() => document.querySelectorAll('.destination-group').length === 1);
  await page.locator('#destination-search').fill('');
  await page.waitForFunction(() => document.querySelectorAll('.destination-group').length === 2);
  // Narrow screens clip long names instead of overlapping the header controls.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.machine-toggle').first().waitFor();
  const overlap = await page.locator('.destination-group').first().evaluate(group => {
    const tag = group.querySelector('.machine-provider-badge');
    const controls = group.querySelector('.machine-header-controls');
    return tag.getBoundingClientRect().right - controls.getBoundingClientRect().left;
  });
  assert.ok(overlap <= 0, `provider badge overlaps controls by ${overlap}px`);
  await page.setViewportSize({ width: 1280, height: 844 });
  const newTaskButton = page.locator('.destination-group').last().locator('.machine-header-controls .icon-button[aria-label="New task"]');
  await newTaskButton.click();
  await page.locator('#new-task-dialog[open]').waitFor();
  assert.equal(await page.locator('#new-task-title').textContent(), 'New Task on Mac mini [DeepSeek]');
  await page.locator('#new-task-cancel').click();
  await page.locator('#destination-button').click();
  await page.waitForFunction(() => document.querySelector('#destination-button').getAttribute('aria-expanded') === 'false');

  // Settings exposes the macOS-only opt-in, and a pending change asks for a restart.
  await page.locator('#settings-button').click();
  await page.locator('#settings-screen:not([hidden])').waitFor();
  await page.locator('#settings-deepseek').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#settings-deepseek').isVisible(), true);
  assert.equal(await page.locator('#settings-deepseek-enabled').isChecked(), true);
  assert.equal(await page.locator('#settings-restart').isVisible(), true);
  assert.match(await page.locator('#settings-deepseek').textContent(), /~\/.codex-pocket\/secrets\/deepseek-api-key/);
  await page.locator('#settings-close').click();
  console.log('PASS: DeepSeek/OpenAI same-ID drafts stay separate; missing-key setup message is visible; no subscription quota is shown; provider badges carry OpenAI/DeepSeek without renaming, stay searchable, keep local/local:deepseek identities, avoid narrow-screen control overlap, and the Settings opt-in requests a restart');
} finally { await browser.close(); server.closeAllConnections(); for (const response of clients) response.end(); await new Promise(resolve => server.close(resolve)); }
