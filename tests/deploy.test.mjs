// Deployment and runtime-carrier checks. Everything here runs against throwaway directories and
// fake installs: no SSH, no Docker, no production state, no DSH credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADAPTER_FILES, FEATURES, effectiveProtocol, gatewayLifecycle, liveReasonFrom, liveStatusFrom, localManifest, markerName,
  planFleet, planMachine, posixActivateScript, posixRollbackScript, posixStageScript, posixLegacyStopLines, posixQuote, powershellCommand, previousName,
  rollbackDecision, windowsActivateScript, windowsRollbackScript, windowsStageScript,
} from "../scripts/deploy.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const hasPosixTools = process.platform !== "win32"
  && spawnSync("bash", ["-c", "true"]).status === 0
  && spawnSync("tar", ["--version"]).status === 0;
const realDeps = join(ROOT, "dsh/node_modules");
const temp = (prefix) => mkdtempSync(join(tmpdir(), prefix));

// A fake runtime that behaves like the real carrier: --probe/--verify read a real dependency through
// the staged or live node_modules, and an injected file can fail a post-activation probe.
function fakeRuntime({ ownerAbsent = true, stopBusy = false } = {}) {
  const owner = ownerAbsent
    ? '{"ok":true,"state":"absent","dshChildren":[],"dshChildrenKnown":true}'
    : '{"ok":true,"state":"owned","pid":1,"dshChildren":[],"dshChildrenKnown":true}';
  const stop = stopBusy ? '{"ok":false,"reason":"busy"}' : '{"ok":true,"result":{"accepted":true}}';
  return `import fs from 'node:fs';
import p from 'node:path';
const dir = p.dirname(new URL(import.meta.url).pathname);
const mode = process.argv[2];
if (mode === '--probe' || mode === '--verify') {
  if (fs.existsSync(p.join(dir, 'FORCE_PROBE_FAIL'))) { process.stdout.write('{"ok":false}'); process.exit(1); }
  try { fs.readFileSync(p.join(dir, 'node_modules', 'marker.txt')); } catch { process.stdout.write('{"ok":false,"reason":"no-deps"}'); process.exit(1); }
  process.stdout.write('{"ok":true}'); process.exit(0);
}
if (mode === '--owner') { process.stdout.write('${owner}'); process.exit(0); }
if (mode === '--stop') { process.stdout.write('${stop}'); process.exit(${stopBusy ? 1 : 0}); }
process.exit(1);`;
}

// A fake live adapter install: a dsh directory, a deepseek.ts beside it, and a loadable runtime.
function fakeBundle(options = {}) {
  const bundle = join(temp("pocket-deploy-bundle-"), "bundle");
  const dsh = join(bundle, "dsh");
  mkdirSync(join(dsh, "node_modules"), { recursive: true });
  writeFileSync(join(dsh, "node_modules", "marker.txt"), "deps\n");
  for (const file of ADAPTER_FILES) {
    const destination = join(bundle, file);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, `LIVE ${file}\n`);
  }
  writeFileSync(join(dsh, "runtime.mjs"), fakeRuntime(options));
  writeFileSync(join(dsh, ".pocket-adapter.json"), JSON.stringify({ protocol: 2, bundle: "old-bundle", lockHash: "old-lock", features: [...FEATURES], files: {} }));
  return { bundle, dsh };
}

function fakeStaging(options = {}) {
  const source = temp("pocket-deploy-stage-");
  for (const file of ADAPTER_FILES) {
    const destination = join(source, file);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, `STAGED ${file}\n`);
  }
  writeFileSync(join(source, "dsh/runtime.mjs"), fakeRuntime(options));
  writeFileSync(join(source, "pocket-manifest.json"), JSON.stringify({ protocol: 2, bundle: "new-bundle", lockHash: "new-lock", features: [...FEATURES], files: {} }));
  return source;
}

const archiveOf = (source) => spawnSync("tar", ["-czf", "-", "-C", source, "."], { maxBuffer: 1 << 28 }).stdout;
const runScript = (script, input) => spawnSync("bash", ["-c", script], { input, encoding: "utf8" });
const payloadOf = (result) => {
  try { return JSON.parse(result.stdout.trim().split("\n").filter(Boolean).pop()); } catch { return null; }
};

test("the deploy manifest matches the gateway protocol and includes the router", () => {
  const value = localManifest();
  const gateway = /export const DSH_ADAPTER_PROTOCOL = (\d+)/.exec(readFileSync(join(ROOT, "gateway.ts"), "utf8"));
  assert.ok(gateway, "gateway.ts declares the protocol");
  assert.equal(value.protocol, Number(gateway[1]));
  for (const feature of FEATURES) assert.ok(value.features.includes(feature), `manifest advertises ${feature}`);
  assert.ok(value.files["dsh/router.mjs"], "the manifest hashes the routing module");
});

test("planMachine keeps old, busy and protocol-mismatched installations pending", () => {
  const m = { bundle: "new", protocol: 2, lockHash: "lock" };
  const modern = (extra) => ({ protocol: 2, bundle: "old", lockHash: "lock", features: [...FEATURES], ...extra });
  assert.equal(planMachine({ current: null, manifest: m, liveStatus: null, confirmIdle: false, allowProtocolChange: false }).action, "hold");
  assert.equal(planMachine({ current: null, manifest: m, liveStatus: null, confirmIdle: true, allowProtocolChange: false }).action, "update");
  assert.equal(planMachine({ current: modern(), manifest: m, liveStatus: "busy", confirmIdle: true, allowProtocolChange: false }).action, "hold");
  assert.equal(planMachine({ current: modern(), manifest: m, liveStatus: "unknown", confirmIdle: false, allowProtocolChange: false }).action, "hold");
  assert.equal(planMachine({ current: modern(), manifest: m, liveStatus: "unknown", confirmIdle: true, allowProtocolChange: false }).action, "hold", "--confirm-idle cannot bypass a modern runtime that cannot be verified");
  assert.equal(planMachine({ current: modern(), manifest: m, liveStatus: "idle", absentProven: true, confirmIdle: false, allowProtocolChange: false }).stopLive, false, "a proven-absent runtime needs no stop");
  const legacy = { protocol: 1, bundle: "old", lockHash: "lock", features: [] };
  assert.equal(planMachine({ current: legacy, manifest: m, liveStatus: null, confirmIdle: true, allowProtocolChange: false }).action, "hold");
  const cutover = planMachine({ current: legacy, manifest: m, liveStatus: null, confirmIdle: true, allowProtocolChange: true });
  assert.equal(cutover.action, "update");
  assert.equal(cutover.legacyStop, true, "the first cutover stops the old carrier");
  assert.equal(planMachine({ current: modern({ bundle: "new" }), manifest: m, liveStatus: "idle", confirmIdle: false, allowProtocolChange: false }).action, "current");
});

test("an unproven runtime status is never treated as idle", () => {
  assert.equal(liveStatusFrom('{"ok":true,"result":{"busy":true,"protocol":2}}'), "busy");
  assert.equal(liveStatusFrom('{"ok":true,"result":{"busy":false,"protocol":2}}'), "idle");
  assert.equal(liveStatusFrom('{"ok":false,"reason":"refused","detail":"ENOENT"}'), "unknown", "a refused endpoint is not idle");
  assert.equal(liveStatusFrom('{"ok":false,"reason":"no-reply"}'), "unknown");
  assert.equal(liveStatusFrom('{"ok":false,"reason":"timeout"}'), "unknown");
  assert.equal(liveStatusFrom("not json"), "unknown");
  assert.equal(liveReasonFrom('{"ok":false,"reason":"no-reply"}'), "no-reply");
});

test("the gateway restart decision uses the machineId contract, not a name suffix", () => {
  // The shape matches MachineRuntime.snapshot() plus listMachines(): provider is a label, and only a
  // connected runtime that passed the durable adapter handshake counts as durable.
  const value = {
    machineId: "ssh:mac:dsh",
    provider: "deepseek",
    connected: true,
    machines: [{ id: "ssh:mac:dsh", provider: "deepseek", connected: true }],
    turn: { id: "t", status: "inProgress" },
  };
  assert.deepEqual(gatewayLifecycle(value), { machineId: "ssh:mac:dsh", durable: true, busy: true });
  assert.equal(gatewayLifecycle({ ...value, provider: "openai" }).durable, false, "a provider label alone is not durability");
  assert.equal(gatewayLifecycle({ ...value, connected: false }).durable, false, "a disconnected runtime is not durable");
  assert.equal(gatewayLifecycle({ ...value, machines: [{ id: "ssh:mac:dsh", provider: "deepseek", connected: false }] }).durable, false);
  assert.equal(gatewayLifecycle({ machineId: "ssh:mac:dsh", provider: "deepseek", connected: true, machines: [], turn: null }).busy, false);
});

test("the running protocol wins over the installed manifest for compatibility", () => {
  assert.equal(effectiveProtocol({ statusProtocol: 3, installedVerified: true, current: { protocol: 2 } }), 3);
  assert.equal(effectiveProtocol({ statusProtocol: null, installedVerified: true, current: { protocol: 2 } }), 2);
  assert.equal(effectiveProtocol({ statusProtocol: null, installedVerified: false, current: { protocol: 2 } }), null, "an unverified install is unknown");
  assert.equal(effectiveProtocol({ current: null }), null);
});

test("a --machine selection never narrows the fleet compatibility check", () => {
  const m = { protocol: 2 };
  const entries = [
    { key: "A", action: "current", protocolChanged: false, statusProtocol: 2, installedVerified: true, current: { protocol: 2 } },
    { key: "B", action: "update", protocolChanged: true, statusProtocol: 1, installedVerified: true, current: { protocol: 1 } },
  ];
  const partial = planFleet({ entries, targetKeys: new Set(["A"]), manifest: m, allowProtocolChange: false });
  assert.equal(partial.isTarget(entries[1]), false);
  assert.equal(partial.staysBehind.length, 1, "B is not a target and cannot join the update");
  assert.equal(partial.reject, true, "a partial protocol upgrade is refused before mutation");
  const full = planFleet({ entries, targetKeys: new Set(["A", "B"]), manifest: m, allowProtocolChange: true });
  assert.equal(full.reject, false);
});

test("rollback blocks on a busy or unproven runtime, matching activation", () => {
  assert.equal(rollbackDecision({ verifiable: true, liveStatus: "busy" }, true).ok, false);
  assert.equal(rollbackDecision({ verifiable: true, liveStatus: "unknown" }, false).ok, false);
  assert.deepEqual(rollbackDecision({ verifiable: true, liveStatus: "idle" }, false), { ok: true, stopLive: true });
  assert.deepEqual(rollbackDecision({ verifiable: false, liveStatus: null }, true), { ok: true, stopLive: false });
});

test("POSIX staging reuses locked dependencies only when the lock is unchanged", () => {
  const withDeps = posixStageScript({ bundleRoot: "/b", dshDir: "/b/dsh", staging: "/b/stage", installDeps: true });
  assert.match(withDeps, /INSTALL_DEPS=1/);
  assert.match(withDeps, /npm ci/);
  const reused = posixStageScript({ bundleRoot: "/b", dshDir: "/b/dsh", staging: "/b/stage", installDeps: false });
  assert.match(reused, /INSTALL_DEPS=0/);
  assert.match(reused, /ln -s "\$DSH\/node_modules"/);
  assert.match(reused, /--probe/);
  assert.match(reused, /rm -f "\$STAGE\/dsh\/node_modules"/);
});

test("activation scripts verify before and after the swap and restore on any failure", () => {
  const activate = posixActivateScript({ bundleRoot: "/b", dshDir: "/b/dsh", staging: "/b/stage", installDeps: false, stopLive: true, legacyStop: false });
  assert.match(activate, /--verify/);
  assert.match(activate, /--probe/);
  assert.match(activate, /install_ok/);
  assert.match(activate, /MUTATED=1/);
  assert.match(activate, /fail "activation-failed"/);
  assert.match(activate, /marker_stuck/);
  assert.doesNotMatch(activate, /chmod 644 "\$DSH\/"\*/);
  assert.match(activate, /safe_idle/);
  assert.match(activate, /unsafe-state/);
  assert.doesNotMatch(activate, /\|\| true/);
  const rollback = posixRollbackScript({ bundleRoot: "/b", dshDir: "/b/dsh", stopLive: true });
  assert.match(rollback, /dsh\/launch\.mjs/, "a manifest-less legacy backup is recognized");
  assert.match(rollback, /node --check/, "a legacy restore is verified by checks it supports");
  assert.match(rollback, /safe_idle/);
  assert.match(rollback, /HOLD_MARKER/);
});

test("Windows scripts travel as files, never as large command arguments", () => {
  const script = windowsActivateScript({ bundleRoot: "C:\\b", dshDir: "C:\\b\\dsh", staging: "C:\\b\\stage", installDeps: false, stopLive: true, legacyStop: false });
  assert.ok(script.length > 1500, "the activation script is substantial");
  assert.match(script, /\$LASTEXITCODE/);
  assert.match(script, /function Restore/);
  const invocation = powershellCommand("& 'C:\\b\\activate.ps1'; exit $LASTEXITCODE");
  assert.ok(invocation.length < 600, "the invocation stays short");
  assert.ok(!invocation.includes("node_modules"), "no script body or archive is embedded");
  assert.match(powershellCommand(script), /EncodedCommand/);
  assert.match(windowsRollbackScript({ bundleRoot: "C:\\b", dshDir: "C:\\b\\dsh", stopLive: false }), /Restore|Copy-Item/);
  assert.match(windowsStageScript({ bundleRoot: "C:\\b", dshDir: "C:\\b\\dsh", staging: "C:\\b\\stage", installDeps: false }), /Junction/);
});

test("the runtime verifies installed bytes against a manifest", () => {
  const bundle = join(temp("pocket-verify-"), "bundle");
  for (const file of ADAPTER_FILES) {
    const destination = join(bundle, file);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(ROOT, file), destination);
  }
  writeFileSync(join(bundle, "pocket-manifest.json"), JSON.stringify(localManifest()));
  const runtime = join(bundle, "dsh/runtime.mjs");
  const clean = spawnSync(process.execPath, [runtime, "--verify", join(bundle, "pocket-manifest.json")], { encoding: "utf8" });
  assert.equal(clean.status, 0, clean.stderr);
  writeFileSync(join(bundle, "dsh/launch.mjs"), "tampered\n");
  const tampered = spawnSync(process.execPath, [runtime, "--verify", join(bundle, "pocket-manifest.json")], { encoding: "utf8" });
  assert.equal(tampered.status, 1);
  assert.deepEqual(JSON.parse(tampered.stdout.trim()).mismatches, ["dsh/launch.mjs"]);
});

test("code-only staging with reused locked dependencies passes the real probe", { skip: !hasPosixTools || !existsSync(realDeps) }, () => {
  const bundle = join(temp("pocket-realstage-"), "bundle");
  for (const file of ADAPTER_FILES) {
    const destination = join(bundle, file);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(ROOT, file), destination);
  }
  symlinkSync(realDeps, join(bundle, "dsh/node_modules"), "dir");
  const probe = spawnSync(process.execPath, [join(bundle, "dsh/runtime.mjs"), "--probe"], { encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stdout + probe.stderr);
  assert.equal(JSON.parse(probe.stdout.trim()).ok, true);
});

test("the attach client refuses to launch behind a fresh or stuck maintenance marker", () => {
  const root = temp("pocket-launch-");
  const bundle = join(root, "bundle");
  mkdirSync(join(bundle, "dsh"), { recursive: true });
  for (const file of ["launch.mjs", "endpoint.mjs"]) copyFileSync(join(ROOT, "dsh", file), join(bundle, "dsh", file));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const marker = join(bundle, markerName);
  const run = () => spawnSync(process.execPath, [join(bundle, "dsh/launch.mjs")], { env: { ...process.env, POCKET_DSH_HOME: home }, encoding: "utf8", timeout: 10_000 });
  writeFileSync(marker, JSON.stringify({ at: Date.now() }));
  assert.match(run().stderr, /deployment in progress/);
  writeFileSync(marker, JSON.stringify({ stuck: true, at: 0 }));
  const stuck = run();
  assert.equal(stuck.status, 1);
  assert.match(stuck.stderr, /deployment in progress/, "a stuck marker never expires");
});

test("staging and activation replace a POSIX install, retain it, and roll back", { skip: !hasPosixTools }, () => {
  const { bundle, dsh } = fakeBundle();
  const staging = join(bundle, ".pocket-staging-new-bundle");
  const staged = runScript(posixStageScript({ bundleRoot: bundle, dshDir: dsh, staging, installDeps: false }), archiveOf(fakeStaging()));
  assert.equal(staged.status, 0, staged.stderr);
  assert.equal(existsSync(join(staging, "dsh/node_modules")), false, "the dependency link is removed after the probe");
  const activated = runScript(posixActivateScript({ bundleRoot: bundle, dshDir: dsh, staging, installDeps: false, stopLive: true, legacyStop: false }));
  assert.equal(activated.status, 0, activated.stdout + activated.stderr);
  assert.match(readFileSync(join(dsh, "launch.mjs"), "utf8"), /STAGED/);
  assert.match(readFileSync(join(bundle, previousName, "dsh/launch.mjs"), "utf8"), /LIVE/, "the previous install is retained");
  assert.equal(existsSync(join(bundle, markerName)), false);
  const rolled = runScript(posixRollbackScript({ bundleRoot: bundle, dshDir: dsh, stopLive: true }));
  assert.equal(rolled.status, 0, rolled.stdout + rolled.stderr);
  assert.match(readFileSync(join(dsh, "launch.mjs"), "utf8"), /LIVE/);
  assert.equal(existsSync(join(bundle, previousName, "dsh/launch.mjs")), true, "the backup survives restoration");
});

test("a runtime that starts during staging prevents replacement", { skip: !hasPosixTools }, () => {
  // Inspection proved absence, but by activation a verified owner exists and its idle-only stop
  // refuses: the activation must defer instead of overwriting a running runtime.
  const { bundle, dsh } = fakeBundle({ ownerAbsent: true, stopBusy: true });
  const staging = join(bundle, ".pocket-staging-new-bundle");
  runScript(posixStageScript({ bundleRoot: bundle, dshDir: dsh, staging, installDeps: false }), archiveOf(fakeStaging({ ownerAbsent: false })));
  const activated = runScript(posixActivateScript({ bundleRoot: bundle, dshDir: dsh, staging, installDeps: false, stopLive: false, legacyStop: false, holdMarker: false }));
  assert.equal(activated.status, 3, activated.stdout + activated.stderr);
  assert.equal(payloadOf(activated).reason, "busy");
  assert.match(readFileSync(join(dsh, "launch.mjs"), "utf8"), /LIVE/, "the running installation is untouched");
  assert.equal(existsSync(join(bundle, previousName)), false);
});

test("a failure halfway through activation restores the previous install", { skip: !hasPosixTools }, () => {
  const { bundle, dsh } = fakeBundle();
  const staging = join(bundle, ".pocket-staging-new-bundle");
  runScript(posixStageScript({ bundleRoot: bundle, dshDir: dsh, staging, installDeps: false }), archiveOf(fakeStaging()));
  chmodSync(join(staging, "dsh/launch.mjs"), 0o000);
  const activated = runScript(posixActivateScript({ bundleRoot: bundle, dshDir: dsh, staging, installDeps: false, stopLive: true, legacyStop: false }));
  const payload = payloadOf(activated);
  assert.notEqual(activated.status, 0);
  assert.equal(payload.rolledBack, true);
  assert.equal(payload.stuck, undefined, "a clean restore is not stuck");
  assert.match(readFileSync(join(dsh, "launch.mjs"), "utf8"), /LIVE/, "the old install is back");
  assert.equal(existsSync(join(bundle, markerName)), false);
});

test("a busy runtime refuses activation without mutating the install", { skip: !hasPosixTools }, () => {
  const options = { ownerAbsent: false, stopBusy: true };
  const { bundle, dsh } = fakeBundle(options);
  const staging = join(bundle, ".pocket-staging-new-bundle");
  runScript(posixStageScript({ bundleRoot: bundle, dshDir: dsh, staging, installDeps: false }), archiveOf(fakeStaging(options)));
  const activated = runScript(posixActivateScript({ bundleRoot: bundle, dshDir: dsh, staging, installDeps: false, stopLive: true, legacyStop: false }));
  assert.equal(activated.status, 3);
  assert.equal(payloadOf(activated).reason, "busy");
  assert.match(readFileSync(join(dsh, "launch.mjs"), "utf8"), /LIVE/);
  assert.equal(existsSync(join(bundle, previousName)), false);
  assert.equal(existsSync(join(bundle, markerName)), false);
});

test("a rollback to a manifest-less legacy install restores the old file set", { skip: !hasPosixTools }, () => {
  const { bundle, dsh } = fakeBundle();
  const legacy = join(bundle, previousName, "dsh");
  mkdirSync(legacy, { recursive: true });
  for (const file of ["launch.mjs", "bridge.mjs", "projection.mjs", "package.json", "package-lock.json", "pocket.patch.yml"]) {
    writeFileSync(join(legacy, file), `// LEGACY ${file}\n`);
  }
  const rolled = runScript(posixRollbackScript({ bundleRoot: bundle, dshDir: dsh, stopLive: true }));
  assert.equal(rolled.status, 0, rolled.stdout + rolled.stderr);
  assert.match(readFileSync(join(dsh, "launch.mjs"), "utf8"), /\/\/ LEGACY/);
  assert.equal(existsSync(join(dsh, "runtime.mjs")), false, "a new-generation file is not left behind");
  assert.equal(existsSync(join(dsh, ".pocket-adapter.json")), false, "no false manifest is left behind");
  assert.equal(existsSync(join(bundle, previousName, "dsh/launch.mjs")), true, "the legacy backup is preserved");
});

test("a refused rollback preserves an existing stuck marker unchanged", { skip: !hasPosixTools }, () => {
  const { bundle, dsh } = fakeBundle({ ownerAbsent: false, stopBusy: true });
  mkdirSync(join(bundle, previousName, "dsh"), { recursive: true });
  writeFileSync(join(bundle, previousName, "dsh/launch.mjs"), "// previous\n");
  const markerFile = join(bundle, markerName);
  writeFileSync(markerFile, JSON.stringify({ stuck: true, at: 123 }));
  const rolled = runScript(posixRollbackScript({ bundleRoot: bundle, dshDir: dsh, stopLive: true }));
  assert.equal(rolled.status, 5, rolled.stdout + rolled.stderr);
  assert.deepEqual(JSON.parse(readFileSync(markerFile, "utf8")), { stuck: true, at: 123 }, "stuck protection is neither downgraded nor removed");
});

test("a rollback whose restoration is unusable keeps protection and marks it stuck", { skip: !hasPosixTools }, () => {
  const { bundle, dsh } = fakeBundle();
  const legacy = join(bundle, previousName, "dsh");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "launch.mjs"), "this is not valid javascript {\n");
  writeFileSync(join(legacy, "bridge.mjs"), "// legacy bridge\n");
  writeFileSync(join(legacy, "projection.mjs"), "// legacy projection\n");
  const markerFile = join(bundle, markerName);
  writeFileSync(markerFile, JSON.stringify({ at: 789 }));
  const rolled = runScript(posixRollbackScript({ bundleRoot: bundle, dshDir: dsh, stopLive: true }));
  assert.equal(rolled.status, 7, rolled.stdout + rolled.stderr);
  assert.equal(JSON.parse(readFileSync(markerFile, "utf8")).stuck, true, "an unusable restoration stays protected");
});

test("a refused rollback preserves an existing held marker unchanged", { skip: !hasPosixTools }, () => {
  const { bundle, dsh } = fakeBundle({ ownerAbsent: false, stopBusy: true });
  mkdirSync(join(bundle, previousName, "dsh"), { recursive: true });
  writeFileSync(join(bundle, previousName, "dsh/launch.mjs"), "// previous\n");
  const markerFile = join(bundle, markerName);
  writeFileSync(markerFile, JSON.stringify({ at: 456 }));
  const rolled = runScript(posixRollbackScript({ bundleRoot: bundle, dshDir: dsh, stopLive: true }));
  assert.equal(rolled.status, 5);
  assert.deepEqual(JSON.parse(readFileSync(markerFile, "utf8")), { at: 456 }, "held protection is preserved");
});

test("a refused rollback with no prior marker leaves no new protection behind", { skip: !hasPosixTools }, () => {
  const { bundle, dsh } = fakeBundle({ ownerAbsent: false, stopBusy: true });
  mkdirSync(join(bundle, previousName, "dsh"), { recursive: true });
  writeFileSync(join(bundle, previousName, "dsh/launch.mjs"), "// previous\n");
  const rolled = runScript(posixRollbackScript({ bundleRoot: bundle, dshDir: dsh, stopLive: true }));
  assert.equal(rolled.status, 5);
  assert.equal(existsSync(join(bundle, markerName)), false, "the temporary marker this run created is cleaned up");
});

test("a rollback without a retained install changes nothing", { skip: !hasPosixTools }, () => {
  const { bundle, dsh } = fakeBundle();
  const rolled = runScript(posixRollbackScript({ bundleRoot: bundle, dshDir: dsh, stopLive: true }));
  assert.equal(rolled.status, 4);
  assert.equal(payloadOf(rolled).reason, "no-previous");
  assert.match(readFileSync(join(dsh, "launch.mjs"), "utf8"), /LIVE/);
});

// A temp adapter tree with the real runtime so the ownership probe sees the same code as production.
function ownerFixture() {
  const root = temp("pocket-owner-");
  const bundle = join(root, "bundle");
  const dsh = join(bundle, "dsh");
  mkdirSync(join(dsh, "node_modules", "@deepseek-ai", "dsh", "lib"), { recursive: true });
  writeFileSync(join(dsh, "node_modules/@deepseek-ai/dsh/lib/bin.js"), "// dsh bin\n");
  for (const file of ["runtime.mjs", "endpoint.mjs", "projection.mjs", "router.mjs", "launch.mjs", "bridge.mjs", "pocket.patch.yml", "package.json"]) {
    copyFileSync(join(ROOT, "dsh", file), join(dsh, file));
  }
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "pocket.patch.yml"), "# patch\n");
  return { root, bundle, dsh, home, lock: join(home, "pocket-owner") };
}

const ownerProbe = (fixture) => spawnSync(process.execPath, [join(fixture.dsh, "runtime.mjs"), "--owner", fixture.dsh], {
  env: { ...process.env, POCKET_DSH_HOME: fixture.home },
  encoding: "utf8",
  timeout: 20000,
});
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; } };

test("an owner lock pointing at an unrelated process is never treated as the carrier", () => {
  const fixture = ownerFixture();
  const unrelated = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], { stdio: "ignore" });
  const pid = unrelated.pid;
  writeFileSync(fixture.lock, `${pid}\n`);
  try {
    const value = JSON.parse(ownerProbe(fixture).stdout.trim().split("\n").pop());
    assert.equal(value.state, "unverified", "an unrelated process is not proof of ownership");
    assert.equal(isAlive(pid), true, "the unrelated process is left untouched");
  } finally {
    try { process.kill(pid, "SIGKILL"); } catch {}
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a verified legacy carrier and its DSH child are both stopped before files change", async () => {
  const fixture = ownerFixture();
  const lull = "setTimeout(()=>{},60000)";
  const carrier = spawn(process.execPath, ["-e", lull, join(fixture.dsh, "launch.mjs")], { stdio: "ignore" });
  const child = spawn(process.execPath, ["-e", lull, join(fixture.dsh, "node_modules/@deepseek-ai/dsh/lib/bin.js"), "--patch", join(fixture.home, "pocket.patch.yml")], { stdio: "ignore" });
  writeFileSync(fixture.lock, `${carrier.pid}\n`);
  const script = [
    "set -eu",
    `STAGE=${posixQuote(fixture.bundle)}`,
    `DSH=${posixQuote(fixture.dsh)}`,
    `DSH_HOME_DIR=${posixQuote(fixture.home)}`,
    "LOCK_CLAIMED=0",
    'fail() { printf \'FAIL:%s\\n\' "$1"; exit 6; }',
    ...posixLegacyStopLines(true),
    "printf 'OK\\n'",
  ].join("\n");
  try {
    const probe = JSON.parse(ownerProbe(fixture).stdout.trim().split("\n").pop());
    assert.equal(probe.state, "owned", "the expected launcher is recognized");
    assert.ok(Array.isArray(probe.dshChildren) && probe.dshChildren.length >= 1, "the DSH child is identified");
    const result = spawnSync("bash", ["-c", script], { env: { ...process.env, POCKET_DSH_HOME: fixture.home }, encoding: "utf8", timeout: 30000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /OK/);
    // Let this process reap the children it killed before checking they are gone.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(isAlive(carrier.pid), false, "the carrier is stopped");
    assert.equal(isAlive(child.pid), false, "the DSH child is stopped");
  } finally {
    for (const pid of [carrier.pid, child.pid]) { try { process.kill(pid, "SIGKILL"); } catch {} }
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
