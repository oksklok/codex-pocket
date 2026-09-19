// Attach one gateway connection to this machine's durable DSH runtime. This is the remote command
// the gateway runs over SSH. It never owns accepted DSH work: if no runtime is listening it starts
// one detached, then attaches. Losing this connection detaches the gateway; DSH keeps running.
import { spawn } from "node:child_process";
import { connect as connectSocket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DSH_HOME as home, SOCKET_PATH as socketPath } from "./endpoint.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const DEADLINE_MS = 20_000;

function startRuntime() {
  try {
    const child = spawn(process.execPath, [join(root, "runtime.mjs")], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: process.env,
      cwd: home,
    });
    child.unref();
  } catch {
    // The retry loop below reports a generic failure if the runtime never answers.
  }
}

function attach() {
  const deadline = Date.now() + DEADLINE_MS;
  let started = false;
  const attempt = () => {
    const socket = connectSocket(socketPath);
    socket.once("connect", () => {
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
    socket.once("error", () => {
      socket.destroy();
      if (Date.now() >= deadline) {
        process.stderr.write("Pocket DSH runtime unavailable; check the machine-side installation.\n");
        process.exit(1);
      }
      if (!started) {
        started = true;
        startRuntime();
      }
      setTimeout(attempt, 400);
    });
  };
  attempt();
}

attach();
