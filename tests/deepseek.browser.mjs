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
let settingsMachines = [];
let settingsRestartRequired = false;
let historySearch = false;
const clients = new Set();
const selections = [];
// The top-bar slot is driven by the sanitized quota/balance payload the host would send.
let quotaFixture = { available: false, stale: false, sourceMachineId: null, sourceMachine: null, limitName: null, windows: [], updatedAt: null, balance: null };
const snapshot = () => ({ ...selected.snapshot(), quota: quotaFixture, submissionEpoch: selected === normal ? 'normal' : selected.state.machineId });
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
  if (url.pathname === '/api/settings') {
    const settings = { headless: false, lanEnabled: false, host: '127.0.0.1', port: 4173, pinConfigured: true, localName: 'Mac mini', machines: settingsMachines, phoneUrls: [], deepseekError };
    if (request.method === 'POST') {
      const body = JSON.parse(await readBody(request) || '{}');
      if (Array.isArray(body.machines)) settingsMachines = body.machines;
      settingsRestartRequired = true;
      return json({ saved: true, settings: { ...settings, machines: settingsMachines }, restartRequired: true });
    }
    return json({ settings, effective: { host: '127.0.0.1', port: 4173, pinRequired: false }, restartRequired: settingsRestartRequired });
  }
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

  // The DeepSeek account balance replaces the subscription windows in the same shared quota slot.
  const setQuota = async (balance) => {
    quotaFixture = {
      available: Boolean(balance?.available), stale: Boolean(balance?.stale),
      sourceMachineId: balance ? 'local:deepseek' : null, sourceMachine: balance ? 'Mac mini' : null,
      limitName: null, windows: [], updatedAt: balance?.updatedAt ?? null,
      balance: balance ?? { available: false, stale: false, isAvailable: null, entries: [], updatedAt: null },
    };
    push();
    await page.waitForTimeout(80);
  };
  await setQuota({ available: true, stale: false, isAvailable: true, entries: [{ currency: 'CNY', total: '83.42' }], updatedAt: 1 });
  assert.equal(await page.locator('#quota-chip').textContent(), 'Balance ¥83.42');
  assert.match(await page.locator('#quota-chip').getAttribute('title'), /CNY 83\.42/);
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('balance-cny-1280');
  await page.emulateMedia({ colorScheme: 'light' });
  await shot('balance-cny-1280-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await setQuota({ available: true, stale: false, isAvailable: true, entries: [{ currency: 'USD', total: '12.34' }], updatedAt: 2 });
  assert.equal(await page.locator('#quota-chip').textContent(), 'Balance $12.34');
  assert.equal(await page.locator('#quota-chip .quota-balance-text').evaluate(node => node.scrollWidth > node.clientWidth + 1), false, 'an ordinary single-currency amount is not clipped');
  // A legitimate zero balance is shown as zero, not treated as a failure.
  await setQuota({ available: true, stale: false, isAvailable: true, entries: [{ currency: 'CNY', total: '0.00' }], updatedAt: 3 });
  assert.equal(await page.locator('#quota-chip').textContent(), 'Balance ¥0.00');
  // is_available drives the insufficient-funds indication.
  await setQuota({ available: true, stale: false, isAvailable: false, entries: [{ currency: 'CNY', total: '0.00' }], updatedAt: 4 });
  assert.equal(await page.locator('#quota-chip').textContent(), '!Balance ¥0.00');
  assert.equal(await page.locator('#quota-chip').evaluate(node => node.classList.contains('insufficient')), true);
  assert.match(await page.locator('#quota-chip').getAttribute('title'), /insufficient funds/);
  // The flag never truncates, so insufficient funds stay recognizable even when the amount is clipped.
  await setQuota({ available: true, stale: false, isAvailable: false, entries: [{ currency: 'JPY', total: '123456789012345678901234567890.00' }], updatedAt: 4 });
  const clipped = await page.locator('#quota-chip').evaluate(node => {
    const text = node.querySelector('.quota-balance-text');
    return { flag: Boolean(node.querySelector('.balance-flag')), truncated: text.scrollWidth > text.clientWidth + 1, textOverflow: getComputedStyle(text).textOverflow };
  });
  assert.equal(clipped.flag, true);
  assert.equal(clipped.truncated, true, 'the amount truncates inside its own shrinking span');
  assert.equal(clipped.textOverflow, 'ellipsis', 'the amount span ellipsizes');
  assert.equal(await page.locator('#quota-chip .balance-flag').isVisible(), true, 'the insufficient flag stays visible');
  // A malformed or failed fetch shows "Balance —" and is never rendered as zero.
  await setQuota({ available: false, stale: false, isAvailable: null, entries: [], updatedAt: null });
  assert.equal(await page.locator('#quota-chip').textContent(), 'Balance —');
  // A last-known balance is clearly marked instead of disappearing or becoming zero.
  await setQuota({ available: true, stale: true, isAvailable: true, entries: [{ currency: 'USD', total: '9.99' }], updatedAt: 5 });
  assert.equal(await page.locator('#quota-chip').textContent(), 'Balance $9.99');
  assert.equal(await page.locator('#quota-chip').evaluate(node => node.classList.contains('stale')), true);
  assert.match(await page.locator('#quota-chip').getAttribute('title'), /last known/);
  // OpenAI keeps its subscription windows; the balance slot never mixes the two.
  quotaFixture = { available: true, stale: false, sourceMachineId: 'local', sourceMachine: 'Mac mini', limitName: 'Pro', windows: [{ id: 'primary', label: '5-hour', remainingPercent: 62, usedPercent: 38, windowDurationMins: 300, resetsAt: null }], updatedAt: 6, balance: null };
  selected = normal; push();
  await page.waitForFunction(() => document.querySelector('#quota-chip .quota-window'));
  assert.equal(await page.locator('#quota-chip').evaluate(node => node.classList.contains('balance')), false);
  assert.equal(await page.locator('#quota-chip').textContent(), '5-hour62%');
  // Several windows carry their own readable duration labels without clipping.
  quotaFixture = { available: true, stale: false, sourceMachineId: 'local', sourceMachine: 'Mac mini', limitName: 'Pro', windows: [
    { id: 'primary', label: 'Weekly', remainingPercent: 88, usedPercent: 12, windowDurationMins: 10_080, resetsAt: null },
    { id: 'secondary', label: '5-hour', remainingPercent: 41, usedPercent: 59, windowDurationMins: 300, resetsAt: null },
  ], updatedAt: 6, balance: null };
  push();
  await page.waitForFunction(() => document.querySelector('#quota-chip .quota-window + .quota-window'));
  assert.deepEqual(await page.locator('#quota-chip .quota-label').allTextContents(), ['Weekly', '5-hour']);
  assert.deepEqual(await page.locator('#quota-chip .quota-percent').allTextContents(), ['88%', '41%']);
  assert.equal(await page.locator('#quota-chip .quota-label').first().evaluate(node => node.scrollWidth > node.clientWidth + 1), false, 'a normal window label is not clipped');
  // Balance sizing is content-driven at desktop, 390px and 320px: a larger amount widens the pill
  // rather than shrinking its text, and multiple currencies stay separate.
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    selected = fallback;
    await setQuota({ available: true, stale: false, isAvailable: true, entries: [{ currency: 'CNY', total: '83.42' }], updatedAt: 1 });
    const ordinary = await page.locator('#quota-chip').evaluate(node => {
      const text = node.querySelector('.quota-balance-text');
      return { width: node.getBoundingClientRect().width, font: getComputedStyle(text).fontSize, clipped: text.scrollWidth > text.clientWidth + 1, text: text.textContent };
    });
    assert.equal(ordinary.text, 'Balance ¥83.42');
    assert.equal(ordinary.clipped, false, `an ordinary balance is not clipped at ${width}`);
    await setQuota({ available: true, stale: false, isAvailable: true, entries: [{ currency: 'CNY', total: '1234567890123.45' }], updatedAt: 1 });
    const large = await page.locator('#quota-chip').evaluate(node => {
      const text = node.querySelector('.quota-balance-text');
      return { width: node.getBoundingClientRect().width, font: getComputedStyle(text).fontSize, clipped: text.scrollWidth > text.clientWidth + 1, overflow: getComputedStyle(text).textOverflow };
    });
    assert.equal(large.font, ordinary.font, `the balance font size is constant at ${width}`);
    assert.ok(large.width >= ordinary.width, `a larger amount never shrinks the pill at ${width}`);
    if (large.clipped) assert.equal(large.overflow, 'ellipsis', `an oversized amount ellipsizes instead of shrinking at ${width}`);
    await setQuota({ available: true, stale: false, isAvailable: true, entries: [{ currency: 'CNY', total: '83.42' }, { currency: 'USD', total: '12.34' }], updatedAt: 1 });
    assert.equal(await page.locator('#quota-chip').textContent(), 'Balance ¥83.42 · $12.34');
    const multiTitle = await page.locator('#quota-chip').getAttribute('title');
    assert.match(multiTitle, /CNY 83\.42/);
    assert.match(multiTitle, /USD 12\.34/);
    assert.doesNotMatch(multiTitle, /95\.76/, `currencies are never summed at ${width}`);
    await shot(`balance-widths-${width}`);
  }
  await page.setViewportSize({ width: 1280, height: 844 });
  // A narrow screen wraps whole meter cards rather than clipping an ordinary single-currency amount.
  selected = fallback;
  await page.setViewportSize({ width: 320, height: 844 });
  if (await page.locator('#destination-button').getAttribute('aria-expanded') === 'true') {
    await page.locator('#destination-close').evaluate(node => node.click());
    await page.waitForFunction(() => document.querySelector('#destination-button').getAttribute('aria-expanded') === 'false');
    await page.waitForTimeout(220);
  }
  await setQuota({ available: true, stale: false, isAvailable: true, entries: [{ currency: 'USD', total: '12.34' }], updatedAt: 2 });
  const narrowBalance = await page.evaluate(() => {
    const text = document.querySelector('#quota-chip .quota-balance-text');
    const button = document.querySelector('#settings-button').getBoundingClientRect();
    const details = document.querySelector('#inspector-button').getBoundingClientRect();
    return {
      clipped: text.scrollWidth > text.clientWidth + 1,
      onScreen: button.right <= innerWidth + 0.5 && button.width > 0 && details.right <= innerWidth + 0.5,
    };
  });
  assert.equal(narrowBalance.clipped, false, 'an ordinary amount is not clipped at 320px');
  assert.equal(narrowBalance.onScreen, true, 'the sidebar controls stay reachable at 320px');
  await shot('balance-320');
  await page.setViewportSize({ width: 1280, height: 844 });
  // The same #show-quota preference owns this slot; no separate balance toggle was added.
  assert.equal(await page.locator('#show-quota').count(), 1);
  assert.equal(await page.locator('#show-balance').count(), 0);
  quotaFixture = { available: false, stale: false, sourceMachineId: null, sourceMachine: null, limitName: null, windows: [], updatedAt: null, balance: { available: false, stale: false, isAvailable: null, entries: [], updatedAt: null } };
  selected = fallback; push();
  await page.waitForFunction(() => document.querySelector('#quota-chip').textContent === 'Balance —');

  // Task Details names the provider once: machine value plus an explicit Provider row.
  assert.equal(await page.locator('#machine').textContent(), 'Mac mini · macOS');
  assert.equal(await page.locator('#machine .provider-label').count(), 0);
  assert.equal(await page.locator('#provider').textContent(), 'DeepSeek');
  assert.deepEqual(await page.locator('#access-select option').allTextContents(), ['Ask for Approval', 'Full Access']);

  // The provider sits immediately after the machine/task text; only the chevron hugs the far right.
  assert.equal(await page.locator('#destination-label').textContent(), 'Mac mini / Same task ID');
  assert.equal(await page.locator('#destination-provider').textContent(), 'DeepSeek');
  assert.deepEqual(
    await page.locator('#destination-button > *').evaluateAll(nodes => nodes.map(node => node.id || node.tagName.toLowerCase())),
    ['destination-text', 'svg']);
  const adjacency = () => page.evaluate(() => {
    const text = document.querySelector('.destination-text');
    const label = document.querySelector('#destination-label');
    const badge = document.querySelector('#destination-provider');
    const chevron = document.querySelector('#destination-button > svg');
    const button = document.querySelector('#destination-button');
    return {
      badgeInsideText: badge.parentElement === text && label.parentElement === text,
      gap: badge.getBoundingClientRect().left - label.getBoundingClientRect().right,
      labelClipped: label.scrollWidth > label.clientWidth + 1,
      badgeVisible: badge.getBoundingClientRect().width > 0,
      chevronRightInset: button.getBoundingClientRect().right - chevron.getBoundingClientRect().right,
    };
  });
  const shortLayout = await adjacency();
  assert.equal(shortLayout.badgeInsideText, true, 'the badge sits inside the shrinking text group');
  assert.ok(shortLayout.gap >= 3 && shortLayout.gap <= 10, `the badge follows the text immediately (gap ${shortLayout.gap})`);
  assert.equal(shortLayout.chevronRightInset <= 12, true, 'only the chevron stays at the far right');
  // Mobile keeps the badge adjacent to the (usually untruncated) text too.
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.locator('#destination-button').getAttribute('aria-expanded') === 'true') {
    await page.locator('#destination-close').evaluate(node => node.click());
    await page.waitForFunction(() => document.querySelector('#destination-button').getAttribute('aria-expanded') === 'false');
  }
  await page.waitForTimeout(120);
  await shot('destination-390');
  const mobileLayout = await adjacency();
  assert.equal(mobileLayout.badgeVisible, true, 'the badge stays visible at 390px');
  assert.ok(mobileLayout.gap >= 3 && mobileLayout.gap <= 10, 'the badge stays adjacent to the text at 390px');
  await page.setViewportSize({ width: 1280, height: 844 });
  assert.equal(await page.locator('#destination-button').getAttribute('title'), 'Mac mini / Same task ID [DeepSeek]');
  // A long task name truncates the text first while the provider badge stays visible and adjacent.
  const originalThread = fallback.state.thread;
  fallback.state.thread = { ...selectedTask, name: 'A very long DeepSeek task name that must truncate before the provider tag appears' };
  selected = fallback; push();
  await page.waitForFunction(() => document.querySelector('#destination-label').textContent.includes('very long DeepSeek'));
  const longLayout = await adjacency();
  assert.equal(longLayout.labelClipped, true, 'a long task name truncates inside its own span');
  assert.equal(longLayout.badgeVisible, true, 'the provider badge stays visible beside a long name');
  assert.ok(longLayout.gap >= 3 && longLayout.gap <= 10, 'the badge stays adjacent when the text truncates');
  fallback.state.thread = originalThread; selected = fallback; push();
  await page.waitForFunction(() => document.querySelector('#destination-label').textContent === 'Mac mini / Same task ID');

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
    // Machine config loads asynchronously and re-renders once; wait so callers measure attached nodes.
    await page.waitForTimeout(220);
  };
  const closeSwitcher = async () => {
    if (await page.locator('#destination-button').getAttribute('aria-expanded') === 'true') await page.locator('#destination-button').click();
    await page.waitForFunction(() => document.querySelector('#destination-button').getAttribute('aria-expanded') === 'false');
  };
  const rows = () => page.locator('.destination-group').first().locator('.destination-entry');
  const rowNames = () => rows().locator('.destination-task-text').allTextContents();
  const rowProviders = () => rows().locator('.provider-label').allTextContents();

  await openSwitcher();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(250);
  await shot('tasks-1280-dark');
  assert.equal(await page.locator('.destination-group').count(), 2, 'Mac mini and the SSH machine');
  const hostGroup = page.locator('.destination-group').first();
  // The visible Host pill is gone; the host designation stays in the accessibility text.
  assert.equal((await hostGroup.locator('.machine-toggle').textContent()).trim(), 'Mac mini Host');
  assert.equal(await page.locator('.machine-host-badge').count(), 0, 'no visible Host pill in any heading');
  assert.equal(await hostGroup.locator('.destination-group-heading .provider-label').count(), 0);
  assert.equal(await hostGroup.locator('.machine-toggle').evaluate(node => node.textContent.includes('Host')), true);

  // Rows are ordered globally across providers: newest DeepSeek task first.
  assert.deepEqual(await rowNames(), ['DeepSeek newest', 'Same task ID', 'Same task ID', 'OpenAI older']);
  assert.deepEqual(await rowProviders(), ['DeepSeek', 'DeepSeek', 'OpenAI', 'OpenAI']);
  // The OpenAI-only machine keeps its rows free of redundant provider labels.
  assert.equal(await page.locator('.destination-group').nth(1).locator('.provider-label').count(), 0);
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

  // Model menus present one deterministic newest-first order for differently ordered catalogs,
  // and a reordering never moves the selected value or the New Task default.
  {
    const gpt = (version, displayName) => ({ model: `gpt-${version}`, displayName, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'low' });
    const originalModels = normal.state.models;
    const originalModel = normal.state.model;
    const originalLocalOptions = OPTIONS.local;
    const applyCatalog = async (models, current) => {
      normal.state.models = models.map(model => ({ ...model }));
      normal.state.model = current;
      OPTIONS.local = { ...originalLocalOptions, models: models.map(model => ({ ...model })), current: { ...originalLocalOptions.current, model: current } };
      selected = normal; push();
      await page.waitForFunction(value => document.querySelector('#model-select')?.value === value, current);
    };
    const catalog = [gpt('5.5', 'GPT-5.5'), gpt('6', 'GPT-6')];
    await page.evaluate(() => localStorage.removeItem('codex-pocket-new-task-settings:local'));
    await applyCatalog(catalog, 'gpt-5.5');
    assert.deepEqual(await page.locator('#model-select option').allTextContents(), ['GPT-6', 'GPT-5.5'], 'Task Details sorts newest first');
    assert.equal(await page.locator('#model-select').inputValue(), 'gpt-5.5');
    await applyCatalog([...catalog].reverse(), 'gpt-5.5');
    assert.deepEqual(await page.locator('#model-select option').allTextContents(), ['GPT-6', 'GPT-5.5'], 'the display order does not depend on the catalog order');
    assert.equal(await page.locator('#model-select').inputValue(), 'gpt-5.5', 'reordering never changes the selected model');
    // New Task shows the same order but keeps the catalog default, not the sorted-first model.
    OPTIONS.local = { ...originalLocalOptions, models: catalog.map(model => ({ ...model })), current: { ...originalLocalOptions.current, model: 'gpt-5.5' } };
    await openSwitcher();
    await page.locator('.destination-group').first().locator('.machine-header-controls .icon-button[aria-label="New task"]').click();
    await page.locator('#new-task-dialog[open]').waitFor();
    await page.locator('#new-task-model option[value="gpt-6"]').waitFor({ state: 'attached' });
    assert.deepEqual(await page.locator('#new-task-model option').allTextContents(), ['GPT-6', 'GPT-5.5']);
    assert.equal(await page.locator('#new-task-model').inputValue(), 'gpt-5.5', 'the default follows the catalog, not the sorted menu');
    await page.locator('#new-task-cancel').click();
    await closeSwitcher();
    normal.state.models = originalModels;
    normal.state.model = originalModel;
    OPTIONS.local = originalLocalOptions;
    selected = fallback; push();
    await page.waitForFunction(() => document.querySelector('#destination-provider').textContent === 'DeepSeek');
  }

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
        effortLabel: (() => {
          const label = document.querySelector('label[for="new-task-effort"]');
          return { text: label.textContent, clipped: label.scrollWidth > label.clientWidth + 1, visible: label.offsetParent !== null };
        })(),
        controlFonts: ['#new-task-provider', '#new-task-model-static', '#new-task-effort', '#new-task-access']
          .map(selector => document.querySelector(selector)).filter(Boolean).map(node => getComputedStyle(node).fontSize),
      };
    });
    assert.equal(rects.effortLabel.text, 'Reasoning Effort', `New Task names the full label at ${width}`);
    assert.equal(rects.effortLabel.clipped, false, `the full Reasoning Effort label fits at ${width}`);
    assert.equal(rects.effortLabel.visible, true, `the Reasoning Effort label is visible at ${width}`);
    // Provider/Model/Reasoning Effort/Access keep the shared UI size instead of inflating at narrow widths.
    assert.equal(rects.controlFonts.every(size => size === '13px'), true, `New Task controls keep the shared UI size at ${width} (${rects.controlFonts.join(', ')})`);
    assert.equal(await page.getByRole('combobox', { name: 'Reasoning Effort' }).count() >= 1, true, `the control is named Reasoning Effort at ${width}`);
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

  // The Settings close glyph is drawn; machine management lives in the Tasks sidebar and a broken
  // DeepSeek credential is the only DeepSeek-related thing Settings shows (no toggle).
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator('#settings-button').click();
    await page.waitForFunction(() => document.querySelector('#settings-status').textContent === '');
    await shot(`settings-${width}`);
    if (width === 1280) {
      await page.emulateMedia({ colorScheme: 'light' });
      await shot('settings-1280-light');
      await page.emulateMedia({ colorScheme: 'dark' });
    }
    assert.equal(await page.locator('#settings-deepseek').isVisible(), false, 'no DeepSeek toggle without an error');
    assert.equal(await page.locator('#settings-machines-title, #settings-local-name, #machines-toggle, .machine-editor').count(), 0, 'machine management is not in Settings');
    const glyph = await page.locator('#settings-close svg').evaluate(svg => ({
      fill: getComputedStyle(svg).fill, stroke: getComputedStyle(svg).stroke,
      width: svg.getBoundingClientRect().width, height: svg.getBoundingClientRect().height,
    }));
    assert.equal(glyph.fill, 'none');
    assert.notEqual(glyph.stroke, 'none');
    assert.ok(glyph.width > 10 && glyph.height > 10, 'settings X has a drawn box');
    await page.locator('#settings-close').click();
    await page.locator('#settings-screen').waitFor({ state: 'hidden' });

    // Add Machine is a fixed footer in the Tasks sidebar; adding focuses Display Name with helper
    // text outside the labels, and the new machine survives until a restart is requested.
    settingsMachines = [];
    settingsRestartRequired = false;
    await page.reload();
    await openSwitcher();
    assert.equal(await page.locator('#machine-add').isVisible(), true, 'Add Machine stays available with an empty list');
    const footer = await page.locator('#destination-switcher').evaluate(el => {
      const list = el.querySelector('#destination-list'), foot = el.querySelector('.machines-footer');
      return { lastChild: el.lastElementChild === foot, insideList: Boolean(list?.querySelector('.machines-footer')) };
    });
    assert.equal(footer.lastChild, true, 'Add Machine is the fixed sidebar footer');
    assert.equal(footer.insideList, false, 'Add Machine sits outside the scrolling task list');
    await page.locator('#machine-add').click();
    await page.waitForFunction(() => document.querySelector('#machine-dialog').open);
    assert.equal(await page.locator('#machine-dialog-title').textContent(), 'Add Machine');
    assert.equal(await page.locator('#machine-dialog-name').evaluate(node => node === document.activeElement), true, 'focus lands on Display Name');
    assert.deepEqual(await page.locator('#machine-dialog .form-field > label').allTextContents(), ['Display Name', 'SSH Alias', 'MAC Address (optional)']);
    assert.deepEqual(await page.locator('#machine-dialog .machine-dialog-help').allTextContents(), ['From the host’s SSH config.', 'For Wake-on-LAN.']);
    assert.equal(await page.locator('label:has(#machine-dialog-ssh-help), label:has(#machine-dialog-mac-help)').count(), 0, 'helper text is not nested inside a label');
    await page.locator('#machine-dialog-name').fill('Studio');
    await page.locator('#machine-dialog-ssh').fill('studio');
    if (width === 390) await shot('machine-details-390');
    await page.locator('#machine-dialog-submit').click();
    await page.waitForFunction(() => !document.querySelector('#machine-dialog').open);
    assert.deepEqual(settingsMachines, [{ name: 'Studio', ssh: 'studio' }]);
    assert.equal(await page.locator('#machines-restart').isVisible(), true, 'saved machine config shows the restart hint');
    // The mobile drawer covers the topbar button, so close it with the drawer's own control.
    if (width < 1100) await page.locator('#destination-close').click();
    else await closeSwitcher();
    await page.waitForFunction(() => document.querySelector('#destination-button').getAttribute('aria-expanded') === 'false');
  }
  settingsMachines = [];
  settingsRestartRequired = false;
  await page.reload();
  await page.locator('#destination-button').waitFor();

  // A credential problem is surfaced concisely instead of silently ignoring DeepSeek.
  deepseekError = 'DeepSeek API key file must not be accessible by other users; run chmod 600 /tmp/key';
  await page.locator('#settings-button').click();
  await page.locator('#settings-deepseek-error').filter({ hasText: 'chmod 600' }).waitFor();
  assert.equal(await page.locator('#settings-deepseek').isVisible(), true);
  await page.locator('#settings-close').click();
  await page.locator('#settings-screen').waitFor({ state: 'hidden' });
  deepseekError = null;

  // The machine heading no longer shows a Host pill; a long name truncates and never overlaps the
  // header controls, and the row provider is plain secondary metadata after a subtle separator.
  await page.setViewportSize({ width: 390, height: 844 });
  await openSwitcher();
  const heading = await page.locator('.destination-group').first().evaluate(group => {
    const name = group.querySelector('.machine-toggle strong');
    const box = name.getBoundingClientRect();
    const label = group.querySelector('.provider-label');
    const labelStyle = getComputedStyle(label);
    return {
      textOverflow: getComputedStyle(name).textOverflow, nameRight: box.right,
      controlsLeft: group.querySelector('.machine-header-controls').getBoundingClientRect().left,
      hostPill: Boolean(group.querySelector('.machine-host-badge')),
      labelText: label.textContent,
      borderWidth: labelStyle.borderTopWidth, bg: labelStyle.backgroundColor, radius: labelStyle.borderTopLeftRadius,
      separator: getComputedStyle(label, '::before').content,
    };
  });
  assert.equal(heading.hostPill, false, 'the heading shows no Host pill');
  assert.equal(heading.textOverflow, 'ellipsis', 'the machine name can truncate');
  assert.ok(heading.nameRight <= heading.controlsLeft + 0.5, 'the machine name never overlaps the header controls');
  assert.equal(heading.labelText, 'DeepSeek');
  assert.equal(heading.borderWidth, '0px', 'the provider label has no border');
  assert.equal(heading.bg, 'rgba(0, 0, 0, 0)', 'the provider label has no background');
  assert.equal(heading.radius, '0px', 'the provider label is not a rounded box');
  assert.equal(heading.separator, '"·"', 'the provider follows a subtle separator');

  // History that contains a search card makes an otherwise-disabled filter available again.
  historySearch = true;
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#destination-label')?.textContent.includes('Same task ID'));
  assert.equal(await page.locator('#display-search').evaluate(node => node.closest('label').hidden), false, 'a search card in history restores its filter');
  assert.equal(await page.locator('#display-collaboration').evaluate(node => node.closest('label').hidden), true, 'nothing restores an unrelated filter');
  historySearch = false;

  // The selected row keeps one opaque neutral surface per theme; providers are plain secondary
  // metadata (no box, border or radius) and the open Tasks toggle keeps its own resting surface.
  await openSwitcher();
  const readSurfaces = () => page.evaluate(() => {
    const row = document.querySelector('.destination-task.selected');
    const button = document.querySelector('#destination-button');
    const label = document.querySelector('.destination-task.selected .provider-label');
    const topLabel = document.querySelector('#destination-provider');
    const style = node => {
      const computed = getComputedStyle(node);
      return {
        bg: computed.backgroundColor, border: computed.borderTopColor, borderWidth: computed.borderTopWidth,
        radius: computed.borderTopLeftRadius, color: computed.color, size: computed.fontSize, weight: computed.fontWeight,
      };
    };
    return {
      row: style(row), button: style(button), label: style(label), topLabel: style(topLabel),
      buttonExpanded: button.getAttribute('aria-expanded'),
    };
  });
  const luma = value => {
    const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value);
    if (!match) return null;
    const [r, g, b] = [1, 2, 3].map(index => { const c = Number(match[index]) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => { const [hi, lo] = [luma(a), luma(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(120);
  const openButtonBg = (await readSurfaces()).button.bg;
  for (const scheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(250);
    await shot(`selected-1280-${scheme}`);
    const surfaces = await readSurfaces();
    assert.equal(surfaces.buttonExpanded, 'true');
    assert.ok(!surfaces.row.bg.startsWith('rgba('), `the selected shade is opaque in ${scheme}`);
    assert.notEqual(surfaces.row.bg, surfaces.button.bg, `the open Tasks toggle keeps its resting surface in ${scheme}`);
    for (const kind of ['label', 'topLabel']) {
      assert.equal(surfaces[kind].borderWidth, '0px', `the ${kind} has no border in ${scheme}`);
      assert.equal(surfaces[kind].bg, 'rgba(0, 0, 0, 0)', `the ${kind} has no background in ${scheme}`);
      assert.equal(surfaces[kind].radius, '0px', `the ${kind} is not a rounded box in ${scheme}`);
      assert.equal(surfaces[kind].size, '12px', `the ${kind} uses 12px secondary metadata in ${scheme}`);
      assert.equal(surfaces[kind].weight, '400', `the ${kind} uses regular weight in ${scheme}`);
      // The row provider must stay readable on the selected/hovered surface.
      if (kind === 'label') assert.ok(contrast(surfaces.label.color, surfaces.row.bg) >= 4.5, `the row provider stays readable on the selected surface in ${scheme}`);
    }
  }
  await page.emulateMedia({ colorScheme: 'dark' });
  await closeSwitcher();
  assert.equal((await readSurfaces()).button.bg, openButtonBg, 'the Tasks toggle keeps one resting surface open or closed');
  await openSwitcher();

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
