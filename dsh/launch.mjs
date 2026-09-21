// Attach one gateway connection to this machine's durable DSH runtime. This is the remote command
// the gateway runs over SSH. It never owns accepted DSH work: if no runtime is listening it starts
// one detached, then attaches. Losing this connection detaches the gateway; DSH keeps running.
import { spawn } from "node:child_process";
import { connect as connectSocket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lstatSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { DSH_HOME as home, SOCKET_PATH as socketPath, MAINTENANCE_MARKER } from "./endpoint.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const DEADLINE_MS = 20_000;
const MARKER_TTL_MS = 15 * 60_000;

// A fresh deployment marker means the adapter directory may be mid-swap: refuse to launch rather
// than start a runtime from a partially updated installation. A stale marker is ignored, but a
// marker written after an unrecoverable failure never expires until an operator clears it.
function maintenanceActive() {
  try {
    const value = JSON.parse(readFileSync(MAINTENANCE_MARKER, "utf8"));
    if (value?.stuck === true) return true;
    if (Number.isFinite(value?.at) && Date.now() - value.at < MARKER_TTL_MS) return true;
    try {
      unlinkSync(MAINTENANCE_MARKER);
    } catch {}
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    // A marker we cannot parse is still respected while its file time is recent.
    try {
      return Date.now() - lstatSync(MAINTENANCE_MARKER).mtimeMs < MARKER_TTL_MS;
    } catch {
      return false;
    }
  }
}

function fail(reason) {
  process.stderr.write(`Pocket DSH runtime unavailable (${reason}); check the machine-side installation.\n`);
  process.exit(1);
}

function startRuntime() {
  try {
    // The runtime owns and validates its home, but a detached child cannot start in a directory that
    // does not exist yet, so a fresh machine would never launch. Create the private home first (same
    // mode the runtime requires); its own symlink/permission validation still runs.
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const child = spawn(process.execPath, [join(root, "runtime.mjs")], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: process.env,
      cwd: home,
    });
    child.unref();
    return child;
  } catch {
    return null;
  }
}

function attach() {
  if (maintenanceActive()) fail("deployment in progress");
  const deadline = Date.now() + DEADLINE_MS;
  let started = false;
  let runtimeExit = null;

  const attempt = () => {
    const socket = connectSocket(socketPath);
    // Removed on connect so a later socket error only ends the attach and never starts a second
    // runtime behind the one already serving this connection.
    const onRetry = () => {
      socket.destroy();
      // A detached runtime that already exited cannot answer a later socket; stop retrying it.
      if (runtimeExit !== null) fail(`runtime exited (${runtimeExit})`);
      if (Date.now() >= deadline) fail("timed out starting the runtime");
      if (!started) {
        started = true;
        const child = startRuntime();
        if (!child) fail("could not start the runtime");
        child.once("exit", (code) => {
          runtimeExit = code ?? 1;
        });
        child.once("error", () => {
          runtimeExit = 1;
        });
      }
      setTimeout(attempt, 400);
    };
    socket.once("error", onRetry);
    socket.once("connect", () => {
      socket.off("error", onRetry);
      socket.setEncoding("utf8");
      const done = () => {
        try {
          socket.destroy();
        } catch {}
        process.exit(0);
      };
      process.stdin.pipe(socket);
      socket.pipe(process.stdout);
      process.stdin.on("end", done);
      process.stdin.on("error", done);
      process.stdout.on("error", done);
      socket.on("error", done);
      socket.on("close", done);
      for (const sig of ["SIGHUP", "SIGTERM", "SIGINT"]) process.on(sig, done);
    });
  };
  attempt();
}

attach();
