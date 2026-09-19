#!/usr/bin/env node
// One deployment command for the Pocket gateway and its execution-side DSH adapter.
//
// Run from a repository checkout on the gateway host (the NAS):
//   npm run deploy                 # gateway image + changed execution-side adapters
//   npm run deploy -- --gateway-only
//   npm run deploy -- --adapters-only
//   npm run deploy -- --dry-run
//   npm run deploy -- --settings path/to/.codex-pocket.local.json
//
// Machines, aliases and dshPath values come from the existing Pocket settings; SSH uses the
// deployment's own ./ssh/config. Remote code is staged completely and activated only when that
// runtime is idle; busy or offline machines are reported as pending and a rerun finishes them.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const DRY = has("--dry-run");
const GATEWAY_ONLY = has("--gateway-only");
const ADAPTERS_ONLY = has("--adapters-only");

const ADAPTER_FILES = [
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
const ADAPTER_NAMES = ADAPTER_FILES.filter((file) => file.startsWith("dsh/")).map((file) => file.slice(4));
const SSH_CONFIG = join(ROOT, "ssh", "config");

const log = (message) => process.stdout.write(`${message}\n`);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function adapterProtocol() {
  const source = readFileSync(join(ROOT, "dsh/projection.mjs"), "utf8");
  const match = /export const DSH_ADAPTER_PROTOCOL = (\d+)/.exec(source);
  if (!match) throw new Error("dsh/projection.mjs does not declare DSH_ADAPTER_PROTOCOL");
  return Number(match[1]);
}

function localManifest() {
  const files = {};
  for (const file of ADAPTER_FILES) files[file] = sha256(readFileSync(join(ROOT, file)));
  const bundle = sha256(Object.entries(files).sort().map(([name, hash]) => `${name}:${hash}`).join("\n"));
  return { protocol: adapterProtocol(), bundle, lockHash: files["dsh/package-lock.json"], files };
}

function settingsPath() {
  const explicit = option("--settings", null);
  if (explicit) return resolve(explicit);
  const dataDir = process.env.CODEX_POCKET_DATA_DIR || join(ROOT, "data");
  return join(dataDir, ".codex-pocket.local.json");
}

function readMachines() {
  const path = settingsPath();
  if (!existsSync(path)) throw new Error(`Pocket settings not found: ${path}`);
  const config = JSON.parse(readFileSync(path, "utf8"));
  return { path, machines: Array.isArray(config.machines) ? config.machines : [] };
}

function run(command, commandArgs, { input = null, timeout = 120_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, commandArgs, { stdio: ["pipe", "pipe", "pipe"] });
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
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=8",
  "-o", "ServerAliveInterval=15",
  "-o", "ServerAliveCountMax=2",
];

const isWindowsPath = (value) => /^[a-z]:[\\/]/i.test(value);
const posixDir = (value) => value.replace(/[\\/][^\\/]*$/, "");
const posixQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;

// Run a shell script on a machine; Windows hosts get an encoded PowerShell command because their
// default SSH shell is cmd.
function sshArgs(machine, script) {
  const base = sshBase();
  if (isWindowsPath(machine.dshPath)) {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    return [...base, machine.ssh, `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`];
  }
  return [...base, machine.ssh, script];
}

const ssh = (machine, script, options) => run("ssh", sshArgs(machine, script), options);

async function tarBuffer() {
  const child = spawn("tar", ["-czf", "-", "-C", ROOT, ...ADAPTER_FILES], { stdio: ["ignore", "pipe", "ignore"] });
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  const code = await new Promise((resolvePromise) => child.on("close", resolvePromise));
  if (code !== 0) throw new Error("Could not create the adapter archive");
  return Buffer.concat(chunks);
}

function parseJson(stdout) {
  try {
    return JSON.parse(stdout.trim().split("\n").filter(Boolean).at(-1));
  } catch {
    return null;
  }
}

async function deployMachine(machine, manifest, archive) {
  const name = machine.name || machine.ssh;
  if (!machine.ssh || !machine.dshPath) return `${name}: skipped (no ssh/dshPath)`;
  const dshDir = posixDir(machine.dshPath);
  const bundleRoot = posixDir(dshDir);
  const windows = isWindowsPath(machine.dshPath);
  const staging = `${bundleRoot}${windows ? "\\" : "/"}.pocket-staging-${manifest.bundle.slice(0, 12)}`;

  // One inventory only: reachability and the current manifest come from the declared alias.
  const reachable = await ssh(machine, "echo pocket-deploy-ok");
  if (reachable.code !== 0) return `${name}: pending (offline)`;
  const current = parseJson((await ssh(machine, `cat ${posixQuote(`${dshDir}/.pocket-adapter.json`)} 2>/dev/null || true`)).stdout);
  if (current?.bundle === manifest.bundle && current?.protocol === manifest.protocol) return `${name}: up to date`;
  if (DRY) return `${name}: would update (adapter ${manifest.bundle.slice(0, 12)})`;
  if (current?.protocol !== undefined && current.protocol !== manifest.protocol) {
    return `${name}: pending (adapter protocol ${current.protocol} != gateway ${manifest.protocol})`;
  }

  // A busy runtime is never overwritten; rerunning the same command finishes the update.
  const status = parseJson((await ssh(machine, `node ${posixQuote(`${dshDir}/runtime.mjs`)} --status 2>/dev/null || true`)).stdout);
  if (status?.busy === true) return `${name}: pending (runtime busy)`;

  const installDeps = current?.lockHash !== manifest.lockHash;
  if (windows) {
    const encoded = archive.toString("base64");
    const stage = [
      "$ErrorActionPreference='Stop'",
      `$tmp = Join-Path $env:TEMP 'pocket-adapter-${manifest.bundle.slice(0, 12)}.tgz'`,
      `[IO.File]::WriteAllBytes($tmp, [Convert]::FromBase64String('${encoded}'))`,
      `New-Item -ItemType Directory -Force -Path ${psQuote(staging)} | Out-Null`,
      `& tar -xzf $tmp -C ${psQuote(staging)}`,
      `Remove-Item $tmp -Force`,
      ...(installDeps ? [`Push-Location ${psQuote(`${staging}\\dsh`)}`, "& npm ci --omit=dev --no-audit --no-fund", "Pop-Location"] : []),
    ].join("; ");
    if ((await ssh(machine, stage, { timeout: 600_000 })).code !== 0) return `${name}: pending (staging failed)`;
    const activate = [
      "$ErrorActionPreference='Stop'",
      `$runtime = Join-Path ${psQuote(dshDir)} 'runtime.mjs'`,
      `if (Test-Path $runtime) { & node $runtime --stop | Out-Null; Start-Sleep -Milliseconds 300 }`,
      `Copy-Item -Recurse -Force ${psQuote(`${staging}\\dsh\\*`)} ${psQuote(dshDir)}`,
      `Copy-Item -Force ${psQuote(`${staging}\\deepseek.ts`)} ${psQuote(`${bundleRoot}\\deepseek.ts`)}`,
      `Set-Content -Path ${psQuote(`${dshDir}\\.pocket-adapter.json`)} -Value ${psQuote(JSON.stringify(manifest))} -Encoding utf8`,
    ].join("; ");
    return (await ssh(machine, activate, { timeout: 180_000 })).code === 0 ? `${name}: updated` : `${name}: pending (activation failed)`;
  }

  const stage = `mkdir -p ${posixQuote(staging)} && tar -xzf - -C ${posixQuote(staging)}`;
  if ((await ssh(machine, stage, { input: archive, timeout: 300_000 })).code !== 0) return `${name}: pending (staging failed)`;
  if (installDeps) {
    const installed = await ssh(machine, `cd ${posixQuote(`${staging}/dsh`)} && npm ci --omit=dev --no-audit --no-fund`, { timeout: 600_000 });
    if (installed.code !== 0) return `${name}: pending (dependency install failed)`;
  }
  const activate = [
    `cd ${posixQuote(bundleRoot)}`,
    `if [ -f ${posixQuote(`${dshDir}/runtime.mjs`)} ]; then node ${posixQuote(`${dshDir}/runtime.mjs`)} --stop >/dev/null 2>&1 || true; sleep 0.3; fi`,
    installDeps ? `rm -rf ${posixQuote(`${dshDir}/node_modules`)} && cp -a ${posixQuote(`${staging}/dsh/node_modules`)} ${posixQuote(`${dshDir}/node_modules`)}` : "true",
    ...ADAPTER_NAMES.map((file) => `cp -f ${posixQuote(`${staging}/dsh/${file}`)} ${posixQuote(`${dshDir}/${file}`)}`),
    `cp -f ${posixQuote(`${staging}/deepseek.ts`)} ${posixQuote(`${bundleRoot}/deepseek.ts`)}`,
    `chmod 644 ${posixQuote(`${dshDir}/`)}* 2>/dev/null || true`,
    `printf '%s' ${posixQuote(JSON.stringify(manifest))} > ${posixQuote(`${dshDir}/.pocket-adapter.json`)}`,
  ].join(" && ");
  return (await ssh(machine, activate, { timeout: 180_000 })).code === 0 ? `${name}: updated` : `${name}: pending (activation failed)`;
}

async function gatewayStatus() {
  const path = settingsPath();
  const pin = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).pin : null;
  if (!/^\d{4}$/.test(pin ?? "")) return { busy: false };
  const base = "http://127.0.0.1:4173";
  const jar = "/tmp/pocket-deploy.jar";
  const login = await run("curl", ["-s", "-c", jar, "-X", "POST", "-H", "Content-Type: application/json", "-H", `Origin: ${base}`, "--data", JSON.stringify({ pin }), "--max-time", "4", `${base}/api/login`]);
  if (login.code !== 0) return { busy: false };
  const state = await run("curl", ["-s", "-b", jar, "--max-time", "4", `${base}/api/state`]);
  const value = parseJson(state.stdout);
  return { busy: Boolean(value && (value.turn?.status === "inProgress" || String(value.threadStatus || "").startsWith("active") || value.phase === "working")) };
}

async function main() {
  const manifest = localManifest();
  log(`adapter protocol ${manifest.protocol}, bundle ${manifest.bundle.slice(0, 12)}`);

  if (!ADAPTERS_ONLY) {
    log("building the gateway image…");
    if (!DRY) {
      const built = await run("docker", ["compose", "build", "pocket"], { timeout: 900_000 });
      if (built.code !== 0) {
        log(`gateway build failed: ${(built.stderr || built.stdout).slice(-1000)}`);
        process.exitCode = 1;
        return;
      }
    }
  }

  let adaptersPending = false;
  if (!GATEWAY_ONLY) {
    const { machines } = readMachines();
    const targets = machines.filter((machine) => machine.ssh && machine.dshPath);
    if (!targets.length) log("no execution machines with dshPath configured");
    const archive = targets.length && !DRY ? await tarBuffer() : null;
    for (const machine of targets) {
      const result = await deployMachine(machine, manifest, archive);
      if (result.includes(": pending")) adaptersPending = true;
      log(result);
    }
  }

  if (!ADAPTERS_ONLY) {
    // Never activate a gateway that the still-running execution adapters cannot speak to.
    if (adaptersPending) {
      log("gateway: pending (some execution adapters are not updated yet; rerun to finish)");
    } else if (!DRY && (await gatewayStatus()).busy) {
      log("gateway: pending (an active turn is running; rerun to finish)");
    } else {
      log("activating the gateway…");
      if (!DRY) {
        const up = await run("docker", ["compose", "up", "-d", "--no-build", "pocket"], { timeout: 300_000 });
        if (up.code === 0) log("gateway: updated");
        else { log(`gateway: pending (activation failed: ${up.stderr.slice(-300)})`); process.exitCode = 1; }
      }
    }
  }
}

main().catch((error) => {
  console.error(`deploy failed: ${error.message}`);
  process.exitCode = 1;
});
