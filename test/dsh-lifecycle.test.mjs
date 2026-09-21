// Machine-side DSH home lifecycle safety: cold start with no home directory, and exclusive ownership
// when launchers race or a stale lock is reclaimed. Both run against a disposable adapter copy, a
// disposable home and a stub SDK child, so no live session, credential or real DSH install is touched.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sourceDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dsh");
const ADAPTER_FILES = ["bridge.mjs", "projection.mjs", "launch.mjs", "runtime.mjs", "endpoint.mjs", "router.mjs", "pocket.patch.yml"];
// Mirrors LOCK_WRITE_GRACE_MS in runtime.mjs: a lock younger than this may still be mid-write.
const GRACE_MS = 2_000;
const children = new Set();
const roots = [];

after(() => {
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {}
  }
});

function makeAdapter() {
  const root = mkdtempSync(join(tmpdir(), "pocket-dsh-lifecycle-"));
  roots.push(root);
  const adapter = join(root, "adapter");
  mkdirSync(adapter, { recursive: true });
  for (const file of ADAPTER_FILES) copyFileSync(join(sourceDir, file), join(adapter, file));
  // installationReady() only reads these manifests, and the child only has to stay alive so the
  // runtime serves its own sockets without reaching a real session or the network.
  const sdk = join(adapter, "node_modules", "@deepseek-ai");
  mkdirSync(join(sdk, "dsh", "lib"), { recursive: true });
  mkdirSync(join(sdk, "dsh-sdk-protocol"), { recursive: true });
  writeFileSync(join(sdk, "dsh", "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.0.0-test" }));
  writeFileSync(join(sdk, "dsh", "lib", "bin.js"), "process.stdin.resume();\nsetInterval(() => {}, 1_000);\n");
  writeFileSync(join(sdk, "dsh-sdk-protocol", "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-sdk-protocol", version: "0.0.0-test" }));
  return { adapter, home: join(root, "home") };
}

const env = (home) => ({ ...process.env, POCKET_DSH_HOME: home, DEEPSEEK_API_KEY: "test-key-not-a-credential" });

function track(child) {
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function startRuntime(adapter, home) {
  return track(spawn(process.execPath, [join(adapter, "runtime.mjs")], { env: env(home), stdio: ["ignore", "ignore", "ignore"] }));
}

function control(adapter, home, mode) {
  const result = spawnSync(process.execPath, [join(adapter, "runtime.mjs"), mode], { env: env(home), encoding: "utf8", timeout: 15_000 });
  if (result.status !== 0) return null;
  const line = String(result.stdout ?? "").trim().split("\n").pop();
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

const status = (adapter, home) => control(adapter, home, "--status");
const stop = (adapter, home) => control(adapter, home, "--stop");

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const lockPath = (home) => join(home, "pocket-owner");
const lockRaw = (home) => {
  try {
    return readFileSync(lockPath(home), "utf8");
  } catch {
    return null;
  }
};
const lockPid = (home) => {
  const pid = Number(String(lockRaw(home) ?? "").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

function seedLock(home, content, { settled = false } = {}) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(lockPath(home), content, { mode: 0o600 });
  if (settled) {
    const when = (Date.now() - GRACE_MS - 1_000) / 1000;
    utimesSync(lockPath(home), when, when);
  }
}

async function exitedPid() {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const pid = child.pid;
  await new Promise((resolve) => child.once("exit", resolve));
  return pid;
}

const survivors = (runtimes) => runtimes.filter((child) => child.exitCode === null && child.signalCode === null);

// Bounded so a regression that leaves a runtime serving fails the test instead of hanging it.
function exitCode(child, timeoutMs = 8_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

test("launch starts a runtime with no home directory and attaches", async () => {
  const { adapter, home } = makeAdapter();
  assert.equal(existsSync(home), false, "the home must start absent");
  const launch = track(spawn(process.execPath, [join(adapter, "launch.mjs")], { env: env(home), stdio: ["pipe", "ignore", "ignore"] }));
  const state = await waitFor(() => status(adapter, home));
  assert.ok(state, "launch did not bring up a runtime from a fresh home");
  // POSIX mode bits are emulated on Windows, where the runtime skips the permission check too.
  if (process.platform !== "win32") {
    assert.equal(statSync(home).mode & 0o777, 0o700, "the launcher must create a private home");
  }
  const pid = lockPid(home);
  assert.ok(pid && alive(pid), "the running runtime must own the lock");
  launch.stdin.end();
  assert.equal(await exitCode(launch), 0, "attach should exit cleanly");
  stop(adapter, home);
  assert.ok(await waitFor(() => !alive(pid)), "the runtime should shut down");
  assert.equal(existsSync(lockPath(home)), false, "shutdown releases the home");
});

test("concurrent launchers elect exactly one owner", async () => {
  const { adapter, home } = makeAdapter();
  const runtimes = [1, 2, 3].map(() => startRuntime(adapter, home));
  assert.ok(await waitFor(() => status(adapter, home)), "no runtime came up");
  await new Promise((resolve) => setTimeout(resolve, 600));
  const one = survivors(runtimes);
  assert.equal(one.length, 1, "only one runtime may own the home");
  assert.equal(lockPid(home), one[0].pid, "the lock must name the surviving owner");
  stop(adapter, home);
});

test("a fresh empty or partial lock is never reclaimed", async () => {
  for (const content of ["", "12"]) {
    const { adapter, home } = makeAdapter();
    seedLock(home, content);
    const child = startRuntime(adapter, home);
    const code = await exitCode(child);
    assert.equal(code, 0, `a runtime must not claim an unattributable lock (${JSON.stringify(content)})`);
    assert.equal(lockRaw(home), content, "the unattributable lock must be left untouched");
  }
});

test("a settled dead-owner lock is reclaimed", async () => {
  const { adapter, home } = makeAdapter();
  seedLock(home, String(await exitedPid()), { settled: true });
  const child = startRuntime(adapter, home);
  assert.ok(await waitFor(() => status(adapter, home)), "genuine dead-owner recovery must still work");
  assert.equal(lockPid(home), child.pid);
  stop(adapter, home);
});

test("a settled lock abandoned mid-write is reclaimed", async () => {
  const { adapter, home } = makeAdapter();
  seedLock(home, "", { settled: true });
  const child = startRuntime(adapter, home);
  assert.ok(await waitFor(() => status(adapter, home)), "an abandoned partial lock must be recovered");
  assert.equal(lockPid(home), child.pid);
  stop(adapter, home);
});

test("concurrent stale-lock recovery elects exactly one owner", async () => {
  const { adapter, home } = makeAdapter();
  seedLock(home, String(await exitedPid()), { settled: true });
  const runtimes = [1, 2, 3].map(() => startRuntime(adapter, home));
  assert.ok(await waitFor(() => status(adapter, home)), "no runtime recovered the stale lock");
  await new Promise((resolve) => setTimeout(resolve, 600));
  const one = survivors(runtimes);
  assert.equal(one.length, 1, "only one runtime may own the home after recovery");
  assert.equal(lockPid(home), one[0].pid, "a replacement lock must not be deleted by a stale observation");
  stop(adapter, home);
});
