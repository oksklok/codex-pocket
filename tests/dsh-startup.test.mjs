import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DshHost } from "../dsh.ts";

const execute = promisify(execFile);
function fixture(t, pid) {
  const root = mkdtempSync(join(tmpdir(), "pocket-dsh-startup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home"), adapter = join(root, "dsh");
  mkdirSync(join(home, "pocket-owner.lock"), { recursive: true, mode: 0o700 });
  mkdirSync(adapter);
  for (const file of ["runtime.mjs", "launch.mjs", "endpoint.mjs", "router.mjs", "projection.mjs", "bridge.mjs", "pocket.patch.yml"])
    copyFileSync(new URL(`../dsh/${file}`, import.meta.url), join(adapter, file));
  // Ownership must fail before SDK launch or credential reads. These placeholders only satisfy the
  // installation file check; no SDK code or real home/credentials is loaded by these fixtures.
  for (const name of ["dsh", "dsh-sdk-protocol"]) {
    const pkg = join(adapter, "node_modules", "@deepseek-ai", name);
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ version: "fixture" }));
  }
  if (pid !== undefined) writeFileSync(join(home, "pocket-owner.lock", "pid"), String(pid));
  writeFileSync(join(home, "session-sentinel"), "durable history remains intact");
  const carrier = join(root, "carrier.mjs");
  writeFileSync(carrier, `process.env.POCKET_DSH_HOME = ${JSON.stringify(home)}; await import(${JSON.stringify(pathToFileURL(join(adapter, "launch.mjs")).href)});`);
  return { home, adapter, carrier };
}

test("DSH startup leaves live, missing and invalid ownership locks intact", async t => {
  for (const [label, pid] of [["live", process.pid], ["missing", undefined], ["invalid", "not-a-pid"]]) {
    await t.test(label, async t => {
      const f = fixture(t, pid);
      const before = pid === undefined ? null : readFileSync(join(f.home, "pocket-owner.lock", "pid"), "utf8");
      await execute(process.execPath, [join(f.adapter, "runtime.mjs")], { env: { ...process.env, POCKET_DSH_HOME: f.home }, timeout: 5000 });
      assert.equal(readFileSync(join(f.home, "session-sentinel"), "utf8"), "durable history remains intact");
      if (before !== null) assert.equal(readFileSync(join(f.home, "pocket-owner.lock", "pid"), "utf8"), before);
      else assert.equal(readFileSync(join(f.home, "pocket-runtime.log"), "utf8").includes("remove it by hand"), true);
    });
  }
});

test("dead ownership stays fail-closed and the attach failure reaches runtime inspection", async t => {
  const exited = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await once(exited, "exit");
  const f = fixture(t, exited.pid);
  const host = new DshHost(null, f.carrier);
  const failure = new Promise(resolve => { host.closed = resolve; });
  await host.start();
  const error = await Promise.race([failure, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("DSH startup failure was not reported")), 5000); timer.unref(); })]);
  assert.match(error.message, /runtime exited \(0\).*inspect pocket-owner\.lock and pocket-runtime\.log/);
  assert.equal(readFileSync(join(f.home, "pocket-owner.lock", "pid"), "utf8"), String(exited.pid));
  assert.equal(readFileSync(join(f.home, "session-sentinel"), "utf8"), "durable history remains intact");
  assert.match(readFileSync(join(f.home, "pocket-runtime.log"), "utf8"), /not held by a live process/);
  assert.equal(host.child, null);
});
