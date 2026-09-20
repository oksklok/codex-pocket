// Machine-side DSH runtime: owns the DSH home and its agent child independently of any gateway
// connection. The gateway attaches over a private socket (Unix domain socket, or a named pipe on
// Windows) and detaching does not stop accepted DSH work. A separate control endpoint serves
// deployment inspection and idle-only shutdown without touching the attached gateway.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, connect as connectSocket } from "node:net";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  mkdirSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  openSync,
  closeSync,
  unlinkSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { DSH_VERSION, DSH_ADAPTER_PROTOCOL } from "./projection.mjs";
import { RequestRouter } from "./router.mjs";
import {
  DSH_HOME as home,
  isWindows,
  LOCK_PATH as lockPath,
  LOG_PATH as logPath,
  SOCKET_PATH as socketPath,
  CONTROL_SOCKET_PATH as controlSocketPath,
} from "./endpoint.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const REQUIRED_FILES = ["bridge.mjs", "projection.mjs", "launch.mjs", "runtime.mjs", "endpoint.mjs", "router.mjs", "pocket.patch.yml"];

function log(message) {
  try {
    appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  } catch {}
}

function safeParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// A complete, loadable installation: the pinned runtime, every adapter file, and both SDK packages
// the adapter imports. Used by `--probe` before and after an activation.
function installationReady() {
  try {
    const version = JSON.parse(readFileSync(join(root, "node_modules/@deepseek-ai/dsh/package.json"), "utf8")).version;
    if (version !== DSH_VERSION) return { ok: false, reason: `dsh-version-${version}` };
    if (!existsSync(join(root, "node_modules/@deepseek-ai/dsh-sdk-protocol/package.json"))) return { ok: false, reason: "sdk-protocol-missing" };
  } catch {
    return { ok: false, reason: "dsh-missing" };
  }
  for (const file of REQUIRED_FILES) {
    try {
      if (!lstatSync(join(root, file)).isFile()) return { ok: false, reason: `missing-${file}` };
    } catch {
      return { ok: false, reason: `missing-${file}` };
    }
  }
  return { ok: true };
}

// ── Control client ──────────────────────────────────────────────────────────
// A short-lived process that talks only to the control endpoint, so it never evicts the attached
// gateway and never receives that gateway's pending requests.
function runControl(mode) {
  const socket = connectSocket(controlSocketPath);
  const requestId = 1;
  const method = mode === "--stop" ? "pocket/runtimeShutdown" : "pocket/runtimeStatus";
  let settled = false;
  let handedOff = false;
  const finish = (code, payload) => {
    if (settled) return;
    settled = true;
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    try {
      socket.destroy();
    } catch {}
    process.exit(code);
  };
  const ownerPid = () => {
    try {
      return Number(readFileSync(lockPath, "utf8"));
    } catch {
      return NaN;
    }
  };
  socket.setEncoding("utf8");
  socket.on("connect", () => {
    try {
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method })}\n`);
    } catch {
      finish(1, { ok: false, reason: "write-failed" });
    }
  });
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      const frame = safeParse(line);
      if (!frame || frame.id !== requestId) continue;
      if (frame.error) return finish(1, { ok: false, reason: "error" });
      const result = frame.result;
      if (!result || typeof result !== "object") return finish(1, { ok: false, reason: "malformed" });
      if (mode === "--status") {
        if (typeof result.busy !== "boolean" || typeof result.protocol !== "number") return finish(1, { ok: false, reason: "malformed" });
        return finish(0, { ok: true, result });
      }
      if (result.accepted !== true) return finish(1, { ok: false, reason: String(result.reason ?? "refused"), result });
      // An acknowledgment is not proof of exit. Wait until this owner and its DSH child are actually
      // gone before reporting a stopped runtime, so a caller may safely replace the installation.
      handedOff = true;
      const deadline = Date.now() + 20_000;
      const poll = () => {
        if (!alive(ownerPid())) return finish(0, { ok: true, result });
        if (Date.now() >= deadline) return finish(1, { ok: false, reason: "shutdown-timeout" });
        setTimeout(poll, 100);
      };
      poll();
      return;
    }
  });
  socket.on("error", () => {
    if (!handedOff) finish(1, { ok: false, reason: "unreachable" });
  });
  socket.on("close", () => {
    if (!handedOff) finish(1, { ok: false, reason: "unreachable" });
  });
  const timer = setTimeout(() => {
    if (!handedOff) finish(1, { ok: false, reason: "timeout" });
  }, 4000);
  timer.unref();
}

// ── Probe ───────────────────────────────────────────────────────────────────
async function runProbe() {
  const ready = installationReady();
  if (!ready.ok) {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: ready.reason })}\n`);
    process.exit(1);
  }
  try {
    const projection = await import("./projection.mjs");
    // Importing the bridge verifies its SDK dependency resolves without starting any runtime; the
    // router is loaded too so a half-installed adapter can never pass the probe.
    await import("./bridge.mjs");
    await import("./router.mjs");
    process.stdout.write(`${JSON.stringify({ ok: true, protocol: projection.DSH_ADAPTER_PROTOCOL })}\n`);
    process.exit(0);
  } catch {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: "import-failed" })}\n`);
    process.exit(1);
  }
}

// ── Integrity ───────────────────────────────────────────────────────────────
// Confirm the adapter files beside this runtime are exactly the bytes a manifest describes. Used by
// deployment after staging and again after activation, so a partial copy is never trusted.
function runVerify(manifestPath) {
  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {}
  const files = manifest?.files;
  if (!files || typeof files !== "object" || typeof manifest.protocol !== "number" || !Object.keys(files).length) {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: "manifest-unreadable" })}\n`);
    process.exit(1);
  }
  const bundleRoot = dirname(root);
  const mismatches = [];
  for (const [relative, expected] of Object.entries(files)) {
    if (typeof relative !== "string" || relative.startsWith("/") || /^[a-z]:[\\/]/i.test(relative) || relative.split(/[\\/]/).includes("..")) {
      mismatches.push(String(relative));
      continue;
    }
    try {
      const actual = createHash("sha256").update(readFileSync(join(bundleRoot, relative))).digest("hex");
      if (actual !== expected) mismatches.push(relative);
    } catch {
      mismatches.push(relative);
    }
  }
  process.stdout.write(`${JSON.stringify({ ok: mismatches.length === 0, protocol: manifest.protocol, mismatches })}\n`);
  process.exit(mismatches.length ? 1 : 0);
}

const mode = process.argv[2];
if (mode === "--probe") runProbe();
else if (mode === "--verify") runVerify(process.argv[3]);
else if (mode === "--status" || mode === "--stop") runControl(mode);
else startRuntime();

// ── Runtime owner ───────────────────────────────────────────────────────────
function startRuntime() {
  let child = null;
  let key = "";
  let ownsLock = false;

  function ownerLock() {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(lockPath, "wx", 0o600);
        writeFileSync(fd, String(process.pid));
        closeSync(fd);
        return true;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        let pid = NaN;
        try {
          pid = Number(readFileSync(lockPath, "utf8"));
        } catch {}
        // Only a dead owner's lock is reclaimed. A live owner keeps its home.
        if (alive(pid)) return false;
        try {
          unlinkSync(lockPath);
        } catch {}
      }
    }
    return false;
  }

  function release() {
    // Never remove another owner's artifacts: only what this process established. Ownership was
    // acquired before any stale socket was reclaimed, so these paths belong to this owner.
    if (!ownsLock) return;
    try {
      if (readFileSync(lockPath, "utf8") === String(process.pid)) unlinkSync(lockPath);
    } catch {}
    if (!isWindows) {
      for (const path of [socketPath, controlSocketPath]) {
        try {
          unlinkSync(path);
        } catch {}
      }
    }
  }

  try {
    const ready = installationReady();
    if (!ready.ok) throw new Error(`installation incomplete (${ready.reason})`);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    if (lstatSync(home).isSymbolicLink() || (!isWindows && lstatSync(home).mode & 0o077))
      throw new Error("DSH home must be a private, non-symlink directory");
    if (!ownerLock()) {
      log("another runtime owns this DSH home; exiting");
      process.exit(0);
    }
    ownsLock = true;

    // Ownership is established, so a remaining socket can only be a dead owner's stale artifact.
    if (!isWindows) {
      for (const path of [socketPath, controlSocketPath]) {
        try {
          if (!lstatSync(path).isSocket()) throw new Error("Runtime endpoint is not a socket");
          unlinkSync(path);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
    }

    const keyPath = join(homedir(), ".codex-pocket", "secrets", "deepseek-api-key");
    if (Object.hasOwn(process.env, "DEEPSEEK_API_KEY")) key = process.env.DEEPSEEK_API_KEY;
    else {
      const stat = lstatSync(keyPath);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 4096 ||
        (!isWindows && stat.mode & 0o077) ||
        (process.getuid && stat.uid !== process.getuid())
      )
        throw new Error("Unsafe execution-machine DeepSeek credential file");
      key = readFileSync(keyPath, "utf8").replace(/\r?\n$/, "");
    }
    if (!key?.trim() || /[\r\n\0]/.test(key)) throw new Error("Invalid execution-machine DeepSeek credential");
    key = key.trim();
    const credentialPath = join(home, ".credentials.yaml");
    try {
      const st = lstatSync(credentialPath);
      if (st.isSymbolicLink() || !st.isFile() || (!isWindows && st.mode & 0o077) || (process.getuid && st.uid !== process.getuid()))
        throw new Error("Unsafe DSH credential path");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    writeFileSync(
      credentialPath,
      JSON.stringify({ version: 1, refs: { DEEPSEEK_API_KEY: key }, records: {} }) + "\n",
      { mode: 0o600 },
    );
    const patchPath = join(home, "pocket.patch.yml");
    try {
      const st = lstatSync(patchPath);
      if (!st.isFile() || st.isSymbolicLink()) throw new Error("Unsafe DSH patch path");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    writeFileSync(
      patchPath,
      readFileSync(join(root, "pocket.patch.yml"), "utf8").replace(
        "POCKET_DSH_ADAPTER",
        JSON.stringify(pathToFileURL(join(root, "bridge.mjs")).href),
      ),
      { mode: 0o600 },
    );
    const env = {
      ...process.env,
      DSH_HOME: home,
      DSH_TELEMETRY_DISABLED: "1",
      POCKET_DSH_ADAPTER: pathToFileURL(join(root, "bridge.mjs")).href,
    };
    for (const k of Object.keys(env))
      if (/^(DEEPSEEK_|OPENAI_|CODEX_|CHATGPT_)/i.test(k)) delete env[k];
    child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        join(root, "node_modules/@deepseek-ai/dsh/lib/bin.js"),
        "--profile",
        "sdk",
        "--patch",
        patchPath,
      ],
      { env, cwd: home, stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch (error) {
    log(`runtime setup failed (${error?.code ?? error?.name ?? "error"})`);
    process.stderr.write("Pocket DSH runtime setup failed; check the pinned installation and credential permissions.\n");
    release();
    process.exit(1);
  }

  const redact = (line) =>
    line
      .split(JSON.stringify(key).slice(1, -1))
      .join("[REDACTED]")
      .split(key)
      .join("[REDACTED]");

  // ── Connection-safe routing ────────────────────────────────────────────────
  // The router owns request correlation: each client request gets a private child id, the child's
  // reply is restored to the client id and delivered only to the connection that sent it, and a
  // superseded or draining connection may no longer submit work.
  const router = new RequestRouter();
  const activeTurns = new Set();
  const controlSockets = new Set();
  const busy = () => router.busy(activeTurns.size);

  const turnKey = (params) => {
    const threadId = params?.threadId;
    const turnId = params?.turn?.id ?? params?.turnId;
    return threadId ? `${threadId}:${turnId ?? "active"}` : null;
  };

  const writeTo = (socket, line) => {
    if (!socket || socket.destroyed) return false;
    try {
      socket.write(`${line}\n`);
      return true;
    } catch {
      return false;
    }
  };

  const forwardToChild = (line) => {
    if (!child?.stdin?.writable) return;
    try {
      child.stdin.write(`${line}\n`);
    } catch {
      log("child stdin write failed");
    }
  };

  const onChildLine = (line) => {
    if (!line.trim()) return;
    const frame = safeParse(line);
    if (frame?.method === "pocket/requestResolved" && typeof frame.params?.pocketRequestId === "string") {
      router.resolvePocket(frame.params.pocketRequestId);
    }
    if (frame && frame.method !== undefined && frame.id !== undefined) router.serverRequest(frame, line);
    if (frame && frame.method === undefined && frame.id !== undefined) {
      // A reply to a client request: restore the client's own id and route it to its owner only.
      const decision = router.reply(frame, line);
      if (decision.deliver) writeTo(decision.deliver.socket, redact(decision.deliver.line));
      return;
    }
    if (frame?.method === "turn/started") {
      const id = turnKey(frame.params);
      if (id) activeTurns.add(id);
    }
    if (frame?.method === "turn/completed") {
      const id = turnKey(frame.params);
      if (id) activeTurns.delete(id);
    }
    writeTo(router.client, redact(line));
  };

  const onClientLine = (line, connection) => {
    if (!line.trim()) return;
    const frame = safeParse(line);
    if (!frame) return;
    const decision = router.fromClient(frame, line, connection);
    if (decision.action === "forward") forwardToChild(decision.line);
  };

  const server = createServer((socket) => {
    const attached = router.attach(socket);
    if (!attached.accepted) {
      socket.destroy();
      return;
    }
    // A new connection supersedes the previous writer: retire it so it cannot keep submitting work.
    if (attached.previous && attached.previous !== socket && !attached.previous.destroyed) {
      try {
        attached.previous.destroy();
      } catch {}
    }
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        onClientLine(line, socket);
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      router.detach(socket);
      // starting is keyed by the private child id and cleared by the child's own reply, so a turn
      // accepted just before a detach keeps the runtime busy and cannot be stopped.
    });
    for (const line of attached.replay) socket.write(`${redact(line)}\n`);
  });
  server.on("error", (error) => {
    log(`attach listener failed (${error?.code ?? "error"})`);
    shutdown(1);
  });

  // Control never touches the attach connection or its pending requests.
  const controlServer = createServer((socket) => {
    controlSockets.add(socket);
    socket.on("close", () => controlSockets.delete(socket));
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        const frame = safeParse(line);
        if (!frame || frame.id === undefined) continue;
        if (frame.method === "pocket/runtimeStatus") {
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {
            busy: busy(), draining: router.draining, protocol: DSH_ADAPTER_PROTOCOL, pid: process.pid,
            attached: Boolean(router.client && !router.client.destroyed), turns: activeTurns.size, starting: router.starting.size,
          } })}\n`);
        } else if (frame.method === "pocket/runtimeShutdown") {
          // Idle-only: accepting immediately enters a draining state that rejects new work, new
          // attaches and competing shutdowns, then stops the child and only then exits.
          if (busy()) {
            socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { accepted: false, reason: router.draining ? "draining" : "busy" } })}\n`);
          } else {
            router.startDraining();
            socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { accepted: true } })}\n`);
            setTimeout(() => shutdown(0), 50);
          }
        } else {
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "unsupported control method" } })}\n`);
        }
      }
    });
    socket.on("error", () => {});
  });
  controlServer.on("error", (error) => {
    log(`control listener failed (${error?.code ?? "error"})`);
    shutdown(1);
  });

  let shuttingDown = false;
  const shutdown = (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Stop accepting anything at once, then wait for the DSH child to actually exit before
    // releasing the home. A caller that waits for the owner to disappear has proof of shutdown.
    router.startDraining();
    try {
      server.close();
    } catch {}
    try {
      controlServer.close();
    } catch {}
    for (const socket of controlSockets) {
      try {
        socket.destroy();
      } catch {}
    }
    controlSockets.clear();
    const previous = router.client;
    router.client = null;
    try {
      previous?.destroy();
    } catch {}
    const finish = () => {
      release();
      process.exit(code);
    };
    if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      finish();
      return;
    }
    child.once("exit", finish);
    let grace;
    try {
      child.stdin.end();
      child.kill("SIGTERM");
    } catch {
      finish();
      return;
    }
    // If DSH does not stop on its own, force it, but never exit before it is gone.
    grace = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, 8000);
    child.once("exit", () => clearTimeout(grace));
  };

  child.stdout.setEncoding("utf8");
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      onChildLine(line);
    }
  });
  child.stderr.resume();
  child.stdin.on("error", () => {});
  child.on("error", () => {
    log("child failed to launch");
    shutdown(1);
  });
  child.on("exit", () => shutdown(0));
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => shutdown(0));
  process.on("SIGHUP", () => {});

  server.listen(socketPath, () => {
    if (!isWindows) {
      try {
        chmodSync(socketPath, 0o600);
      } catch {}
    }
    controlServer.listen(controlSocketPath, () => {
      if (!isWindows) {
        try {
          chmodSync(controlSocketPath, 0o600);
        } catch {}
      }
      log(`listening (protocol ${DSH_ADAPTER_PROTOCOL})`);
    });
  });
}
