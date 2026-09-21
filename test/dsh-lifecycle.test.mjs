// Machine-side DSH home lifecycle safety: cold start with no home directory, and exclusive ownership
// when launchers race or a stale lock is reclaimed. Both run against a disposable adapter copy, a
// disposable home and a stub SDK child, so no live session, credential or real DSH install is touched.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sourceDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dsh");
const ADAPTER_FILES = ["bridge.mjs", "projection.mjs", "launch.mjs", "runtime.mjs", "endpoint.mjs", "router.mjs", "pocket.patch.yml"];
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
  // installationReady() only reads these manifests. The stub exits when its runtime closes stdin, so a
  // runtime that is killed without a clean shutdown never leaves it behind.
  const sdk = join(adapter, "node_modules", "@deepseek-ai");
  mkdirSync(join(sdk, "dsh", "lib"), { recursive: true });
  mkdirSync(join(sdk, "dsh-sdk-protocol"), { recursive: true });
  writeFileSync(join(sdk, "dsh", "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.0.0-test" }));
  writeFileSync(join(sdk, "dsh", "lib", "bin.js"), "process.stdin.resume();\nprocess.stdin.on('end', () => process.exit(0));\nsetInterval(() => {}, 1_000);\n");
  writeFileSync(join(sdk, "dsh-sdk-protocol", "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-sdk-protocol", version: "0.0.0-test" }));
  return { root, adapter, home: join(root, "home") };
}

const env = (home) => ({ ...process.env, POCKET_DSH_HOME: home, DEEPSEEK_API_KEY: "test-key-not-a-credential" });

function track(child) {
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
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
    await new Promise((resolve) => setTimeout(resolve, 50));
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
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

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

async function terminate(child, timeoutMs = 5_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if ((await exitCode(child, timeoutMs)) !== null) return;
  child.kill("SIGKILL");
  await exitCode(child, timeoutMs);
}

// A runtime killed with SIGKILL can orphan its stub SDK child; every process still referencing this
// fixture's directory is torn down so nothing survives the test that started it.
async function sweepFixture(root) {
  if (process.platform === "win32") return;
  const listed = spawnSync("ps", ["-Ao", "pid=,args="], { encoding: "utf8" });
  for (const line of String(listed.stdout ?? "").split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match || !match[2].includes(root) || Number(match[1]) === process.pid) continue;
    try {
      process.kill(Number(match[1]), "SIGKILL");
    } catch {}
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}

async function terminatePid(pid, timeoutMs = 5_000) {
  if (!alive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  if ((await waitFor(() => !alive(pid), timeoutMs)) !== null) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
  await waitFor(() => !alive(pid), timeoutMs);
}

// Every fixture tears down its own processes and waits for them before removing the directory, whether
// the test passed or failed: `t.after` runs on both paths.
function fixture(t) {
  const { root, adapter, home } = makeAdapter();
  const tracked = [];
  const trackChild = (child) => {
    tracked.push(child);
    return track(child);
  };
  t.after(async () => {
    const owner = status(adapter, home)?.result?.pid ?? lockPid(home);
    stop(adapter, home);
    await terminatePid(owner);
    for (const child of tracked) await terminate(child);
    await sweepFixture(root);
    rmSync(root, { recursive: true, force: true });
  });
  return {
    adapter,
    home,
    track: trackChild,
    startRuntime() {
      return trackChild(spawn(process.execPath, [join(adapter, "runtime.mjs")], { env: env(home), stdio: ["ignore", "ignore", "ignore"] }));
    },
  };
}

// The claims directory is the ownership authority; the pid file is only the winner's report.
const claimsDir = (home) => join(home, "pocket-owners");
function seedClaim(home, index, pid) {
  mkdirSync(claimsDir(home), { recursive: true, mode: 0o700 });
  writeFileSync(join(claimsDir(home), String(index).padStart(6, "0")), String(pid), { mode: 0o600 });
}
const claimPids = (home) => {
  try {
    return readdirSync(claimsDir(home)).filter((name) => /^\d{6}$/.test(name)).map((name) => Number(readFileSync(join(claimsDir(home), name), "utf8").trim())).sort((a, b) => a - b);
  } catch {
    return [];
  }
};

async function exitedPid() {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const pid = child.pid;
  await new Promise((resolve) => child.once("exit", resolve));
  return pid;
}

const survivors = (runtimes) => runtimes.filter((child) => child.exitCode === null && child.signalCode === null);

test("launch starts a runtime with no home directory and attaches", async (t) => {
  const f = fixture(t);
  assert.equal(existsSync(f.home), false, "the home must start absent");
  const launch = f.track(spawn(process.execPath, [join(f.adapter, "launch.mjs")], { env: env(f.home), stdio: ["pipe", "ignore", "ignore"] }));
  assert.ok(await waitFor(() => status(f.adapter, f.home)), "launch did not bring up a runtime from a fresh home");
  // POSIX mode bits are emulated on Windows, where the runtime skips the permission check too.
  if (process.platform !== "win32") {
    assert.equal(statSync(f.home).mode & 0o777, 0o700, "the launcher must create a private home");
  }
  const pid = lockPid(f.home);
  assert.ok(pid && alive(pid), "the running runtime must own the lock");
  launch.stdin.end();
  assert.equal(await exitCode(launch), 0, "attach should exit cleanly");
  stop(f.adapter, f.home);
  assert.ok(await waitFor(() => !alive(pid)), "the runtime should shut down");
  assert.equal(existsSync(lockPath(f.home)), false, "shutdown releases the home");
});

test("concurrent launchers elect exactly one owner", async (t) => {
  const f = fixture(t);
  const runtimes = [1, 2, 3].map(() => f.startRuntime());
  // While they race, every published lock must already be complete: never empty or partially written.
  const partial = [];
  const poll = setInterval(() => {
    for (const pid of claimPids(f.home)) if (!/^\d+$/.test(String(pid))) partial.push(String(pid));
    try {
      for (const name of readdirSync(claimsDir(f.home))) {
        if (!/^\d{6}$/.test(name)) continue;
        const raw = readFileSync(join(claimsDir(f.home), name), "utf8");
        if (!/^\d+$/.test(raw)) partial.push(raw);
      }
    } catch {}
  }, 1);
  t.after(() => clearInterval(poll));
  assert.ok(await waitFor(() => status(f.adapter, f.home)), "no runtime came up");
  await new Promise((resolve) => setTimeout(resolve, 600));
  clearInterval(poll);
  const one = survivors(runtimes);
  assert.equal(one.length, 1, "only one runtime may own the home");
  assert.equal(lockPid(f.home), one[0].pid, "the lock must name the surviving owner");
  assert.deepEqual(partial, [], "a claim must never be observable before its content is complete");
});

test("a live claim blocks a new launcher", async (t) => {
  const f = fixture(t);
  seedClaim(f.home, 1, process.pid);
  const child = f.startRuntime();
  assert.equal(await exitCode(child), 0, "a live claim must block a second owner");
  assert.deepEqual(claimPids(f.home), [process.pid], "another launcher's claim must be left untouched");
});

test("a dead claim is reclaimed and the pid file is only a report", async (t) => {
  const f = fixture(t);
  seedClaim(f.home, 1, await exitedPid());
  writeFileSync(lockPath(f.home), "not-a-pid", { mode: 0o600 });
  const child = f.startRuntime();
  assert.ok(await waitFor(() => status(f.adapter, f.home)), "genuine dead-owner recovery must still work");
  assert.equal(lockPid(f.home), child.pid, "the winner reports its own pid");
  assert.deepEqual(claimPids(f.home), [child.pid], "the dead claim is dropped, not inherited");
});

test("concurrent stale-lock recovery elects exactly one owner", async (t) => {
  const f = fixture(t);
  // Repeated rounds make the replacement-lock window, where one launcher reclaims the lock another
  // just published, far likelier to be hit than in a single race.
  for (let round = 0; round < 4; round += 1) {
    stop(f.adapter, f.home);
    await terminatePid(lockPid(f.home));
    rmSync(claimsDir(f.home), { recursive: true, force: true });
    seedClaim(f.home, 1, await exitedPid());
    const runtimes = [1, 2, 3].map(() => f.startRuntime());
    assert.ok(await waitFor(() => status(f.adapter, f.home)), `no runtime recovered the stale lock (round ${round})`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const one = survivors(runtimes);
    assert.equal(one.length, 1, `only one runtime may own the home after recovery (round ${round})`);
    assert.deepEqual(claimPids(f.home), [one[0].pid], `a stale claim must not disturb the winner (round ${round})`);
  }
});
