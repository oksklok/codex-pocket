// Executed on the execution machine over the existing SSH connection. Runtime inspection and normal Codex startup.
import { spawn } from 'node:child_process';
import { readFileSync, realpathSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { connect } from 'node:net';
const windows = process.platform === 'win32';
// SSH PATH may expose node through a user shim but omit npm beside the actual Node executable.
if (!windows) process.env.PATH = `${dirname(process.execPath)}${delimiter}${process.env.PATH || ''}`;
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
const powershell = (script, timeout = 60000) => run('powershell', ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; ${script}`, 'utf16le').toString('base64')], { timeout });
async function npm(args, cwd) {
  return windows
    ? powershell(`Set-Location ${quotePS(cwd)}; & npm.cmd ${args.map(quotePS).join(' ')}; if ($LASTEXITCODE -ne 0) { throw 'npm failed' }`, 240000)
    : run('npm', args, { cwd, timeout: 240000 });
}
function newer(candidate, installed) {
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
  // Node on Windows treats these paths as named pipes; Codex uses a native AF_UNIX socket.
  if (windows) {
    try {
      const state = JSON.parse(await run(await codexExecutable(), ['app-server', 'daemon', 'version']));
      if (state.status === 'running') return true;
      if (state.status === 'stopped') return false;
      throw new Error(`Unexpected Codex daemon status: ${state.status}`);
    } catch (error) {
      if (/failed to connect to .*app-server-control\.sock/is.test(error.message) && /os error (?:2|3|10061)\)/.test(error.message)) return false;
      throw error;
    }
  }
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
  return { installed, latest, error };
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
  return { installed, latest, error };
}
export async function manage(request) {
  if (request.action === 'start') { await startCodex(await codexExecutable()); return {}; }
  if (request.action !== 'inspect') throw new Error('Unknown runtime operation');
  if (request.provider === 'openai') return codexInfo();
  if (!request.path) throw new Error('DSH path is not configured');
  return dshInfo(request.path);
}
