import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { MachineRuntime } from '../gateway.ts';

// Two providers on one physical Mac mini, plus an OpenAI-only SSH machine.
const normal = new MachineRuntime({}, { id: 'local', name: 'Mac mini', ssh: null, provider: 'openai', group: 'local' }, () => {});
const fallback = new MachineRuntime({}, { id: 'local:deepseek', name: 'Mac mini', ssh: null, deepseek: true, provider: 'deepseek', group: 'local' }, () => {});
const remote = new MachineRuntime({}, { id: 'ssh:test', name: 'Test machine', ssh: 'test', provider: 'openai', group: 'ssh:test' }, () => {});
const selectedTask = { id: 'same-thread', name: 'Same task ID', cwd: '/disposable', status: 'idle' };
// Long enough to overflow a half-width read-only control, so ellipsis behaviour is observable.
const LONG_MODEL_NAME = 'DeepSeek-Flash Extended Preview With A Very Long Marketing Name For Enterprise Deployments';
// Deliberately interleaved recency so a global order is observable across providers.
const TASKS = {
  local: [{ ...selectedTask, updatedAt: 30 }, { id: 'openai-old', name: 'OpenAI older', cwd: '/disposable', status: 'idle', updatedAt: 10 }],
  'local:deepseek': [{ ...selectedTask, updatedAt: 50 }, { id: 'deepseek-new', name: 'DeepSeek newest', cwd: '/disposable', status: 'idle', updatedAt: 70 }],
  'ssh:test': [{ id: 'remote-task', name: 'Remote owned task', cwd: '/srv', status: 'idle', updatedAt: 40 }],
};
for (const runtime of [normal, fallback, remote]) {
  Object.assign(runtime.state, { connected: true, thread: selectedTask, threadStatus: 'idle', phase: 'ready', platform: runtime === remote ? 'linux / Linux' : 'darwin / macOS', model: runtime === fallback ? 'deepseek-flash' : 'gpt-x' });
  runtime.state.models = [{
    model: runtime === fallback ? 'deepseek-flash' : 'gpt-x',
    displayName: runtime === fallback ? LONG_MODEL_NAME : 'GPT-X',
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
    defaultReasoningEffort: 'low',
  }];
  runtime.state.access = { mode: 'ask', choices: { ask: { available: true }, auto: { available: runtime !== fallback }, full: { available: true } } };
  runtime.canAcceptDirectInput = true; runtime.rpc = {};
}
const OPTIONS = {
  local: { models: [{ model: 'gpt-x', displayName: 'GPT-X', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'low' }], current: { model: 'gpt-x', effort: 'low', access: 'ask' }, access: { ask: true, auto: true, full: true } },
  'local:deepseek': { models: [{ model: 'deepseek-flash', displayName: LONG_MODEL_NAME, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }, { reasoningEffort: 'max' }], defaultReasoningEffort: 'high' }], current: { model: 'deepseek-flash', effort: 'high', access: 'ask' }, access: { ask: true, auto: false, full: true } },
  'ssh:test': { models: [{ model: 'gpt-a', displayName: 'GPT-A', supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low' }, { model: 'gpt-b', displayName: 'GPT-B', supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high' }], current: { model: 'gpt-a', effort: 'low', access: 'ask' }, access: { ask: true, auto: true, full: true } },
};
let selected = normal;
let deepseekError = null;
let taskGate = null;
let taskFail = false;
let historySearch = false;
const clients = new Set();
const selections = [];
const snapshot = () => ({ ...selected.snapshot(), quota: { available: false, windows: [] }, submissionEpoch: selected === normal ? 'normal' : selected.state.machineId });
const push = () => { for (const response of clients) response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`); };
const readBody = request => new Promise(resolve => { let text = ''; request.on('data', chunk => { text += chunk; }); request.on('end', () => resolve(text)); });
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const json = (value, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
  if (url.pathname === '/events') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }); clients.add(response); push();
    request.on('close', () => clients.delete(response)); return;
  }
  if (url.pathname === '/api/state') return json(snapshot());
  if (url.pathname === '/api/navigation') return json({
    machines: [normal, fallback, remote].map(r => ({
      ...r.machineSummary(), local: r.state.machineId !== 'ssh:test', catalogAvailable: r.state.connected,
      tasks: r.state.connected ? TASKS[r.state.machineId] : [],
    })),
  });
  if (url.pathname === '/api/history') return json({
    machineId: selected.state.machineId, threadId: selectedTask.id, nextCursor: null,
    turns: historySearch ? [{
      id: 'history-turn', status: 'completed', messages: [],
      activities: [{ id: 'history-search', kind: 'search', label: 'Web search', status: 'completed', createdAt: 1 }],
    }] : [],
  });
  if (url.pathname === '/api/machines') return json({ machines: [normal, fallback, remote].map(r => r.machineSummary()) });
  if (url.pathname === '/api/tasks/options') return json(OPTIONS[url.searchParams.get('machineId')] || OPTIONS.local);
  if (url.pathname === '/api/tasks') {
    JSON.parse(await readBody(request) || '{}');
    if (taskGate) await taskGate;
    if (taskFail) return json({ error: 'Fixture task action failed' }, 409);
    return json(snapshot());
  }
  if (url.pathname === '/api/navigation/select') {
    const body = JSON.parse(await readBody(request) || '{}');
    selections.push({ machineId: body.machineId, threadId: body.threadId, expectedMachineId: body.expectedMachineId });
    selected = [normal, fallback, remote].find(runtime => runtime.state.machineId === body.machineId) || selected;
    push();
    return json({ ...snapshot(), machineId: body.machineId, thread: TASKS[body.machineId].find(entry => entry.id === body.threadId) || selectedTask });
  }
  if (url.pathname === '/api/settings') return json({ settings: { headless: false, lanEnabled: false, host: '127.0.0.1', port: 4173, pinConfigured: true, localName: 'Mac mini', machines: [], phoneUrls: [], deepseekError }, effective: { host: '127.0.0.1', port: 4173, pinRequired: false }, restartRequired: false });
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
  // A clean profile once; later reloads keep whatever the test set, so sidebar defaults are testable.
  await page.addInitScript(() => {
    try {
      if (localStorage.getItem('codex-pocket-test-seeded')) return;
      localStorage.clear();
      localStorage.setItem('codex-pocket-details-open', 'false');
      localStorage.setItem('codex-pocket-test-seeded', '1');
    } catch {}
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const input = page.locator('#message-text');
  const shot = async (name) => {
    if (process.env.POCKET_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.POCKET_SCREENSHOT_DIR}/${name}.png` });
  };
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

  // Task Details names the provider once: machine value plus an explicit Provider row.
  assert.equal(await page.locator('#machine').textContent(), 'Mac mini · macOS');
  assert.equal(await page.locator('#machine .machine-provider-badge').count(), 0);
  assert.equal(await page.locator('#provider').textContent(), 'DeepSeek');
  assert.deepEqual(await page.locator('#access-select option').allTextContents(), ['Ask for Approval', 'Full Access']);

  // The provider tag is its own layout item after the truncating machine/task text.
  assert.equal(await page.locator('#destination-label').textContent(), 'Mac mini / Same task ID');
  assert.equal(await page.locator('#destination-provider').textContent(), 'DeepSeek');
  assert.deepEqual(
    await page.locator('#destination-button > *').evaluateAll(nodes => nodes.map(node => node.id || node.tagName.toLowerCase())),
    ['destination-label', 'destination-provider', 'svg']);
  assert.equal(await page.locator('#destination-button').getAttribute('title'), 'Mac mini / Same task ID [DeepSeek]');

  // A long single-model value ellipsizes inside its own control and keeps the full tooltip.
  const detailsModelText = page.locator('#model-select-static .select-static-text');
  assert.equal(await detailsModelText.textContent(), LONG_MODEL_NAME);
  assert.equal(await detailsModelText.getAttribute('title'), LONG_MODEL_NAME);
  assert.equal(await detailsModelText.evaluate(node => getComputedStyle(node).textOverflow), 'ellipsis');
  assert.equal(await detailsModelText.evaluate(node => node.scrollWidth > node.clientWidth), true, 'the long model name is truncated');
  assert.equal(await page.locator('#model-select-static').evaluate(node => node.getBoundingClientRect().right <= node.closest('.runtime-panel').getBoundingClientRect().right + 0.5), true, 'the value stays inside its control');

  // Display filters: a positively disabled feature hides its filter, unknown capability never does.
  const filterHidden = key => page.locator(`#display-${key}`).evaluate(node => node.closest('label').hidden);
  assert.equal(await filterHidden('search'), true, 'DeepSeek disables web search');
  assert.equal(await filterHidden('collaboration'), true, 'DeepSeek disables subagents');
  assert.equal(await filterHidden('reasoning'), false);
  assert.equal(await filterHidden('review'), false, 'Review tracks code-review events, not the approval reviewer');
  assert.equal(await filterHidden('images'), false, 'Image filters activity cards, not vision support');
  // Hide All must not overwrite the saved preference of an inapplicable filter.
  await page.evaluate(() => localStorage.setItem('codex-pocket-info-display', JSON.stringify({ search: true })));
  await page.evaluate(() => document.querySelector('#display-hide-all').click());
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('codex-pocket-info-display')).search), true, 'hidden filters keep their saved preference');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('codex-pocket-info-display')).reasoning), false, 'applicable filters still change');

  const openSwitcher = async () => {
    if (await page.locator('#destination-button').getAttribute('aria-expanded') !== 'true') await page.locator('#destination-button').click();
    await page.locator('.destination-group').first().waitFor();
  };
  const closeSwitcher = async () => {
    if (await page.locator('#destination-button').getAttribute('aria-expanded') === 'true') await page.locator('#destination-button').click();
    await page.waitForFunction(() => document.querySelector('#destination-button').getAttribute('aria-expanded') === 'false');
  };
  const rows = () => page.locator('.destination-group').first().locator('.destination-entry');
  const rowNames = () => rows().locator('.destination-task-text').allTextContents();
  const rowProviders = () => rows().locator('.task-provider-badge').allTextContents();

  await openSwitcher();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(250);
  await shot('tasks-1280-dark');
  assert.equal(await page.locator('.destination-group').count(), 2, 'Mac mini and the SSH machine');
  const hostGroup = page.locator('.destination-group').first();
  assert.equal((await hostGroup.locator('.machine-toggle').textContent()).trim(), 'Mac miniHost');
  assert.equal(await hostGroup.locator('.destination-group-heading .machine-provider-badge').count(), 0);
  assert.equal(await hostGroup.locator('.machine-host-badge').textContent(), 'Host');

  // Rows are ordered globally across providers: newest DeepSeek task first.
  assert.deepEqual(await rowNames(), ['DeepSeek newest', 'Same task ID', 'Same task ID', 'OpenAI older']);
  assert.deepEqual(await rowProviders(), ['DeepSeek', 'DeepSeek', 'OpenAI', 'OpenAI']);
  // The OpenAI-only machine keeps its rows free of redundant provider badges.
  assert.equal(await page.locator('.destination-group').nth(1).locator('.task-provider-badge').count(), 0);
  // Same-name tasks stay distinguishable to assistive tech, provider-qualified only when needed.
  assert.equal(await hostGroup.locator('.destination-entry').nth(1).locator('summary').getAttribute('aria-label'), 'Actions for Same task ID [DeepSeek]');
  assert.equal(await page.locator('.destination-group').nth(1).locator('.destination-entry').first().locator('summary').getAttribute('aria-label'), 'Actions for Remote owned task');

  // Search keeps physical-machine matching separate from provider matching.
  const search = page.locator('#destination-search');
  await search.fill('Mac mini');
  assert.deepEqual(await rowNames(), ['DeepSeek newest', 'Same task ID', 'Same task ID', 'OpenAI older']);
  assert.equal(await page.locator('.destination-group').count(), 1, 'only the Mac matches');
  await search.fill('DeepSeek');
  assert.deepEqual(await rowNames(), ['DeepSeek newest', 'Same task ID']);
  assert.deepEqual(await rowProviders(), ['DeepSeek', 'DeepSeek']);
  assert.equal(await page.locator('.destination-group').count(), 1, 'the Mac group stays visible for its provider match');
  await search.fill('OpenAI');
  assert.deepEqual(await rowNames(), ['Same task ID', 'OpenAI older']);
  assert.deepEqual(await rowProviders(), ['OpenAI', 'OpenAI']);
  await search.fill('Remote owned');
  assert.deepEqual(await page.locator('.destination-group').count(), 1);
  assert.deepEqual(await page.locator('.destination-group').first().locator('.destination-task-text').allTextContents(), ['Remote owned task']);
  await search.fill('');
  assert.equal(await page.locator('.destination-group').count(), 2);

  // Identical names still select their own runtime identity.
  selections.length = 0;
  // The DeepSeek row is already selected, so switch to the OpenAI twin first and back.
  await rows().nth(2).locator('.destination-task').click();
  await page.waitForFunction(() => document.querySelector('#destination-provider').textContent === 'OpenAI');
  assert.deepEqual(selections.at(-1), { machineId: 'local', threadId: 'same-thread', expectedMachineId: 'local:deepseek' });
  assert.deepEqual(await page.locator('#access-select option').allTextContents(), ['Ask for Approval', 'Approve for Me', 'Full Access']);
  await rows().nth(1).locator('.destination-task').click();
  await page.waitForFunction(() => document.querySelector('#destination-provider').textContent === 'DeepSeek');
  assert.deepEqual(selections.at(-1), { machineId: 'local:deepseek', threadId: 'same-thread', expectedMachineId: 'local' });
  assert.deepEqual(await page.locator('#access-select option').allTextContents(), ['Ask for Approval', 'Full Access']);

  // New Task: one dialog, machine-only title, provider picker only for a multi-runtime machine.
  await page.locator('.destination-group').first().locator('.machine-header-controls .icon-button[aria-label="New task"]').click();
  await page.locator('#new-task-dialog[open]').waitFor();
  assert.equal(await page.locator('#new-task-title').textContent(), 'New Task on Mac mini');
  const providerSelect = page.locator('#new-task-provider');
  await page.locator('#new-task-model-static').waitFor();
  assert.equal(await providerSelect.inputValue(), 'local:deepseek', 'defaults to the selected task provider');
  assert.deepEqual(await providerSelect.locator('option').allTextContents(), ['OpenAI', 'DeepSeek']);
  assert.equal(await page.locator('#new-task-model-static').textContent(), LONG_MODEL_NAME);
  assert.deepEqual(await page.locator('#new-task-effort option').allTextContents(), ['Low', 'High', 'Max']);
  assert.deepEqual(await page.locator('#new-task-access option').allTextContents(), ['Ask for Approval', 'Full Access']);
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

  // New Task layout: Provider and Model take a full row each, Effort and Access share columns.
  const dialogRects = async (width) => {
    await page.setViewportSize({ width, height: 844 });
    await openSwitcher();
    await page.locator('.destination-group').first().locator('.machine-header-controls .icon-button[aria-label="New task"]').click();
    await page.locator('#new-task-dialog[open]').waitFor();
    await page.locator('#new-task-model-static').waitFor();
    await shot(`new-task-${width}`);
    if (width === 1280) {
      await page.emulateMedia({ colorScheme: 'light' });
      await shot('new-task-1280-light');
      await page.emulateMedia({ colorScheme: 'dark' });
    }
    const rects = await page.evaluate(() => {
      const box = selector => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      return {
        dialog: box('#new-task-dialog'), name: box('#new-task-name'), cwd: box('#new-task-cwd'),
        provider: box('#new-task-provider'), model: box('#new-task-model-static'),
        effort: box('#new-task-effort'), access: box('#new-task-access'),
        effortField: (() => { const rect = document.querySelector('#new-task-effort').closest('.form-field').getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }; })(),
        accessField: (() => { const rect = document.querySelector('#new-task-access').closest('.form-field').getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }; })(),
        cwdPlaceholder: getComputedStyle(document.querySelector('#new-task-cwd'), '::placeholder').color,
        modelText: (() => {
          const span = document.querySelector('#new-task-model-static .select-static-text');
          return { title: span.getAttribute('title'), overflow: getComputedStyle(span).textOverflow, truncated: span.scrollWidth > span.clientWidth };
        })(),
      };
    });
    await page.locator('#new-task-cancel').click();
    return rects;
  };
  const boxesOverlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5
    && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
  await page.emulateMedia({ colorScheme: 'dark' });
  for (const width of [1280, 390, 320]) {
    const rects = await dialogRects(width);
    for (const [a, b] of [['name', 'cwd'], ['cwd', 'provider'], ['provider', 'model'], ['model', 'effort'], ['model', 'access'], ['effort', 'access']]) {
      assert.equal(boxesOverlap(rects[a], rects[b]), false, `${a}/${b} must not overlap at ${width}`);
    }
    for (const key of ['provider', 'model']) {
      assert.ok(rects[key].width > rects.dialog.width * 0.7, `${key} spans the dialog at ${width}`);
      assert.ok(rects[key].right <= rects.dialog.right, `${key} stays inside the dialog at ${width}`);
    }
    assert.equal(Math.round(rects.model.height), Math.round(rects.effort.height), 'read-only value matches the selector height');
    const baselinePlaceholder = await page.evaluate(() => getComputedStyle(document.querySelector('#destination-search'), '::placeholder').color);
    assert.equal(rects.cwdPlaceholder, baselinePlaceholder, `dialog placeholders share the same colour at ${width}`);
    if (width > 380) {
      assert.equal(Math.round(rects.effortField.top), Math.round(rects.accessField.top), `Effort and Access share a row at ${width}`);
      assert.equal(Math.round(rects.effortField.width), Math.round(rects.accessField.width), `Effort and Access keep equal columns at ${width}`);
      assert.equal(Math.round(rects.accessField.left - rects.effortField.right), 8, `columns keep the grid gap at ${width}`);
    } else {
      // Too narrow for "Ask for Approval" in a half-width control, so the row stacks.
      assert.equal(Math.round(rects.accessField.top - rects.effortField.bottom), 12, `Effort and Access stack at ${width}`);
      assert.equal(Math.round(rects.effortField.left), Math.round(rects.accessField.left));
      assert.equal(Math.round(rects.effortField.width), Math.round(rects.accessField.width));
    }
    assert.equal(rects.modelText.title, LONG_MODEL_NAME, `dialog keeps the full model tooltip at ${width}`);
    assert.equal(rects.modelText.overflow, 'ellipsis');
    assert.equal(rects.modelText.truncated, true, `dialog truncates the long model name at ${width}`);
  }
  await page.setViewportSize({ width: 1280, height: 844 });

  // A pending delete follows the current query: hidden for another provider, restored in place.
  await openSwitcher();
  const searchBox = page.locator('#destination-search');
  await searchBox.fill('');
  await rows().nth(3).locator('summary').click();
  await rows().nth(3).getByRole('button', { name: 'Delete', exact: true }).click();
  let releaseTaskGate;
  taskGate = new Promise(resolve => { releaseTaskGate = resolve; });
  await page.locator('#task-dialog-submit').click();
  await rows().nth(3).getByText('Deleting…', { exact: true }).waitFor();
  // The refreshed catalog omits the task while its delete is still in flight.
  TASKS.local = TASKS.local.filter(task => task.id !== 'openai-old');
  await page.locator('#destination-refresh').click();
  await page.waitForFunction(() => !document.querySelector('#destination-refresh').disabled);
  assert.deepEqual(await rowNames(), ['DeepSeek newest', 'Same task ID', 'Same task ID', 'OpenAI older'], 'pending row restored while the query shows it');
  assert.equal(await rows().nth(3).getByText('Deleting…', { exact: true }).count(), 1);
  await searchBox.fill('DeepSeek');
  assert.deepEqual(await rowNames(), ['DeepSeek newest', 'Same task ID']);
  assert.equal(await rows().getByText('Deleting…', { exact: true }).count(), 0, 'pending OpenAI row stays hidden under a provider search');
  await searchBox.fill('OpenAI');
  assert.deepEqual(await rowNames(), ['Same task ID', 'OpenAI older']);
  assert.equal(await rows().nth(1).getByText('Deleting…', { exact: true }).count(), 1, 'restored for a matching provider');
  await searchBox.fill('older');
  assert.deepEqual(await rowNames(), ['OpenAI older'], 'restored for matching task text');
  await searchBox.fill('Mac mini');
  assert.deepEqual(await rowNames(), ['DeepSeek newest', 'Same task ID', 'Same task ID', 'OpenAI older'], 'restored for a physical-machine match');
  await searchBox.fill('');
  assert.equal(await rows().nth(3).getByText('Deleting…', { exact: true }).count(), 1, 'pinned in its visible slot');
  releaseTaskGate(); taskGate = null;
  await page.waitForFunction(() => ![...document.querySelectorAll('.destination-task-text')].some(node => node.textContent === 'OpenAI older'));
  await closeSwitcher();

  // A create busy on one runtime disables only that physical machine's + control.
  await openSwitcher();
  const macCreate = page.locator('.destination-group').first().locator('.machine-header-controls .icon-button[aria-label="New task"]');
  const otherCreate = page.locator('.destination-group').nth(1).locator('.machine-header-controls .icon-button[aria-label="New task"]');
  let releaseCreateGate;
  taskGate = new Promise(resolve => { releaseCreateGate = resolve; });
  await macCreate.click();
  await page.locator('#new-task-dialog[open]').waitFor();
  await page.locator('#new-task-provider').selectOption('local:deepseek');
  await page.locator('#new-task-model-static').filter({ hasText: 'DeepSeek-Flash' }).waitFor();
  await page.locator('#new-task-name').fill('Gated DeepSeek create');
  await page.locator('#new-task-create').click();
  await page.waitForFunction(() => document.querySelector('.destination-group .machine-header-controls .icon-button[aria-label="New task"]').disabled);
  assert.equal(await macCreate.isDisabled(), true, 'the Mac mini + is disabled during a DeepSeek create');
  assert.equal(await otherCreate.isDisabled(), false, 'another physical machine stays usable');
  releaseCreateGate(); taskGate = null;
  await page.waitForFunction(() => !document.querySelector('.destination-group .machine-header-controls .icon-button[aria-label="New task"]').disabled);
  assert.equal(await macCreate.isDisabled(), false, 'the control recovers after success');
  // The same control recovers after a failed create.
  taskFail = true;
  await macCreate.click();
  await page.locator('#new-task-dialog[open]').waitFor();
  await page.locator('#new-task-provider').selectOption('local:deepseek');
  await page.locator('#new-task-model-static').filter({ hasText: 'DeepSeek-Flash' }).waitFor();
  await page.locator('#new-task-name').fill('Failing DeepSeek create');
  await page.locator('#new-task-create').click();
  await page.locator('#new-task-error').filter({ hasText: 'Fixture task action failed' }).waitFor();
  assert.equal(await macCreate.isDisabled(), false, 'the control recovers after a failure');
  await page.locator('#new-task-cancel').click();
  taskFail = false;
  await closeSwitcher();

  // The Settings close glyph is drawn, the SSH + control works at both widths, and a broken
  // DeepSeek credential is the only DeepSeek-related thing Settings shows (no toggle).
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator('#settings-button').click();
    await page.locator('#settings-machines-title').waitFor({ state: 'visible' });
    await page.locator('.machine-settings-header').waitFor({ state: 'attached' });
    // Scroll the settings card so the machines area is visible in the capture.
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      const card = document.querySelector('.settings-card');
      const header = document.querySelector('.machine-settings-header');
      if (card && header) card.scrollTop += header.getBoundingClientRect().top - 60;
    });
    await page.waitForTimeout(120);
    await shot(`settings-machines-${width}`);
    if (width === 1280) {
      await page.emulateMedia({ colorScheme: 'light' });
      await shot('settings-machines-1280-light');
      await page.emulateMedia({ colorScheme: 'dark' });
    }
    assert.equal(await page.locator('#settings-deepseek').isVisible(), false, 'no DeepSeek toggle without an error');
    const glyph = await page.locator('#settings-close svg').evaluate(svg => ({
      fill: getComputedStyle(svg).fill, stroke: getComputedStyle(svg).stroke,
      width: svg.getBoundingClientRect().width, height: svg.getBoundingClientRect().height,
    }));
    assert.equal(glyph.fill, 'none');
    assert.notEqual(glyph.stroke, 'none');
    assert.ok(glyph.width > 10 && glyph.height > 10, 'settings X has a drawn box');
    assert.equal(await page.locator('#machine-add').getAttribute('aria-label'), 'Add SSH machine');
    const before = await page.locator('.machine-settings-row').count();
    // With no machines configured the single add control is still present, right aligned and never aria-hidden.
    const placement = await page.evaluate(() => {
      const button = document.querySelector('#machine-add');
      const header = document.querySelector('.machine-settings-header');
      const note = document.querySelector('.machine-settings-empty') || document.querySelector('.machine-settings-row');
      const rect = button.getBoundingClientRect();
      return {
        inHeader: Boolean(button.closest('.machine-settings-actions-cell')) && header.contains(button),
        ariaHiddenAncestor: Boolean(button.closest('[aria-hidden="true"]')),
        visible: rect.width > 0 && rect.height > 0,
        rightAligned: header.getBoundingClientRect().right - rect.right <= 9,
        aboveCards: rect.bottom <= note.getBoundingClientRect().top + 0.5,
        labelsVisible: [...header.querySelectorAll(':scope > span')].some(span => span.offsetParent !== null),
      };
    });
    assert.equal(placement.inHeader, true);
    assert.equal(placement.ariaHiddenAncestor, false, 'the add control is never under aria-hidden');
    assert.equal(placement.visible, true, 'add control stays available with an empty list');
    assert.equal(placement.rightAligned, true, `add control is right aligned at ${width}`);
    assert.equal(placement.aboveCards, true, `add control sits above the cards at ${width}`);
    assert.equal(placement.labelsVisible, width >= 600, `column labels follow the desktop layout at ${width}`);
    if (width >= 600) {
      // Every header cell shares one vertical centre with the add control beside "Actions".
      const headerCenters = await page.evaluate(() => {
        const header = document.querySelector('.machine-settings-header');
        const nodes = [...header.querySelectorAll(':scope > span, .machine-settings-actions-cell > span'), document.querySelector('#machine-add')];
        return nodes.map(node => { const rect = node.getBoundingClientRect(); return rect.top + rect.height / 2; });
      });
      assert.equal(headerCenters.every(center => Math.abs(center - headerCenters[0]) < 1), true, `header cells align vertically at ${width}`);
    }
    await page.locator('#machine-add').click();
    assert.equal(await page.locator('.machine-settings-row').count(), before + 1);
    assert.equal(await page.locator('.machine-settings-row').last().locator('[data-machine-name]').evaluate(node => node === document.activeElement), true, 'focus lands on the new row');
    await page.locator('#settings-close').click();
    await page.locator('#settings-screen').waitFor({ state: 'hidden' });
  }

  // A credential problem is surfaced concisely instead of silently ignoring DeepSeek.
  deepseekError = 'DeepSeek API key file must not be accessible by other users; run chmod 600 /tmp/key';
  await page.locator('#settings-button').click();
  await page.locator('#settings-deepseek-error').filter({ hasText: 'chmod 600' }).waitFor();
  assert.equal(await page.locator('#settings-deepseek').isVisible(), true);
  await page.locator('#settings-close').click();
  await page.locator('#settings-screen').waitFor({ state: 'hidden' });
  deepseekError = null;

  // Labels never clip their badge border, including a long machine name.
  await page.setViewportSize({ width: 390, height: 844 });
  await openSwitcher();
  const clipping = await page.locator('.destination-group').first().evaluate(group => {
    const badge = group.querySelector('.machine-host-badge');
    const box = badge.getBoundingClientRect();
    return {
      borderTop: getComputedStyle(badge).borderTopWidth, boxTop: box.top,
      controlsLeft: group.querySelector('.machine-header-controls').getBoundingClientRect().left, badgeRight: box.right,
    };
  });
  assert.notEqual(clipping.borderTop, '0px');
  assert.ok(clipping.boxTop > 0, 'badge has a real box');
  assert.ok(clipping.badgeRight <= clipping.controlsLeft + 0.5, 'badge never overlaps the header controls');

  // History that contains a search card makes an otherwise-disabled filter available again.
  historySearch = true;
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#destination-label')?.textContent.includes('Same task ID'));
  assert.equal(await page.locator('#display-search').evaluate(node => node.closest('label').hidden), false, 'a search card in history restores its filter');
  assert.equal(await page.locator('#display-collaboration').evaluate(node => node.closest('label').hidden), true, 'nothing restores an unrelated filter');
  historySearch = false;

  // Selected surfaces share one opaque shade per theme; metadata badges keep a visible border.
  await openSwitcher();
  const readSurfaces = () => page.evaluate(() => {
    const row = document.querySelector('.destination-task.selected');
    const button = document.querySelector('#destination-button');
    const badge = document.querySelector('.destination-task.selected .task-provider-badge');
    return {
      rowBg: getComputedStyle(row).backgroundColor, rowBorder: getComputedStyle(row).borderTopColor,
      buttonBg: getComputedStyle(button).backgroundColor, buttonBorder: getComputedStyle(button).borderTopColor,
      badgeBorder: getComputedStyle(badge).borderTopColor,
    };
  });
  for (const scheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(250);
    await shot(`selected-1280-${scheme}`);
    const surfaces = await readSurfaces();
    assert.equal(surfaces.rowBg, surfaces.buttonBg, `selected background matches in ${scheme}`);
    assert.equal(surfaces.rowBorder, surfaces.buttonBorder, `selected border matches in ${scheme}`);
    assert.ok(!surfaces.rowBg.startsWith('rgba('), 'the selected shade is opaque, not a translucent overlay');
    assert.notEqual(surfaces.badgeBorder, 'rgba(0, 0, 0, 0)', 'badge border stays visible on a selected row');
  }
  await page.emulateMedia({ colorScheme: 'dark' });

  // Task list rhythm: 8px between the search field and the first machine header.
  const rhythm = await page.evaluate(() => (
    document.querySelector('.destination-group-heading').getBoundingClientRect().top
      - document.querySelector('.destination-search').getBoundingClientRect().bottom
  ));
  assert.equal(Math.round(rhythm), 8);

  // One placeholder treatment, inheriting each field's typography.
  const placeholders = await page.evaluate(() => {
    const read = selector => {
      const node = document.querySelector(selector);
      return { placeholder: getComputedStyle(node, '::placeholder').color, size: getComputedStyle(node, '::placeholder').fontSize, value: getComputedStyle(node).fontSize };
    };
    return { search: read('#destination-search'), composer: read('#message-text') };
  });
  assert.equal(placeholders.search.size, placeholders.search.value, 'placeholder inherits the search typography');
  assert.equal(placeholders.search.size, '16px', 'task search text stays 16px');
  assert.equal(placeholders.composer.size, '16px', 'composer text stays 16px');
  assert.equal(placeholders.composer.size, placeholders.composer.value);
  const placeholderColor = placeholders.search.placeholder;

  // First desktop launch opens both sidebars in a fresh profile; saved preferences always win.
  const origin = `http://127.0.0.1:${server.address().port}`;
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 844 } });
  const desktopPage = await desktop.newPage();
  await desktopPage.goto(origin);
  await desktopPage.waitForFunction(() => document.querySelector('#destination-button').getAttribute('aria-expanded') === 'true');
  assert.equal(await desktopPage.locator('#destination-switcher').evaluate(node => node.hidden), false, 'tasks sidebar defaults open on desktop');
  assert.equal(await desktopPage.locator('#app-shell').evaluate(node => node.classList.contains('inspector-closed')), false, 'details sidebar defaults open on desktop');
  await desktopPage.evaluate(() => localStorage.setItem('codex-pocket-tasks-open', 'false'));
  await desktopPage.reload();
  await desktopPage.waitForFunction(() => document.querySelector('#destination-button').getAttribute('aria-expanded') === 'false');
  assert.equal(await desktopPage.locator('#destination-switcher').evaluate(node => node.hidden), true, 'a saved preference still wins');
  await desktop.close();
  // Narrow layouts keep both overlay sidebars closed by default.
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mobilePage = await mobile.newPage();
  await mobilePage.goto(origin);
  await mobilePage.waitForFunction(() => document.querySelector('#destination-label') && !document.querySelector('#app-shell').hidden);
  assert.equal(await mobilePage.locator('#destination-switcher').evaluate(node => node.hidden), true, 'tasks overlay stays closed on mobile');
  assert.equal(await mobilePage.locator('#app-shell').evaluate(node => node.classList.contains('inspector-closed')), true, 'details overlay stays closed on mobile');
  assert.equal(await mobilePage.evaluate(() => localStorage.getItem('codex-pocket-tasks-open')), null, 'mobile never stores a desktop sidebar preference');
  await mobile.close();
  console.log('PASS: one physical-machine group with provider tag after the task text, shared selected surfaces in both themes, capability-aware Display filters with history exceptions, New Task full-width Provider/Model rows with ellipsizing read-only values and Effort+Access columns (stacked at 320px, side by side at 390px and desktop), aligned Settings header cells, placeholder typography, 8px list rhythm, SSH add control beside Actions and above the cards, global provider ordering, separate machine/provider search, pending-delete visibility and pinning, group-wide create busy state, provider-qualified labels, and desktop first-launch sidebars');
} finally { await browser.close(); server.closeAllConnections(); for (const response of clients) response.end(); await new Promise(resolve => server.close(resolve)); }
