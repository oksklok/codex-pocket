import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, realpath, access, symlink, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeepSeekHost, deepseekEnabled, deepseekEnvironment, withoutDeepseekKey, deepseekConfig, deepseekArgs, assertDeepseekConfig, constrainDeepseekRequest } from '../deepseek.ts';
import { MachineRuntime, PocketGateway, MessageSubmissions, RpcClient, handleRequest } from '../gateway.ts';
import { rememberComposerDraft } from '../public/pocket-logic.js';

test('DeepSeek opt-in is disabled by default and local macOS only', () => {
  assert.equal(deepseekEnabled({}, 'darwin'), false);
  assert.equal(deepseekEnabled({ POCKET_DEEPSEEK: '1' }, 'darwin'), true);
  for (const platform of ['win32', 'linux']) assert.equal(deepseekEnabled({ POCKET_DEEPSEEK: '1' }, platform), false);
  const previous = process.env.POCKET_DEEPSEEK;
  try {
    delete process.env.POCKET_DEEPSEEK;
    const gateway = new PocketGateway({ machines: [] });
    assert.deepEqual([...gateway.runtimes.keys()], ['local']);
    process.env.POCKET_DEEPSEEK = '1';
    assert.deepEqual([...new PocketGateway({ machines: [{ name: 'Remote', ssh: 'remote' }] }, true).runtimes.keys()], ['ssh:remote']);
    if (process.platform === 'darwin') assert.deepEqual([...new PocketGateway({ machines: [] }).runtimes.keys()], ['local', 'local:deepseek']);
  } finally { if (previous === undefined) delete process.env.POCKET_DEEPSEEK; else process.env.POCKET_DEEPSEEK = previous; }
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
