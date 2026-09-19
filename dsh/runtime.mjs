// Machine-side DSH runtime: owns the DSH home and its agent child independently of any gateway
// connection. Attach clients connect over a private socket (Unix domain socket, or a named pipe on
// Windows); detaching a client does not stop accepted DSH work. Mirrors the DSH child setup that
// previously lived in launch.mjs.
import { spawn } from "node:child_process";
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
} from "node:fs";
import { DSH_ADAPTER_PROTOCOL } from "./projection.mjs";
import { DSH_HOME as home, isWindows, LOCK_PATH as lockPath, LOG_PATH as logPath, SOCKET_PATH as socketPath } from "./endpoint.mjs";

const root = dirname(fileURLToPath(import.meta.url));

function log(message) {
  try {
    appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  } catch {}
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
      if (alive(pid)) return false;
      try {
        unlinkSync(lockPath);
      } catch {}
    }
  }
  return false;
}

function release() {
  try {
    if (readFileSync(lockPath, "utf8") === String(process.pid)) unlinkSync(lockPath);
  } catch {}
  if (!isWindows) {
    try {
      unlinkSync(socketPath);
    } catch {}
  }
}

// Control helpers run in their own short-lived process so the deploy command can query or stop a
// runtime without touching its home.
if (process.argv[2] === "--status" || process.argv[2] === "--stop") {
  const socket = connectSocket(socketPath);
  let settled = false;
  const finish = (code) => {
    if (settled) return;
    settled = true;
    try {
      socket.destroy();
    } catch {}
    process.exit(code);
  };
  socket.setEncoding("utf8");
  socket.on("connect", () => {
    const method = process.argv[2] === "--stop" ? "pocket/runtimeShutdown" : "pocket/runtimeStatus";
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method })}\n`);
  });
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    const at = buffer.indexOf("\n");
    if (at < 0) return;
    const line = buffer.slice(0, at);
    if (process.argv[2] === "--status") process.stdout.write(`${line}\n`);
    finish(0);
  });
  socket.on("error", () => finish(1));
  socket.on("close", () => finish(process.argv[2] === "--stop" ? 0 : 1));
  setTimeout(() => finish(1), 4000).unref();
} else {
  startRuntime();
}

function startRuntime() {
  let child = null;
  let key = "";
  try {
    const version = JSON.parse(
      readFileSync(join(root, "node_modules/@deepseek-ai/dsh/package.json"), "utf8"),
    ).version;
    if (version !== "0.1.6-alpha.2")
      throw new Error("Install the locked Pocket DSH dependencies with npm ci in dsh/");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    if (lstatSync(home).isSymbolicLink() || (!isWindows && lstatSync(home).mode & 0o077))
      throw new Error("DSH home must be a private, non-symlink directory");
    if (!ownerLock()) {
      log("another runtime owns this DSH home; exiting");
      process.exit(0);
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

  // A transparent, durable carrier: child frames are held for the attached client, responses are
  // dropped when detached, and unanswered server requests are replayed on the next attach.
  let client = null;
  const pending = new Map();
  const pocketPending = new Map();
  let busy = false;

  const writeClient = (line) => {
    if (!client || client.destroyed) return false;
    try {
      client.write(`${line}\n`);
      return true;
    } catch {
      return false;
    }
  };

  const onChildLine = (line) => {
    if (!line.trim()) return;
    let frame = null;
    try {
      frame = JSON.parse(line);
    } catch {}
    if (frame && typeof frame.pocketRequestId === "string") {
      const id = pocketPending.get(frame.pocketRequestId);
      if (id !== undefined) {
        pending.delete(id);
        pocketPending.delete(frame.pocketRequestId);
      }
    }
    if (frame && frame.method !== undefined && frame.id !== undefined) {
      const id = String(frame.id);
      pending.set(id, line);
      if (typeof frame.params?.pocketRequestId === "string") pocketPending.set(frame.params.pocketRequestId, id);
    }
    if (frame?.method === "turn/started") busy = true;
    if (frame?.method === "turn/completed") busy = false;
    writeClient(redact(line));
  };

  const onClientLine = (line) => {
    if (!line.trim()) return;
    let frame = null;
    try {
      frame = JSON.parse(line);
    } catch {}
    if (frame?.method === "pocket/runtimeStatus" && frame.id !== undefined) {
      writeClient(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { busy, protocol: DSH_ADAPTER_PROTOCOL, pid: process.pid } }));
      return;
    }
    if (frame?.method === "pocket/runtimeShutdown" && frame.id !== undefined) {
      writeClient(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { stopping: true } }));
      setTimeout(() => shutdown(0), 50);
      return;
    }
    if (frame && frame.method === undefined && frame.id !== undefined) {
      const id = String(frame.id);
      pending.delete(id);
      for (const [pocketId, pendingId] of pocketPending) if (pendingId === id) pocketPending.delete(pocketId);
    }
    if (child?.stdin?.writable) {
      try {
        child.stdin.write(`${line}\n`);
      } catch {
        log("child stdin write failed");
      }
    }
  };

  const server = createServer((socket) => {
    if (client && !client.destroyed) {
      try {
        client.destroy();
      } catch {}
    }
    client = socket;
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        onClientLine(line);
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (client === socket) client = null;
    });
    for (const line of pending.values()) socket.write(`${redact(line)}\n`);
  });
  server.on("error", (error) => {
    log(`listener failed (${error?.code ?? "error"})`);
    shutdown(1);
  });

  let shuttingDown = false;
  const shutdown = (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      server.close();
    } catch {}
    try {
      client?.destroy();
    } catch {}
    try {
      child?.stdin?.end();
      child?.kill("SIGTERM");
    } catch {}
    release();
    setTimeout(() => process.exit(code), 250).unref();
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
    log(`listening (protocol ${DSH_ADAPTER_PROTOCOL})`);
  });
}
