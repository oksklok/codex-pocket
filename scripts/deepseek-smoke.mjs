// Live provider test. Credentials come only from the invoking host environment.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { MachineRuntime } from '../gateway.ts';
import { withoutDeepseekKey } from '../deepseek.ts';

if (!process.env.DEEPSEEK_API_KEY) throw Error('Set DEEPSEEK_API_KEY in this host environment before running the live smoke test.');
if (process.platform !== 'darwin') throw Error('This smoke test supports the local macOS host only.');
const cwd = mkdtempSync(join(tmpdir(), 'pocket-deepseek-smoke-'));
execFileSync('git', ['init', '-q', cwd], { env: withoutDeepseekKey() });
writeFileSync(join(cwd, 'value.txt'), '41\n');
writeFileSync(join(cwd, 'test.py'), 'from pathlib import Path\nassert Path("value.txt").read_text().strip() == "42"\nprint("TEST_OK")\n');
mkdirSync(join(cwd, '.codex'));
writeFileSync(join(cwd, '.codex/config.toml'), 'model = "gpt-5.4"\nmodel_provider = "openai"\n[model_providers.deepseek]\nbase_url = "https://example.invalid"\n');
const definition = { id: 'local:deepseek', name: 'DeepSeek smoke', ssh: null, deepseek: true };
let runtime = new MachineRuntime({}, definition, () => {});
const wait = async (predicate, label, timeout = 120_000) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error('Timed out: ' + label);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
};
async function turn(text, images = []) {
  const sent = await runtime.sendMessage(text, 'start', images);
  await wait(() => runtime.state.turn?.id === sent.turnId && ['completed', 'failed', 'interrupted'].includes(runtime.state.turn.status), 'turn completion');
  assert.equal(runtime.state.turn.status, 'completed', JSON.stringify(runtime.state.turn));
  return runtime.state.liveMessages.filter(m => m.turnId === sent.turnId && m.role === 'assistant').map(m => m.text).join('\n');
}
try {
  await runtime.start(false);
  assert.equal(runtime.state.connected, true, runtime.state.connectionError);
  assert.deepEqual(runtime.state.models.map(m => m.model), ['deepseek-flash']);
  assert.deepEqual(runtime.state.models[0].supportedReasoningEfforts.map(e => e.reasoningEffort), ['low', 'high', 'max']);
  console.log('PASS isolated initialize/model discovery:', runtime.state.userAgent);
  // Trust only this disposable repo in the isolated home, so project config is actually loaded.
  await runtime.rpc.request('config/value/write', { keyPath: `projects.${JSON.stringify(cwd)}.trust_level`, value: 'trusted', mergeStrategy: 'upsert' });
  const effective = await runtime.rpc.request('config/read', { cwd, includeLayers: true });
  assert.equal(effective.config.model_provider, 'deepseek');
  assert.equal(effective.config.model_providers.deepseek.base_url, 'https://api.deepseek.com');
  assert.ok(effective.layers.some(layer => layer.name?.type === 'project' && layer.name.dotCodexFolder === join(cwd, '.codex') && layer.config.model === 'gpt-5.4'), 'Project config layer must be exercised');
  await runtime.taskAction({ action: 'create', name: 'Disposable DeepSeek smoke', cwd, model: 'deepseek-flash', effort: 'low', access: 'full' });
  const threadId = runtime.state.thread.id;
  runtime.autoAttach = true;
  assert.equal(runtime.state.model, 'deepseek-flash');
  assert.equal(runtime.state.access.choices.auto.available, false);
  const output = await turn('Read value.txt and test.py. Use apply_patch to change value.txt from 41 to 42. Run python3 test.py. Also run a shell check that DEEPSEEK_API_KEY and OPENAI_API_KEY are absent (check presence only; never print values). Report TEST_OK and KEYS_ABSENT only if those checks pass.');
  assert.equal(readFileSync(join(cwd, 'value.txt'), 'utf8').trim(), '42');
  assert.match(output, /TEST_OK/); assert.match(output, /KEYS_ABSENT/);
  const history = await runtime.history(null, 20);
  const evidence = JSON.stringify(history);
  assert.match(evidence, /"kind":"files"/);
  assert.match(evidence, /"kind":"command"/);
  console.log('PASS task creation, trusted project override, file read, patch, shell/test, credential exclusion, history');
  const png = readFileSync(new URL('../tests/fixtures/deepseek-smoke.png', import.meta.url)).toString('base64');
  const imageReply = await turn('Read the text and identify the colored shape in the attached image. Do not use tools.', [{ url: `data:image/png;base64,${png}` }]);
  assert.match(imageReply, /red/i);
  assert.match(imageReply, /POCKET\s*42/i);
  console.log('PASS image input:', imageReply);
  const started = await runtime.sendMessage('Run sleep 30 in the shell, then reply WAIT_DONE.', 'start');
  await wait(() => runtime.state.activities.some(a => a.kind === 'commandExecution' || JSON.stringify(a).includes('sleep 30')), 'sleep command');
  await runtime.interruptTurn(threadId, started.turnId);
  await wait(() => runtime.state.turn?.status === 'interrupted', 'Stop', 20_000);
  console.log('PASS Stop');
  // Transport loss uses MachineRuntime's existing reconnect path and the same owned server.
  runtime.rpc.disconnect(new Error('Live smoke transport disconnect'));
  await wait(() => runtime.state.connected && runtime.state.thread?.id === threadId, 'reconnect/resume', 30_000);
  assert.equal(runtime.state.reasoningEffort, 'low');
  assert.match(await turn('Reply exactly RESUMED_OK.'), /RESUMED_OK/);
  console.log('PASS proxy reconnect/resume');
  await runtime.stop();
  runtime = new MachineRuntime({ thread: threadId }, definition, () => {});
  await runtime.start(true);
  assert.equal(runtime.state.thread?.id, threadId);
  assert.equal(runtime.state.reasoningEffort, 'low');
  assert.match(await turn('Reply exactly RESTART_RESUMED_OK.'), /RESTART_RESUMED_OK/);
  console.log('PASS owned server restart and persisted session resume');
  console.log('Disposable workspace:', cwd);
} finally {
  await runtime.stop();
}
