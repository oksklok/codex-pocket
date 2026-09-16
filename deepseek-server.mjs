// Private supervisor: IPC disconnect on Pocket exit also stops our server.
// Never print child output: it can contain provider errors or credentials.
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, rm, stat, lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
let server, timer, stopping = false, owned = false, socket;
const home = process.env.CODEX_HOME;
const lock = join(home, 'pocket-owner');
const report = message => { if (process.connected) process.send(message, () => {}); };
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  if (server && server.exitCode === null && server.signalCode === null) {
    await new Promise(resolve => {
      const killTimer = setTimeout(() => server.kill('SIGKILL'), 3000);
      server.once('exit', () => { clearTimeout(killTimer); resolve(); });
      server.kill('SIGTERM');
    });
  }
  if (owned) {
    await rm(socket, { force: true });
    await rm(lock, { recursive: true, force: true });
  }
  process.exit(0);
}
process.on('disconnect', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.once('message', async message => {
  try {
    socket = message.socket;
    if (await realpath(home) !== home) throw Error('DeepSeek home must be an absolute directory without symlinks');
    for (const file of ['config.toml', 'models.json', 'pocket-owner']) {
      try { if ((await lstat(join(home, file))).isSymbolicLink()) throw Error('DeepSeek refuses symlinked configuration or ownership files'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    try { await mkdir(lock, { mode: 0o700 }); }
    catch {
      // A SIGKILL can leave a lock. Never reclaim an endpoint we cannot prove we own.
      const pid = Number(await readFile(join(lock, 'pid'), 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw Error('DeepSeek ownership lock needs inspection: ' + lock);
      try { process.kill(pid, 0); throw Error('DeepSeek runtime is already owned by another Pocket host'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      // Its server may still exist; never attach to it or delete its endpoint.
      throw Error('Stale DeepSeek ownership lock: inspect ' + lock + ' and its endpoint before retrying');
    }
    owned = true;
    await writeFile(join(lock, 'pid'), String(process.pid), { mode: 0o600 });
    try { await stat(socket); throw Error('DeepSeek endpoint already exists; refusing to replace an unowned server'); }
    catch (error) { if (error.code !== 'ENOENT') { owned = false; await rm(lock, { recursive: true }); throw error; } }
    if (stopping) return;
    await writeFile(join(home, 'config.toml'), message.config, { mode: 0o600 });
    await writeFile(join(home, 'models.json'), message.catalog, { mode: 0o600 });
    server = spawn(message.bin, ['app-server', ...message.args, '--listen', 'unix://' + socket], {
      cwd: home, env: process.env, stdio: ['ignore', 'ignore', 'ignore'],
    });
    server.once('spawn', () => { void writeFile(join(lock, 'server-pid'), String(server.pid), { mode: 0o600 }).catch(() => {}); });
    server.once('error', () => { if (!stopping) report({ type: 'error', message: 'Could not start the DeepSeek Codex binary. Check CODEX_BIN.' }); void stop(); });
    server.once('exit', () => { if (!stopping) report({ type: 'error', message: 'DeepSeek Codex server exited. Check CLI compatibility and isolated configuration.' }); void stop(); });
    timer = setInterval(async () => {
      try { if ((await stat(socket)).isSocket()) { clearInterval(timer); report({ type: 'ready' }); } } catch {}
    }, 50);
  } catch (error) {
    report({ type: 'error', message: error.message });
    await stop();
  }
});
