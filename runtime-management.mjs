// Executed on the execution machine over the existing SSH connection. No resident updater.
import { spawn } from 'node:child_process';
import { readFileSync, realpathSync, existsSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { connect } from 'node:net';
const windows = process.platform === 'win32';
const quotePS = value => `'${String(value).replaceAll("'", "''")}'`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function run(file, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...options, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${file} timed out`)); }, options.timeout ?? 30000);
    child.stdout.on('data', value => { out = (out + value).slice(-100000); });
    child.stderr.on('data', value => { err = (err + value).slice(-100000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out.trim()) : reject(new Error((err || out || `${file} exited ${code}`).trim().slice(-1800))); });
  });
}
const powershell = (script, timeout = 60000) => run('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; ${script}`, 'utf16le').toString('base64')], { timeout });
async function npm(args, cwd) {
  return windows
    ? powershell(`Set-Location ${quotePS(cwd)}; & npm ${args.map(quotePS).join(' ')}; if ($LASTEXITCODE -ne 0) { throw 'npm failed' }`, 240000)
    : run('npm', args, { cwd, timeout: 240000 });
}
export function newer(candidate, installed) {
  const parse = v => /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?/.exec(v ?? '');
  const a = parse(candidate), b = parse(installed);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) if (+a[i] !== +b[i]) return +a[i] > +b[i];
  if (!a[4] || !b[4]) return !a[4] && Boolean(b[4]);
  const x = a[4].split('.'), y = b[4].split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    if (x[i] === undefined) return false;
    if (y[i] === undefined) return true;
    const xn = /^\d+$/.test(x[i]), yn = /^\d+$/.test(y[i]);
    return xn && yn ? +x[i] > +y[i] : xn !== yn ? !xn : x[i] > y[i];
  }
  return false;
}
async function codexExecutable() {
  if (process.env.CODEX_BIN) return realpathSync(process.env.CODEX_BIN);
  const path = windows ? await powershell('(Get-Command codex.exe).Source') : await run('sh', ['-c', 'command -v codex']);
  return realpathSync(path.trim());
}
const controlPath = () => join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'app-server-control', 'app-server-control.sock');
async function socketRunning() {
  return new Promise((resolve, reject) => {
    const socket = connect(controlPath());
    socket.setTimeout(3000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('Codex control socket timed out')); });
    socket.once('error', error => { socket.destroy(); ['ENOENT', 'ECONNREFUSED'].includes(error.code) ? resolve(false) : reject(error); });
  });
}
async function startCodex(exe) {
  if (await socketRunning()) return;
  if (!windows) { await run(exe, ['app-server', 'daemon', 'start']); return; }
  // Windows OpenSSH is elevated. Launch in the user's interactive, limited session, as Codex requires.
  const dir = dirname(controlPath());
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    await powershell(`$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))); Set-Acl -Path ${quotePS(dir)} -AclObject $acl`);
  }
  const script = `Start-Process -FilePath ${quotePS(exe)} -ArgumentList 'app-server','--listen','unix://' -WindowStyle Hidden -RedirectStandardOutput ${quotePS(join(dir, 'pocket-start.stdout.log'))} -RedirectStandardError ${quotePS(join(dir, 'pocket-start.stderr.log'))}`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  if (existsSync(controlPath())) unlinkSync(controlPath()); // Confirmed refused, not an SSH error.
  await powershell(`$shell=New-Object -ComObject Shell.Application; $desktop=$shell.Windows().FindWindowSW(0,0,8,0,1); if (-not $desktop) { throw 'Codex needs a logged-in Windows desktop session' }; $desktop.Document.Application.ShellExecute("$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", '-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encoded}', ${quotePS(homedir())}, 'open', 0)`);
  for (let i = 0; i < 30; i++) { if (await socketRunning()) return; await pause(300); }
  let detail = '';
  try { detail = readFileSync(join(dir, 'pocket-start.stderr.log'), 'utf8').trim().slice(-1000); } catch {}
  throw new Error(detail || 'Codex did not start in the logged-in Windows session');
}
async function stopCodex(exe) {
  if (!await socketRunning()) return;
  if (!windows) { await run(exe, ['app-server', 'daemon', 'stop']); return; }
  // Only the shared server, never proxy connections, terminals, or the other provider.
  await powershell(`$servers=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'codex.exe' -and $_.CommandLine -match ' app-server --listen unix://(?: |$)' }); if ($servers.Count -ne 1) { throw 'Could not identify the shared Codex server' }; $servers | ForEach-Object { Stop-Process -Id $_.ProcessId }`);
  for (let i = 0; i < 30; i++) { if (!await socketRunning()) return; await pause(300); }
  throw new Error('Codex server did not stop');
}
async function codexInfo() {
  const exe = await codexExecutable();
  const installed = (await run(exe, ['--version'])).match(/\d+\.\d+\.\d+(?:-[\w.]+)?/)?.[0];
  let latest = null, error = null;
  try {
    if (/[\\/]node_modules[\\/]/.test(exe)) latest = JSON.parse(await npm(['view', '@openai/codex', 'version', '--json'], homedir()));
    else if (/Cellar|Caskroom/.test(exe)) {
      const value = JSON.parse(await run('brew', ['info', '--json=v2', '--cask', 'codex']));
      latest = value.casks[0].version;
    } else {
      // The standalone installer uses this source, with GitHub Releases as its normal fallback.
      let metadata;
      for (const url of ['https://releases.openai.com/codex/channels/latest', 'https://api.github.com/repos/openai/codex/releases/latest']) {
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
          if (!response.ok) throw new Error(`Codex release source: HTTP ${response.status}`);
          metadata = await response.json();
          break;
        } catch (failure) { if (url.includes('api.github.com')) throw failure; }
      }
      latest = metadata.tag_name.replace(/^rust-v/, '');
    }
  } catch (e) { error = `Latest version: ${e.message}`; }
  return { installed, latest, error, updateAvailable: newer(latest, installed) };
}
async function dshInfo(path) {
  const root = dirname(path);
  const installed = JSON.parse(readFileSync(join(root, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version;
  // Follow the installed release channel, while allowing a newer stable release to supersede it.
  const channel = installed.match(/-(alpha|beta|rc)/)?.[1] ?? 'latest';
  let latest = null, error = null;
  try {
    const tags = JSON.parse(await npm(['view', '@deepseek-ai/dsh', 'dist-tags', '--json'], root));
    latest = tags[channel] || tags.latest;
    if (newer(tags.latest, latest)) latest = tags.latest;
  } catch (e) { error = `Latest version: ${e.message}`; }
  return { installed, latest, channel, error, updateAvailable: newer(latest, installed) };
}
export async function manage(request) {
  if (request.action === 'start') { await startCodex(await codexExecutable()); return {}; }
  if (request.provider === 'openai') {
    if (request.action === 'inspect') return codexInfo();
    const exe = await codexExecutable();
    if (request.action === 'install') {
      const env = { ...process.env, CODEX_NON_INTERACTIVE: '1' };
      if (windows) {
        const path = process.env.Path ?? process.env.PATH;
        for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
        env.Path = `${process.env.SystemRoot}\\System32${delimiter}${path}`;
      }
      await run(exe, ['update'], { env, timeout: 300000 });
    } else if (request.action === 'restart') { await stopCodex(exe); await startCodex(exe); }
    else throw new Error('Unknown Codex operation');
    return {};
  }
  if (!request.path) throw new Error('DSH path is not configured');
  if (request.action === 'inspect') return dshInfo(request.path);
  if (request.action === 'status') {
    const status = JSON.parse(await run(process.execPath, [join(dirname(request.path), 'runtime.mjs'), '--status']));
    if (!status.ok || typeof status.result?.busy !== 'boolean') throw new Error(status.reason || 'DSH did not report runtime status');
    return status.result;
  }
  if (request.action !== 'install') throw new Error('Unknown DSH operation');
  const root = dirname(request.path);
  const marker = join(dirname(root), '.pocket-deploying');
  // Reuse the attach launcher's maintenance marker so reconnect cannot start a half-installed DSH.
  writeFileSync(marker, JSON.stringify({ at: Date.now() }), { flag: 'wx', mode: 0o600 });
  let stopped = false;
  try {
    const result = JSON.parse(await run(process.execPath, [join(root, 'runtime.mjs'), '--stop']));
    if (!result.ok || !result.result?.accepted) throw new Error(result.reason || 'DSH refused shutdown');
    stopped = true;
    await npm(['install', '--save-exact', `@deepseek-ai/dsh@${request.version}`, '--omit=dev', '--no-audit', '--no-fund'], root);
    await run(process.execPath, [join(root, 'runtime.mjs'), '--probe']);
    unlinkSync(marker);
    return {};
  } catch (error) {
    if (stopped) writeFileSync(marker, JSON.stringify({ stuck: true, at: Date.now(), error: error.message }));
    else unlinkSync(marker);
    throw error;
  }
}
