import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ADAPTER_FILES, FEATURES, gatewayRequest, localManifest, manualRollbackDecision, planFleet, selectMachines } from "../scripts/deploy.mjs";
import { projectEvents } from "../dsh/projection.mjs";
import { allowedBrowserHost, handleControlRequest, handleRequest, validateLocalConfig } from "../gateway.ts";

function temporary(t, prefix) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("deployment authentication keeps secrets private and cleans every return/exception", async t => {
  const root = temporary(t, "pocket-auth-test-");
  writeFileSync(join(root, ".codex-pocket.local.json"), JSON.stringify({ pin: "4826", host: "127.0.0.1", port: 4173 }));
  const before = process.env.CODEX_POCKET_DATA_DIR;
  process.env.CODEX_POCKET_DATA_DIR = root;
  t.after(() => before === undefined ? delete process.env.CODEX_POCKET_DATA_DIR : process.env.CODEX_POCKET_DATA_DIR = before);
  const directories = new Set();
  for (const mode of ["success", "login-failed", "request-failed", "login-threw", "request-threw"]) {
    let jar, calls = 0;
    const runCommand = async (command, args, options) => {
      calls++;
      assert.equal(command, "curl");
      assert.ok(!args.join(" ").includes("4826"));
      if (calls === 1) {
        jar = args[args.indexOf("-c") + 1];
        assert.ok(!directories.has(dirname(jar)), "unique directory per request");
        directories.add(dirname(jar));
        assert.equal(statSync(dirname(jar)).mode & 0o777, 0o700);
        assert.equal(statSync(jar).mode & 0o777, 0o600);
        assert.equal(args[args.indexOf("--data-binary") + 1], "@-");
        assert.deepEqual(JSON.parse(options.input), { pin: "4826" });
        if (mode === "login-threw") throw new Error("fixture login exception");
        return { code: mode === "login-failed" ? 7 : 0, stdout: "{}" };
      }
      assert.equal(args[args.indexOf("-b") + 1], jar);
      assert.equal(args.at(-1), "http://127.0.0.1:4173/healthz");
      if (mode === "request-threw") throw new Error("fixture request exception");
      return { code: mode === "request-failed" ? 28 : 0, stdout: '{"ok":true}' };
    };
    if (mode.endsWith("threw")) await assert.rejects(gatewayRequest("/healthz", { runCommand }), /fixture .* exception/);
    else {
      const result = await gatewayRequest("/healthz", { runCommand });
      assert.equal(result.code, mode === "success" ? 0 : mode === "login-failed" ? 7 : 28);
      assert.equal(calls, mode === "login-failed" ? 1 : 2);
    }
    assert.equal(existsSync(dirname(jar)), false, mode);
  }
});

test("deployment targets use SSH identities and reject ambiguous display names", () => {
  const machines = [{ ssh: "first", name: "Shared" }, { ssh: "second", name: "Shared" }, { ssh: "third", name: "first" }];
  assert.deepEqual(selectMachines(machines, "first"), [machines[0]], "alias takes precedence over display names");
  assert.deepEqual(selectMachines(machines, "second"), [machines[1]]);
  assert.throws(() => selectMachines(machines, "Shared"), /ambiguous/);
  assert.throws(() => selectMachines(machines, "missing"), /unknown/);
  assert.throws(() => selectMachines(machines, ""), /unknown/);
  assert.throws(() => selectMachines([...machines, { ssh: "FIRST", name: "Other" }]), /duplicate SSH alias/);
  assert.deepEqual(selectMachines(machines), machines);
  const entries = machines.map(machine => ({ key: machine.ssh, machine, action: "update", protocolChanged: true, statusProtocol: 1 }));
  const plan = planFleet({ entries, targetKeys: new Set(["first"]), manifest: { protocol: 2 }, allowProtocolChange: true });
  assert.deepEqual(entries.filter(plan.isTarget).map(entry => entry.key), ["first"]);
  assert.equal(plan.reject, true, "unselected machines still participate in fleet compatibility");
});

test("manual rollback requires verified compatible protocols as well as existing safety", () => {
  const idle = { liveStatus: "idle", verifiable: true };
  assert.equal(manualRollbackDecision(idle, false, 2, 2).ok, true);
  assert.equal(manualRollbackDecision(idle, false, 2, 1).ok, false);
  for (const unknown of [null, undefined, "2", 0, NaN]) {
    assert.equal(manualRollbackDecision(idle, true, unknown, 2).ok, false);
    assert.equal(manualRollbackDecision(idle, true, 2, unknown).ok, false);
  }
  assert.equal(manualRollbackDecision({ ...idle, liveStatus: "busy" }, true, 2, 2).ok, false);
  assert.equal(manualRollbackDecision({ ...idle, markerUnreadable: true }, true, 2, 2).ok, false);
  assert.equal(manualRollbackDecision({ ...idle, liveStatus: "unknown" }, true, 2, 2).ok, false);
});

// The real deployment entry point, but SSH/Docker are disposable fixture executables. No live
// machine is reachable, no real runtime is started, and any attempted rollback mutation is refused.
function deploymentFixture(t, retainedProtocol = 2) {
  const root = temporary(t, "pocket-deploy-test-");
  for (const file of ["scripts/deploy.mjs", ...ADAPTER_FILES]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(new URL(`../${file}`, import.meta.url), join(root, file));
  }
  const install = join(root, "execution"), previous = join(install, ".pocket-previous");
  for (const target of [install, previous]) {
    for (const file of ADAPTER_FILES) {
      mkdirSync(dirname(join(target, file)), { recursive: true });
      copyFileSync(new URL(`../${file}`, import.meta.url), join(target, file));
    }
    if (target === previous) {
      const path = join(target, "dsh/projection.mjs");
      writeFileSync(path, readFileSync(path, "utf8").replace("DSH_ADAPTER_PROTOCOL = 2", `DSH_ADAPTER_PROTOCOL = ${retainedProtocol}`));
    }
    const files = Object.fromEntries(ADAPTER_FILES.map(file => [file, createHash("sha256").update(readFileSync(join(target, file))).digest("hex")]));
    const manifest = target === install ? localManifest() : { protocol: retainedProtocol, files, features: FEATURES };
    writeFileSync(join(target, target === install ? "dsh/.pocket-adapter.json" : ".pocket-adapter.json"), JSON.stringify(manifest));
  }
  writeFileSync(join(install, "sentinel"), "unchanged");
  const settings = join(root, "settings.json");
  writeFileSync(settings, JSON.stringify({ machines: [{ name: "Fixture", ssh: "fixture", dshPath: join(install, "dsh/launch.mjs") }] }));
  const bin = join(root, "bin"), log = join(root, "commands.jsonl");
  mkdirSync(bin);
  writeFileSync(join(bin, "ssh"), `#!${process.execPath}
const fs = require('fs'); const {spawnSync} = require('child_process');
const command = process.argv.at(-1);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(command)+'\\n');
if (command.includes('STOP_LIVE=')) { console.error('fixture refused mutation'); process.exit(99); }
if (command.includes('--status')) { console.log(JSON.stringify({result:{busy:false,protocol:2}})); process.exit(0); }
const result=spawnSync('sh',['-c',command],{encoding:'utf8'});
process.stdout.write(result.stdout||''); process.stderr.write(result.stderr||''); process.exit(result.status??1);
`, { mode: 0o700 });
  writeFileSync(join(bin, "docker"), `#!${process.execPath}
const fs = require('fs'); fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n');
if (process.argv.slice(2,7).join(' ') !== 'compose exec -T pocket node') process.exit(99);
console.log(JSON.stringify({protocol:process.env.FIXTURE_GATEWAY_PROTOCOL==='unknown'?null:Number(process.env.FIXTURE_GATEWAY_PROTOCOL||2)}));
process.exit(process.env.FIXTURE_GATEWAY_PROTOCOL==='stopped'?1:0);
`, { mode: 0o700 });
  const run = (flags = [], gatewayProtocol = "2") => spawnSync(process.execPath, [join(root, "scripts/deploy.mjs"), "--settings", settings, "--rollback", ...flags], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, POCKET_DSH_HOME: join(root, "home"), FIXTURE_GATEWAY_PROTOCOL: gatewayProtocol }, encoding: "utf8", timeout: 10000,
  });
  return { root, settings, install, previous, run, commands: () => readFileSync(log, "utf8") };
}

test("deployment CLI selects one SSH alias despite duplicate display names", t => {
  const f = deploymentFixture(t);
  writeFileSync(f.settings, JSON.stringify({ machines: ["fixture", "other"].map(ssh => ({ name: "Shared", ssh, dshPath: join(f.install, "dsh/launch.mjs") })) }));
  const selected = f.run(["--machine", "fixture", "--dry-run"]);
  assert.equal(selected.status, 0, selected.stdout + selected.stderr);
  assert.equal(selected.stdout.match(/would roll back/g)?.length, 1);
  assert.match(selected.stdout, /untouched \(not selected by --machine/);
  const ambiguous = f.run(["--machine", "Shared"]);
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguous.stderr, /ambiguous machine name/);
  const missing = f.run(["--machine"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /--machine requires/);
  assert.equal(f.commands().includes("STOP_LIVE="), false);
});

test("manual rollback preflight refuses incompatible/unverifiable fixtures before mutation", async t => {
  for (const mode of ["incompatible", "unknown-gateway", "stopped-gateway", "missing-manifest", "bad-manifest", "tampered", "compatible"]) {
    await t.test(mode, t => {
      const f = deploymentFixture(t, mode === "incompatible" ? 1 : 2);
      const retainedManifest = join(f.previous, ".pocket-adapter.json");
      if (mode === "missing-manifest") rmSync(retainedManifest);
      if (mode === "bad-manifest") writeFileSync(retainedManifest, "null");
      if (mode === "tampered") writeFileSync(join(f.previous, "dsh/projection.mjs"), "export const DSH_ADAPTER_PROTOCOL = 2;");
      const before = readFileSync(join(f.install, "dsh/projection.mjs"));
      const result = f.run(mode === "compatible" ? ["--dry-run"] : [], mode === "unknown-gateway" ? "unknown" : mode === "stopped-gateway" ? "stopped" : "2");
      assert.equal(result.status, mode === "compatible" ? 0 : 1, result.stdout + result.stderr);
      assert.match(result.stdout, mode === "compatible" ? /would roll back/ : /rollback refused; nothing was changed/);
      assert.equal(f.commands().includes("STOP_LIVE="), false);
      assert.equal(existsSync(join(f.install, ".pocket-deploying")), false);
      assert.deepEqual(readFileSync(join(f.install, "dsh/projection.mjs")), before);
      assert.equal(readFileSync(join(f.install, "sentinel"), "utf8"), "unchanged");
    });
  }
});

test("DSH saved tool arguments tolerate malformed values without losing later history", () => {
  const values = [null, undefined, {}, ["one", "two"], "null", "not JSON", "42", '"string"', "false", "[]", '{"queries":42}', '{"queries":"text"}', '{"queries":{}}', '{"queries":["valid",null,{"toString":null}]}', '{"file_path":"a.txt","content":{"toString":null},"new_string":{"toString":null}}', '{"path":"a.txt","command":"str_replace","old_str":{"toString":null},"new_str":{"toString":null}}'];
  const events = [{ type: "turn/start", time: 1, data: { turn: 1 } }];
  let id = 0;
  for (const name of ["bash", "pwsh", "web_search", "grep", "write", "edit", "str_replace_editor", "subagent"]) {
    for (const args of values) {
      const callId = String(id++);
      events.push({ type: "tool/call", time: 2, data: { name, arguments: args, callId } },
        { type: "tool/result", time: 3, data: { message: { toolCallId: callId, content: [{ type: "text", text: "result" }] } } });
    }
  }
  for (const [name, args] of [["bash", '{"command":"echo valid"}'], ["web_search", '{"queries":["one","two"]}'], ["write", '{"file_path":"ok.txt","content":"valid"}']])
    events.push({ type: "tool/call", time: 4, data: { name, arguments: args, callId: `valid-${name}` } });
  events.push({ type: "assistant/message", time: 5, data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "Later answer" }] } } },
    { type: "turn/end", time: 6, data: { reason: { kind: "completed" } } });
  const [turn] = projectEvents(events, "/fixture");
  assert.equal(turn.status, "completed");
  assert.equal(turn.items.at(-1).text, "Later answer");
  assert.ok(turn.items.slice(0, id).every(item => item.status === "completed"));
  assert.equal(turn.items.find(item => item.id === "valid-bash").command, "echo valid");
  assert.equal(turn.items.find(item => item.id === "valid-web_search").query, "one; two");
  assert.equal(turn.items.find(item => item.id === "valid-write").changes[0].diff, "+valid");
});

test("configured proxy authorities preserve Host, origin, authentication and control protections", async t => {
  const config = validateLocalConfig({ host: "127.0.0.1", port: 4173, lanEnabled: false, pin: "4826", localName: "Fixture", machines: [], accessUrls: ["https://pocket.example:8443", "https://pocket-default.example"] }, null);
  const options = { ...config };
  for (const host of ["pocket.example:8443", "POCKET.example:8443", "pocket-default.example", "pocket-default.example:443"])
    assert.equal(allowedBrowserHost({ headers: { host } }, options), true, host);
  for (const host of ["pocket.example", "pocket.example:443", "pocket.example:8444", "pocket-default.example:80", "pocket.example.evil:8443", "evil.example", "user@pocket.example:8443", "pocket.example:8443/path"])
    assert.equal(allowedBrowserHost({ headers: { host, "x-forwarded-host": "pocket.example:8443" } }, options), false, host);
  assert.throws(() => validateLocalConfig({ ...config, accessUrls: ["https://pocket.example/path"] }, null), /origins/);
  const auth = { required: true, pin: "4826", sessionId: "fixture-session", attempts: new Map() };
  const gateway = { countBrowserPayload() {}, snapshot: () => ({ connected: true }), hostStatus: () => ({ ok: true }) };
  const server = createServer((req, res) => {
    if (req.url === "/host-status") handleControlRequest(req, res, gateway, options, () => {}, () => {});
    else handleRequest(req, res, gateway, auth, { config, loaded: true }, options, async () => ({}), () => {}, () => false).catch(error => { res.writeHead(500); res.end(String(error)); });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const fetchFixture = (url, options = {}) => new Promise((resolve, reject) => {
    const req = request(url, options, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
    });
    req.on("error", reject);
    req.end(options.body);
  });
  const headers = { host: "pocket.example:8443", "content-type": "application/json" };
  let response = await fetchFixture(`${base}/api/login`, { method: "POST", headers: { ...headers, origin: "https://evil.example" }, body: '{"pin":"4826"}' });
  assert.equal(response.status, 403);
  response = await fetchFixture(`${base}/api/settings`, { headers });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  response = await fetchFixture(`${base}/api/login`, { method: "POST", headers: { ...headers, origin: "https://pocket.example:8443" }, body: '{"pin":"4826"}' });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly; SameSite=Strict.*Secure/);
  response = await fetchFixture(`${base}/api/auth`, { headers: { ...headers, cookie: cookie.split(";", 1)[0] } });
  assert.deepEqual(await response.json(), { required: true, authenticated: true });
  response = await fetchFixture(`${base}/host-status`, { headers });
  assert.equal(response.status, 403, "native control remains loopback-authority only");
  response = await fetchFixture(`${base}/api/auth`, { headers: { host: "evil.example", "x-forwarded-host": "pocket.example:8443" } });
  assert.equal(response.status, 403);

  // Exercise the actual curl/stdin/cookie path against the isolated authenticated HTTP fixture.
  const root = temporary(t, "pocket-auth-http-");
  writeFileSync(join(root, ".codex-pocket.local.json"), JSON.stringify({ pin: "4826", accessUrls: [base] }));
  const before = process.env.CODEX_POCKET_DATA_DIR;
  process.env.CODEX_POCKET_DATA_DIR = root;
  try { assert.deepEqual((await gatewayRequest("/api/auth")).value, { required: true, authenticated: true }); }
  finally { if (before === undefined) delete process.env.CODEX_POCKET_DATA_DIR; else process.env.CODEX_POCKET_DATA_DIR = before; }
});
