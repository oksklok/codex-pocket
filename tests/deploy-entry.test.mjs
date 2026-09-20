// Deployment entrypoint checks. External commands are replaced at the processRunner seam so main()
// runs with controlled SSH/Docker/curl boundaries; no host, container or credential is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployTiming, localManifest, main, processRunner } from "../scripts/deploy.mjs";

const originalRun = processRunner.run;
const originalDataDir = process.env.CODEX_POCKET_DATA_DIR;
const IMAGE_A = "sha256:" + "a".repeat(64);
const IMAGE_B = "sha256:" + "b".repeat(64);
const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });

// A stateful fake host: it answers the deploy's SSH scripts and Docker/curl calls, and tracks the
// running image so readiness and gateway restore behave like a real container lifecycle.
function harness({ manifest, status, owner, gatewayState, health = true, failFirstUp = false, marker = null, releaseFails = false, healthFailures = 0 } = {}) {
  const calls = [];
  const state = { imageId: IMAGE_A, builtId: IMAGE_B, refTarget: IMAGE_B, upCalls: 0, healthChecks: 0, markerReleased: false };
  const currentManifest = manifest ?? { protocol: 2, bundle: "old-bundle", lockHash: "old-lock", features: ["control-socket", "integrity-verify", "idle-only-shutdown"], files: { "dsh/runtime.mjs": "x" } };
  const statusValue = status ?? { ok: true, result: { busy: false, protocol: 2 } };
  const ownerValue = owner ?? { ok: true, state: "absent" };
  const gateway = gatewayState ?? {
    machineId: "ssh:mac:dsh",
    provider: "deepseek",
    connected: true,
    machines: [{ id: "ssh:mac:dsh", provider: "deepseek", connected: true }],
    turn: null,
    threadStatus: "idle",
    phase: "done",
  };
  processRunner.run = async (command, args = [], options = {}) => {
    calls.push({ command, args, hasInput: Boolean(options.input) });
    if (command === "ssh") {
      const script = String(args.at(-1) ?? "");
      if (script.includes("echo pocket-deploy-ok")) return ok("pocket-deploy-ok\n");
      if (script.includes("tar -xzf - -C")) return ok('{"ok":true}\n');
      if (script.includes("MUTATED=1")) return ok('{"ok":true,"held":true}\n');
      if (script.includes("no-previous")) return ok('{"ok":true}\n');
      if (script.includes(".pocket-deploying")) {
        if (script.includes("rm -f") || script.includes("Remove-Item")) {
          if (releaseFails) return { code: 1, stdout: "", stderr: "release failed" };
          state.markerReleased = true;
          return ok("");
        }
        return ok(marker && !state.markerReleased ? `${JSON.stringify(marker)}\n` : "null");
      }
      if (script.includes("--owner")) return ok(`${JSON.stringify(ownerValue)}\n`);
      if (script.includes("--status")) return ok(`${JSON.stringify(statusValue)}\n`);
      if (script.includes("--verify")) return ok("");
      if (script.includes(".pocket-adapter.json") && script.includes("node -e")) return ok(`${JSON.stringify(currentManifest)}\n`);
      return { code: 1, stdout: "", stderr: `unexpected ssh script: ${script.slice(0, 80)}` };
    }
    if (command === "docker") {
      const line = args.join(" ");
      if (line.startsWith("compose config --images")) return ok("codex-pocket-pocket\n");
      if (line.startsWith("compose ps -q")) return ok("container1\n");
      if (line.includes("inspect --format {{.Image}}")) return ok(`${state.imageId}\n`);
      if (line.includes("inspect --format {{.Config.Image}}")) return ok("codex-pocket-pocket:latest\n");
      if (line.startsWith("image inspect")) return ok(`${state.refTarget}\n`);
      if (line.startsWith("tag ")) {
        if (args[2] === "codex-pocket-pocket:latest") state.refTarget = args[1];
        return ok("");
      }
      if (line.startsWith("compose build")) return ok("");
      if (line.startsWith("compose run")) return ok('{"protocol":2}\n');
      if (line.startsWith("compose up")) {
        state.upCalls += 1;
        if (failFirstUp && state.upCalls === 1) return { code: 1, stdout: "", stderr: "start failed" };
        // The container now runs whatever the compose reference resolves to.
        state.imageId = state.refTarget;
        return ok("");
      }
      return { code: 1, stdout: "", stderr: `unexpected docker: ${line}` };
    }
    if (command === "curl") {
      const line = args.join(" ");
      if (line.includes("/api/login")) return ok("{}");
      if (line.includes("/healthz")) { state.healthChecks += 1; return ok(state.healthChecks <= healthFailures || health ? '{"ok":true}' : '{"ok":false}'); }
      if (line.includes("/api/state")) return ok(JSON.stringify(gateway));
      return { code: 0, stdout: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
  };
  return { calls, state, currentManifest };
}

function withSettings(machines, run) {
  const dir = mkdtempSync(join(tmpdir(), "pocket-entry-"));
  writeFileSync(join(dir, ".codex-pocket.local.json"), JSON.stringify({ pin: "1234", machines }));
  const previous = process.env.CODEX_POCKET_DATA_DIR;
  process.env.CODEX_POCKET_DATA_DIR = dir;
  return (async () => {
    try {
      return await run();
    } finally {
      process.env.CODEX_POCKET_DATA_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  })();
}

const MACHINE = { name: "Mac", ssh: "mac", dshPath: "/opt/pocket/dsh/launch.mjs" };
const mutation = (calls) => calls.filter((call) => call.command === "ssh" && /tar -xzf|MUTATED=1|no-previous/.test(String(call.args.at(-1))));

test.afterEach(() => { processRunner.run = originalRun; process.exitCode = 0; deployTiming.readinessAttempts = 90; deployTiming.readinessDelayMs = 1000; });

test("--gateway-only never stages, stops or updates execution adapters", async () => {
  const h = harness();
  process.exitCode = 0;
  await withSettings([MACHINE], () => main(["--gateway-only", "--settings", "ignored"]));
  assert.equal(mutation(h.calls).length, 0, "no adapter mutation ran");
  const stops = h.calls.filter((call) => call.command === "ssh" && String(call.args.at(-1)).includes("--stop"));
  assert.equal(stops.length, 0, "no runtime was stopped");
  assert.ok(h.calls.some((call) => call.command === "docker" && call.args.join(" ").startsWith("compose up")), "the gateway was activated");
  assert.equal(process.exitCode, 0);
});

test("--dry-run --rollback performs no rollback or other mutation", async () => {
  const h = harness();
  process.exitCode = 0;
  await withSettings([MACHINE], () => main(["--rollback", "--dry-run", "--settings", "ignored"]));
  assert.equal(mutation(h.calls).length, 0);
  assert.equal(h.calls.some((call) => call.command === "docker"), false, "no image or container work");
  assert.equal(process.exitCode, 0);
});

test("--dry-run --gateway-only builds nothing and starts nothing", async () => {
  const h = harness();
  process.exitCode = 0;
  await withSettings([MACHINE], () => main(["--gateway-only", "--dry-run", "--settings", "ignored"]));
  assert.equal(h.calls.some((call) => call.command === "docker"), false, "no image build or container change");
  assert.equal(process.exitCode, 0);
});

test("a modern runtime that cannot be verified stays pending even with --confirm-idle", async () => {
  const h = harness({ status: { ok: false, reason: "no-reply" }, owner: { ok: true, state: "owned", pid: 4321, dshChildren: [] } });
  process.exitCode = 0;
  await withSettings([MACHINE], () => main(["--adapters-only", "--confirm-idle", "--settings", "ignored"]));
  assert.equal(mutation(h.calls).length, 0, "nothing was staged or activated");
  assert.equal(process.exitCode, 0);
});

test("a protocol upgrade whose final fleet check fails restores the adapters and the gateway", async () => {
  // The installed adapter is an older protocol; after activation the runtime still reports the old
  // protocol, which must fail the final fleet check and trigger restoration.
  const h = harness({ manifest: { protocol: 1, bundle: "old-bundle", lockHash: "old-lock", features: ["control-socket", "integrity-verify", "idle-only-shutdown"], files: { "dsh/runtime.mjs": "x" } }, status: { ok: true, result: { busy: false, protocol: 1 } } });
  deployTiming.readinessAttempts = 1;
  deployTiming.readinessDelayMs = 0;
  process.exitCode = 0;
  await withSettings([MACHINE], () => main(["--allow-protocol-change", "--settings", "ignored"]));
  const scripts = h.calls.filter((call) => call.command === "ssh").map((call) => String(call.args.at(-1)));
  assert.ok(scripts.some((script) => script.includes("MUTATED=1")), "activation ran");
  assert.ok(scripts.some((script) => script.includes("no-previous")), "the switched adapter was rolled back");
  assert.ok(h.calls.some((call) => call.command === "docker" && call.args.join(" ").startsWith("tag ")), "the previous gateway image was restored");
  assert.equal(process.exitCode, 1);
});

test("a gateway start failure restores the compatible arrangement", async () => {
  const h = harness({ failFirstUp: true });
  deployTiming.readinessAttempts = 1;
  deployTiming.readinessDelayMs = 0;
  process.exitCode = 0;
  await withSettings([MACHINE], () => main(["--settings", "ignored"]));
  assert.ok(h.calls.some((call) => call.command === "docker" && call.args.join(" ").startsWith("tag ")), "the previous image was retagged");
  assert.equal(process.exitCode, 1);
});

test("a readiness failure restores the previous gateway image", async () => {
  const h = harness({ health: false });
  deployTiming.readinessAttempts = 1;
  deployTiming.readinessDelayMs = 0;
  process.exitCode = 0;
  await withSettings([MACHINE], () => main(["--settings", "ignored"]));
  assert.ok(h.calls.some((call) => call.command === "docker" && call.args.join(" ").startsWith("tag ")), "the previous image was retagged");
  assert.equal(process.exitCode, 1);
});

test("a compatible gateway-only redeploy proceeds while durable DSH work is running", async () => {
  const h = harness({
    gatewayState: {
      machineId: "ssh:mac:dsh",
      provider: "deepseek",
      connected: true,
      machines: [{ id: "ssh:mac:dsh", provider: "deepseek", connected: true }],
      turn: { id: "turn-1", status: "inProgress" },
      threadStatus: "active",
      phase: "working",
    },
  });
  process.exitCode = 0;
  await withSettings([MACHINE], () => main(["--gateway-only", "--settings", "ignored"]));
  const stops = h.calls.filter((call) => call.command === "ssh" && String(call.args.at(-1)).includes("--stop"));
  assert.equal(stops.length, 0, "no execution runtime was stopped");
  assert.ok(h.calls.some((call) => call.command === "docker" && call.args.join(" ").startsWith("compose up")), "the compatible gateway was activated");
  assert.equal(process.exitCode, 0);
});

const releaseCalls = (calls) => calls.filter((call) => call.command === "ssh" && /rm -f .*pocket-deploying|Remove-Item .*pocket-deploying/.test(String(call.args.at(-1))));

test("an absent owner with a surviving DSH child is refused", async () => {
  const h = harness({ status: { ok: false, reason: "no-reply" }, owner: { ok: true, state: "absent", dshChildren: [{ pid: 99 }], dshChildrenKnown: true } });
  process.exitCode = 0;
  await withSettings([MACHINE], () => main(["--adapters-only", "--settings", "ignored"]));
  assert.equal(mutation(h.calls).length, 0, "a surviving child blocks replacement");
  assert.equal(process.exitCode, 0);
});

test("failed DSH-child enumeration is refused", async () => {
  const h = harness({ status: { ok: false, reason: "no-reply" }, owner: { ok: true, state: "absent", dshChildren: null, dshChildrenKnown: false } });
  process.exitCode = 0;
  await withSettings([MACHINE], () => main(["--adapters-only", "--settings", "ignored"]));
  assert.equal(mutation(h.calls).length, 0, "incomplete ownership evidence blocks replacement");
});

test("--adapters-only rejects a coordinated cutover before any mutation", async () => {
  const h = harness({ manifest: { protocol: 1, bundle: "old-bundle", lockHash: "old-lock", features: ["control-socket", "integrity-verify", "idle-only-shutdown"], files: { "dsh/runtime.mjs": "x" } }, status: { ok: true, result: { busy: false, protocol: 1 } } });
  process.exitCode = 0;
  await withSettings([MACHINE], () => main(["--adapters-only", "--allow-protocol-change", "--settings", "ignored"]));
  assert.equal(mutation(h.calls).length, 0);
  assert.equal(process.exitCode, 1);
});

test("a compatible rerun finishes an already-current held target", async () => {
  const current = localManifest();
  const h = harness({ manifest: { protocol: current.protocol, bundle: current.bundle, lockHash: "old-lock", features: ["control-socket", "integrity-verify", "idle-only-shutdown"], files: { "dsh/runtime.mjs": "x" } }, marker: { at: Date.now() } });
  process.exitCode = 0;
  await withSettings([MACHINE], () => main(["--gateway-only", "--settings", "ignored"]));
  assert.equal(releaseCalls(h.calls).length, 1, "the held marker was released");
  assert.equal(process.exitCode, 0);
});

test("a marker-release failure is reported as unresolved", async () => {
  const current = localManifest();
  const h = harness({ manifest: { protocol: current.protocol, bundle: current.bundle, lockHash: "old-lock", features: ["control-socket", "integrity-verify", "idle-only-shutdown"], files: { "dsh/runtime.mjs": "x" } }, marker: { at: Date.now() }, releaseFails: true });
  process.exitCode = 0;
  await withSettings([MACHINE], () => main(["--gateway-only", "--settings", "ignored"]));
  assert.equal(releaseCalls(h.calls).length, 1);
  assert.equal(process.exitCode, 1, "a release failure is not success");
});

test("a restored-but-unhealthy gateway is not reported as recovery", async () => {
  const h = harness({ manifest: { protocol: 1, bundle: "old-bundle", lockHash: "old-lock", features: ["control-socket", "integrity-verify", "idle-only-shutdown"], files: { "dsh/runtime.mjs": "x" } }, status: { ok: true, result: { busy: false, protocol: 1 } }, health: false });
  deployTiming.readinessAttempts = 1;
  deployTiming.readinessDelayMs = 0;
  process.exitCode = 0;
  await withSettings([MACHINE], () => main(["--allow-protocol-change", "--settings", "ignored"]));
  assert.equal(releaseCalls(h.calls).length, 0, "transition protection stays in place");
  assert.equal(process.exitCode, 1);
});

test("verified recovery releases protection only after the restored gateway is ready", async () => {
  const h = harness({ manifest: { protocol: 1, bundle: "old-bundle", lockHash: "old-lock", features: ["control-socket", "integrity-verify", "idle-only-shutdown"], files: { "dsh/runtime.mjs": "x" } }, status: { ok: true, result: { busy: false, protocol: 1 } }, healthFailures: 1 });
  deployTiming.readinessAttempts = 1;
  deployTiming.readinessDelayMs = 0;
  process.exitCode = 0;
  await withSettings([MACHINE], () => main(["--allow-protocol-change", "--settings", "ignored"]));
  const scripts = h.calls.filter((call) => call.command === "ssh").map((call) => String(call.args.at(-1)));
  assert.ok(scripts.some((script) => script.includes("no-previous")), "the switched adapter was restored");
  assert.ok(h.calls.some((call) => call.command === "docker" && call.args.join(" ").startsWith("tag ")), "the retained image was restored");
  assert.equal(process.exitCode, 1, "the deployment still ends pending while recovery succeeded");
});
