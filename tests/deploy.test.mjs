// Deployment and runtime-carrier checks. Everything here runs against throwaway directories and
// fake installs: no SSH, no Docker, no production state, no DSH credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADAPTER_FILES, FEATURES, liveStatusFrom, localManifest, planMachine,
  posixActivateScript, posixRollbackScript, posixStageScript, windowsActivateScript, windowsRollbackScript, windowsStageScript,
} from "../scripts/deploy.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const hasPosixTools = process.platform !== "win32"
  && spawnSync("bash", ["-c", "true"]).status === 0
  && spawnSync("tar", ["--version"]).status === 0;

const temp = (prefix) => mkdtempSync(join(tmpdir(), prefix));

// A fake runtime that answers --verify/--probe/--stop the way the real carrier does. It can be told
// to fail only outside a staging directory, which simulates a corrupt copy during activation.
function runtimeSource({ liveProbeFails = false, stopReason = null } = {}) {
  return `const mode = process.argv[2];
const inStage = process.argv[1].includes('.pocket-staging');
if (mode === '--probe' || mode === '--verify') {
  const ok = ${liveProbeFails} ? inStage : true;
  process.stdout.write(ok ? '{"ok":true}' : '{"ok":false}');
  process.exit(ok ? 0 : 1);
}
if (mode === '--stop') {
  process.stdout.write(${stopReason ? JSON.stringify(JSON.stringify({ ok: false, reason: stopReason })) : "'{\"ok\":true,\"result\":{\"accepted\":true}}'"});
  process.exit(${stopReason ? 1 : 0});
}
process.exit(1);`;
}

// A fake live adapter install: a `dsh` directory plus a `deepseek.ts` beside it.
function fakeBundle(options = {}) {
  const bundle = join(temp("pocket-deploy-bundle-"), "bundle");
  mkdirSync(join(bundle, "dsh"), { recursive: true });
  for (const file of ADAPTER_FILES) {
    const destination = join(bundle, file);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, `LIVE ${file}\n`);
  }
  writeFileSync(join(bundle, "dsh/runtime.mjs"), runtimeSource(options));
  writeFileSync(join(bundle, "dsh/.pocket-adapter.json"), JSON.stringify({
    protocol: options.protocol ?? 2, bundle: "old-bundle", lockHash: "old-lock", features: [...FEATURES], files: {},
  }));
  return bundle;
}

function fakeStaging(options = {}) {
  const source = temp("pocket-deploy-stage-");
  for (const file of ADAPTER_FILES) {
    const destination = join(source, file);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, `STAGED ${file}\n`);
  }
  writeFileSync(join(source, "dsh/runtime.mjs"), runtimeSource(options));
  writeFileSync(join(source, "pocket-manifest.json"), JSON.stringify({
    protocol: options.protocol ?? 2, bundle: "new-bundle", lockHash: "new-lock", features: [...FEATURES], files: {},
  }));
  return source;
}

function archiveOf(source) {
  const result = spawnSync("tar", ["-czf", "-", "-C", source, "."], { maxBuffer: 1 << 28 });
  assert.equal(result.status, 0, "the test archive is created");
  return result.stdout;
}

const runScript = (script, { input } = {}) => spawnSync("bash", ["-c", script], { input, encoding: "utf8" });

test("the deploy manifest matches the gateway protocol and advertises runtime capabilities", () => {
  const manifest = localManifest();
  const gateway = /export const DSH_ADAPTER_PROTOCOL = (\d+)/.exec(readFileSync(join(ROOT, "gateway.ts"), "utf8"));
  assert.ok(gateway, "gateway.ts declares the protocol");
  assert.equal(manifest.protocol, Number(gateway[1]));
  for (const feature of FEATURES) assert.ok(manifest.features.includes(feature), `manifest advertises ${feature}`);
  assert.equal(manifest.files["dsh/runtime.mjs"].length, 64, "the manifest hashes the carrier");
});

test("planMachine keeps old, busy and protocol-mismatched installations pending", () => {
  const manifest = { bundle: "new", protocol: 2, lockHash: "lock" };
  const modern = (extra) => ({ protocol: 2, bundle: "old", lockHash: "lock", features: [...FEATURES], ...extra });
  assert.equal(planMachine({ current: null, manifest, liveStatus: null, confirmIdle: false, allowProtocolChange: false }).action, "hold");
  assert.equal(planMachine({ current: null, manifest, liveStatus: null, confirmIdle: true, allowProtocolChange: false }).action, "update");
  // One of two turns finishing leaves the runtime busy; a trustworthy busy runtime is never touched.
  assert.equal(planMachine({ current: modern(), manifest, liveStatus: "busy", confirmIdle: true, allowProtocolChange: false }).action, "hold");
  assert.equal(planMachine({ current: modern(), manifest, liveStatus: "idle", confirmIdle: false, allowProtocolChange: false }).action, "update");
  // An install without the control-socket capability is never inspected through its live runtime.
  const legacy = { protocol: 1, bundle: "old", lockHash: "lock", features: [] };
  assert.equal(planMachine({ current: legacy, manifest, liveStatus: null, confirmIdle: true, allowProtocolChange: false }).action, "hold");
  const upgrade = planMachine({ current: legacy, manifest, liveStatus: null, confirmIdle: true, allowProtocolChange: true });
  assert.equal(upgrade.action, "update");
  assert.equal(upgrade.protocolChanged, true);
  assert.equal(upgrade.stopLive, false, "a legacy install is never stopped through the durable control path");
  // Already current, including every capability.
  assert.equal(planMachine({ current: modern({ bundle: "new" }), manifest, liveStatus: "idle", confirmIdle: false, allowProtocolChange: false }).action, "current");
});

test("an unproven runtime status is never treated as idle", () => {
  // Only an explicit boolean answer or a genuinely unreachable endpoint counts as idle.
  assert.equal(liveStatusFrom('{"ok":true,"result":{"busy":true,"protocol":2}}'), "busy");
  assert.equal(liveStatusFrom('{"ok":true,"result":{"busy":false,"protocol":2}}'), "idle");
  assert.equal(liveStatusFrom('{"ok":false,"reason":"unreachable"}'), "idle");
  assert.equal(liveStatusFrom('{"ok":false,"reason":"timeout"}'), "unknown");
  assert.equal(liveStatusFrom('{"ok":false,"reason":"error"}'), "unknown");
  assert.equal(liveStatusFrom("not json"), "unknown");
  assert.equal(liveStatusFrom(""), "unknown");

  const manifest = { bundle: "new", protocol: 2, lockHash: "lock" };
  const current = { protocol: 2, bundle: "old", lockHash: "lock", features: [...FEATURES] };
  const held = planMachine({ current, manifest, liveStatus: "unknown", confirmIdle: false, allowProtocolChange: false });
  assert.equal(held.action, "hold");
  const confirmed = planMachine({ current, manifest, liveStatus: "unknown", confirmIdle: true, allowProtocolChange: false });
  assert.equal(confirmed.action, "update");
  assert.equal(confirmed.stopLive, false, "an unproven status never authorizes stopping the runtime");
});

test("generated activation scripts verify before and after the swap and never mask failures", () => {
  const stage = posixStageScript({ bundleRoot: "/b", staging: "/b/.pocket-staging-x", installDeps: true });
  assert.match(stage, /set -eu/);
  assert.match(stage, /--verify/);
  assert.match(stage, /--probe/);
  assert.match(stage, /npm ci/);
  const activate = posixActivateScript({ bundleRoot: "/b", dshDir: "/b/dsh", staging: "/b/.pocket-staging-x", stopLive: true });
  assert.match(activate, /\.pocket-deploying/);
  assert.match(activate, /\.pocket-previous/);
  assert.match(activate, /--verify/);
  assert.match(activate, /--probe/);
  assert.match(activate, /rolledBack/);
  assert.doesNotMatch(activate, /chmod 644 "\$DSH\/"\*/);
  assert.doesNotMatch(activate, /\|\| true/);
  assert.doesNotMatch(activate, /reason==='timeout'/, "a timed-out stop is not accepted as idle");
  const windowsStage = windowsStageScript({ bundleRoot: "C:\\b", staging: "C:\\b\\stage", installDeps: true });
  assert.match(windowsStage, /\$LASTEXITCODE/);
  assert.match(windowsStage, /OpenStandardInput/);
  assert.doesNotMatch(windowsStage, /FromBase64String/);
  const windowsActivate = windowsActivateScript({ bundleRoot: "C:\\b", dshDir: "C:\\b\\dsh", staging: "C:\\b\\stage", stopLive: true });
  assert.match(windowsActivate, /\$LASTEXITCODE/);
  assert.match(windowsActivate, /Restore/);
  assert.match(windowsActivate, /\.pocket-deploying/);
  assert.doesNotMatch(windowsActivate, /reason -eq 'timeout'/, "a timed-out stop is not accepted as idle");
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
  assert.equal(JSON.parse(clean.stdout.trim()).ok, true);
  writeFileSync(join(bundle, "dsh/launch.mjs"), "tampered\n");
  const tampered = spawnSync(process.execPath, [runtime, "--verify", join(bundle, "pocket-manifest.json")], { encoding: "utf8" });
  assert.equal(tampered.status, 1);
  assert.deepEqual(JSON.parse(tampered.stdout.trim()).mismatches, ["dsh/launch.mjs"]);
});

test("the attach client refuses to launch behind a fresh maintenance marker", () => {
  const root = temp("pocket-launch-");
  const bundle = join(root, "bundle");
  mkdirSync(join(bundle, "dsh"), { recursive: true });
  for (const file of ["launch.mjs", "endpoint.mjs"]) copyFileSync(join(ROOT, "dsh", file), join(bundle, "dsh", file));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(bundle, ".pocket-deploying"), JSON.stringify({ at: Date.now() }), { mode: 0o600 });
  const result = spawnSync(process.execPath, [join(bundle, "dsh/launch.mjs")], {
    env: { ...process.env, POCKET_DSH_HOME: home },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /deployment in progress/);
});

test("staging and activation replace a POSIX install and retain the previous one", { skip: !hasPosixTools && "requires bash and tar" }, () => {
  const bundle = fakeBundle();
  const staging = join(bundle, ".pocket-staging-new-bundle");
  const staged = runScript(posixStageScript({ bundleRoot: bundle, staging, installDeps: false }), { input: archiveOf(fakeStaging()) });
  assert.equal(staged.status, 0, staged.stderr);
  const activated = runScript(posixActivateScript({ bundleRoot: bundle, dshDir: join(bundle, "dsh"), staging, stopLive: true }));
  assert.equal(activated.status, 0, activated.stderr);
  assert.equal(JSON.parse(activated.stdout.trim()).ok, true);
  assert.match(readFileSync(join(bundle, "dsh/launch.mjs"), "utf8"), /STAGED/);
  assert.equal(JSON.parse(readFileSync(join(bundle, "dsh/.pocket-adapter.json"), "utf8")).bundle, "new-bundle");
  assert.equal(existsSync(join(bundle, ".pocket-deploying")), false, "the maintenance marker is removed");
  assert.match(readFileSync(join(bundle, ".pocket-previous/dsh/launch.mjs"), "utf8"), /LIVE/, "the replaced install is retained for rollback");
});

test("a failed post-activation check restores the previous POSIX install", { skip: !hasPosixTools && "requires bash and tar" }, () => {
  const options = { liveProbeFails: true };
  const bundle = fakeBundle(options);
  const staging = join(bundle, ".pocket-staging-new-bundle");
  const staged = runScript(posixStageScript({ bundleRoot: bundle, staging, installDeps: false }), { input: archiveOf(fakeStaging(options)) });
  assert.equal(staged.status, 0, staged.stderr);
  const activated = runScript(posixActivateScript({ bundleRoot: bundle, dshDir: join(bundle, "dsh"), staging, stopLive: true }));
  assert.equal(activated.status, 6);
  assert.equal(JSON.parse(activated.stdout.trim()).rolledBack, true);
  assert.equal(JSON.parse(readFileSync(join(bundle, "dsh/.pocket-adapter.json"), "utf8")).bundle, "old-bundle", "the previous manifest is back");
  assert.equal(existsSync(join(bundle, ".pocket-deploying")), false);
});

test("a busy runtime refuses activation without mutating the install", { skip: !hasPosixTools && "requires bash and tar" }, () => {
  const options = { stopReason: "busy" };
  const bundle = fakeBundle(options);
  const staging = join(bundle, ".pocket-staging-new-bundle");
  const staged = runScript(posixStageScript({ bundleRoot: bundle, staging, installDeps: false }), { input: archiveOf(fakeStaging(options)) });
  assert.equal(staged.status, 0, staged.stderr);
  const activated = runScript(posixActivateScript({ bundleRoot: bundle, dshDir: join(bundle, "dsh"), staging, stopLive: true }));
  assert.equal(activated.status, 3);
  assert.equal(JSON.parse(activated.stdout.trim()).reason, "busy");
  assert.match(readFileSync(join(bundle, "dsh/launch.mjs"), "utf8"), /LIVE/, "the live install is untouched");
  assert.equal(existsSync(join(bundle, ".pocket-previous")), false);
  assert.equal(existsSync(join(bundle, ".pocket-deploying")), false);
});

test("a rollback restores the retained POSIX install without deleting it first", { skip: !hasPosixTools && "requires bash and tar" }, () => {
  const bundle = fakeBundle();
  const staging = join(bundle, ".pocket-staging-new-bundle");
  assert.equal(runScript(posixStageScript({ bundleRoot: bundle, staging, installDeps: false }), { input: archiveOf(fakeStaging()) }).status, 0);
  assert.equal(runScript(posixActivateScript({ bundleRoot: bundle, dshDir: join(bundle, "dsh"), staging, stopLive: true })).status, 0);
  assert.match(readFileSync(join(bundle, "dsh/launch.mjs"), "utf8"), /STAGED/);
  const rolled = runScript(posixRollbackScript({ bundleRoot: bundle, dshDir: join(bundle, "dsh"), stopLive: true }));
  assert.equal(rolled.status, 0, rolled.stderr);
  assert.equal(JSON.parse(rolled.stdout.trim()).ok, true);
  assert.match(readFileSync(join(bundle, "dsh/launch.mjs"), "utf8"), /LIVE/, "the previous install is back");
  assert.equal(JSON.parse(readFileSync(join(bundle, "dsh/.pocket-adapter.json"), "utf8")).bundle, "old-bundle");
  assert.equal(existsSync(join(bundle, ".pocket-deploying")), false);
});

test("a rollback without a retained install changes nothing", { skip: !hasPosixTools && "requires bash and tar" }, () => {
  const bundle = fakeBundle();
  const rolled = runScript(posixRollbackScript({ bundleRoot: bundle, dshDir: join(bundle, "dsh"), stopLive: true }));
  assert.equal(rolled.status, 4);
  assert.equal(JSON.parse(rolled.stdout.trim()).reason, "no-previous");
  assert.match(readFileSync(join(bundle, "dsh/launch.mjs"), "utf8"), /LIVE/);
  assert.equal(existsSync(join(bundle, ".pocket-deploying")), false);
});

test("the Windows rollback script restores in place instead of swapping a directory", () => {
  const script = windowsRollbackScript({ bundleRoot: "C:\\b", dshDir: "C:\\b\\dsh", stopLive: false });
  assert.match(script, /\.pocket-previous/);
  assert.match(script, /Copy-Item/);
  assert.doesNotMatch(script, /Remove-Item -LiteralPath \$PREV -Recurse/);
  assert.match(script, /\$LASTEXITCODE/);
});
