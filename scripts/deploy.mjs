#!/usr/bin/env node
// One deployment command for the Pocket gateway and its execution-side DSH adapter.
//
// Run from a repository checkout on the gateway host:
//   node scripts/deploy.mjs                # gateway image + changed execution-side adapters
//   node scripts/deploy.mjs --gateway-only
//   node scripts/deploy.mjs --adapters-only
//   node scripts/deploy.mjs --dry-run
//   node scripts/deploy.mjs --rollback
//   node scripts/deploy.mjs --settings path/to/.codex-pocket.local.json
//
// Machines, aliases and dshPath values come from the existing Pocket settings; SSH uses the
// deployment's own ./ssh/config. Every update is staged completely and verified by hash and by a
// load probe before any live file is touched, activated only while the durable runtime reports
// idle, verified again afterwards, and rolled back from .pocket-previous if that verification
// fails. A maintenance marker makes attach clients refuse to launch from a half-swapped install.
// Busy, offline or unverifiable machines are reported as pending and a rerun finishes them.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SSH_CONFIG = join(ROOT, "ssh", "config");

export const ADAPTER_FILES = [
  "dsh/endpoint.mjs",
  "dsh/launch.mjs",
  "dsh/runtime.mjs",
  "dsh/bridge.mjs",
  "dsh/projection.mjs",
  "dsh/package.json",
  "dsh/package-lock.json",
  "dsh/pocket.patch.yml",
  "deepseek.ts",
];
export const ADAPTER_NAMES = ADAPTER_FILES.filter((file) => file.startsWith("dsh/")).map((file) => file.slice(4));
// Capabilities an installed adapter must report before this script treats its live runtime as
// safely inspectable. An install without them may predate the durable runtime or may have used the
// earlier `--status` that evicted the attached gateway, so its idle state is never trusted.
export const FEATURES = ["control-socket", "integrity-verify", "idle-only-shutdown"];

// JS one-liners passed to `node -e`. They deliberately avoid double quotes, backticks and `$` so
// the same text is safe inside a POSIX double-quoted string and a PowerShell double-quoted string.
const JS_READ = "try{process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))}catch(e){process.stdout.write('null')}";
const JS_WRITE_MARKER = "require('fs').writeFileSync(process.argv[1],JSON.stringify({at:Date.now()}),{mode:384})";
const JS_STOP_DECISION = "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{let v=null;try{v=JSON.parse(s.trim().split('\\n').filter(Boolean).pop())}catch{};if(v&&v.ok===true&&v.result&&v.result.accepted===true)process.stdout.write('stopped');else if(v&&v.reason==='busy')process.stdout.write('busy');else if(v&&(v.reason==='unreachable'||v.reason==='timeout'))process.stdout.write('stopped');else process.stdout.write('error')})";

const log = (message) => process.stdout.write(`${message}\n`);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// ── Pure helpers (exported for tests) ───────────────────────────────────────
export const isWindowsPath = (value) => /^[a-z]:[\\/]/i.test(value);
export const parentDir = (value) => String(value).replace(/[\\/][^\\/]*$/, "");
export const posixQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
export const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
export const joinPath = (windows, ...parts) => parts.join(windows ? "\\" : "/");

export function parseLastJson(stdout) {
  const lines = String(stdout ?? "").trim().split("\n").filter(Boolean);
  try {
    return JSON.parse(lines.at(-1));
  } catch {
    return null;
  }
}

export function protocolFrom(source, label) {
  const match = /export const DSH_ADAPTER_PROTOCOL = (\d+)/.exec(String(source));
  if (!match) throw new Error(`${label} does not declare DSH_ADAPTER_PROTOCOL`);
  return Number(match[1]);
}

export function localManifest() {
  const files = {};
  for (const file of ADAPTER_FILES) files[file] = sha256(readFileSync(join(ROOT, file)));
  const bundle = sha256(Object.entries(files).sort().map(([name, hash]) => `${name}:${hash}`).join("\n"));
  return { protocol: protocolFrom(readFileSync(join(ROOT, "dsh/projection.mjs"), "utf8"), "dsh/projection.mjs"), bundle, lockHash: files["dsh/package-lock.json"], features: FEATURES, files };
}

// Decide what can happen on one machine without touching it. `liveStatus` is "busy" or "idle" only
// when the installed adapter reported a capability that makes the reading trustworthy.
export function planMachine({ current, manifest, liveStatus, confirmIdle, allowProtocolChange }) {
  const features = Array.isArray(current?.features) ? current.features : [];
  const upToDate = Boolean(
    current && current.bundle === manifest.bundle && current.protocol === manifest.protocol
      && FEATURES.every((feature) => features.includes(feature)),
  );
  const knownProtocol = typeof current?.protocol === "number" ? current.protocol : null;
  const protocolChanged = knownProtocol !== null && knownProtocol !== manifest.protocol;
  if (upToDate) return { action: "current", protocolChanged };
  if (protocolChanged && !allowProtocolChange) {
    return { action: "hold", protocolChanged, reason: `adapter protocol ${knownProtocol}→${manifest.protocol} needs --allow-protocol-change` };
  }
  const verifiable = features.includes("control-socket");
  if (!verifiable) {
    if (!confirmIdle) return { action: "hold", protocolChanged, reason: "runtime idle state unknown on the old install; drain the machine, then pass --confirm-idle" };
    return { action: "update", stopLive: false, protocolChanged };
  }
  if (liveStatus === "busy") return { action: "hold", protocolChanged, reason: "runtime busy" };
  // A trustworthy adapter with no reachable control socket has no running runtime, so no accepted
  // work exists; a reachable idle one is safe to stop atomically inside activation.
  return { action: "update", stopLive: liveStatus === "idle", protocolChanged };
}

// ── Remote script builders (exported for tests) ─────────────────────────────
export function posixStageScript({ bundleRoot, staging, installDeps }) {
  const chmodFiles = ADAPTER_FILES.map((file) => posixQuote(`${staging}/${file}`)).join(" ");
  return [
    "set -eu",
    `STAGE=${posixQuote(staging)}`,
    `BUNDLE=${posixQuote(bundleRoot)}`,
    'rm -rf "$STAGE"',
    'mkdir -p "$STAGE"',
    'tar -xzf - -C "$STAGE"',
    'chmod 755 "$BUNDLE" "$STAGE" "$STAGE/dsh"',
    `chmod 644 ${chmodFiles} ${posixQuote(`${staging}/pocket-manifest.json`)}`,
    ...(installDeps ? ['cd "$STAGE/dsh"', "npm ci --omit=dev --no-audit --no-fund"] : []),
    'node "$STAGE/dsh/runtime.mjs" --verify "$STAGE/pocket-manifest.json"',
    'node "$STAGE/dsh/runtime.mjs" --probe',
    "printf '%s' '{\"ok\":true}'",
  ].join("\n");
}

export function windowsStageScript({ bundleRoot, staging, installDeps }) {
  const lines = [
    "$ErrorActionPreference='Stop'",
    `$BUNDLE = ${psQuote(bundleRoot)}`,
    `$STAGE = ${psQuote(staging)}`,
    'if (Test-Path -LiteralPath $STAGE) { Remove-Item -LiteralPath $STAGE -Recurse -Force }',
    'New-Item -ItemType Directory -Force -Path $STAGE | Out-Null',
    "$tmp = Join-Path $env:TEMP ('pocket-adapter-' + [guid]::NewGuid().ToString('N') + '.tgz')",
    '$stdinStream = [Console]::OpenStandardInput()',
    '$output = [IO.File]::Create($tmp)',
    'try { $stdinStream.CopyTo($output) } finally { $output.Dispose() }',
    '& tar -xzf $tmp -C $STAGE',
    "if ($LASTEXITCODE -ne 0) { throw 'adapter archive could not be extracted' }",
    'Remove-Item -LiteralPath $tmp -Force',
  ];
  if (installDeps) {
    lines.push("Push-Location (Join-Path $STAGE 'dsh')");
    lines.push('try { & npm ci --omit=dev --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw \'dependency install failed\' } } finally { Pop-Location }');
  }
  lines.push("& node (Join-Path $STAGE 'dsh/runtime.mjs') --verify (Join-Path $STAGE 'pocket-manifest.json')");
  lines.push("if ($LASTEXITCODE -ne 0) { throw 'staged adapter failed verification' }");
  lines.push("& node (Join-Path $STAGE 'dsh/runtime.mjs') --probe");
  lines.push("if ($LASTEXITCODE -ne 0) { throw 'staged adapter failed its load probe' }");
  lines.push("Write-Output '{\"ok\":true}'");
  return lines.join("\n");
}

function posixRestore(bundleRootPath, dshDirPath, previous) {
  return [
    `if [ -f ${posixQuote(`${previous}/.pocket-adapter.json`)} ]; then cp -f ${posixQuote(`${previous}/.pocket-adapter.json`)} ${posixQuote(`${dshDirPath}/.pocket-adapter.json`)}; else rm -f ${posixQuote(`${dshDirPath}/.pocket-adapter.json`)}; fi`,
    ...ADAPTER_NAMES.map((file) => `if [ -f ${posixQuote(`${previous}/dsh/${file}`)} ]; then cp -f ${posixQuote(`${previous}/dsh/${file}`)} ${posixQuote(`${dshDirPath}/${file}`)}; fi`),
    `if [ -f ${posixQuote(`${previous}/deepseek.ts`)} ]; then cp -f ${posixQuote(`${previous}/deepseek.ts`)} ${posixQuote(`${bundleRootPath}/deepseek.ts`)}; fi`,
    `if [ -d ${posixQuote(`${previous}/node_modules`)} ]; then rm -rf ${posixQuote(`${dshDirPath}/node_modules`)}; mv ${posixQuote(`${previous}/node_modules`)} ${posixQuote(`${dshDirPath}/node_modules`)}; fi`,
  ];
}

export function posixActivateScript({ bundleRoot, dshDir, staging, stopLive }) {
  const previous = joinPath(false, bundleRoot, ".pocket-previous");
  const marker = joinPath(false, bundleRoot, ".pocket-deploying");
  return [
    "set -eu",
    `BUNDLE=${posixQuote(bundleRoot)}`,
    `DSH=${posixQuote(dshDir)}`,
    `STAGE=${posixQuote(staging)}`,
    `PREV=${posixQuote(previous)}`,
    `MARKER=${posixQuote(marker)}`,
    `STOP_LIVE=${stopLive ? 1 : 0}`,
    `node -e "${JS_WRITE_MARKER}" "$MARKER"`,
    'if [ "$STOP_LIVE" = "1" ]; then',
    // The refusal itself (busy) is a normal outcome carried in the JSON, so its nonzero exit must
    // not be treated as a script failure nor clobber the captured status.
    "  set +e",
    '  STOP_JSON=$(node "$DSH/runtime.mjs" --stop 2>/dev/null)',
    "  set -e",
    `  DECISION=$(printf '%s' "$STOP_JSON" | node -e "${JS_STOP_DECISION}")`,
    '  if [ "$DECISION" = "busy" ]; then rm -f "$MARKER"; printf \'%s\' \'{"ok":false,"reason":"busy"}\'; exit 3; fi',
    '  if [ "$DECISION" = "error" ]; then rm -f "$MARKER"; printf \'%s\' \'{"ok":false,"reason":"stop-failed"}\'; exit 5; fi',
    "fi",
    'rm -rf "$PREV"',
    'mkdir -p "$PREV/dsh"',
    'if [ -f "$DSH/.pocket-adapter.json" ]; then cp -f "$DSH/.pocket-adapter.json" "$PREV/.pocket-adapter.json"; fi',
    ...ADAPTER_NAMES.map((file) => `if [ -f "$DSH/${file}" ]; then cp -f "$DSH/${file}" "$PREV/dsh/${file}"; fi`),
    'if [ -f "$BUNDLE/deepseek.ts" ]; then cp -f "$BUNDLE/deepseek.ts" "$PREV/deepseek.ts"; fi',
    ...ADAPTER_NAMES.map((file) => `cp -f "$STAGE/dsh/${file}" "$DSH/${file}"`),
    'cp -f "$STAGE/deepseek.ts" "$BUNDLE/deepseek.ts"',
    'cp -f "$STAGE/pocket-manifest.json" "$DSH/.pocket-adapter.json"',
    'chmod 755 "$DSH"',
    ...ADAPTER_NAMES.map((file) => `chmod 644 "$DSH/${file}"`),
    'chmod 644 "$DSH/.pocket-adapter.json"',
    'if [ -d "$STAGE/dsh/node_modules" ]; then rm -rf "$PREV/node_modules"; if [ -d "$DSH/node_modules" ]; then mv "$DSH/node_modules" "$PREV/node_modules"; fi; mv "$STAGE/dsh/node_modules" "$DSH/node_modules"; fi',
    'if ! node "$DSH/runtime.mjs" --verify "$DSH/.pocket-adapter.json" >/dev/null 2>&1 || ! node "$DSH/runtime.mjs" --probe >/dev/null 2>&1; then',
    ...posixRestore(bundleRoot, dshDir, previous).map((line) => `  ${line}`),
    '  rm -f "$MARKER"',
    "  printf '%s' '{\"ok\":false,\"reason\":\"activation-verify-failed\",\"rolledBack\":true}'",
    "  exit 6",
    "fi",
    'rm -f "$MARKER"',
    "printf '%s' '{\"ok\":true}'",
  ].join("\n");
}

function windowsRestore(bundleRootPath, dshDirPath, previous) {
  return [
    `if (Test-Path -LiteralPath (Join-Path ${psQuote(previous)} '.pocket-adapter.json')) { Copy-Item -Force (Join-Path ${psQuote(previous)} '.pocket-adapter.json') (Join-Path ${psQuote(dshDirPath)} '.pocket-adapter.json') } else { Remove-Item -LiteralPath (Join-Path ${psQuote(dshDirPath)} '.pocket-adapter.json') -Force -ErrorAction SilentlyContinue }`,
    ...ADAPTER_NAMES.map((file) => `if (Test-Path -LiteralPath (Join-Path ${psQuote(previous)} 'dsh/${file}')) { Copy-Item -Force (Join-Path ${psQuote(previous)} 'dsh/${file}') (Join-Path ${psQuote(dshDirPath)} '${file}') }`),
    `if (Test-Path -LiteralPath (Join-Path ${psQuote(previous)} 'deepseek.ts')) { Copy-Item -Force (Join-Path ${psQuote(previous)} 'deepseek.ts') (Join-Path ${psQuote(bundleRootPath)} 'deepseek.ts') }`,
    `if (Test-Path -LiteralPath (Join-Path ${psQuote(previous)} 'node_modules')) { Remove-Item -LiteralPath (Join-Path ${psQuote(dshDirPath)} 'node_modules') -Recurse -Force -ErrorAction SilentlyContinue; Move-Item -LiteralPath (Join-Path ${psQuote(previous)} 'node_modules') -Destination (Join-Path ${psQuote(dshDirPath)} 'node_modules') }`,
  ];
}

export function windowsActivateScript({ bundleRoot, dshDir, staging, stopLive }) {
  const previous = joinPath(true, bundleRoot, ".pocket-previous");
  const marker = joinPath(true, bundleRoot, ".pocket-deploying");
  const lines = [
    "$ErrorActionPreference='Stop'",
    `$BUNDLE = ${psQuote(bundleRoot)}`,
    `$DSH = ${psQuote(dshDir)}`,
    `$STAGE = ${psQuote(staging)}`,
    `$PREV = ${psQuote(previous)}`,
    `$MARKER = ${psQuote(marker)}`,
    `$STOP_LIVE = ${stopLive ? 1 : 0}`,
    "$mutated = $false",
    "function Restore {",
    ...windowsRestore(bundleRoot, dshDir, previous).map((line) => `  ${line}`),
    "}",
    "try {",
    `  & node -e "${JS_WRITE_MARKER}" $MARKER`,
    "  if ($LASTEXITCODE -ne 0) { throw 'maintenance marker could not be written' }",
    "  if ($STOP_LIVE -eq 1) {",
    "    $stopJson = & node (Join-Path $DSH 'runtime.mjs') --stop 2>$null",
    "    $stopCode = $LASTEXITCODE",
    "    $stopResult = $null",
    "    try { $stopResult = (($stopJson | Select-Object -Last 1) | ConvertFrom-Json) } catch {}",
    "    if ($stopResult -and $stopResult.reason -eq 'busy') { Remove-Item -LiteralPath $MARKER -Force; Write-Output '{\"ok\":false,\"reason\":\"busy\"}'; exit 3 }",
    "    if ($stopCode -ne 0 -and -not ($stopResult -and ($stopResult.reason -eq 'unreachable' -or $stopResult.reason -eq 'timeout'))) { Remove-Item -LiteralPath $MARKER -Force; Write-Output '{\"ok\":false,\"reason\":\"stop-failed\"}'; exit 5 }",
    "  }",
    "  if (Test-Path -LiteralPath $PREV) { Remove-Item -LiteralPath $PREV -Recurse -Force }",
    "  New-Item -ItemType Directory -Force -Path (Join-Path $PREV 'dsh') | Out-Null",
    "  if (Test-Path -LiteralPath (Join-Path $DSH '.pocket-adapter.json')) { Copy-Item -Force (Join-Path $DSH '.pocket-adapter.json') (Join-Path $PREV '.pocket-adapter.json') }",
    ...ADAPTER_NAMES.map((file) => `  if (Test-Path -LiteralPath (Join-Path $DSH '${file}')) { Copy-Item -Force (Join-Path $DSH '${file}') (Join-Path $PREV 'dsh/${file}') }`),
    "  if (Test-Path -LiteralPath (Join-Path $BUNDLE 'deepseek.ts')) { Copy-Item -Force (Join-Path $BUNDLE 'deepseek.ts') (Join-Path $PREV 'deepseek.ts') }",
    "  $mutated = $true",
    ...ADAPTER_NAMES.map((file) => `  Copy-Item -Force (Join-Path $STAGE 'dsh/${file}') (Join-Path $DSH '${file}')`),
    "  Copy-Item -Force (Join-Path $STAGE 'deepseek.ts') (Join-Path $BUNDLE 'deepseek.ts')",
    "  Copy-Item -Force (Join-Path $STAGE 'pocket-manifest.json') (Join-Path $DSH '.pocket-adapter.json')",
    "  if (Test-Path -LiteralPath (Join-Path $STAGE 'dsh/node_modules')) { Remove-Item -LiteralPath (Join-Path $PREV 'node_modules') -Recurse -Force -ErrorAction SilentlyContinue; if (Test-Path -LiteralPath (Join-Path $DSH 'node_modules')) { Move-Item -LiteralPath (Join-Path $DSH 'node_modules') -Destination (Join-Path $PREV 'node_modules') }; Move-Item -LiteralPath (Join-Path $STAGE 'dsh/node_modules') -Destination (Join-Path $DSH 'node_modules') }",
    "  & node (Join-Path $DSH 'runtime.mjs') --verify (Join-Path $DSH '.pocket-adapter.json')",
    "  if ($LASTEXITCODE -ne 0) { throw 'activated adapter failed verification' }",
    "  & node (Join-Path $DSH 'runtime.mjs') --probe",
    "  if ($LASTEXITCODE -ne 0) { throw 'activated adapter failed its load probe' }",
    "  Remove-Item -LiteralPath $MARKER -Force",
    "  Write-Output '{\"ok\":true}'",
    "} catch {",
    "  if ($mutated) { Restore }",
    "  Remove-Item -LiteralPath $MARKER -Force -ErrorAction SilentlyContinue",
    "  Write-Output '{\"ok\":false,\"reason\":\"activation-verify-failed\",\"rolledBack\":true}'",
    "  exit 6",
    "}",
  ];
  return lines.join("\n");
}

// ── Rollback ────────────────────────────────────────────────────────────────
// A rollback restores from .pocket-previous in place. It never takes a snapshot of the install it
// is replacing, so it can never delete the very copy it is restoring from.
function posixStopBlock() {
  return [
    'if [ "$STOP_LIVE" = "1" ]; then',
    "  set +e",
    '  STOP_JSON=$(node "$DSH/runtime.mjs" --stop 2>/dev/null)',
    "  set -e",
    `  DECISION=$(printf '%s' "$STOP_JSON" | node -e "${JS_STOP_DECISION}")`,
    '  if [ "$DECISION" = "busy" ]; then rm -f "$MARKER"; printf \'%s\' \'{"ok":false,"reason":"busy"}\'; exit 3; fi',
    '  if [ "$DECISION" = "error" ]; then rm -f "$MARKER"; printf \'%s\' \'{"ok":false,"reason":"stop-failed"}\'; exit 5; fi',
    "fi",
  ];
}

export function posixRollbackScript({ bundleRoot, dshDir, stopLive }) {
  const previous = joinPath(false, bundleRoot, ".pocket-previous");
  const marker = joinPath(false, bundleRoot, ".pocket-deploying");
  return [
    "set -eu",
    `BUNDLE=${posixQuote(bundleRoot)}`,
    `DSH=${posixQuote(dshDir)}`,
    `PREV=${posixQuote(previous)}`,
    `MARKER=${posixQuote(marker)}`,
    `STOP_LIVE=${stopLive ? 1 : 0}`,
    'if [ ! -f "$PREV/.pocket-adapter.json" ]; then printf \'%s\' \'{"ok":false,"reason":"no-previous"}\'; exit 4; fi',
    `node -e "${JS_WRITE_MARKER}" "$MARKER"`,
    ...posixStopBlock(),
    ...posixRestore(bundleRoot, dshDir, previous),
    'chmod 755 "$DSH"',
    ...ADAPTER_NAMES.map((file) => `chmod 644 "$DSH/${file}"`),
    'if ! node "$DSH/runtime.mjs" --probe >/dev/null 2>&1; then rm -f "$MARKER"; printf \'%s\' \'{"ok":false,"reason":"rollback-verify-failed"}\'; exit 6; fi',
    'rm -f "$MARKER"',
    "printf '%s' '{\"ok\":true}'",
  ].join("\n");
}

export function windowsRollbackScript({ bundleRoot, dshDir, stopLive }) {
  const previous = joinPath(true, bundleRoot, ".pocket-previous");
  const marker = joinPath(true, bundleRoot, ".pocket-deploying");
  return [
    "$ErrorActionPreference='Stop'",
    `$BUNDLE = ${psQuote(bundleRoot)}`,
    `$DSH = ${psQuote(dshDir)}`,
    `$PREV = ${psQuote(previous)}`,
    `$MARKER = ${psQuote(marker)}`,
    `$STOP_LIVE = ${stopLive ? 1 : 0}`,
    `if (-not (Test-Path -LiteralPath (Join-Path $PREV '.pocket-adapter.json'))) { Write-Output '{"ok":false,"reason":"no-previous"}'; exit 4 }`,
    "try {",
    `  & node -e "${JS_WRITE_MARKER}" $MARKER`,
    "  if ($LASTEXITCODE -ne 0) { throw 'maintenance marker could not be written' }",
    "  if ($STOP_LIVE -eq 1) {",
    "    $stopJson = & node (Join-Path $DSH 'runtime.mjs') --stop 2>$null",
    "    $stopCode = $LASTEXITCODE",
    "    $stopResult = $null",
    "    try { $stopResult = (($stopJson | Select-Object -Last 1) | ConvertFrom-Json) } catch {}",
    "    if ($stopResult -and $stopResult.reason -eq 'busy') { Remove-Item -LiteralPath $MARKER -Force; Write-Output '{\"ok\":false,\"reason\":\"busy\"}'; exit 3 }",
    "    if ($stopCode -ne 0 -and -not ($stopResult -and ($stopResult.reason -eq 'unreachable' -or $stopResult.reason -eq 'timeout'))) { Remove-Item -LiteralPath $MARKER -Force; Write-Output '{\"ok\":false,\"reason\":\"stop-failed\"}'; exit 5 }",
    "  }",
    ...windowsRestore(bundleRoot, dshDir, previous).map((line) => `  ${line}`),
    "  & node (Join-Path $DSH 'runtime.mjs') --probe",
    "  if ($LASTEXITCODE -ne 0) { throw 'rolled-back adapter failed its load probe' }",
    "  Remove-Item -LiteralPath $MARKER -Force",
    "  Write-Output '{\"ok\":true}'",
    "} catch {",
    "  Remove-Item -LiteralPath $MARKER -Force -ErrorAction SilentlyContinue",
    "  Write-Output '{\"ok\":false,\"reason\":\"rollback-verify-failed\"}'",
    "  exit 6",
    "}",
  ].join("\n");
}

// ── Process plumbing ────────────────────────────────────────────────────────
function run(command, commandArgs, { input = null, timeout = 120_000, cwd = undefined } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, commandArgs, { stdio: ["pipe", "pipe", "pipe"], cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    timer.unref();
    child.on("error", (error) => { clearTimeout(timer); resolvePromise({ code: -1, stdout, stderr: String(error.message || error) }); });
    child.on("close", (code) => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
    child.stdin.end(input || undefined);
  });
}

const sshBase = () => [
  ...(existsSync(SSH_CONFIG) ? ["-F", SSH_CONFIG] : []),
  "-T",
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=8",
  "-o", "ServerAliveInterval=15",
  "-o", "ServerAliveCountMax=2",
];

// Run a shell script on a machine; Windows hosts get an encoded PowerShell command because their
// default SSH shell is cmd. Only logic travels this way; the archive always travels on stdin, so a
// large payload can never overflow a Windows command line.
function sshArgs(machine, script) {
  const base = sshBase();
  if (isWindowsPath(machine.dshPath)) {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    return [...base, machine.ssh, `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`];
  }
  return [...base, machine.ssh, script];
}

const ssh = (machine, script, options) => run("ssh", sshArgs(machine, script), options);

async function buildArchive(manifest) {
  const dir = mkdtempSync(join(tmpdir(), "pocket-deploy-"));
  try {
    for (const file of ADAPTER_FILES) {
      const destination = join(dir, file);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(ROOT, file), destination);
      chmodSync(destination, 0o644);
    }
    writeFileSync(join(dir, "pocket-manifest.json"), JSON.stringify(manifest), { mode: 0o644 });
    const child = spawn("tar", ["-czf", "-", "-C", dir, "."], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    const code = await new Promise((resolvePromise) => child.on("close", resolvePromise));
    if (code !== 0) throw new Error("Could not create the adapter archive");
    return Buffer.concat(chunks);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Machine inspection / staging / activation ───────────────────────────────
function settingsPath() {
  const index = process.argv.indexOf("--settings");
  const explicit = index >= 0 ? process.argv[index + 1] : null;
  if (explicit) return resolve(explicit);
  const dataDir = process.env.CODEX_POCKET_DATA_DIR || join(ROOT, "data");
  return join(dataDir, ".codex-pocket.local.json");
}

function readMachines() {
  const path = settingsPath();
  if (!existsSync(path)) throw new Error(`Pocket settings not found: ${path}`);
  const config = JSON.parse(readFileSync(path, "utf8"));
  return Array.isArray(config.machines) ? config.machines : [];
}

const manifestPath = (windows, dshDir) => joinPath(windows, dshDir, ".pocket-adapter.json");
const runtimePath = (windows, dshDir) => joinPath(windows, dshDir, "runtime.mjs");

async function inspectMachine(machine, manifest, options) {
  const name = machine.name || machine.ssh;
  const dshDir = parentDir(machine.dshPath);
  const windows = isWindowsPath(machine.dshPath);
  const entry = { name, machine, dshDir, windows };
  const reachable = await ssh(machine, "echo pocket-deploy-ok");
  if (reachable.code !== 0) return { ...entry, current: null, liveStatus: null, verifiable: false, action: "hold", reason: "offline" };
  const readCommand = windows
    ? `& node -e "${JS_READ}" ${psQuote(manifestPath(windows, dshDir))}`
    : `node -e "${JS_READ}" ${posixQuote(manifestPath(windows, dshDir))}`;
  const current = parseLastJson((await ssh(machine, readCommand)).stdout);
  const verifiable = Boolean(current && Array.isArray(current.features) && current.features.includes("control-socket"));
  let liveStatus = null;
  if (verifiable) {
    const statusCommand = windows
      ? `& node ${psQuote(runtimePath(windows, dshDir))} --status`
      : `node ${posixQuote(runtimePath(windows, dshDir))} --status`;
    const parsed = parseLastJson((await ssh(machine, statusCommand)).stdout);
    // An unreachable control socket on a capable install means no runtime is running: idle.
    liveStatus = parsed?.result?.busy === true ? "busy" : "idle";
  }
  return { ...entry, current, liveStatus, verifiable, ...planMachine({ current, manifest, liveStatus, ...options }) };
}

async function stageMachine(entry, manifest, archive) {
  const { machine, dshDir, windows, current } = entry;
  const bundleRoot = parentDir(dshDir);
  const staging = joinPath(windows, bundleRoot, `.pocket-staging-${manifest.bundle.slice(0, 12)}`);
  const installDeps = current?.lockHash !== manifest.lockHash;
  const script = windows
    ? windowsStageScript({ bundleRoot, staging, installDeps })
    : posixStageScript({ bundleRoot, staging, installDeps });
  const result = await ssh(machine, script, { input: archive, timeout: 900_000 });
  if (result.code !== 0) {
    return { ...entry, action: "hold", reason: `staging failed (${parseLastJson(result.stdout)?.reason ?? result.code})` };
  }
  return { ...entry, staging, installDeps };
}

async function activateMachine(entry) {
  const { machine, dshDir, windows, staging, stopLive } = entry;
  const bundleRoot = parentDir(dshDir);
  const script = windows
    ? windowsActivateScript({ bundleRoot, dshDir, staging, stopLive })
    : posixActivateScript({ bundleRoot, dshDir, staging, stopLive });
  const result = await ssh(machine, script, { timeout: 300_000 });
  const payload = parseLastJson(result.stdout);
  if (result.code === 0 && payload?.ok === true) {
    const cleanup = windows ? `Remove-Item -LiteralPath ${psQuote(staging)} -Recurse -Force -ErrorAction SilentlyContinue` : `rm -rf ${posixQuote(staging)}`;
    await ssh(machine, cleanup, { timeout: 120_000 });
    return { ...entry, action: "updated" };
  }
  return { ...entry, action: "hold", reason: `activation failed (${payload?.reason ?? result.code})`, rolledBack: payload?.rolledBack === true };
}

async function rollbackMachine(entry, confirmIdle) {
  const { machine, dshDir, windows, verifiable, liveStatus } = entry;
  const bundleRoot = parentDir(dshDir);
  if (!verifiable && !confirmIdle) return { ...entry, action: "hold", reason: "rollback needs a drained machine; pass --confirm-idle" };
  if (verifiable && liveStatus === "busy") return { ...entry, action: "hold", reason: "runtime busy" };
  const script = windows
    ? windowsRollbackScript({ bundleRoot, dshDir, stopLive: verifiable && liveStatus === "idle" })
    : posixRollbackScript({ bundleRoot, dshDir, stopLive: verifiable && liveStatus === "idle" });
  const result = await ssh(machine, script, { timeout: 300_000 });
  const payload = parseLastJson(result.stdout);
  if (result.code === 0 && payload?.ok === true) return { ...entry, action: "rolled back" };
  return { ...entry, action: "hold", reason: `rollback failed (${payload?.reason ?? result.code})` };
}

// Read the protocol an installed adapter currently declares. A machine that cannot be reached, or
// that has no deployment manifest, is not compatible with the gateway.
async function liveProtocol(entry) {
  const { machine, dshDir, windows } = entry;
  const readCommand = windows
    ? `& node -e "${JS_READ}" ${psQuote(manifestPath(windows, dshDir))}`
    : `node -e "${JS_READ}" ${posixQuote(manifestPath(windows, dshDir))}`;
  const value = parseLastJson((await ssh(machine, readCommand)).stdout);
  return typeof value?.protocol === "number" ? value.protocol : null;
}

async function incompatibleMachines(entries, manifest) {
  const incompatible = [];
  for (const entry of entries) {
    const protocol = await liveProtocol(entry);
    if (protocol !== manifest.protocol) incompatible.push({ ...entry, liveProtocol: protocol });
  }
  return incompatible;
}

// ── Gateway ─────────────────────────────────────────────────────────────────
async function composeImageRef() {
  const list = await run("docker", ["compose", "ps", "-q", "pocket"], { cwd: ROOT });
  const container = list.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (!container) return null;
  const inspect = await run("docker", ["inspect", "--format", "{{.Config.Image}}", container], { cwd: ROOT });
  return inspect.code === 0 ? inspect.stdout.trim() || null : null;
}

async function retainGatewayImage() {
  const ref = await composeImageRef();
  if (!ref) return null;
  const tag = `codex-pocket-gateway:previous`;
  return (await run("docker", ["tag", ref, tag], { cwd: ROOT })).code === 0 ? { ref, tag } : null;
}

async function imageProtocol() {
  const js = "const s=require('fs').readFileSync('/app/gateway.ts','utf8');const m=/export const DSH_ADAPTER_PROTOCOL = (\\d+)/.exec(s);console.log(JSON.stringify({protocol:m?Number(m[1]):null}))";
  const probe = await run("docker", ["compose", "run", "--rm", "--no-deps", "-T", "--entrypoint", "node", "pocket", "-e", js], { cwd: ROOT, timeout: 120_000 });
  return parseLastJson(probe.stdout)?.protocol ?? null;
}

async function gatewayState() {
  const path = settingsPath();
  let pin = null;
  try { pin = JSON.parse(readFileSync(path, "utf8")).pin; } catch {}
  if (!/^\d{4}$/.test(pin ?? "")) return { state: "unknown", reason: "no access PIN is configured" };
  const base = "http://127.0.0.1:4173";
  const jar = join(tmpdir(), "pocket-deploy.jar");
  const login = await run("curl", ["-s", "-c", jar, "-X", "POST", "-H", "Content-Type: application/json", "-H", `Origin: ${base}`, "--data", JSON.stringify({ pin }), "--max-time", "4", `${base}/api/login`]);
  if (login.code !== 0) return { state: "unknown", reason: "the gateway did not answer" };
  const state = await run("curl", ["-s", "-b", jar, "--max-time", "4", `${base}/api/state`]);
  const value = parseLastJson(state.stdout);
  if (!value || typeof value !== "object") return { state: "unknown", reason: "the gateway state could not be read" };
  const busy = value.turn?.status === "inProgress" || String(value.threadStatus ?? "").startsWith("active") || value.phase === "working";
  return busy ? { state: "busy" } : { state: "idle" };
}

// ── Entry point ─────────────────────────────────────────────────────────────
export async function main(argv = process.argv.slice(2)) {
  const has = (flag) => argv.includes(flag);
  const option = (name) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] ?? null : null; };
  const dryRun = has("--dry-run");
  const gatewayOnly = has("--gateway-only");
  const adaptersOnly = has("--adapters-only");
  const rollback = has("--rollback");
  const confirmIdle = has("--confirm-idle");
  const allowProtocolChange = has("--allow-protocol-change");
  const only = option("--machine");
  if (gatewayOnly && adaptersOnly) { log("choose --gateway-only or --adapters-only, not both"); process.exitCode = 1; return; }

  const manifest = localManifest();
  log(`adapter protocol ${manifest.protocol}, bundle ${manifest.bundle.slice(0, 12)}`);

  const machines = readMachines().filter((machine) => machine.ssh && machine.dshPath && (!only || machine.name === only || machine.ssh === only));
  if (!gatewayOnly && !machines.length) log("no matching execution machines with dshPath configured");

  if (rollback) {
    if (!machines.length) log("nothing to roll back");
    for (const machine of machines) {
      const entry = await inspectMachine(machine, manifest, { confirmIdle: true, allowProtocolChange: true });
      if (entry.action === "hold" && entry.reason === "offline") { log(`${entry.name}: pending (offline)`); continue; }
      const result = await rollbackMachine(entry, confirmIdle);
      log(result.action === "rolled back" ? `${result.name}: rolled back` : `${result.name}: pending (${result.reason})`);
    }
    return;
  }

  // Pass 1: read-only inspection of every machine, so a protocol transition can be refused before
  // anything on any host or in the image cache is modified.
  const inspected = [];
  for (const machine of machines) inspected.push(await inspectMachine(machine, manifest, { confirmIdle, allowProtocolChange }));
  for (const entry of inspected) {
    if (entry.action === "current") log(`${entry.name}: up to date`);
    else if (entry.action === "update") log(`${entry.name}: ${dryRun ? "would update" : "ready to update"} (live ${entry.verifiable ? entry.liveStatus : "idle state unknown"})`);
    else log(`${entry.name}: pending (${entry.reason})`);
  }
  const protocolTransition = inspected.some((entry) => entry.protocolChanged);
  const blockers = inspected.filter((entry) => entry.action === "hold");
  // A protocol change must move the whole fleet or none of it: an offline machine has an unknown
  // protocol, and updating only part of the fleet would leave the other half unusable either way.
  if ((protocolTransition || allowProtocolChange) && blockers.length) {
    for (const entry of blockers) log(`${entry.name}: blocks the protocol update (${entry.reason})`);
    log("a protocol change is pending and not every machine can be updated; nothing was activated");
    process.exitCode = 1;
    return;
  }

  if (gatewayOnly) {
    if (protocolFrom(readFileSync(join(ROOT, "gateway.ts"), "utf8"), "gateway.ts") !== manifest.protocol) {
      log("gateway.ts and dsh/projection.mjs disagree on the adapter protocol; nothing was changed");
      process.exitCode = 1;
      return;
    }
    // A gateway-only update must never create a fleet it cannot talk to. Every machine that the
    // gateway would attach to must already declare the new protocol.
    const incompatible = await incompatibleMachines(inspected, manifest);
    if (incompatible.length) {
      for (const entry of incompatible) log(`${entry.name}: blocking gateway-only update (adapter protocol ${entry.liveProtocol ?? "unknown"})`);
      log("run the full deploy so the execution adapters are updated with the gateway");
      process.exitCode = 1;
      return;
    }
  }

  let retained = null;
  if (!adaptersOnly) {
    if (protocolFrom(readFileSync(join(ROOT, "gateway.ts"), "utf8"), "gateway.ts") !== manifest.protocol) {
      log("gateway.ts and dsh/projection.mjs disagree on the adapter protocol; nothing was changed");
      process.exitCode = 1;
      return;
    }
    log("building the gateway image…");
    if (!dryRun) {
      retained = await retainGatewayImage();
      const built = await run("docker", ["compose", "build", "pocket"], { cwd: ROOT, timeout: 900_000 });
      if (built.code !== 0) {
        log(`gateway build failed: ${(built.stderr || built.stdout).slice(-1000)}`);
        process.exitCode = 1;
        return;
      }
      const builtProtocol = await imageProtocol();
      if (builtProtocol !== manifest.protocol) {
        log(`built gateway speaks adapter protocol ${builtProtocol ?? "unknown"}, expected ${manifest.protocol}; nothing was activated`);
        process.exitCode = 1;
        return;
      }
      log(`gateway image verified (adapter protocol ${builtProtocol})`);
    }
  }

  // Pass 2: stage and self-verify on every machine before anything is activated.
  const archive = inspected.some((entry) => entry.action === "update") && !dryRun ? await buildArchive(manifest) : null;
  const staged = [];
  for (const entry of inspected) {
    if (entry.action !== "update" || dryRun) { staged.push(entry); continue; }
    const result = await stageMachine(entry, manifest, archive);
    if (result.action === "hold") log(`${result.name}: pending (${result.reason})`);
    staged.push(result);
  }
  const stageFailure = staged.some((entry) => entry.reason?.startsWith("staging failed"));
  if (protocolTransition && stageFailure) {
    log("a protocol change is pending and staging failed; nothing was activated");
    process.exitCode = 1;
    return;
  }

  // Pass 3: idle-only activation, each machine verified after the swap.
  const activated = [];
  for (const entry of staged) {
    if (entry.action !== "update" || dryRun) { activated.push(entry); continue; }
    const result = await activateMachine(entry);
    log(result.action === "updated" ? `${result.name}: updated` : `${result.name}: pending (${result.reason}${result.rolledBack ? ", restored the previous install" : ""})`);
    activated.push(result);
  }
  if (dryRun) {
    log("dry run: no files, images or containers were changed");
    return;
  }

  if (!adaptersOnly) {
    // Re-read every machine after activation: the gateway may only move once the whole fleet it
    // attaches to declares the protocol the built image speaks. This also covers a machine that
    // was already current, was offline, or had its activation rolled back.
    const incompatible = await incompatibleMachines(activated, manifest);
    if (incompatible.length) {
      for (const entry of incompatible) log(`${entry.name}: gateway waits on adapter protocol ${entry.liveProtocol ?? "unknown"}`);
      log("gateway: pending (an execution adapter is not on the built protocol; rerun once the blocked machines are idle)");
    } else {
      const state = await gatewayState();
      if (state.state === "busy") {
        log("gateway: pending (an active task is running; rerun once it finishes)");
      } else if (state.state === "unknown" && !confirmIdle) {
        log(`gateway: pending (${state.reason}; drain the gateway and pass --confirm-idle)`);
      } else {
        log("activating the gateway…");
        const up = await run("docker", ["compose", "up", "-d", "--no-build", "pocket"], { cwd: ROOT, timeout: 300_000 });
        if (up.code === 0) log(`gateway: updated${retained ? ` (previous image kept as ${retained.tag})` : ""}`);
        else { log(`gateway: pending (activation failed: ${up.stderr.slice(-300)})`); process.exitCode = 1; }
      }
    }
  } else if (protocolTransition) {
    log("execution adapters are on the new protocol; run the full deploy (or restart the gateway with the new image) before DSH is usable again");
  }
  if (inspected.some((entry) => entry.action === "update" && !entry.verifiable)) log("note: a machine without a trustworthy runtime skipped its automatic idle check; the deployment marker expires on its own if a run is interrupted");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`deploy failed: ${error.message}`);
    process.exitCode = 1;
  });
}
