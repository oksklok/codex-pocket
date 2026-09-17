import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, realpath, access, symlink, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeepSeekHost, DEEPSEEK_HOME, DEEPSEEK_BALANCE_URL, deepseekCredentialStatus, deepseekEnvironment, withoutDeepseekKey, deepseekConfig, deepseekArgs, assertDeepseekConfig, constrainDeepseekRequest, DeepSeekBalanceMonitor, sanitizeDeepseekBalance } from '../deepseek.ts';
import { MachineRuntime, PocketGateway, MessageSubmissions, RpcClient, handleRequest, isMessageNotSent, parseArgs, publicSettings, validateLocalConfig } from '../gateway.ts';
import { rememberComposerDraft } from '../public/pocket-logic.js';

test('DeepSeek is exposed from a valid credential and stays local macOS only', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { deepseekStartupOptions } = await import('../gateway.ts');
  const dir = mkdtempSync(join(tmpdir(), 'pocket-deepseek-credential-'));
  const keyPath = join(dir, 'deepseek-api-key');
  try {
    // No credential anywhere: DeepSeek is simply not exposed.
    assert.deepEqual(deepseekStartupOptions({}, 'darwin', false, keyPath), { enabled: false });
    // Either an environment key or the host key file is enough on its own.
    assert.deepEqual(deepseekStartupOptions({ DEEPSEEK_API_KEY: 'env-key' }, 'darwin', false, keyPath), { enabled: true, key: 'env-key' });
    writeFileSync(keyPath, 'file-key', { mode: 0o600 });
    assert.deepEqual(deepseekStartupOptions({}, 'darwin', false, keyPath), { enabled: true, key: 'file-key' });
    // Never on Linux/Windows or in Docker/headless hosts, even with a valid credential.
    for (const platform of ['linux', 'win32']) assert.deepEqual(deepseekStartupOptions({ DEEPSEEK_API_KEY: 'env-key' }, platform, false, keyPath), { enabled: false });
    assert.deepEqual(deepseekStartupOptions({ DEEPSEEK_API_KEY: 'env-key' }, 'darwin', true, keyPath), { enabled: false });
  } finally { rmSync(dir, { recursive: true, force: true }); }
  // The gateway only builds the runtime from explicit, resolved options; headless never adds it.
  assert.deepEqual([...new PocketGateway({ machines: [] }).runtimes.keys()], ['local']);
  assert.deepEqual([...new PocketGateway({ machines: [], deepseek: { enabled: false } }).runtimes.keys()], ['local']);
  assert.deepEqual([...new PocketGateway({ machines: [{ name: 'Remote', ssh: 'remote' }], deepseek: { enabled: true } }, true).runtimes.keys()], ['ssh:remote']);
  assert.deepEqual([...new PocketGateway({ machines: [], deepseek: { enabled: true } }).runtimes.keys()], ['local', 'local:deepseek']);
});

test('missing key leaves only DeepSeek unavailable with a useful setup message', async () => {
  const previous = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  const runtime = new MachineRuntime({}, { id: 'local:deepseek', name: 'DeepSeek', deepseek: true }, () => {});
  try {
    await runtime.start(false);
    assert.equal(runtime.state.connected, false);
    assert.match(runtime.state.connectionError, /DEEPSEEK_API_KEY.*host environment/);
    assert.equal(runtime.daemonStart, null);
    assert.ok(runtime.reconnectTimer);
  } finally { await runtime.stop(); if (previous !== undefined) process.env.DEEPSEEK_API_KEY = previous; }
});

test('child environment, provider overrides and redaction never mutate parent credentials', () => {
  const secret = randomBytes(32).toString('hex');
  const env = { PATH: '/bin', CODEX_HOME: '/normal', OPENAI_API_KEY: 'unrelated', CODEX_THREAD_ID: 'normal-thread', DEEPSEEK_API_KEY: secret };
  const original = { ...env };
  const child = deepseekEnvironment(env, '/isolated');
  assert.equal(child.CODEX_HOME, '/isolated');
  assert.equal(child.DEEPSEEK_API_KEY, secret);
  assert.equal(child.OPENAI_API_KEY, undefined);
  assert.equal(child.CODEX_THREAD_ID, undefined);
  assert.equal(withoutDeepseekKey(env).DEEPSEEK_API_KEY, undefined);
  assert.deepEqual(env, original);
  assert.ok(!JSON.stringify(deepseekConfig('/isolated')).includes(secret));
  assert.ok(!deepseekArgs('/isolated').join(' ').includes(secret));
  const host = new DeepSeekHost('/isolated', env);
  assert.equal(host.redact('failure ' + secret + ' ' + secret), 'failure [REDACTED] [REDACTED]');
  assert.equal(host.proxyOptions().env.CODEX_HOME, '/isolated');
  assert.ok(host.proxyOptions().args.includes('/isolated/pocket.sock'));
  assert.throws(() => deepseekEnvironment({}), /DEEPSEEK_API_KEY/);
});

function effectiveConfig(home) {
  const values = deepseekConfig(home);
  return { ...values, model_providers: { deepseek: values['model_providers.deepseek'] }, shell_environment_policy: { exclude: values['shell_environment_policy.exclude'] } };
}

test('effective project configuration fails closed for providers, endpoint, auth and shell leaks', () => {
  const good = effectiveConfig('/isolated');
  assert.doesNotThrow(() => assertDeepseekConfig(good, '/isolated'));
  for (const change of [
    { model_provider: 'openai' }, { model: 'gpt-5' }, { model_catalog_json: '/normal/models.json' },
    { sqlite_home: '/normal' }, { shell_environment_policy: { exclude: [] } }, { web_search: 'live' },
    { mcp_servers: { injected: { command: 'printenv' } } },
    { model_providers: { deepseek: { ...good.model_providers.deepseek, experimental_bearer_token: 'other' } } },
    { model_providers: { deepseek: { ...good.model_providers.deepseek, base_url: 'https://example.invalid' } } },
  ]) assert.throws(() => assertDeepseekConfig({ ...good, ...change }, '/isolated'), /isolation check failed/);
  assert.throws(() => constrainDeepseekRequest('thread/settings/update', { model: 'gpt-5' }), /only supports/);
  assert.throws(() => constrainDeepseekRequest('thread/settings/update', { effort: 'medium' }), /effort/);
  assert.throws(() => constrainDeepseekRequest('thread/settings/update', { approvalsReviewer: 'auto_review' }), /unavailable/);
  assert.equal(constrainDeepseekRequest('thread/start', {}).modelProvider, 'deepseek');
  assert.equal(constrainDeepseekRequest('command/exec', {}).env.DEEPSEEK_API_KEY, null);
});

test('runtime identities isolate queues, receipts, drafts and subscription quota', async () => {
  const submissions = new MessageSubmissions();
  const local = new MachineRuntime({}, { id: 'local', name: 'Local' }, () => {}, () => {}, submissions);
  const fallback = new MachineRuntime({}, { id: 'local:deepseek', name: 'DeepSeek', deepseek: true }, () => {}, () => {}, submissions);
  local.taskQueues.set('same-id', { text: 'OpenAI only' });
  assert.equal(fallback.taskQueues.size, 0);
  local.asyncAnswers.task = { item: 'OpenAI only' };
  assert.deepEqual(fallback.asyncAnswers, {});
  const gateway = new PocketGateway({ machines: [] });
  const receiptId = gateway.submissions.epoch + '-same-submission';
  await gateway.submissions.run(receiptId, async () => ({ accepted: true, turnId: 'openai-turn' }));
  assert.equal((await gateway.submissionStore('local:deepseek').recover(receiptId)).status, 'unknown');
  await assert.rejects(gateway.submissionStore('local:deepseek').run(receiptId, async () => ({ accepted: true })), /restarted/);
  const drafts = new Map();
  rememberComposerDraft(drafts, JSON.stringify(['local', 'same-id']), { text: 'OpenAI draft' });
  assert.equal(rememberComposerDraft(drafts, JSON.stringify(['local:deepseek', 'same-id'])), undefined);
  gateway.runtimes.set('local', local); gateway.runtimes.set('local:deepseek', fallback);
  local.state.connected = true;
  local.quota = { fresh: true, windows: [{ windowDurationMins: 300 }], updatedAt: Date.now() };
  gateway.selectedMachineId = 'local'; gateway.refreshQuotaSource();
  assert.equal(gateway.snapshot().quota.available, true);
  gateway.selectedMachineId = 'local:deepseek'; gateway.refreshQuotaSource();
  assert.equal(gateway.snapshot().quota.available, false);
  gateway.selectedMachineId = 'local'; gateway.refreshQuotaSource();
  assert.equal(gateway.snapshot().quota.available, true);
});

test('owned server startup, duplicate prevention, reconnect reuse, failure and cleanup (simulated CLI)', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'pocket-deepseek-test-')));
  const bin = join(home, 'fake-codex');
  const secret = randomBytes(32).toString('hex');
  await writeFile(bin, `#!${process.execPath}\nimport net from 'node:net';import fs from 'node:fs';\nconst socket=process.argv.at(-1).slice(7);\nfs.writeFileSync(process.env.CODEX_HOME+'/env-check.json',JSON.stringify({home:process.env.CODEX_HOME,keyPresent:Boolean(process.env.DEEPSEEK_API_KEY),openaiPresent:Boolean(process.env.OPENAI_API_KEY),argvSecret:process.argv.some(x=>x.includes(process.env.DEEPSEEK_API_KEY))}));\nnet.createServer().listen(socket);\n`, { mode: 0o700 });
  const host = new DeepSeekHost(home, { ...process.env, CODEX_BIN: bin, DEEPSEEK_API_KEY: secret, OPENAI_API_KEY: 'unrelated' });
  const duplicate = new DeepSeekHost(home, { ...process.env, CODEX_BIN: bin, DEEPSEEK_API_KEY: secret });
  try {
    await Promise.all([host.start(), host.start()]);
    const child = host.child;
    await host.start(); assert.equal(host.child, child);
    const env = JSON.parse(await readFile(join(home, 'env-check.json'), 'utf8'));
    assert.deepEqual(env, { home, keyPresent: true, openaiPresent: false, argvSecret: false });
    await assert.rejects(duplicate.start(), /already owned/);
    assert.equal(host.child, child);
    assert.ok(!(await readFile(join(home, 'config.toml'), 'utf8')).includes(secret));
  } finally { await duplicate.stop(); await host.stop(); }
  await assert.rejects(access(join(home, 'pocket.sock')));
  await assert.rejects(access(join(home, 'pocket-owner')));
  const failed = new DeepSeekHost(home, { ...process.env, CODEX_BIN: '/nonexistent/pocket-codex', DEEPSEEK_API_KEY: secret });
  try { await assert.rejects(failed.start(), /Could not start|exited/); } finally { await failed.stop(); }
  const recovered = new DeepSeekHost(home, { ...process.env, CODEX_BIN: bin, DEEPSEEK_API_KEY: secret });
  try { await recovered.start(); } finally { await recovered.stop(); await rm(home, { recursive: true, force: true }); }
});

test('RPC rejects project provider mismatch before starting a task and redacts upstream errors', async () => {
  const secret = randomBytes(32).toString('hex');
  const rpc = new RpcClient(new DeepSeekHost('/isolated', { DEEPSEEK_API_KEY: secret }));
  const sent = [];
  rpc.wire = { close() {}, send(message) {
    sent.push(message.method);
    queueMicrotask(() => rpc.receive({ id: message.id, result: { config: { model_provider: 'openai' } } }));
  } };
  await assert.rejects(rpc.request('thread/start', { cwd: '/project' }), /isolation check/);
  assert.deepEqual(sent, ['config/read']);
  rpc.wire.send = message => queueMicrotask(() => rpc.receive({ id: message.id, error: { message: 'Provider said ' + secret, code: -1 } }));
  await assert.rejects(rpc.request('model/list'), error => !error.message.includes(secret) && error.message.includes('[REDACTED]'));
  let notification;
  rpc.onNotification = message => { notification = message; };
  rpc.receive({ method: 'error', params: { message: secret } });
  assert.equal(notification.params.message, '[REDACTED]');
  rpc.close();
});

test('setup refuses links to normal configuration and preserves its contents', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pocket-deepseek-boundary-')));
  const normal = join(root, 'normal-config.toml'), home = join(root, 'isolated');
  await writeFile(normal, 'model = "official-model"\n');
  await mkdir(home);
  await symlink(normal, join(home, 'config.toml'));
  const host = new DeepSeekHost(home, { ...process.env, DEEPSEEK_API_KEY: randomBytes(32).toString('hex') });
  try {
    await assert.rejects(host.start(), /symlinked/);
    assert.equal(await readFile(normal, 'utf8'), 'model = "official-model"\n');
  } finally { await host.stop(); await rm(root, { recursive: true, force: true }); }
});

test('supervisor stops only its owned server when Pocket unexpectedly exits (simulated CLI)', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'pocket-deepseek-parent-')));
  const bin = join(home, 'fake-codex');
  await writeFile(bin, `#!${process.execPath}\nimport net from 'node:net';import fs from 'node:fs';fs.writeFileSync(process.env.CODEX_HOME+'/server-pid',String(process.pid));net.createServer().listen(process.argv.at(-1).slice(7));`, { mode: 0o700 });
  const script = join(home, 'parent.mjs');
  await writeFile(script, `import {DeepSeekHost} from ${JSON.stringify(new URL('../deepseek.ts', import.meta.url).href)};import fs from 'node:fs';const host=new DeepSeekHost(process.env.CODEX_HOME);await host.start();fs.writeFileSync(process.env.CODEX_HOME+'/ready','yes');setInterval(()=>{},1000);`);
  const parent = spawn(process.execPath, ['--experimental-strip-types', script], { env: { ...process.env, CODEX_HOME: home, CODEX_BIN: bin, DEEPSEEK_API_KEY: randomBytes(32).toString('hex') }, stdio: 'ignore' });
  const waitUntil = async predicate => {
    for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 50)); }
    assert.fail('owned server lifecycle timed out');
  };
  try {
    await waitUntil(() => access(join(home, 'ready')).then(() => true, () => false));
    const serverPid = Number(await readFile(join(home, 'server-pid'), 'utf8'));
    parent.kill('SIGKILL');
    await waitUntil(() => access(join(home, 'pocket-owner')).then(() => false, () => true));
    assert.throws(() => process.kill(serverPid, 0), { code: 'ESRCH' });
    await assert.rejects(access(join(home, 'pocket.sock')));
  } finally { parent.kill('SIGKILL'); await rm(home, { recursive: true, force: true }); }
});

// Manual queued Start/Steer recovery runs through PocketGateway.sendQueuedMessage, which
// must hand the runtime the same receipt store the /api/message/queue route created it in.
async function queuedReceiptHarness() {
  const { createServer } = await import('node:http');
  const gateway = new PocketGateway({ machines: [] });
  const openai = new MachineRuntime({}, { id: 'local', name: 'Local', ssh: null }, () => {}, () => {}, gateway.submissions);
  const deepseek = new MachineRuntime({}, { id: 'local:deepseek', name: 'Local · DeepSeek', ssh: null, deepseek: true }, () => {}, () => {}, gateway.submissionStore('local:deepseek'));
  gateway.runtimes.set('local', openai);
  gateway.runtimes.set('local:deepseek', deepseek);
  const auth = { required: false, pin: null, sessionId: 'session', attempts: new Map() };
  const server = createServer((request, response) => {
    handleRequest(request, response, gateway, auth, {}, { host: '127.0.0.1' }, async () => ({ localUrl: '/' }), () => {}, () => false)
      .catch(() => { try { response.writeHead(500); response.end(); } catch {} });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    gateway, openai, deepseek,
    sendQueued: async value => {
      const response = await fetch(`${origin}/api/message/queue`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
      });
      return { status: response.status, body: await response.json() };
    },
    pollSubmission: async submissionId => (await fetch(`${origin}/api/state?submissionId=${encodeURIComponent(submissionId)}`)).json(),
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

function activeThread(runtime) {
  runtime.canAcceptDirectInput = true;
  Object.assign(runtime.state, { connected: true, thread: { id: 'thread-1', name: 'Task', cwd: '/tmp' }, threadStatus: 'active' });
  runtime.handleNotification({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress' } } });
}

function closingRpcFor(calls, failingMethod) {
  return { request: async method => {
    calls.push(method);
    if (method === 'thread/turns/list') return { data: [], nextCursor: null };
    if (method === failingMethod) throw new Error('Codex app-server connection closed');
    return {};
  } };
}

test('DeepSeek queued Steer blocks an unconfirmed delivery and recovers the machine receipt', async () => {
  const harness = await queuedReceiptHarness();
  const { gateway, openai, deepseek, sendQueued, pollSubmission } = harness;
  try {
    gateway.selectedMachineId = 'local:deepseek';
    const calls = [];
    deepseek.rpc = closingRpcFor(calls, 'turn/steer');
    activeThread(deepseek);
    await deepseek.sendMessage('Queued steer text', 'queue');
    const queued = deepseek.state.queuedMessage;
    assert.ok(queued);
    const submissionId = `${gateway.submissionStore('local:deepseek').epoch}-deepseek-steer`;
    const sent = await sendQueued({ machineId: 'local:deepseek', threadId: 'thread-1', queueId: queued.id, action: 'steer', submissionId });
    assert.equal(sent.status, 409);
    assert.equal(sent.body.submission.status, 'unknown');
    assert.equal(calls.filter(method => method === 'turn/steer').length, 1);
    assert.equal(deepseek.state.queuedMessage, queued);
    assert.equal(deepseek.state.queuedMessage.deliveryUnknown, true);
    // Unconfirmed delivery stays blocked and is never retried upstream.
    const blocked = await pollSubmission(submissionId);
    assert.equal(blocked.submission.status, 'unknown');
    assert.equal(calls.filter(method => method === 'turn/steer').length, 1);
    assert.equal(deepseek.state.queuedMessage, queued);
    // The steered message landing in the same turn confirms delivery and retires the queue.
    deepseek.handleNotification({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1',
      item: { id: 'steer-user', type: 'userMessage', text: 'Queued steer text' } } });
    assert.equal(deepseek.state.queuedMessage, null);
    const recovered = await pollSubmission(submissionId);
    assert.equal(recovered.submission.status, 'accepted');
    assert.equal(calls.filter(method => method === 'turn/steer').length, 1);
    // Receipts stay namespaced: the OpenAI store never owns this submission.
    assert.equal((await openai.submissions.recover(submissionId)).status, 'unknown');
  } finally { await harness.close(); }
});

test('DeepSeek queued Start recovers once the confirmed turn begins', async () => {
  const harness = await queuedReceiptHarness();
  const { gateway, deepseek, sendQueued, pollSubmission } = harness;
  try {
    gateway.selectedMachineId = 'local:deepseek';
    const calls = [];
    deepseek.rpc = closingRpcFor(calls, 'turn/start');
    activeThread(deepseek);
    await deepseek.sendMessage('Queued start text', 'queue');
    const queued = deepseek.state.queuedMessage;
    assert.ok(queued);
    deepseek.autoAttach = false;
    deepseek.handleNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    const submissionId = `${gateway.submissionStore('local:deepseek').epoch}-deepseek-start`;
    const sent = await sendQueued({ machineId: 'local:deepseek', threadId: 'thread-1', queueId: queued.id, action: 'start', submissionId });
    assert.equal(sent.status, 409);
    assert.equal(sent.body.submission.status, 'unknown');
    assert.equal(calls.filter(method => method === 'turn/start').length, 1);
    assert.equal(deepseek.state.queuedMessage.deliveryUnknown, true);
    // Upstream starts the new turn carrying the queued message.
    deepseek.handleNotification({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-2', status: 'inProgress' } } });
    deepseek.handleNotification({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-2',
      item: { id: 'start-user', type: 'userMessage', text: 'Queued start text' } } });
    assert.equal(deepseek.state.queuedMessage, null);
    const recovered = await pollSubmission(submissionId);
    assert.equal(recovered.submission.status, 'accepted');
    assert.equal(calls.filter(method => method === 'turn/start').length, 1);
  } finally { await harness.close(); }
});

test('DeepSeek parked queued receipt recovers and retires the parked queue', async () => {
  const harness = await queuedReceiptHarness();
  const { gateway, deepseek, sendQueued, pollSubmission } = harness;
  try {
    gateway.selectedMachineId = 'local:deepseek';
    const calls = [];
    deepseek.rpc = closingRpcFor(calls, 'turn/steer');
    activeThread(deepseek);
    await deepseek.sendMessage('Parked text', 'queue');
    const queued = deepseek.state.queuedMessage;
    const submissionId = `${gateway.submissionStore('local:deepseek').epoch}-deepseek-parked`;
    const sent = await sendQueued({ machineId: 'local:deepseek', threadId: 'thread-1', queueId: queued.id, action: 'steer', submissionId });
    assert.equal(sent.body.submission.status, 'unknown');
    // Walking away parks the unresolved queue for its task.
    deepseek.taskQueues.set('thread-1', deepseek.state.queuedMessage);
    deepseek.state.queuedMessage = null;
    // The parked delivery is later confirmed upstream.
    deepseek.handleNotification({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1',
      item: { id: 'parked-user', type: 'userMessage', text: 'Parked text' } } });
    assert.equal(deepseek.state.queuedMessage, null);
    const recovered = await pollSubmission(submissionId);
    assert.equal(recovered.submission.status, 'accepted');
    assert.equal(deepseek.taskQueues.has('thread-1'), false);
  } finally { await harness.close(); }
});

test('DeepSeek receipt recovery never retires a replacement queue', async () => {
  const harness = await queuedReceiptHarness();
  const { gateway, deepseek, sendQueued, pollSubmission } = harness;
  try {
    gateway.selectedMachineId = 'local:deepseek';
    const calls = [];
    deepseek.rpc = closingRpcFor(calls, 'turn/steer');
    activeThread(deepseek);
    await deepseek.sendMessage('Original text', 'queue');
    const queued = deepseek.state.queuedMessage;
    const submissionId = `${gateway.submissionStore('local:deepseek').epoch}-deepseek-replaced`;
    await sendQueued({ machineId: 'local:deepseek', threadId: 'thread-1', queueId: queued.id, action: 'steer', submissionId });
    // Park the unresolved original, then let a replacement take the same task slot.
    deepseek.taskQueues.set('thread-1', deepseek.state.queuedMessage);
    deepseek.state.queuedMessage = null;
    const replacement = { id: 'replacement-queue', threadId: 'thread-1', text: 'Replacement text', createdAt: Date.now() };
    deepseek.taskQueues.set('thread-1', replacement);
    deepseek.handleNotification({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1',
      item: { id: 'original-user', type: 'userMessage', text: 'Original text' } } });
    const recovered = await pollSubmission(submissionId);
    assert.equal(recovered.submission.status, 'accepted');
    assert.equal(deepseek.taskQueues.get('thread-1'), replacement);
  } finally { await harness.close(); }
});

test('OpenAI queued Steer receipts keep recovering through the shared store', async () => {
  const harness = await queuedReceiptHarness();
  const { gateway, openai, sendQueued, pollSubmission } = harness;
  try {
    gateway.selectedMachineId = 'local';
    const calls = [];
    openai.rpc = closingRpcFor(calls, 'turn/steer');
    activeThread(openai);
    await openai.sendMessage('OpenAI steer text', 'queue');
    const queued = openai.state.queuedMessage;
    const submissionId = `${gateway.submissions.epoch}-openai-steer`;
    const sent = await sendQueued({ machineId: 'local', threadId: 'thread-1', queueId: queued.id, action: 'steer', submissionId });
    assert.equal(sent.status, 409);
    assert.equal(sent.body.submission.status, 'unknown');
    openai.handleNotification({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1',
      item: { id: 'openai-user', type: 'userMessage', text: 'OpenAI steer text' } } });
    assert.equal(openai.state.queuedMessage, null);
    const recovered = await pollSubmission(submissionId);
    assert.equal(recovered.submission.status, 'accepted');
  } finally { await harness.close(); }
});

// --- Preflight vs. post-dispatch delivery outcomes (real RpcClient, mocked wire) ---

function isolatedRpc(send) {
  const rpc = new RpcClient(new DeepSeekHost('/isolated', { DEEPSEEK_API_KEY: randomBytes(32).toString('hex') }));
  rpc.wire = { close() {}, send };
  return rpc;
}

function reply(rpc, id, result) { queueMicrotask(() => rpc.receive({ id, result })); }

async function settle() { for (let i = 0; i < 10; i += 1) await Promise.resolve(); }

test('DeepSeek preflight timeout is a definitive not-sent failure with zero turn/start calls', async () => {
  const sent = [];
  const rpc = isolatedRpc(message => { sent.push(message.method); });
  let failure;
  await assert.rejects(rpc.request('turn/start', { threadId: 'thread-1', input: [] }, 50), error => { failure = error; return true; });
  assert.equal(isMessageNotSent(failure), true);
  assert.match(failure.message, /thread\/read timed out/);
  assert.deepEqual(sent, ['thread/read']);
  // The marker, not the wording, decides the receipt outcome.
  const receipts = new MessageSubmissions();
  const id = `${receipts.epoch}-presend-timeout`;
  await assert.rejects(receipts.run(id, async () => { throw failure; }));
  assert.equal((await receipts.recover(id)).status, 'rejected');
});

test('DeepSeek preflight isolation failure is a definitive not-sent failure', async () => {
  const sent = [];
  const rpc = isolatedRpc(message => {
    sent.push(message.method);
    if (message.method === 'config/read') reply(rpc, message.id, { config: { model_provider: 'openai' } });
  });
  await assert.rejects(rpc.request('turn/start', { cwd: '/project', input: [] }, 2_000),
    error => isMessageNotSent(error) && /isolation check/.test(error.message));
  assert.deepEqual(sent, ['config/read']);
});

test('DeepSeek preflight and the dispatched RPC share one timeout budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const sent = [];
  const rpc = isolatedRpc(message => {
    sent.push(message.method);
    // Answer the preflight late: 60% of the caller's 1s budget.
    if (message.method === 'config/read') setTimeout(() => rpc.receive({ id: message.id, result: { config: effectiveConfig('/isolated') } }), 600);
  });
  let outcome = 'pending';
  const pending = rpc.request('turn/start', { cwd: '/project', input: [] }, 1_000)
    .then(() => { outcome = 'resolved'; }, error => { outcome = error; });
  await settle();
  assert.deepEqual(sent, ['config/read']);
  t.mock.timers.tick(600);
  await settle();
  assert.deepEqual(sent, ['config/read', 'turn/start']);
  assert.equal(outcome, 'pending');
  t.mock.timers.tick(399);
  assert.equal(outcome, 'pending');
  t.mock.timers.tick(1);
  await settle();
  assert.ok(outcome instanceof Error && /turn\/start timed out/.test(outcome.message) && !isMessageNotSent(outcome));
  await pending;
});

test('DeepSeek post-dispatch timeout stays uncertain and cannot duplicate the send', async () => {
  const sent = [];
  const rpc = isolatedRpc(message => {
    sent.push(message.method);
    if (message.method === 'config/read') reply(rpc, message.id, { config: effectiveConfig('/isolated') });
  });
  let failure;
  await assert.rejects(rpc.request('turn/start', { cwd: '/project', input: [] }, 50), error => { failure = error; return true; });
  assert.equal(isMessageNotSent(failure), false);
  assert.match(failure.message, /turn\/start timed out/);
  assert.equal(sent.filter(method => method === 'turn/start').length, 1);
  const receipts = new MessageSubmissions();
  const id = `${receipts.epoch}-postsend-timeout`;
  await assert.rejects(receipts.run(id, async () => { throw failure; }));
  assert.equal((await receipts.recover(id)).status, 'unknown');
});

test('DeepSeek queued Start preflight timeout keeps a retryable queue and sends nothing', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const harness = await queuedReceiptHarness();
  const { gateway, deepseek } = harness;
  try {
    gateway.selectedMachineId = 'local:deepseek';
    const sent = [];
    const rpc = isolatedRpc(message => {
      sent.push(message.method);
      if (message.method === 'thread/turns/list') reply(rpc, message.id, { data: [], nextCursor: null });
    });
    deepseek.rpc = rpc;
    activeThread(deepseek);
    await deepseek.sendMessage('Queued start text', 'queue');
    const queued = deepseek.state.queuedMessage;
    deepseek.autoAttach = false;
    deepseek.handleNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    // Same call the /api/message/queue route makes: the receipt store wraps the gateway send.
    const receipts = gateway.submissionStore('local:deepseek');
    const submissionId = `${receipts.epoch}-deepseek-presend`;
    const pending = receipts.run(submissionId, () => gateway.sendQueuedMessage('local:deepseek', 'start', 'thread-1', queued.id, submissionId))
      .then(() => 'accepted', error => error);
    await settle();
    assert.deepEqual(sent, ['thread/read']);
    t.mock.timers.tick(20_000);
    await settle();
    const outcome = await pending;
    assert.equal(isMessageNotSent(outcome), true);
    assert.match(outcome.message, /thread\/read timed out/);
    assert.equal(sent.includes('turn/start'), false);
    // Definitive failure keeps the queue for a manual retry instead of blocking it as uncertain.
    assert.equal(deepseek.state.queuedMessage?.threadId, 'thread-1');
    assert.equal(deepseek.state.queuedMessage?.deliveryUnknown, false);
    assert.equal((await receipts.recover(submissionId)).status, 'rejected');
  } finally { await harness.close(); }
});

test('DeepSeek isolation rejects shell_environment_policy.set entries that reintroduce excluded credentials', () => {
  const home = '/isolated';
  const base = effectiveConfig(home);
  for (const name of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'OPENAI_ORG_ID', 'CODEX_GITHUB_TOKEN', 'CODEX_TOKEN', 'openai_api_key']) {
    const config = { ...base, shell_environment_policy: { ...base.shell_environment_policy, set: { [name]: 'synthetic-value' } } };
    assert.throws(() => assertDeepseekConfig(config, home), /isolation check failed/, name);
  }
  assert.throws(() => assertDeepseekConfig({
    ...base, shell_environment_policy: { ...base.shell_environment_policy, set: ['DEEPSEEK_API_KEY'] },
  }, home), /isolation check failed/);
  for (const name of ['PATH', 'HOME', 'CODEX_HOME', 'MY_API_KEY', 'MY_TOKEN']) {
    const config = { ...base, shell_environment_policy: { ...base.shell_environment_policy, set: { [name]: 'keep' } } };
    assert.doesNotThrow(() => assertDeepseekConfig(config, home), name);
  }
});

// --- Credential-driven enablement, the host key file, and provider metadata ---

const baseConfig = { lanEnabled: false, host: '127.0.0.1', port: 4173, pin: '1234', localName: 'Mac mini', machines: [] };

test('DeepSeek needs no stored setting: older files load harmlessly and only a broken credential is surfaced', async () => {
  const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { saveLocalSettings, settingsNeedRestart } = await import('../gateway.ts');
  const dir = mkdtempSync(join(tmpdir(), 'pocket-deepseek-settings-'));
  try {
    // Settings written by the previous release still load even though the flag is gone.
    const legacyPath = join(dir, 'legacy.json');
    writeFileSync(legacyPath, JSON.stringify({ ...baseConfig, deepseekEnabled: true }));
    assert.equal(JSON.parse(readFileSync(legacyPath, 'utf8')).deepseekEnabled, true);
    const settings = { path: join(dir, 'settings.json'), config: validateLocalConfig({ ...baseConfig, deepseekEnabled: true }), loaded: true };
    // Saving writes only known fields, so the obsolete flag disappears harmlessly.
    saveLocalSettings(settings, { ...baseConfig }, undefined, false);
    assert.equal('deepseekEnabled' in JSON.parse(readFileSync(settings.path, 'utf8')), false);
    // Nothing about DeepSeek is a setting any more: only host settings require a restart.
    const same = parseArgs([], { ...baseConfig });
    const withProvider = parseArgs([], { ...baseConfig, deepseek: { enabled: true } });
    const changedHost = parseArgs([], { ...baseConfig, localName: 'Other' });
    assert.equal(settingsNeedRestart(settings, same, { pin: '1234' }, [], undefined), false);
    assert.equal(settingsNeedRestart(settings, withProvider, { pin: '1234' }, [], undefined), false);
    assert.equal(settingsNeedRestart(settings, changedHost, { pin: '1234' }, [], undefined), true);
    // The browser payload has no toggle at all — only a configuration error when one exists.
    const payload = publicSettings(settings, null);
    assert.equal('deepseekEnabled' in payload, false);
    assert.equal('deepseekSupported' in payload, false);
    assert.equal(payload.deepseekError, null);
    assert.match(publicSettings(settings, null, 'DeepSeek API key file must not be accessible by other users; run chmod 600').deepseekError, /chmod 600/);
    assert.equal(Object.keys(payload).some(key => /key|secret|path/i.test(key)), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a broken DeepSeek credential is reported without breaking the host, a missing one stays silent', async () => {
  const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { deepseekStartupOptions } = await import('../gateway.ts');
  const dir = mkdtempSync(join(tmpdir(), 'pocket-deepseek-broken-'));
  const keyPath = join(dir, 'deepseek-api-key');
  const envBefore = { ...process.env };
  try {
    // No file at all: silently omitted, no error to surface.
    assert.deepEqual(deepseekStartupOptions({}, 'darwin', false, keyPath), { enabled: false });
    assert.deepEqual(deepseekCredentialStatus({}, keyPath), {});
    // Unsafe permissions: omitted, but with a concise configuration error.
    writeFileSync(keyPath, 'synthetic-key', { mode: 0o644 });
    chmodSync(keyPath, 0o644);
    const unsafe = deepseekStartupOptions({}, 'darwin', false, keyPath);
    assert.equal(unsafe.enabled, false);
    assert.match(unsafe.error, /chmod 600/);
    // Invalid content: omitted, error explains why.
    chmodSync(keyPath, 0o600);
    writeFileSync(keyPath, 'synthetic-key\n\n', { mode: 0o600 });
    const invalid = deepseekStartupOptions({}, 'darwin', false, keyPath);
    assert.equal(invalid.enabled, false);
    assert.match(invalid.error, /single line/);
    // An explicitly supplied environment key still wins, and a broken one is reported.
    assert.deepEqual(deepseekStartupOptions({ DEEPSEEK_API_KEY: 'env-key' }, 'darwin', false, keyPath), { enabled: true, key: 'env-key' });
    assert.match(deepseekStartupOptions({ DEEPSEEK_API_KEY: '   ' }, 'darwin', false, keyPath).error, /empty/);
    assert.deepEqual({ ...process.env }, envBefore);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the host key file is validated strictly and rejects unsafe paths', async () => {
  const { mkdtempSync, writeFileSync, chmodSync, mkdirSync, symlinkSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { readDeepseekKeyFile, resolveDeepseekKey } = await import('../deepseek.ts');
  const dir = mkdtempSync(join(tmpdir(), 'pocket-deepseek-file-'));
  const keyPath = join(dir, 'deepseek-api-key');
  try {
    assert.throws(() => readDeepseekKeyFile(keyPath), /no API key file exists/);
    writeFileSync(keyPath, 'synthetic-key', { mode: 0o600 });
    assert.equal(readDeepseekKeyFile(keyPath), 'synthetic-key');
    writeFileSync(keyPath, 'synthetic-key\r\n', { mode: 0o600 });
    assert.equal(readDeepseekKeyFile(keyPath), 'synthetic-key');
    writeFileSync(keyPath, 'synthetic-key\n\n', { mode: 0o600 });
    assert.throws(() => readDeepseekKeyFile(keyPath), /single line/);
    writeFileSync(keyPath, '   ', { mode: 0o600 });
    assert.throws(() => readDeepseekKeyFile(keyPath), /empty/);
    writeFileSync(keyPath, 'synthetic-key', { mode: 0o600 });
    chmodSync(keyPath, 0o644);
    assert.throws(() => readDeepseekKeyFile(keyPath), /not be accessible by other users/);
    chmodSync(keyPath, 0o600);
    // Symlinks, directories, and oversized files are rejected rather than followed.
    const link = join(dir, 'link');
    symlinkSync(keyPath, link);
    assert.throws(() => readDeepseekKeyFile(link), /regular file/);
    assert.throws(() => readDeepseekKeyFile(dir), /regular file/);
    writeFileSync(keyPath, 'x'.repeat(4097), { mode: 0o600 });
    assert.throws(() => readDeepseekKeyFile(keyPath), /unexpectedly large/);
    // The environment key is used without reading the file.
    assert.equal(resolveDeepseekKey({ DEEPSEEK_API_KEY: 'env-key' }, keyPath), 'env-key');
    assert.throws(() => resolveDeepseekKey({ DEEPSEEK_API_KEY: '' }, keyPath), /empty/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an enabled runtime gets the resolved key while other runtimes and browser payloads do not', () => {
  const key = 'synthetic-runtime-key';
  const definition = { id: 'local:deepseek', name: 'Mac mini', ssh: null, deepseek: true, provider: 'deepseek' };
  const runtime = new MachineRuntime({ deepseek: { enabled: true, key } }, definition, () => {});
  try {
    assert.equal(runtime.state.provider, 'deepseek');
    assert.equal(runtime.machineSummary().provider, 'deepseek');
    // The machine keeps its configured name; the provider is separate metadata.
    assert.equal(runtime.machineSummary().name, 'Mac mini');
    assert.equal(runtime.deepseek.proxyOptions().env.DEEPSEEK_API_KEY, key);
    assert.equal(runtime.deepseek.proxyOptions().env.CODEX_HOME, DEEPSEEK_HOME);
    for (const payload of [runtime.snapshot(), runtime.machineSummary(), runtime.diagnostics()]) {
      assert.equal(JSON.stringify(payload).includes(key), false);
    }
    assert.equal(process.env.DEEPSEEK_API_KEY, undefined);
  } finally { void runtime.stop(); }

  const gateway = new PocketGateway({ machines: [{ name: 'Remote', ssh: 'remote' }], deepseek: { enabled: true, key, error: undefined } });
  assert.equal(gateway.runtimes.get('local').deepseek, undefined);
  assert.equal(gateway.runtimes.get('ssh:remote').deepseek, undefined);
  assert.ok(gateway.runtimes.get('local:deepseek').deepseek);
  assert.equal(gateway.runtimes.get('local').machineSummary().provider, 'openai');
  assert.equal(gateway.runtimes.get('ssh:remote').machineSummary().provider, 'openai');
  for (const payload of [gateway.snapshot(), gateway.listMachines()]) {
    assert.equal(JSON.stringify(payload).includes(key), false);
  }
  // Disabling removes the fallback without touching anything else.
  const disabled = new PocketGateway({ machines: [{ name: 'Remote', ssh: 'remote' }], deepseek: { enabled: false } });
  assert.deepEqual([...disabled.runtimes.keys()], ['local', 'ssh:remote']);
});

test('an invalid key affects only DeepSeek while the other runtimes stay available', () => {
  const gateway = new PocketGateway({ machines: [{ name: 'Remote', ssh: 'remote' }], deepseek: { enabled: true, error: 'DeepSeek is enabled but no API key file exists at /tmp/missing.' } });
  assert.deepEqual([...gateway.runtimes.keys()], ['local', 'local:deepseek', 'ssh:remote']);
  const deepseek = gateway.runtimes.get('local:deepseek');
  assert.equal(deepseek.state.provider, 'deepseek');
  assert.match(deepseek.deepseek.redact('no key loaded'), /no key loaded/);
  assert.equal(gateway.runtimes.get('local').deepseek, undefined);
});

test('DeepSeek balance parsing keeps currencies explicit and never fabricates a value', () => {
  const cny = sanitizeDeepseekBalance({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '83.42', granted_balance: '0.00', topped_up_balance: '83.42' }] }, 111);
  assert.deepEqual(cny, { available: true, stale: false, isAvailable: true, entries: [{ currency: 'CNY', total: '83.42' }], updatedAt: 111 });
  const usd = sanitizeDeepseekBalance({ is_available: false, balance_infos: [{ currency: 'usd', total_balance: '0' }] }, 5);
  assert.deepEqual(usd, { available: true, stale: false, isAvailable: false, entries: [{ currency: 'USD', total: '0' }], updatedAt: 5 });
  // Malformed payloads, unknown shapes and unusable amounts are rejected instead of mapped to zero.
  for (const payload of [null, {}, { balance_infos: 'nope' }, { balance_infos: [] }, { balance_infos: [{ currency: '', total_balance: '1' }] },
    { balance_infos: [{ currency: 'CNY', total_balance: 'free' }] }, { balance_infos: [{ currency: 'not a currency', total_balance: '1' }] }]) {
    assert.equal(sanitizeDeepseekBalance(payload), null);
  }
});

test('DeepSeek balance monitor shares one request, marks a last-known value stale and always resolves', async () => {
  const payload = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12.34' }] };
  let calls = 0;
  let resolveFirst;
  const fetchImpl = (url, options) => {
    calls += 1;
    assert.equal(url, DEEPSEEK_BALANCE_URL);
    assert.equal(options.headers.Authorization, 'Bearer synthetic-key');
    if (calls === 1) return new Promise(resolve => { resolveFirst = () => resolve({ ok: true, json: async () => payload }); });
    return Promise.reject(new Error('network down'));
  };
  let clock = 1_000;
  const monitor = new DeepSeekBalanceMonitor({ key: 'synthetic-key' }, { fetchImpl, now: () => clock, minIntervalMs: 5_000 });
  // Two concurrent refreshes share the single in-flight request.
  const first = monitor.refresh();
  const second = monitor.refresh();
  assert.equal(monitor.snapshot(), null);
  resolveFirst();
  assert.deepEqual(await first, await second);
  assert.equal(calls, 1);
  assert.equal(monitor.snapshot().entries[0].total, '12.34');
  // Within the minimum interval an on-demand refresh reuses the cache instead of calling upstream.
  clock += 1_000;
  await monitor.refresh();
  assert.equal(calls, 1);
  // A later failure keeps the last-known balance, clearly marked stale, and never returns zero.
  clock += 10_000;
  const failed = await monitor.refresh();
  assert.equal(calls, 2);
  assert.equal(failed.stale, true);
  assert.equal(failed.available, true);
  assert.equal(failed.entries[0].total, '12.34');
  // A monitor without a usable credential does nothing and resolves to no balance.
  const empty = new DeepSeekBalanceMonitor({ error: 'no key' }, { fetchImpl });
  assert.equal(empty.enabled, false);
  assert.equal(await empty.refresh(), null);
});

test('DeepSeek balance monitor times out a stalled request without throwing and cleans up on stop', async () => {
  const monitor = new DeepSeekBalanceMonitor({ key: 'synthetic-key' }, {
    timeoutMs: 10,
    fetchImpl: (url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  });
  assert.equal(await monitor.refresh(), null);
  // stop() aborts an in-flight request and is safe to call twice.
  const stalled = monitor.refresh({ force: true });
  monitor.stop();
  monitor.stop();
  assert.equal(await stalled, null);
});

test('a late DeepSeek balance response never replaces the OpenAI quota after switching providers', async () => {
  const gateway = new PocketGateway({ machines: [], deepseek: { enabled: true, key: 'synthetic-key' } });
  let releaseBalance = null;
  const balance = { available: true, stale: false, isAvailable: true, entries: [{ currency: 'CNY', total: '83.42' }], updatedAt: 999 };
  const fake = {
    value: null,
    snapshot() { return this.value ? { ...this.value, entries: this.value.entries.map(entry => ({ ...entry })) } : null; },
    refresh() { return new Promise(resolve => { releaseBalance = () => { this.value = balance; resolve(this.snapshot()); }; }); },
    stop() {},
  };
  gateway.balanceMonitor = fake;
  gateway.selectedMachineId = 'local:deepseek';
  gateway.refreshQuotaSource();
  assert.deepEqual(gateway.quota.balance, { available: false, stale: false, isAvailable: null, entries: [], updatedAt: null }, 'an in-flight balance leaves a clearly unavailable slot');
  gateway.updateBalanceWatch();
  // The user switches back to OpenAI while the balance request is still in flight.
  gateway.selectedMachineId = 'local';
  gateway.updateBalanceWatch();
  gateway.runtimes.get('local').state.connected = true;
  gateway.runtimes.get('local').quota = {
    fresh: true, accountId: 'acct', limitId: 'codex', limitName: 'Pro',
    windows: [{ id: 'primary', label: '5h', remainingPercent: 62, usedPercent: 38, windowDurationMins: 300, resetsAt: null }],
    additionalLimitCount: 0, credits: null, updatedAt: 7,
  };
  gateway.refreshQuotaSource();
  assert.equal(gateway.quota.windows.length, 1);
  assert.equal(gateway.quota.balance, null);
  releaseBalance();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(gateway.quota.balance, null, 'the late response is ignored while OpenAI is selected');
  assert.deepEqual(gateway.quota.windows.map(window => window.remainingPercent), [62]);
});
