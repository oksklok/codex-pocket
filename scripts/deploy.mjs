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
// Every update is inspected read-only, staged completely beside the install, verified by hash and by
// a real dependency/import probe while reusing the existing locked dependencies when the lock did not
// change, activated only while the durable runtime proves idle behind a maintenance marker, verified
// again, and restored from .pocket-previous on any failure once mutation begins. Windows receives its
// scripts as files so no script text or archive ever travels on a command line.
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
  "dsh/router.mjs",
  "dsh/bridge.mjs",
  "dsh/projection.mjs",
  "dsh/package.json",
  "dsh/package-lock.json",
  "dsh/pocket.patch.yml",
  "deepseek.ts",
];
export const ADAPTER_NAMES = ADAPTER_FILES.filter((file) => file.startsWith("dsh/")).map((file) => file.slice(4));
// Capabilities an installed adapter must report before its live runtime is treated as inspectable.
export const FEATURES = ["control-socket", "integrity-verify", "idle-only-shutdown"];

// Node one-liners. The POSIX ones avoid double quotes, backticks and `$` so they are safe inside a
// double-quoted shell string; the Windows script is a file, so it can quote normally.
const JS_READ = "try{process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))}catch(e){process.stdout.write('null')}";
const JS_WRITE_MARKER = "require('fs').writeFileSync(process.argv[1],JSON.stringify({at:Date.now()}),{mode:384})";
const JS_STUCK_MARKER = "require('fs').writeFileSync(process.argv[1],JSON.stringify({stuck:true,at:Date.now()}))";
const JS_WAS_STUCK = "const fs=require('fs');try{const v=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(v&&v.stuck?'stuck':'ok')}catch(e){process.stdout.write('ok')}";
const JS_OWNER_DECISION = "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{let v=null;try{v=JSON.parse(s.trim().split('\\n').filter(Boolean).pop())}catch{};const st=v&&v.ok===true?v.state:null;process.stdout.write(st==='absent'||st==='owned'?st:'unverified')})";
const JS_OWNER_PIDS = "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{let v=null;try{v=JSON.parse(s.trim().split('\\n').filter(Boolean).pop())}catch{};const p=[];if(v&&Number.isInteger(v.pid))p.push(v.pid);for(const c of (v&&Array.isArray(v.dshChildren)?v.dshChildren:[]))if(Number.isInteger(c.pid))p.push(c.pid);process.stdout.write([...new Set(p)].join(' '))})";
const JS_OWNER_CLEAR = "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{let v=null;try{v=JSON.parse(s.trim().split('\\n').filter(Boolean).pop())}catch{};const clear=v&&v.ok===true&&v.state==='absent'&&v.dshChildrenKnown===true&&(!Array.isArray(v.dshChildren)||v.dshChildren.length===0);process.stdout.write(clear?'clear':'busy')})";
// Only a stop that confirmed the owner and child exited authorizes the swap; a refused endpoint or
// any other failure is an error, never an assumed shutdown.
const JS_STOP_DECISION = "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{let v=null;try{v=JSON.parse(s.trim().split('\\n').filter(Boolean).pop())}catch{};if(v&&v.ok===true&&v.result&&v.result.accepted===true)process.stdout.write('stopped');else if(v&&v.reason==='busy')process.stdout.write('busy');else process.stdout.write('error')})";

const log = (message) => process.stdout.write(`${message}\n`);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// ── Pure helpers (exported for tests) ───────────────────────────────────────
export const isWindowsPath = (value) => /^[a-z]:[\\/]/i.test(value);
export const parentDir = (value) => String(value).replace(/[\\/][^\\/]*$/, "");
export const posixQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
export const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
export const joinPath = (windows, ...parts) => parts.join(windows ? "\\" : "/");
export const stagingName = (bundle) => `.pocket-staging-${bundle.slice(0, 12)}`;
export const previousName = ".pocket-previous";
export const markerName = ".pocket-deploying";
export const remoteScriptName = (bundle, phase) => `.pocket-deploy-${bundle.slice(0, 12)}-${phase}.ps1`;
export const powershellCommand = (script) => `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;

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

// Turn a `--status` result into a trust level. Only a valid correlated reply proves a state; a
// refused endpoint, a timeout, a malformed line or a connection that closes before replying is
// "unknown" and must never be read as idle.
export function liveStatusFrom(stdout) {
  const parsed = parseLastJson(stdout);
  if (parsed?.result?.busy === true) return "busy";
  if (parsed?.result && typeof parsed.result.busy === "boolean") return "idle";
  return "unknown";
}

export function liveReasonFrom(stdout) {
  const parsed = parseLastJson(stdout);
  return parsed && parsed.ok === false ? String(parsed.reason ?? "unknown") : "no-reply";
}

// The protocol a machine will speak after this deployment. A running runtime's control response is
// authoritative; otherwise the installed manifest counts only when the installed bytes verify.
export function effectiveProtocol(entry) {
  if (typeof entry.statusProtocol === "number") return entry.statusProtocol;
  if (entry.installedVerified === true && typeof entry.current?.protocol === "number") return entry.current.protocol;
  return null;
}

export function planMachine({ current, manifest, liveStatus, absentProven, confirmIdle, allowProtocolChange }) {
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
    // Only the deliberate first cutover may confirm idleness; its carrier is verified inside the
    // activation script before anything is signalled or replaced.
    if (!confirmIdle) return { action: "hold", protocolChanged, reason: "runtime state unknown on the old install; drain the machine, then pass --confirm-idle" };
    return { action: "update", stopLive: false, legacyStop: true, protocolChanged };
  }
  if (liveStatus === "busy") return { action: "hold", protocolChanged, reason: "runtime busy" };
  if (liveStatus === "idle") return { action: "update", stopLive: !absentProven, legacyStop: false, protocolChanged };
  // A modern runtime whose state cannot be verified is never treated as idle, with or without
  // --confirm-idle; absence must be proven from ownership.
  return { action: "hold", protocolChanged, reason: "runtime state could not be verified (control endpoint did not answer and ownership is not proven absent)" };
}

// Decide the whole-fleet protocol arrangement before anything is mutated. Adapter work is limited
// to the selected targets, but staying compatible is judged across every machine the gateway uses.
export function planFleet({ entries, targetKeys, manifest, allowProtocolChange }) {
  const isTarget = (entry) => targetKeys.has(entry.key);
  const protocolChanged = entries.some((entry) => entry.protocolChanged);
  const blockers = entries.filter((entry) => isTarget(entry) && entry.action === "hold");
  const staysBehind = entries.filter((entry) => !(isTarget(entry) && entry.action === "update") && effectiveProtocol(entry) !== manifest.protocol);
  return {
    isTarget,
    protocolChanged,
    blockers,
    staysBehind,
    reject: (protocolChanged || allowProtocolChange) && staysBehind.length > 0,
    blocked: (protocolChanged || allowProtocolChange) && blockers.length > 0,
  };
}

// Idle-state decision for a rollback, matching activation: an unproven state never authorizes
// stopping the runtime, and a busy runtime is never touched.
export function rollbackDecision(entry, confirmIdle) {
  if (entry.liveStatus === "busy") return { ok: false, reason: "runtime busy" };
  if (entry.liveStatus === "idle") return { ok: true, stopLive: Boolean(entry.verifiable) && !entry.absentProven };
  if (!entry.verifiable && confirmIdle) return { ok: true, stopLive: false };
  return { ok: false, reason: "runtime state could not be verified; --confirm-idle applies only to the deliberate legacy cutover" };
}

// The selected runtime's own state is the restart-safety fact: a deepseek runtime is the durable DSH
// carrier, so an accepted turn survives a gateway restart; any other provider does not.
export function gatewayLifecycle(value) {
  const machineId = typeof value?.machineId === "string" ? value.machineId : "";
  const machines = Array.isArray(value?.machines) ? value.machines : [];
  const selected = machines.find((machine) => machine && machine.id === machineId) ?? null;
  const durable = value?.provider === "deepseek" && selected?.deepseek === true;
  const busy = value?.turn?.status === "inProgress" || String(value?.threadStatus ?? "").startsWith("active") || value?.phase === "working";
  return { machineId, durable, busy };
}

// ── Shared script fragments ─────────────────────────────────────────────────
function posixInstallOkLines() {
  return [
    'if [ -f "$DSH/runtime.mjs" ]; then',
    '  if [ -f "$DSH/.pocket-adapter.json" ]; then node "$DSH/runtime.mjs" --verify "$DSH/.pocket-adapter.json" >/dev/null 2>&1 || return 1; fi',
    '  node "$DSH/runtime.mjs" --probe >/dev/null 2>&1 || return 1',
    "else",
    '  for f in launch.mjs bridge.mjs projection.mjs; do [ -f "$DSH/$f" ] || return 1; node --check "$DSH/$f" >/dev/null 2>&1 || return 1; done',
    "fi",
    "return 0",
  ];
}

function posixRestoreLines(bundleRoot, dshDir, previous) {
  const q = posixQuote;
  return [
    `if [ -f ${q(`${previous}/.pocket-adapter.json`)} ]; then cp -f ${q(`${previous}/.pocket-adapter.json`)} ${q(`${dshDir}/.pocket-adapter.json`)}; else rm -f ${q(`${dshDir}/.pocket-adapter.json`)}; fi`,
    ...ADAPTER_NAMES.map((file) => `if [ -f ${q(`${previous}/dsh/${file}`)} ]; then cp -f ${q(`${previous}/dsh/${file}`)} ${q(`${dshDir}/${file}`)}; else rm -f ${q(`${dshDir}/${file}`)}; fi`),
    `if [ -f ${q(`${previous}/deepseek.ts`)} ]; then cp -f ${q(`${previous}/deepseek.ts`)} ${q(`${bundleRoot}/deepseek.ts`)}; else rm -f ${q(`${bundleRoot}/deepseek.ts`)}; fi`,
    `if [ -d ${q(`${previous}/node_modules`)} ]; then rm -rf ${q(`${dshDir}/node_modules`)}; cp -a ${q(`${previous}/node_modules`)} ${q(`${dshDir}/node_modules`)}; fi`,
  ];
}

function posixStopLines(stopLive) {
  if (!stopLive) return [];
  return [
    "set +e",
    'STOP_JSON=$(node "$DSH/runtime.mjs" --stop 2>/dev/null)',
    "set -e",
    `DECISION=$(printf '%s' "$STOP_JSON" | node -e "${JS_STOP_DECISION}")`,
    'if [ "$DECISION" = "busy" ]; then rm -f "$MARKER"; printf \'%s\' \'{"ok":false,"reason":"busy"}\'; exit 3; fi',
    'if [ "$DECISION" = "error" ]; then rm -f "$MARKER"; printf \'%s\' \'{"ok":false,"reason":"stop-failed"}\'; exit 5; fi',
  ];
}

export function posixLegacyStopLines(legacyStop) {
  if (!legacyStop) return [];
  return [
    'OWNER_BIN="$STAGE/dsh/runtime.mjs"',
    'LOCK="$DSH_HOME_DIR/pocket-owner"',
    'owner_json() { node "$OWNER_BIN" --owner "$DSH" 2>/dev/null || printf \'%s\' \'{"ok":false,"reason":"owner-probe-failed"}\'; }',
    `owner_clear() { owner_json | node -e "${JS_OWNER_CLEAR}"; }`,
    "stop_legacy() {",
    "  ATTEMPT=0",
    '  while [ "$ATTEMPT" -lt 3 ]; do',
    "    ATTEMPT=$((ATTEMPT+1))",
    '    OWNER_JSON=$(owner_json)',
    `    OWNER_DECISION=$(printf '%s' "$OWNER_JSON" | node -e "${JS_OWNER_DECISION}")`,
    '    if [ "$OWNER_DECISION" = "unverified" ]; then fail "legacy-owner-unverified"; fi',
    // A verified launcher and every identified DSH child are stopped, even when the launcher died.
    `    OWNER_PIDS=$(printf '%s' "$OWNER_JSON" | node -e "${JS_OWNER_PIDS}")`,
    '    if [ -n "$OWNER_PIDS" ]; then',
    '      for TARGET in $OWNER_PIDS; do kill -TERM "$TARGET" 2>/dev/null || true; done',
    '      WAIT=0; while [ "$WAIT" -lt 100 ] && [ "$(owner_clear)" != "clear" ]; do sleep 0.1; WAIT=$((WAIT+1)); done',
    '      if [ "$(owner_clear)" != "clear" ]; then',
    '        for TARGET in $OWNER_PIDS; do kill -KILL "$TARGET" 2>/dev/null || true; done',
    '        WAIT=0; while [ "$WAIT" -lt 50 ] && [ "$(owner_clear)" != "clear" ]; do sleep 0.1; WAIT=$((WAIT+1)); done',
    "      fi",
    "    fi",
    '    if [ "$(owner_clear)" != "clear" ]; then fail "legacy-carrier-still-running"; fi',
    '    rm -f "$LOCK"',
    '    if ( set -C; printf \'%s\' "$$" > "$LOCK" ) 2>/dev/null; then LOCK_CLAIMED=1; return 0; fi',
    "  done",
    '  fail "legacy-relaunch-raced"',
    "}",
    "stop_legacy",
  ];
}

export function posixStageScript({ bundleRoot, dshDir, staging, installDeps }) {
  const q = posixQuote;
  const chmodFiles = ADAPTER_FILES.map((file) => q(`${staging}/${file}`)).join(" ");
  return [
    "set -eu",
    `STAGE=${q(staging)}`,
    `BUNDLE=${q(bundleRoot)}`,
    `DSH=${q(dshDir)}`,
    `INSTALL_DEPS=${installDeps ? 1 : 0}`,
    'rm -rf "$STAGE"',
    'mkdir -p "$STAGE"',
    'tar -xzf - -C "$STAGE"',
    'chmod 755 "$BUNDLE" "$STAGE" "$STAGE/dsh"',
    `chmod 644 ${chmodFiles} ${q(`${staging}/pocket-manifest.json`)}`,
    'if [ "$INSTALL_DEPS" = "1" ]; then',
    '  cd "$STAGE/dsh" && npm ci --omit=dev --no-audit --no-fund',
    "else",
    // Reuse the locked live dependencies for the probe without mutating them; the link is removed
    // before the staged tree is ever activated.
    '  ln -s "$DSH/node_modules" "$STAGE/dsh/node_modules"',
    "fi",
    'node "$STAGE/dsh/runtime.mjs" --verify "$STAGE/pocket-manifest.json"',
    'node "$STAGE/dsh/runtime.mjs" --probe',
    'if [ -L "$STAGE/dsh/node_modules" ]; then rm -f "$STAGE/dsh/node_modules"; fi',
    "printf '%s' '{\"ok\":true}'",
  ].join("\n");
}

export function posixActivateScript({ bundleRoot, dshDir, staging, installDeps, stopLive, legacyStop, holdMarker }) {
  const previous = joinPath(false, bundleRoot, previousName);
  const marker = joinPath(false, bundleRoot, markerName);
  const q = posixQuote;
  return [
    "set -eu",
    `BUNDLE=${q(bundleRoot)}`,
    `DSH=${q(dshDir)}`,
    `STAGE=${q(staging)}`,
    `PREV=${q(previous)}`,
    `MARKER=${q(marker)}`,
    `STOP_LIVE=${stopLive ? 1 : 0}`,
    `LEGACY_STOP=${legacyStop ? 1 : 0}`,
    `INSTALL_DEPS=${installDeps ? 1 : 0}`,
    `HOLD_MARKER=${holdMarker ? 1 : 0}`,
    'DSH_HOME_DIR="${POCKET_DSH_HOME:-$HOME/.codex-pocket/dsh}"',
    "MUTATED=0",
    "LOCK_CLAIMED=0",
    "marker_stuck() {",
    `  node -e "${JS_STUCK_MARKER}" "$MARKER"`,
    "}",
    "install_ok() {",
    ...posixInstallOkLines().map((line) => `  ${line}`),
    "}",
    "restore() {",
    ...posixRestoreLines(bundleRoot, dshDir, previous).map((line) => `  ${line}`),
    "}",
    "release_claim() {",
    '  if [ "$LOCK_CLAIMED" = "1" ]; then',
    '    if [ "$(tr -dc \'0-9\' < "$DSH_HOME_DIR/pocket-owner" 2>/dev/null)" = "$$" ]; then rm -f "$DSH_HOME_DIR/pocket-owner"; fi',
    "    LOCK_CLAIMED=0",
    "  fi",
    "}",
    "fail() {",
    '  reason="$1"',
    "  rolled=0",
    '  if [ "$MUTATED" = "1" ]; then',
    '    if restore && install_ok; then',
    "      rolled=1",
    "    else",
    "      marker_stuck",
    `      printf '%s' '{"ok":false,"reason":"'"$reason"'","rolledBack":false,"stuck":true}'`,
    "      exit 7",
    "    fi",
    "  fi",
    "  release_claim",
    '  rm -f "$MARKER"',
    `  if [ "$rolled" = "1" ]; then printf '%s' '{"ok":false,"reason":"'"$reason"'","rolledBack":true}'; else printf '%s' '{"ok":false,"reason":"'"$reason"'","rolledBack":false}'; fi`,
    "  exit 6",
    "}",
    `if [ -f "$MARKER" ] && [ "$(node -e "${JS_WAS_STUCK}" "$MARKER")" = "stuck" ]; then printf '%s' '{"ok":false,"reason":"stuck-marker"}'; exit 8; fi`,
    `node -e "${JS_WRITE_MARKER}" "$MARKER"`,
    ...posixStopLines(stopLive),
    ...posixLegacyStopLines(legacyStop),
    // Never overwrite the last good backup with an install that is not itself loadable.
    'if [ -d "$PREV" ] && ! install_ok; then',
    "  if restore && install_ok; then :; else marker_stuck; printf '%s' '{\"ok\":false,\"reason\":\"previous-restore-failed\",\"stuck\":true}'; exit 7; fi",
    "fi",
    "set +e",
    "(",
    "  set -e",
    '  rm -rf "$PREV"',
    '  mkdir -p "$PREV/dsh"',
    '  if [ -f "$DSH/.pocket-adapter.json" ]; then cp -f "$DSH/.pocket-adapter.json" "$PREV/.pocket-adapter.json"; fi',
    ...ADAPTER_NAMES.map((file) => `  if [ -f "$DSH/${file}" ]; then cp -f "$DSH/${file}" "$PREV/dsh/${file}"; fi`),
    '  if [ -f "$BUNDLE/deepseek.ts" ]; then cp -f "$BUNDLE/deepseek.ts" "$PREV/deepseek.ts"; fi',
    ")",
    "SNAP=$?",
    "set -e",
    'if [ "$SNAP" -ne 0 ]; then fail "snapshot-failed"; fi',
    "MUTATED=1",
    "set +e",
    "(",
    "  set -e",
    ...ADAPTER_NAMES.map((file) => `  cp -f "$STAGE/dsh/${file}" "$DSH/${file}"`),
    '  cp -f "$STAGE/deepseek.ts" "$BUNDLE/deepseek.ts"',
    '  cp -f "$STAGE/pocket-manifest.json" "$DSH/.pocket-adapter.json"',
    '  chmod 755 "$BUNDLE" "$DSH"',
    ...ADAPTER_NAMES.map((file) => `  chmod 644 "$DSH/${file}"`),
    '  chmod 644 "$DSH/.pocket-adapter.json"',
    '  if [ "$INSTALL_DEPS" = "1" ]; then rm -rf "$PREV/node_modules"; if [ -d "$DSH/node_modules" ]; then mv "$DSH/node_modules" "$PREV/node_modules"; fi; mv "$STAGE/dsh/node_modules" "$DSH/node_modules"; fi',
    ")",
    "MUTATE=$?",
    "set -e",
    'if [ "$MUTATE" -ne 0 ]; then fail "activation-failed"; fi',
    'if ! install_ok; then fail "activation-verify-failed"; fi',
    "release_claim",
    'if [ "$HOLD_MARKER" = "1" ]; then',
    "  printf '%s' '{\"ok\":true,\"held\":true}'",
    "else",
    '  rm -f "$MARKER"',
    "  printf '%s' '{\"ok\":true}'",
    "fi",
  ].join("\n");
}

export function posixRollbackScript({ bundleRoot, dshDir, stopLive }) {
  const previous = joinPath(false, bundleRoot, previousName);
  const marker = joinPath(false, bundleRoot, markerName);
  const q = posixQuote;
  return [
    "set -eu",
    `BUNDLE=${q(bundleRoot)}`,
    `DSH=${q(dshDir)}`,
    `PREV=${q(previous)}`,
    `MARKER=${q(marker)}`,
    `STOP_LIVE=${stopLive ? 1 : 0}`,
    'if [ ! -f "$PREV/.pocket-adapter.json" ] && [ ! -f "$PREV/dsh/launch.mjs" ]; then printf \'%s\' \'{"ok":false,"reason":"no-previous"}\'; exit 4; fi',
    "marker_stuck() {",
    `  node -e "${JS_STUCK_MARKER}" "$MARKER"`,
    "}",
    "install_ok() {",
    ...posixInstallOkLines().map((line) => `  ${line}`),
    "}",
    "restore() {",
    ...posixRestoreLines(bundleRoot, dshDir, previous).map((line) => `  ${line}`),
    "}",
    `node -e "${JS_WRITE_MARKER}" "$MARKER"`,
    ...posixStopLines(stopLive),
    "if ! restore || ! install_ok; then",
    "  marker_stuck",
    "  printf '%s' '{\"ok\":false,\"reason\":\"rollback-verify-failed\",\"stuck\":true}'",
    "  exit 7",
    "fi",
    'rm -f "$MARKER"',
    "printf '%s' '{\"ok\":true}'",
  ].join("\n");
}

function windowsInstallOkLines() {
  return [
    "$runtime = Join-Path $DSH 'runtime.mjs'",
    "if (Test-Path -LiteralPath $runtime) {",
    "  $manifest = Join-Path $DSH '.pocket-adapter.json'",
    "  if (Test-Path -LiteralPath $manifest) { & node $runtime --verify $manifest | Out-Null; if ($LASTEXITCODE -ne 0) { return $false } }",
    "  & node $runtime --probe | Out-Null",
    "  if ($LASTEXITCODE -ne 0) { return $false }",
    "} else {",
    "  foreach ($f in @('launch.mjs','bridge.mjs','projection.mjs')) {",
    "    $p = Join-Path $DSH $f",
    "    if (-not (Test-Path -LiteralPath $p)) { return $false }",
    "    & node --check $p | Out-Null",
    "    if ($LASTEXITCODE -ne 0) { return $false }",
    "  }",
    "}",
    "return $true",
  ];
}

function windowsRestoreLines(bundleRoot, dshDir, previous) {
  return [
    `if (Test-Path -LiteralPath (Join-Path ${psQuote(previous)} '.pocket-adapter.json')) { Copy-Item -Force (Join-Path ${psQuote(previous)} '.pocket-adapter.json') (Join-Path ${psQuote(dshDir)} '.pocket-adapter.json') } else { Remove-Item -LiteralPath (Join-Path ${psQuote(dshDir)} '.pocket-adapter.json') -Force -ErrorAction SilentlyContinue }`,
    ...ADAPTER_NAMES.map((file) => `if (Test-Path -LiteralPath (Join-Path ${psQuote(previous)} 'dsh/${file}')) { Copy-Item -Force (Join-Path ${psQuote(previous)} 'dsh/${file}') (Join-Path ${psQuote(dshDir)} '${file}') } else { Remove-Item -LiteralPath (Join-Path ${psQuote(dshDir)} '${file}') -Force -ErrorAction SilentlyContinue }`),
    `if (Test-Path -LiteralPath (Join-Path ${psQuote(previous)} 'deepseek.ts')) { Copy-Item -Force (Join-Path ${psQuote(previous)} 'deepseek.ts') (Join-Path ${psQuote(bundleRoot)} 'deepseek.ts') } else { Remove-Item -LiteralPath (Join-Path ${psQuote(bundleRoot)} 'deepseek.ts') -Force -ErrorAction SilentlyContinue }`,
    `if (Test-Path -LiteralPath (Join-Path ${psQuote(previous)} 'node_modules')) { Remove-Item -LiteralPath (Join-Path ${psQuote(dshDir)} 'node_modules') -Recurse -Force -ErrorAction SilentlyContinue; Copy-Item -Recurse -Force (Join-Path ${psQuote(previous)} 'node_modules') (Join-Path ${psQuote(dshDir)} 'node_modules') }`,
  ];
}

function windowsStopLines(stopLive) {
  if (!stopLive) return [];
  return [
    "if ($STOP_LIVE -eq 1) {",
    "  $stopJson = & node (Join-Path $DSH 'runtime.mjs') --stop 2>$null",
    "  $stopCode = $LASTEXITCODE",
    "  $stopResult = $null",
    "  try { $stopResult = (($stopJson | Select-Object -Last 1) | ConvertFrom-Json) } catch {}",
    "  if ($stopResult -and $stopResult.reason -eq 'busy') { Remove-Item -LiteralPath $MARKER -Force; Write-Output '{\"ok\":false,\"reason\":\"busy\"}'; exit 3 }",
    "  if ($stopResult -and $stopResult.reason -eq 'draining') { Remove-Item -LiteralPath $MARKER -Force; Write-Output '{\"ok\":false,\"reason\":\"busy\"}'; exit 3 }",
    "  if ($stopCode -ne 0 -or -not ($stopResult -and $stopResult.ok -eq $true -and $stopResult.result -and $stopResult.result.accepted -eq $true)) { Remove-Item -LiteralPath $MARKER -Force; Write-Output '{\"ok\":false,\"reason\":\"stop-failed\"}'; exit 5 }",
    "}",
  ];
}

function windowsLegacyStopLines(legacyStop) {
  if (!legacyStop) return [];
  return [
    "if ($LEGACY_STOP -eq 1) {",
    "  $ownerBin = Join-Path $STAGE 'dsh/runtime.mjs'",
    "  $lock = Join-Path $HOME_DIR 'pocket-owner'",
    "  function Get-Owner {",
    "    $out = & node $ownerBin --owner $DSH 2>$null",
    "    try { return (($out | Select-Object -Last 1) | ConvertFrom-Json) } catch { return $null }",
    "  }",
    "  $ownerClear = { param($probe) $probe -and $probe.ok -eq $true -and $probe.state -eq 'absent' -and $probe.dshChildrenKnown -eq $true -and @($probe.dshChildren).Count -eq 0 }",
    "  for ($attempt = 0; $attempt -lt 3 -and -not $LOCK_CLAIMED; $attempt++) {",
    "    $owner = Get-Owner",
    "    if (-not $owner -or $owner.ok -ne $true -or $owner.state -eq 'unverified') { throw 'legacy owner could not be verified' }",
    "    $targets = @()",
    "    if ($owner.pid) { $targets += [int]$owner.pid }",
    "    foreach ($child in @($owner.dshChildren)) { if ($child.pid) { $targets += [int]$child.pid } }",
    "    foreach ($t in $targets) { Stop-Process -Id $t -Force -ErrorAction SilentlyContinue }",
    "    $clear = $false",
    "    for ($i = 0; $i -lt 100; $i++) { $probe = Get-Owner; if (& $ownerClear $probe) { $clear = $true; break }; Start-Sleep -Milliseconds 100 }",
    "    if (-not $clear) { throw 'legacy carrier or its DSH child is still running' }",
    "    Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue",
    "    try {",
    "      $stream = [IO.File]::Open($lock, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)",
    "      $bytes = [Text.Encoding]::ASCII.GetBytes([string]$PID)",
    "      $stream.Write($bytes, 0, $bytes.Length); $stream.Dispose()",
    "      $LOCK_CLAIMED = $true",
    "    } catch { Start-Sleep -Milliseconds 100 }",
    "  }",
    "  if (-not $LOCK_CLAIMED) { throw 'legacy relaunch raced the cutover' }",
    "}",
  ];
}

export function windowsStageScript({ bundleRoot, dshDir, staging, installDeps }) {
  const link = joinPath(true, staging, "dsh", "node_modules");
  return [
    "$ErrorActionPreference='Stop'",
    `$BUNDLE = ${psQuote(bundleRoot)}`,
    `$DSH = ${psQuote(dshDir)}`,
    `$STAGE = ${psQuote(staging)}`,
    `$LINK = ${psQuote(link)}`,
    `$INSTALL_DEPS = ${installDeps ? 1 : 0}`,
    "if (Test-Path -LiteralPath $STAGE) {",
    "  if (Test-Path -LiteralPath $LINK) { $existing = Get-Item -Force -LiteralPath $LINK; if ($existing.LinkType -eq 'Junction') { & cmd /c rmdir $LINK } }",
    "  Remove-Item -LiteralPath $STAGE -Recurse -Force",
    "}",
    "New-Item -ItemType Directory -Force -Path $STAGE | Out-Null",
    "$tmp = Join-Path $env:TEMP ('pocket-adapter-' + [guid]::NewGuid().ToString('N') + '.tgz')",
    "$stdinStream = [Console]::OpenStandardInput()",
    "$output = [IO.File]::Create($tmp)",
    "try { $stdinStream.CopyTo($output) } finally { $output.Dispose() }",
    "& tar -xzf $tmp -C $STAGE",
    "if ($LASTEXITCODE -ne 0) { throw 'adapter archive could not be extracted' }",
    "Remove-Item -LiteralPath $tmp -Force",
    "if ($INSTALL_DEPS -eq 1) {",
    "  Push-Location (Join-Path $STAGE 'dsh')",
    "  try { & npm ci --omit=dev --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw 'dependency install failed' } } finally { Pop-Location }",
    "} else {",
    "  New-Item -ItemType Junction -Path $LINK -Target (Join-Path $DSH 'node_modules') | Out-Null",
    "}",
    "try {",
    "  & node (Join-Path $STAGE 'dsh/runtime.mjs') --verify (Join-Path $STAGE 'pocket-manifest.json')",
    "  if ($LASTEXITCODE -ne 0) { throw 'staged adapter failed verification' }",
    "  & node (Join-Path $STAGE 'dsh/runtime.mjs') --probe",
    "  if ($LASTEXITCODE -ne 0) { throw 'staged adapter failed its load probe' }",
    "} finally {",
    "  if (Test-Path -LiteralPath $LINK) { $item = Get-Item -Force -LiteralPath $LINK; if ($item.LinkType -eq 'Junction') { & cmd /c rmdir $LINK } }",
    "}",
    "Write-Output '{\"ok\":true}'",
  ].join("\n");
}

export function windowsActivateScript({ bundleRoot, dshDir, staging, installDeps, stopLive, legacyStop, holdMarker }) {
  const previous = joinPath(true, bundleRoot, previousName);
  const marker = joinPath(true, bundleRoot, markerName);
  const lines = [
    "$ErrorActionPreference='Stop'",
    `$BUNDLE = ${psQuote(bundleRoot)}`,
    `$DSH = ${psQuote(dshDir)}`,
    `$STAGE = ${psQuote(staging)}`,
    `$PREV = ${psQuote(previous)}`,
    `$MARKER = ${psQuote(marker)}`,
    `$STOP_LIVE = ${stopLive ? 1 : 0}`,
    `$LEGACY_STOP = ${legacyStop ? 1 : 0}`,
    `$INSTALL_DEPS = ${installDeps ? 1 : 0}`,
    `$HOLD_MARKER = ${holdMarker ? 1 : 0}`,
    "$HOME_DIR = if ($env:POCKET_DSH_HOME) { $env:POCKET_DSH_HOME } else { Join-Path $env:USERPROFILE '.codex-pocket/dsh' }",
    "$MUTATED = $false",
    "$LOCK_CLAIMED = $false",
    `function MarkerStuck { & node -e "${JS_STUCK_MARKER}" $MARKER }`,
    "function InstallOk {",
    ...windowsInstallOkLines().map((line) => `  ${line}`),
    "}",
    "function Restore {",
    ...windowsRestoreLines(bundleRoot, dshDir, previous).map((line) => `  ${line}`),
    "}",
    "function ReleaseClaim {",
    "  if ($LOCK_CLAIMED) {",
    "    $lock = Join-Path $HOME_DIR 'pocket-owner'",
    "    try { if ((Get-Content -LiteralPath $lock -Raw).Trim() -eq [string]$PID) { Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue } } catch {}",
    "    $LOCK_CLAIMED = $false",
    "  }",
    "}",
    "function Fail([string]$reason) {",
    "  if ($MUTATED) {",
    "    try {",
    "      Restore",
    "      if (-not (InstallOk)) { throw 'restore-verify-failed' }",
    "    } catch {",
    "      MarkerStuck",
    "      Write-Output ('{\"ok\":false,\"reason\":\"' + $reason + '\",\"rolledBack\":false,\"stuck\":true}')",
    "      exit 7",
    "    }",
    "  }",
    "  ReleaseClaim",
    "  Remove-Item -LiteralPath $MARKER -Force -ErrorAction SilentlyContinue",
    "  Write-Output ('{\"ok\":false,\"reason\":\"' + $reason + '\",\"rolledBack\":' + $(if ($MUTATED) { 'true' } else { 'false' }) + '}')",
    "  exit 6",
    "}",
    "try {",
    `  if ((Test-Path -LiteralPath $MARKER) -and ((& node -e "${JS_WAS_STUCK}" $MARKER) -eq 'stuck')) { Write-Output '{"ok":false,"reason":"stuck-marker"}'; exit 8 }`,
    `  & node -e "${JS_WRITE_MARKER}" $MARKER`,
    "  if ($LASTEXITCODE -ne 0) { throw 'maintenance marker could not be written' }",
    ...windowsStopLines(stopLive).map((line) => `  ${line}`),
    ...windowsLegacyStopLines(legacyStop).map((line) => `  ${line}`),
    "  if ((Test-Path -LiteralPath $PREV) -and -not (InstallOk)) {",
    "    try { Restore; if (-not (InstallOk)) { throw 'restore-verify-failed' } } catch { MarkerStuck; Write-Output '{\"ok\":false,\"reason\":\"previous-restore-failed\",\"stuck\":true}'; exit 7 }",
    "  }",
    "  if (Test-Path -LiteralPath $PREV) { Remove-Item -LiteralPath $PREV -Recurse -Force }",
    "  New-Item -ItemType Directory -Force -Path (Join-Path $PREV 'dsh') | Out-Null",
    "  if (Test-Path -LiteralPath (Join-Path $DSH '.pocket-adapter.json')) { Copy-Item -Force (Join-Path $DSH '.pocket-adapter.json') (Join-Path $PREV '.pocket-adapter.json') }",
    ...ADAPTER_NAMES.map((file) => `  if (Test-Path -LiteralPath (Join-Path $DSH '${file}')) { Copy-Item -Force (Join-Path $DSH '${file}') (Join-Path $PREV 'dsh/${file}') }`),
    "  if (Test-Path -LiteralPath (Join-Path $BUNDLE 'deepseek.ts')) { Copy-Item -Force (Join-Path $BUNDLE 'deepseek.ts') (Join-Path $PREV 'deepseek.ts') }",
    "  $MUTATED = $true",
    ...ADAPTER_NAMES.map((file) => `  Copy-Item -Force (Join-Path $STAGE 'dsh/${file}') (Join-Path $DSH '${file}')`),
    "  Copy-Item -Force (Join-Path $STAGE 'deepseek.ts') (Join-Path $BUNDLE 'deepseek.ts')",
    "  Copy-Item -Force (Join-Path $STAGE 'pocket-manifest.json') (Join-Path $DSH '.pocket-adapter.json')",
    "  if ($INSTALL_DEPS -eq 1) { Remove-Item -LiteralPath (Join-Path $PREV 'node_modules') -Recurse -Force -ErrorAction SilentlyContinue; if (Test-Path -LiteralPath (Join-Path $DSH 'node_modules')) { Move-Item -LiteralPath (Join-Path $DSH 'node_modules') -Destination (Join-Path $PREV 'node_modules') }; Move-Item -LiteralPath (Join-Path $STAGE 'dsh/node_modules') -Destination (Join-Path $DSH 'node_modules') }",
    "  if (-not (InstallOk)) { Fail 'activation-verify-failed' }",
    "  ReleaseClaim",
    "  if ($HOLD_MARKER -eq 1) { Write-Output '{\"ok\":true,\"held\":true}' } else { Remove-Item -LiteralPath $MARKER -Force; Write-Output '{\"ok\":true}' }",
    "} catch {",
    "  if (-not $MUTATED) { Remove-Item -LiteralPath $MARKER -Force -ErrorAction SilentlyContinue; Write-Output '{\"ok\":false,\"reason\":\"activation-failed\"}'; exit 6 }",
    "  Fail 'activation-failed'",
    "}",
  ];
  return lines.join("\n");
}

export function windowsRollbackScript({ bundleRoot, dshDir, stopLive }) {
  const previous = joinPath(true, bundleRoot, previousName);
  const marker = joinPath(true, bundleRoot, markerName);
  const lines = [
    "$ErrorActionPreference='Stop'",
    `$BUNDLE = ${psQuote(bundleRoot)}`,
    `$DSH = ${psQuote(dshDir)}`,
    `$PREV = ${psQuote(previous)}`,
    `$MARKER = ${psQuote(marker)}`,
    `$STOP_LIVE = ${stopLive ? 1 : 0}`,
    "$LEGACY_STOP = 0",
    "$MUTATED = $true",
    `if (-not (Test-Path -LiteralPath (Join-Path $PREV '.pocket-adapter.json')) -and -not (Test-Path -LiteralPath (Join-Path $PREV 'dsh/launch.mjs'))) { Write-Output '{"ok":false,"reason":"no-previous"}'; exit 4 }`,
    `function MarkerStuck { & node -e "${JS_STUCK_MARKER}" $MARKER }`,
    "function InstallOk {",
    ...windowsInstallOkLines().map((line) => `  ${line}`),
    "}",
    "function Restore {",
    ...windowsRestoreLines(bundleRoot, dshDir, previous).map((line) => `  ${line}`),
    "}",
    "try {",
    `  & node -e "${JS_WRITE_MARKER}" $MARKER`,
    "  if ($LASTEXITCODE -ne 0) { throw 'maintenance marker could not be written' }",
    ...windowsStopLines(stopLive).map((line) => `  ${line}`),
    "  Restore",
    "  if (-not (InstallOk)) { throw 'rollback-verify-failed' }",
    "  Remove-Item -LiteralPath $MARKER -Force",
    "  Write-Output '{\"ok\":true}'",
    "} catch {",
    "  MarkerStuck",
    "  Write-Output '{\"ok\":false,\"reason\":\"rollback-verify-failed\",\"stuck\":true}'",
    "  exit 7",
    "}",
  ];
  return lines.join("\n");
}

// ── Process plumbing ────────────────────────────────────────────────────────
async function defaultRun(command, commandArgs, { input = null, timeout = 120_000, cwd = undefined } = {}) {
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

// All external commands go through this seam; tests replace processRunner.run with controlled fakes.
export const processRunner = { run: defaultRun };
// Readiness polling is time-based in production; tests shorten it without changing the logic.
export const deployTiming = { readinessAttempts: 90, readinessDelayMs: 1000 };
const run = (command, commandArgs, options) => processRunner.run(command, commandArgs, options);

const sshBase = () => [
  ...(existsSync(SSH_CONFIG) ? ["-F", SSH_CONFIG] : []),
  "-T",
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=8",
  "-o", "ServerAliveInterval=15",
  "-o", "ServerAliveCountMax=2",
];

// POSIX keeps the script on the command line (no length limit in practice). Windows always writes
// the script to a file first, so neither the script text nor the archive is a large command argument.
function sshArgs(machine, script) {
  const base = sshBase();
  if (isWindowsPath(machine.dshPath)) return [...base, machine.ssh, powershellCommand(script)];
  return [...base, machine.ssh, script];
}

const ssh = (machine, script, options) => run("ssh", sshArgs(machine, script), options);

async function writeRemoteScript(machine, remotePath, text) {
  const command = powershellCommand(`$stdinStream = [Console]::OpenStandardInput(); $output = [IO.File]::Create(${psQuote(remotePath)}); try { $stdinStream.CopyTo($output) } finally { $output.Dispose() }`);
  const result = await run("ssh", [...sshBase(), machine.ssh, command], { input: Buffer.from(`\ufeff${text}`, "utf8"), timeout: 60_000 });
  return result.code === 0;
}

async function runRemoteScript(machine, remotePath, { input = null, timeout = 300_000 } = {}) {
  const command = powershellCommand(`& ${psQuote(remotePath)}; exit $LASTEXITCODE`);
  return run("ssh", [...sshBase(), machine.ssh, command], { input, timeout });
}

async function removeRemoteScript(machine, remotePath) {
  await run("ssh", [...sshBase(), machine.ssh, powershellCommand(`Remove-Item -LiteralPath ${psQuote(remotePath)} -Force -ErrorAction SilentlyContinue`)], { timeout: 60_000 });
}

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
function settingsPath(argv = process.argv) {
  const index = argv.indexOf("--settings");
  const explicit = index >= 0 ? argv[index + 1] : null;
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

const pathFor = (windows, ...parts) => joinPath(windows, ...parts);
const manifestPath = (windows, dshDir) => pathFor(windows, dshDir, ".pocket-adapter.json");
const runtimePath = (windows, dshDir) => pathFor(windows, dshDir, "runtime.mjs");
const quoteFor = (windows, value) => (windows ? psQuote(value) : posixQuote(value));
const readJsonCommand = (windows, path) => (windows
  ? `& node -e "${JS_READ}" ${psQuote(path)}`
  : `node -e "${JS_READ}" ${posixQuote(path)}`);
const nodeCommand = (windows, ...args) => (windows ? `& node ${args.join(" ")}` : `node ${args.join(" ")}`);

async function inspectMachine(machine, manifest, options) {
  const name = machine.name || machine.ssh;
  const dshDir = parentDir(machine.dshPath);
  const windows = isWindowsPath(machine.dshPath);
  const entry = { key: name, name, machine, dshDir, windows };
  const reachable = await ssh(machine, "echo pocket-deploy-ok");
  if (reachable.code !== 0) return { ...entry, current: null, liveStatus: null, verifiable: false, statusProtocol: null, installedVerified: false, action: "hold", reason: "offline" };
  const current = parseLastJson((await ssh(machine, readJsonCommand(windows, manifestPath(windows, dshDir)))).stdout);
  const verifiable = Boolean(current && Array.isArray(current.features) && current.features.includes("control-socket"));
  let installedVerified = false;
  if (current && current.files && Object.keys(current.files).length) {
    const verify = await ssh(machine, nodeCommand(windows, quoteFor(windows, runtimePath(windows, dshDir)), "--verify", quoteFor(windows, manifestPath(windows, dshDir))));
    installedVerified = verify.code === 0;
  }
  let liveStatus = null;
  let statusProtocol = null;
  let liveReason = null;
  let absentProven = false;
  let ownerState = null;
  if (verifiable) {
    const statusOut = (await ssh(machine, nodeCommand(windows, quoteFor(windows, runtimePath(windows, dshDir)), "--status"))).stdout;
    liveStatus = liveStatusFrom(statusOut);
    liveReason = liveReasonFrom(statusOut);
    const parsed = parseLastJson(statusOut);
    if (parsed?.result && typeof parsed.result.protocol === "number") statusProtocol = parsed.result.protocol;
    if (liveStatus === "unknown") {
      // A missing endpoint is not proof of absence: verify the recorded owner instead.
      const ownerOut = (await ssh(machine, nodeCommand(windows, quoteFor(windows, runtimePath(windows, dshDir)), "--owner", quoteFor(windows, dshDir)))).stdout;
      const owner = parseLastJson(ownerOut);
      ownerState = owner && owner.ok === true ? owner.state : "probe-failed";
      if (ownerState === "absent") {
        liveStatus = "idle";
        absentProven = true;
        liveReason = null;
      } else {
        liveReason = `${liveReason}/owner-${ownerState}`;
      }
    }
  }
  return { ...entry, current, liveStatus, verifiable, statusProtocol, installedVerified, liveReason, absentProven, ownerState, ...planMachine({ current, manifest, liveStatus, absentProven, ...options }) };
}

async function stageMachine(entry, manifest, archive) {
  const { machine, dshDir, windows, current } = entry;
  const bundleRoot = parentDir(dshDir);
  const staging = joinPath(windows, bundleRoot, stagingName(manifest.bundle));
  const installDeps = current?.lockHash !== manifest.lockHash;
  const options = { bundleRoot, dshDir, staging, installDeps };
  let result;
  if (windows) {
    const scriptPath = joinPath(true, bundleRoot, remoteScriptName(manifest.bundle, "stage"));
    const script = windowsStageScript(options);
    if (!(await writeRemoteScript(machine, scriptPath, script))) return { ...entry, action: "hold", reason: "staging failed (script-transfer)" };
    result = await runRemoteScript(machine, scriptPath, { input: archive, timeout: 900_000 });
    await removeRemoteScript(machine, scriptPath);
  } else {
    result = await ssh(machine, posixStageScript(options), { input: archive, timeout: 900_000 });
  }
  if (result.code !== 0) return { ...entry, action: "hold", reason: `staging failed (${parseLastJson(result.stdout)?.reason ?? result.code})` };
  return { ...entry, staging, installDeps, stopLive: entry.stopLive, legacyStop: entry.legacyStop };
}

async function activateMachine(entry, manifest, { holdMarker = false } = {}) {
  const { machine, dshDir, windows, staging, installDeps, stopLive, legacyStop } = entry;
  const bundleRoot = parentDir(dshDir);
  const options = { bundleRoot, dshDir, staging, installDeps, stopLive, legacyStop, holdMarker };
  let result;
  if (windows) {
    const scriptPath = joinPath(true, bundleRoot, remoteScriptName(manifest.bundle, "activate"));
    const script = windowsActivateScript(options);
    if (!(await writeRemoteScript(machine, scriptPath, script))) return { ...entry, action: "hold", reason: "activation failed (script-transfer)" };
    result = await runRemoteScript(machine, scriptPath, { timeout: 300_000 });
    await removeRemoteScript(machine, scriptPath);
  } else {
    result = await ssh(machine, posixActivateScript(options), { timeout: 300_000 });
  }
  const payload = parseLastJson(result.stdout);
  if (result.code === 0 && payload?.ok === true) {
    const cleanup = windows ? `Remove-Item -LiteralPath ${psQuote(staging)} -Recurse -Force -ErrorAction SilentlyContinue` : `rm -rf ${posixQuote(staging)}`;
    await ssh(machine, cleanup, { timeout: 120_000 });
    return { ...entry, action: "updated", held: payload?.held === true };
  }
  return { ...entry, action: "hold", reason: `activation failed (${payload?.reason ?? result.code})`, rolledBack: payload?.rolledBack === true, stuck: payload?.stuck === true };
}

async function rollbackMachine(entry, confirmIdle) {
  const { machine, dshDir, windows, verifiable, liveStatus } = entry;
  const bundleRoot = parentDir(dshDir);
  const decision = rollbackDecision(entry, confirmIdle);
  if (!decision.ok) return { ...entry, action: "hold", reason: decision.reason };
  const options = { bundleRoot, dshDir, stopLive: decision.stopLive };
  let result;
  if (windows) {
    const scriptPath = joinPath(true, bundleRoot, remoteScriptName("rollback", "rollback"));
    const script = windowsRollbackScript(options);
    if (!(await writeRemoteScript(machine, scriptPath, script))) return { ...entry, action: "hold", reason: "rollback failed (script-transfer)" };
    result = await runRemoteScript(machine, scriptPath, { timeout: 300_000 });
    await removeRemoteScript(machine, scriptPath);
  } else {
    result = await ssh(machine, posixRollbackScript(options), { timeout: 300_000 });
  }
  const payload = parseLastJson(result.stdout);
  if (result.code === 0 && payload?.ok === true) return { ...entry, action: "rolled back" };
  return { ...entry, action: "hold", reason: `rollback failed (${payload?.reason ?? result.code})`, stuck: payload?.stuck === true };
}

// Re-read the protocol a machine will actually serve: the running runtime's control response when it
// answers, otherwise the installed manifest only after its bytes verify.
async function machineProtocol(entry) {
  const { machine, dshDir, windows } = entry;
  if (entry.verifiable) {
    const parsed = parseLastJson((await ssh(machine, nodeCommand(windows, quoteFor(windows, runtimePath(windows, dshDir)), "--status"))).stdout);
    if (parsed?.result && typeof parsed.result.protocol === "number") return parsed.result.protocol;
  }
  const current = parseLastJson((await ssh(machine, readJsonCommand(windows, manifestPath(windows, dshDir)))).stdout);
  if (typeof current?.protocol !== "number") return null;
  const verify = await ssh(machine, nodeCommand(windows, quoteFor(windows, runtimePath(windows, dshDir)), "--verify", quoteFor(windows, manifestPath(windows, dshDir))));
  return verify.code === 0 ? current.protocol : null;
}

async function incompatibleMachines(entries, manifest) {
  const incompatible = [];
  for (const entry of entries) {
    const protocol = await machineProtocol(entry);
    if (protocol !== manifest.protocol) incompatible.push({ ...entry, machineProtocol: protocol });
  }
  return incompatible;
}

// ── Gateway ─────────────────────────────────────────────────────────────────
async function runningGatewayImage() {
  const list = await run("docker", ["compose", "ps", "-q", "pocket"], { cwd: ROOT });
  const container = list.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (!container) return null;
  const inspect = await run("docker", ["inspect", "--format", "{{.Image}}", container], { cwd: ROOT });
  const id = inspect.stdout.trim();
  if (!/^sha256:[0-9a-f]{64}$/.test(id)) return null;
  const reference = await run("docker", ["inspect", "--format", "{{.Config.Image}}", container], { cwd: ROOT });
  return { id, ref: reference.code === 0 ? reference.stdout.trim() || null : null };
}

async function imageIdFor(reference) {
  if (!reference) return null;
  const inspect = await run("docker", ["image", "inspect", "--format", "{{.Id}}", reference], { cwd: ROOT });
  const id = inspect.stdout.trim();
  return /^sha256:[0-9a-f]{64}$/.test(id) ? id : null;
}

async function retainGatewayImage() {
  const running = await runningGatewayImage();
  if (!running) return null;
  const tag = "codex-pocket-gateway:previous";
  return (await run("docker", ["tag", running.id, tag], { cwd: ROOT })).code === 0 ? { id: running.id, ref: running.ref, tag } : null;
}

// Re-point the compose image at the retained immutable id and restart, so a failed upgrade does not
// leave the new image paired with the old adapters.
async function restoreGatewayImage(retained) {
  if (!retained?.id) return { ok: false, reason: "no retained previous image" };
  const reference = retained.ref ?? await composeImageName();
  if (!reference) return { ok: false, reason: "compose image reference unavailable" };
  const tagged = await run("docker", ["tag", retained.id, reference], { cwd: ROOT });
  if (tagged.code !== 0) return { ok: false, reason: "could not retag the previous image" };
  const up = await run("docker", ["compose", "up", "-d", "--no-build", "pocket"], { cwd: ROOT, timeout: 300_000 });
  return up.code === 0 ? { ok: true } : { ok: false, reason: "the previous image did not start" };
}

async function composeImageName() {
  const config = await run("docker", ["compose", "config", "--images"], { cwd: ROOT });
  const name = config.stdout.trim().split("\n").map((line) => line.trim()).filter(Boolean).at(-1);
  return config.code === 0 && name ? name : null;
}

async function imageProtocol() {
  const js = "const s=require('fs').readFileSync('/app/gateway.ts','utf8');const m=/export const DSH_ADAPTER_PROTOCOL = (\\d+)/.exec(s);console.log(JSON.stringify({protocol:m?Number(m[1]):null}))";
  const probe = await run("docker", ["compose", "run", "--rm", "--no-deps", "-T", "--entrypoint", "node", "pocket", "-e", js], { cwd: ROOT, timeout: 120_000 });
  return parseLastJson(probe.stdout)?.protocol ?? null;
}

// /api/state returns the selected runtime's own snapshot, whose contract field is `machineId`; the
// restart-safety decision comes from that runtime's provider plus the machine it belongs to.
export async function gatewayRequest(pathname, { timeout = 4 } = {}) {
  const path = settingsPath();
  let pin = null;
  try { pin = JSON.parse(readFileSync(path, "utf8")).pin; } catch {}
  const base = "http://127.0.0.1:4173";
  const args = ["-s", "--max-time", String(timeout)];
  if (/^\d{4}$/.test(pin ?? "")) {
    const jar = join(tmpdir(), "pocket-deploy.jar");
    const login = await run("curl", ["-s", "-c", jar, "-X", "POST", "-H", "Content-Type: application/json", "-H", `Origin: ${base}`, "--data", JSON.stringify({ pin }), "--max-time", "4", `${base}/api/login`], { cwd: ROOT });
    if (login.code !== 0) return { code: login.code, value: null, reason: "login failed" };
    args.push("-b", jar);
  }
  const result = await run("curl", [...args, `${base}${pathname}`], { cwd: ROOT });
  return { code: result.code, value: parseLastJson(result.stdout) };
}

async function gatewayState() {
  const path = settingsPath();
  let pin = null;
  try { pin = JSON.parse(readFileSync(path, "utf8")).pin; } catch {}
  if (!/^\d{4}$/.test(pin ?? "")) return { state: "unknown", reason: "no access PIN is configured", durable: false };
  const state = await gatewayRequest("/api/state", { timeout: 4 });
  if (state.code !== 0) return { state: "unknown", reason: "the gateway did not answer", durable: false, detail: state.reason ?? null };
  if (!state.value || typeof state.value !== "object" || typeof state.value.machineId !== "string") return { state: "unknown", reason: "the gateway state did not include the expected machineId contract", durable: false };
  const lifecycle = gatewayLifecycle(state.value);
  return lifecycle.busy ? { state: "busy", durable: lifecycle.durable } : { state: "idle", durable: lifecycle.durable };
}

// A successful `docker compose up -d` exit is not readiness: the running container must be the built
// image and the application must answer its health and state endpoints.
export async function gatewayReadiness(expectedImageId) {
  let last = "no response";
  const attempts = deployTiming.readinessAttempts;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const health = await gatewayRequest("/healthz", { timeout: 3 });
    const healthy = health.code === 0 && health.value?.ok === true;
    const running = await runningGatewayImage();
    const imageOk = expectedImageId ? running?.id === expectedImageId : Boolean(running?.id);
    const state = await gatewayRequest("/api/state", { timeout: 3 });
    const stateOk = state.code === 0 && state.value && typeof state.value === "object" && typeof state.value.machineId === "string";
    if (healthy && imageOk && stateOk) return { ok: true, machineId: state.value.machineId };
    last = !running?.id ? "the gateway container is not running" : !imageOk ? "the running image is not the built image" : !healthy ? "the health check did not pass" : "the state endpoint did not answer";
    if (deployTiming.readinessDelayMs > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, deployTiming.readinessDelayMs));
  }
  return { ok: false, reason: last };
}

async function releaseMarker(entry) {
  const { machine, dshDir, windows } = entry;
  const marker = joinPath(windows, parentDir(dshDir), markerName);
  const command = windows
    ? powershellCommand(`Remove-Item -LiteralPath ${psQuote(marker)} -Force -ErrorAction SilentlyContinue`)
    : `rm -f ${posixQuote(marker)}`;
  await ssh(machine, command, { timeout: 60_000 });
}

// Restore every adapter already switched for a protocol change. If any restore cannot be verified,
// the caller keeps the installations protected and reports the unresolved state.
async function restoreSwitched(switched, manifest) {
  const failures = [];
  for (const done of switched) {
    const refreshed = await inspectMachine(done.machine, manifest, { confirmIdle: true, allowProtocolChange: true });
    const back = await rollbackMachine(refreshed, true);
    if (back.action === "rolled back") log(`${back.name}: restored to the previous protocol`);
    else failures.push(`${back.name}: ${back.reason}`);
  }
  return failures.length ? { ok: false, reason: failures.join("; ") } : { ok: true };
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
  if (gatewayOnly && rollback) { log("--gateway-only never rolls back execution adapters; rerun --rollback without it"); process.exitCode = 1; return; }
  const adapterMode = !gatewayOnly;

  const manifest = localManifest();
  log(`adapter protocol ${manifest.protocol}, bundle ${manifest.bundle.slice(0, 12)}`);

  const all = readMachines().filter((machine) => machine.ssh && machine.dshPath);
  const targets = all.filter((machine) => !only || machine.name === only || machine.ssh === only);
  if (!targets.length && adapterMode) log("no matching execution machines with dshPath configured");

  // Pass 1: read-only inspection of every configured machine. Adapter work is limited to targets;
  // the gateway compatibility decision always covers the whole fleet.
  const inspected = [];
  for (const machine of all) inspected.push(await inspectMachine(machine, manifest, { confirmIdle, allowProtocolChange }));
  const targetKeys = new Set(targets.map((machine) => machine.name || machine.ssh));
  const fleet = planFleet({ entries: inspected, targetKeys, manifest, allowProtocolChange });
  const { isTarget, protocolChanged, blockers } = fleet;
  for (const entry of inspected.filter(isTarget)) {
    const live = entry.verifiable ? (entry.absentProven ? "verified absent" : entry.liveStatus) : "legacy carrier, verified at activation";
    if (entry.action === "current") log(`${entry.name}: up to date`);
    else if (entry.action === "update") log(`${entry.name}: ${dryRun ? "would update" : "ready to update"} (live ${live})`);
    else log(`${entry.name}: pending (${entry.reason}${entry.liveReason ? `; ${entry.liveReason}` : ""})`);
  }
  for (const entry of inspected.filter((entry) => !isTarget(entry))) log(`${entry.name}: untouched (not selected by --machine; protocol ${effectiveProtocol(entry) ?? "unknown"})`);

  if (adapterMode && fleet.reject) {
    for (const entry of fleet.staysBehind) log(`${entry.name}: cannot join the protocol update (protocol ${effectiveProtocol(entry) ?? "unknown"})`);
    log("this machine selection cannot leave a compatible fleet; nothing was activated");
    process.exitCode = 1;
    return;
  }
  if (adapterMode && fleet.blocked) {
    for (const entry of blockers) log(`${entry.name}: blocks the protocol update (${entry.reason})`);
    log("a protocol change is pending and not every selected machine can be updated; nothing was activated");
    process.exitCode = 1;
    return;
  }

  // Rollback is adapter-only, never mutates under --dry-run, and never runs under --gateway-only.
  if (rollback) {
    if (!targets.length) log("nothing to roll back");
    if (dryRun) {
      for (const entry of inspected.filter(isTarget)) {
        const decision = rollbackDecision(entry, confirmIdle);
        log(`${entry.name}: ${decision.ok ? "would roll back" : `pending (${decision.reason})`}`);
      }
      log("dry run: no files, images or containers were changed");
      return;
    }
    for (const entry of inspected.filter(isTarget)) {
      if (entry.action === "hold" && entry.reason === "offline") { log(`${entry.name}: pending (offline)`); continue; }
      const result = await rollbackMachine(entry, confirmIdle);
      log(result.action === "rolled back" ? `${result.name}: rolled back` : `${result.name}: pending (${result.reason})`);
    }
    return;
  }

  if (gatewayOnly) {
    if (protocolFrom(readFileSync(join(ROOT, "gateway.ts"), "utf8"), "gateway.ts") !== manifest.protocol) {
      log("gateway.ts and dsh/projection.mjs disagree on the adapter protocol; nothing was changed");
      process.exitCode = 1;
      return;
    }
    const incompatible = await incompatibleMachines(inspected, manifest);
    if (incompatible.length) {
      for (const entry of incompatible) log(`${entry.name}: blocking gateway-only update (adapter protocol ${entry.machineProtocol ?? "unknown"})`);
      log("run the full deploy so the execution adapters are updated with the gateway");
      process.exitCode = 1;
      return;
    }
  }

  let retained = null;
  let builtImageId = null;
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
      builtImageId = await imageIdFor(retained?.ref);
      log(`gateway image verified (adapter protocol ${builtProtocol})`);
    }
  }

  // Checks that could defer the deployment run before any live installation changes: a task that
  // cannot survive a restart, or an unverifiable gateway state, stops the run here.
  if (!adaptersOnly && !dryRun) {
    const state = await gatewayState();
    const durableBusy = state.state === "busy" && state.durable && !protocolChanged;
    if (state.state === "busy" && !durableBusy) { log("gateway: pending (a non-durable active task is running); nothing was activated"); process.exitCode = 1; return; }
    if (state.state === "unknown" && !confirmIdle) { log(`gateway: pending (${state.reason}; drain the gateway and pass --confirm-idle); nothing was activated`); process.exitCode = 1; return; }
  }

  let switched = [];
  let protocolSensitive = protocolChanged;
  if (adapterMode) {
    // Pass 2: stage and self-verify on every selected machine before anything is activated.
    const archive = inspected.some((entry) => isTarget(entry) && entry.action === "update") && !dryRun ? await buildArchive(manifest) : null;
    const staged = [];
    for (const entry of inspected) {
      if (!isTarget(entry) || entry.action !== "update" || dryRun) { staged.push(entry); continue; }
      const result = await stageMachine(entry, manifest, archive);
      if (result.action === "hold") log(`${result.name}: pending (${result.reason})`);
      staged.push(result);
    }
    const stageFailure = staged.some((entry) => isTarget(entry) && entry.reason?.startsWith("staging failed"));
    if (protocolChanged && stageFailure) {
      log("a protocol change is pending and staging failed; nothing was activated");
      process.exitCode = 1;
      return;
    }

    // Pass 3: idle-only activation. A protocol change or the one-time legacy cutover holds the
    // maintenance marker so the switched adapters stay protected until a compatible gateway is ready.
    const legacyCutover = staged.some((entry) => isTarget(entry) && entry.action === "update" && entry.legacyStop);
    protocolSensitive = protocolChanged || legacyCutover;
    const holdMarker = protocolSensitive;
    for (const entry of staged) {
      if (!isTarget(entry) || entry.action !== "update" || dryRun) continue;
      const result = await activateMachine(entry, manifest, { holdMarker });
      log(result.action === "updated" ? `${result.name}: updated` : `${result.name}: pending (${result.reason}${result.rolledBack ? ", restored the previous install" : ""})`);
      if (result.action === "updated") { switched.push(result); continue; }
      if (protocolSensitive) {
        log("an adapter target failed; returning the machines already switched to the previous arrangement");
        const restored = await restoreSwitched(switched, manifest);
        if (!restored.ok) log(`adapter restore unresolved: ${restored.reason}; affected installations stay protected`);
        process.exitCode = 1;
        return;
      }
    }
    if (dryRun) {
      log("dry run: no files, images or containers were changed");
      return;
    }
  }

  if (dryRun) {
    log("dry run: no files, images or containers were changed");
    return;
  }

  if (!adaptersOnly) {
    // The gateway may only move once the whole fleet it attaches to serves the built protocol.
    const incompatible = await incompatibleMachines(inspected, manifest);
    let failure = null;
    if (incompatible.length) {
      for (const entry of incompatible) log(`${entry.name}: gateway waits on adapter protocol ${entry.machineProtocol ?? "unknown"}`);
      failure = "an execution adapter is not on the built protocol";
    } else {
      log("activating the gateway…");
      const up = await run("docker", ["compose", "up", "-d", "--no-build", "pocket"], { cwd: ROOT, timeout: 300_000 });
      if (up.code !== 0) {
        failure = `gateway start failed (${up.stderr.slice(-200)})`;
      } else {
        const ready = await gatewayReadiness(builtImageId);
        if (!ready.ok) failure = `readiness failed (${ready.reason})`;
        else {
          for (const done of switched) if (done.held) await releaseMarker(done);
          log(`gateway: updated${retained ? ` (previous image kept as ${retained.tag})` : ""}`);
        }
      }
    }
    if (failure) {
      log(`gateway: pending (${failure})`);
      const gatewayRestore = await restoreGatewayImage(retained);
      if (protocolSensitive) {
        // The switched adapters cannot pair with the old gateway: return them to the retained
        // generation, and keep them protected if that restore cannot be verified.
        const adapterRestore = await restoreSwitched(switched, manifest);
        if (!adapterRestore.ok) {
          log(`adapter restore unresolved: ${adapterRestore.reason}`);
          log("affected installations stay protected; run --rollback after an operator drains the machine");
        } else if (gatewayRestore.ok) {
          log("restored the previous compatible gateway and adapter arrangement");
        } else {
          log(`gateway restore unresolved: ${gatewayRestore.reason}`);
        }
      } else if (!gatewayRestore.ok) {
        log(`gateway restore unresolved: ${gatewayRestore.reason}`);
      } else {
        log("restored the previous gateway image; the adapters remain compatible");
      }
      process.exitCode = 1;
    }
  } else if (protocolChanged) {
    log("execution adapters are on the new protocol; run the full deploy (or restart the gateway with the new image) before DSH is usable again");
  }
  if (inspected.some((entry) => isTarget(entry) && entry.action === "update" && !entry.verifiable)) log("note: the legacy cutover verified the old carrier at activation; a run interrupted mid-cutover expires its maintenance marker");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`deploy failed: ${error.message}`);
    process.exitCode = 1;
  });
}
