import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { MachineRuntime } from '../gateway.ts';

// Two providers on one physical Mac mini, plus an OpenAI-only SSH machine.
const normal = new MachineRuntime({}, { id: 'local', name: 'Mac mini', ssh: null, provider: 'openai', group: 'local' }, () => {});
const fallback = new MachineRuntime({}, { id: 'local:deepseek', name: 'Mac mini', ssh: null, deepseek: true, provider: 'deepseek', group: 'local' }, () => {});
const remote = new MachineRuntime({}, { id: 'ssh:test', name: 'Test machine', ssh: 'test', provider: 'openai', group: 'ssh:test' }, () => {});
const task = { id: 'same-thread', name: 'Same task ID', cwd: '/disposable', status: 'idle' };
for (const runtime of [normal, fallback, remote]) {
  Object.assign(runtime.state, { connected: true, thread: task, threadStatus: 'idle', phase: 'ready', model: runtime === fallback ? 'deepseek-flash' : 'gpt-x' });
  runtime.state.access = { mode: 'ask', choices: { ask: { available: true }, auto: { available: runtime !== fallback }, full: { available: true } } };
  runtime.canAcceptDirectInput = true; runtime.rpc = {};
}
const OPTIONS = {
  local: { models: [{ model: 'gpt-x', displayName: 'GPT-X', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'low' }], current: { model: 'gpt-x', effort: 'low', access: 'ask' }, access: { ask: true, auto: true, full: true } },
  'local:deepseek': { models: [{ model: 'deepseek-flash', displayName: 'DeepSeek-Flash', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }, { reasoningEffort: 'max' }], defaultReasoningEffort: 'high' }], current: { model: 'deepseek-flash', effort: 'high', access: 'ask' }, access: { ask: true, auto: false, full: true } },
  'ssh:test': { models: [{ model: 'gpt-a', displayName: 'GPT-A', supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low' }, { model: 'gpt-b', displayName: 'GPT-B', supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high' }], current: { model: 'gpt-a', effort: 'low', access: 'ask' }, access: { ask: true, auto: true, full: true } },
};
let selected = normal;
const clients = new Set();
const selections = [];
const snapshot = () => ({ ...selected.snapshot(), quota: { available: false, windows: [] }, submissionEpoch: selected === normal ? 'normal' : selected.state.machineId });
const push = () => { for (const response of clients) response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`); };
const readBody = request => new Promise(resolve => { let text = ''; request.on('data', chunk => { text += chunk; }); request.on('end', () => resolve(text)); });
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const json = value => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
  if (url.pathname === '/events') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }); clients.add(response); push();
    request.on('close', () => clients.delete(response)); return;
  }
  if (url.pathname === '/api/state') return json(snapshot());
  if (url.pathname === '/api/navigation') return json({ machines: [normal, fallback, remote].map(r => ({ ...r.machineSummary(), local: r.state.machineId !== 'ssh:test', catalogAvailable: r.state.connected, tasks: r.state.connected ? [task] : [] })) });
  if (url.pathname === '/api/history') return json({ machineId: selected.state.machineId, threadId: task.id, turns: [], nextCursor: null });
  if (url.pathname === '/api/machines') return json({ machines: [normal, fallback, remote].map(r => r.machineSummary()) });
  if (url.pathname === '/api/tasks/options') return json(OPTIONS[url.searchParams.get('machineId')] || OPTIONS.local);
  if (url.pathname === '/api/navigation/select') {
    const body = JSON.parse(await readBody(request) || '{}');
    selections.push({ machineId: body.machineId, threadId: body.threadId, expectedMachineId: body.expectedMachineId });
    selected = [normal, fallback, remote].find(runtime => runtime.state.machineId === body.machineId) || selected;
    push();
    return json({ ...snapshot(), machineId: body.machineId, thread: task });
  }
  if (url.pathname === '/api/settings') return json({ settings: { headless: false, lanEnabled: false, host: '127.0.0.1', port: 4173, pinConfigured: true, localName: 'Mac mini', machines: [], phoneUrls: [], deepseekEnabled: true, deepseekSupported: true }, effective: { host: '127.0.0.1', port: 4173, pinRequired: false }, restartRequired: true });
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
  // Task Details is an overlay on mobile; start it closed so the topbar stays clickable.
  await page.addInitScript(() => { try { localStorage.setItem('codex-pocket-details-open', 'false'); } catch {} });
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
  assert.match(await page.locator('#quota-chip').textContent(), /—/);
  assert.equal(await input.inputValue(), 'DeepSeek draft');

  // Task Details and the top selector name the provider as metadata, never inside the machine name.
  assert.match(await page.locator('#destination-label').textContent(), /Mac mini\s*DeepSeek/);
  assert.equal(await page.locator('#destination-label .machine-provider-badge').textContent(), 'DeepSeek');
  assert.equal(await page.locator('#machine .machine-provider-badge').textContent(), 'DeepSeek');
  assert.equal(await page.locator('#provider').textContent(), 'DeepSeek');
  // Unsupported access modes are omitted entirely, not shown as disabled "unavailable" entries.
  assert.deepEqual(await page.locator('#access-select option').allTextContents(), ['Ask for Approval', 'Full Access']);

  // One physical machine group: name + [Host] only, no provider badge in the header.
  const openSwitcher = async () => {
    if (await page.locator('#destination-button').getAttribute('aria-expanded') !== 'true') await page.locator('#destination-button').click();
    await page.locator('.destination-group').first().waitFor();
  };
  const closeSwitcher = async () => {
    if (await page.locator('#destination-button').getAttribute('aria-expanded') === 'true') await page.locator('#destination-button').click();
    await page.waitForFunction(() => document.querySelector('#destination-button').getAttribute('aria-expanded') === 'false');
  };
  await openSwitcher();
  assert.equal(await page.locator('.destination-group').count(), 2, 'Mac mini and the SSH machine');
  const hostGroup = page.locator('.destination-group').first();
  assert.equal((await hostGroup.locator('.machine-toggle').textContent()).trim(), 'Mac miniHost');
  assert.equal(await hostGroup.locator('.destination-group-heading .machine-provider-badge').count(), 0);
  assert.equal(await hostGroup.locator('.machine-host-badge').textContent(), 'Host');
  assert.deepEqual(await hostGroup.locator('.machine-toggle').evaluateAll(nodes => nodes.map(node => node.dataset.machineId)), ['local']);

  // Task rows keep both providers distinguishable, with identical names.
  const rows = hostGroup.locator('.destination-entry');
  assert.equal(await rows.count(), 2);
  assert.deepEqual(await rows.locator('.destination-task-text').allTextContents(), ['Same task ID', 'Same task ID']);
  assert.deepEqual(await rows.locator('.task-provider-badge').allTextContents(), ['OpenAI', 'DeepSeek']);
  // The OpenAI-only machine keeps its rows free of redundant provider badges.
  assert.equal(await page.locator('.destination-group').nth(1).locator('.task-provider-badge').count(), 0);

  // Identical names still select their own runtime identity.
  selections.length = 0;
  await rows.nth(0).locator('.destination-task').click();
  await page.waitForFunction(() => document.querySelector('#destination-label').textContent.includes('OpenAI'));
  assert.deepEqual(selections.at(-1), { machineId: 'local', threadId: 'same-thread', expectedMachineId: 'local:deepseek' });
  assert.deepEqual(await page.locator('#access-select option').allTextContents(), ['Ask for Approval', 'Approve for Me', 'Full Access']);
  await hostGroup.locator('.destination-entry').nth(1).locator('.destination-task').click();
  await page.waitForFunction(() => document.querySelector('#destination-label').textContent.includes('DeepSeek'));
  assert.equal(selections.at(-1).machineId, 'local:deepseek');
  assert.equal(selections.at(-1).expectedMachineId, 'local');

  // Search matches the provider name.
  await page.locator('#destination-search').fill('deepseek');
  await page.waitForFunction(() => document.querySelectorAll('.destination-group').length === 1);
  await page.locator('#destination-search').fill('');
  await page.waitForFunction(() => document.querySelectorAll('.destination-group').length === 2);

  // New Task: one dialog, machine-only title, provider picker only for a multi-runtime machine.
  await page.locator('.destination-group').first().locator('.machine-header-controls .icon-button[aria-label="New task"]').click();
  await page.locator('#new-task-dialog[open]').waitFor();
  assert.equal(await page.locator('#new-task-title').textContent(), 'New Task on Mac mini');
  const providerSelect = page.locator('#new-task-provider');
  await page.locator('#new-task-model-static').waitFor();
  assert.equal(await providerSelect.inputValue(), 'local:deepseek', 'defaults to the selected task provider');
  assert.deepEqual(await providerSelect.locator('option').allTextContents(), ['OpenAI', 'DeepSeek']);
  // DeepSeek options: one model reads as a value, effort uses plain names, access omits Auto.
  assert.equal(await page.locator('#new-task-model-static').textContent(), 'DeepSeek-Flash');
  assert.equal(await page.locator('#new-task-model').count(), 0);
  assert.deepEqual(await page.locator('#new-task-effort option').allTextContents(), ['Low', 'High', 'Max']);
  assert.deepEqual(await page.locator('#new-task-access option').allTextContents(), ['Ask for Approval', 'Full Access']);
  // Switching provider refreshes model, effort and access from that runtime's own options.
  await providerSelect.selectOption('local');
  await page.locator('#new-task-model-static').filter({ hasText: 'GPT-X' }).waitFor();
  assert.deepEqual(await page.locator('#new-task-effort option').allTextContents(), ['Low', 'High']);
  assert.deepEqual(await page.locator('#new-task-access option').allTextContents(), ['Ask for Approval', 'Approve for Me', 'Full Access']);
  await page.locator('#new-task-cancel').click();

  // A single-provider machine hides the provider picker; a multi-model provider keeps a select.
  await openSwitcher();
  await page.locator('.destination-group').nth(1).locator('.machine-header-controls .icon-button[aria-label="New task"]').click();
  await page.locator('#new-task-dialog[open]').waitFor();
  assert.equal(await page.locator('#new-task-title').textContent(), 'New Task on Test machine');
  assert.equal(await page.locator('#new-task-provider').count(), 0);
  assert.equal(await page.locator('#new-task-model-static').count(), 0);
  await page.locator('#new-task-model option[value="gpt-a"]').waitFor({ state: 'attached' });
  assert.deepEqual(await page.locator('#new-task-model option').allTextContents(), ['GPT-A', 'GPT-B']);
  await page.locator('#new-task-cancel').click();
  await closeSwitcher();

  // The Settings close glyph is drawn, and the SSH + control adds a row at either width.
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator('#settings-button').click();
    await page.locator('#settings-deepseek').waitFor({ state: 'visible' });
    const glyph = await page.locator('#settings-close svg').evaluate(svg => ({
      fill: getComputedStyle(svg).fill, stroke: getComputedStyle(svg).stroke,
      width: svg.getBoundingClientRect().width, height: svg.getBoundingClientRect().height,
    }));
    assert.equal(glyph.fill, 'none');
    assert.notEqual(glyph.stroke, 'none');
    assert.ok(glyph.width > 10 && glyph.height > 10, 'settings X has a drawn box');
    assert.equal(await page.locator('#machine-add').getAttribute('aria-label'), 'Add SSH machine');
    const before = await page.locator('.machine-settings-row').count();
    await page.locator('#machine-add').click();
    assert.equal(await page.locator('.machine-settings-row').count(), before + 1);
    await page.locator('#settings-close').click();
    await page.locator('#settings-screen').waitFor({ state: 'hidden' });
  }

  // Labels never clip their badge border, including a long machine name.
  await page.setViewportSize({ width: 390, height: 844 });
  await openSwitcher();
  const clipping = await page.locator('.destination-group').first().evaluate(group => {
    const badge = group.querySelector('.machine-host-badge');
    const box = badge.getBoundingClientRect();
    const style = getComputedStyle(badge);
    return { borderTop: style.borderTopWidth, boxTop: box.top, controlsLeft: group.querySelector('.machine-header-controls').getBoundingClientRect().left, badgeRight: box.right };
  });
  assert.notEqual(clipping.borderTop, '0px');
  assert.ok(clipping.boxTop > 0, 'badge has a real box');
  assert.ok(clipping.badgeRight <= clipping.controlsLeft + 0.5, 'badge never overlaps the header controls');
  console.log('PASS: one physical-machine group with per-provider task badges, same-name tasks keep their runtime identity, provider picker only for multi-runtime machines, one-model providers read as values, Low effort, unsupported access omitted, Settings X drawn, unclipped badge borders, and the SSH + control adds rows on desktop and mobile');
} finally { await browser.close(); server.closeAllConnections(); for (const response of clients) response.end(); await new Promise(resolve => server.close(resolve)); }
