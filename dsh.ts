import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { withoutDeepseekKey } from "./deepseek.ts";

const DSH_TRANSPORT_ENDED =
  "DSH connection ended; check execution-machine setup and ownership";

// One normal DSH process per provider runtime. Browser reconnects only reattach;
// transport uncertainty never automatically resubmits a prompt.
export class DshHost {
  child: ChildProcessWithoutNullStreams | null = null;
  nextId = 1;
  requests = new Map<string | number, any>();
  receiver: ((message: any) => void) | null = null;
  closed: ((error: Error) => void) | null = null;
  private ssh: string | null;
  private remotePath?: string;
  constructor(ssh: string | null, remotePath?: string) {
    this.ssh = ssh;
    this.remotePath = remotePath;
  }
  // Every transport-closure signal (stdin/stdout error, spawn error, exit, a
  // synchronous write failure) funnels through here so it settles the existing
  // disconnect path exactly once. Pending RPCs are rejected by
  // DshRpcClient.close(); a possibly delivered message is never resent.
  fail(child: ChildProcessWithoutNullStreams, error: Error) {
    if (this.child !== child) return;
    this.child = null;
    this.requests.clear();
    try {
      child.stdin.destroy();
    } catch {}
    try {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
    } catch {}
    this.closed?.(error);
  }
  write(child: ChildProcessWithoutNullStreams, payload: string) {
    if (this.child !== child || !child.stdin.writable)
      throw new Error("DSH disconnected");
    try {
      child.stdin.write(payload);
    } catch {
      this.fail(child, new Error(DSH_TRANSPORT_ENDED));
      throw new Error("DSH disconnected");
    }
  }
  async start() {
    if (this.child) return;
    const path =
      this.remotePath ??
      fileURLToPath(new URL("./dsh/launch.mjs", import.meta.url));
    const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
    const command = this.ssh ? process.env.SSH_BIN || "ssh" : process.execPath;
    const args = this.ssh
      ? [
          "-T",
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=5",
          "-o",
          "ServerAliveInterval=15",
          "-o",
          "ServerAliveCountMax=3",
          this.ssh,
          `node ${quote(path)}`,
        ]
      : [path];
    const child = spawn(command, args, {
      env: this.ssh ? withoutDeepseekKey() : process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 32 * 1024 * 1024) {
        child.kill("SIGTERM");
        return;
      }
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        try {
          const message = JSON.parse(line);
          if (message.method === "pocket/requestResolved") {
            for (const [id, request] of this.requests)
              if (
                request.params?.pocketRequestId ===
                message.params?.pocketRequestId
              ) {
                this.requests.delete(id);
                this.receiver?.({
                  method: "serverRequest/resolved",
                  params: { requestId: id },
                });
              }
            continue;
          }
          if (message.method && message.id !== undefined)
            this.requests.set(message.id, message);
          if (message.method === "turn/completed")
            for (const [id, request] of this.requests)
              if (request.params?.threadId === message.params?.threadId)
                this.requests.delete(id);
          this.receiver?.(message);
        } catch {
          this.fail(child, new Error("Invalid DSH protocol frame"));
          return;
        }
      }
    });
    child.stderr.resume();
    // A broken stdin/stdout pipe must never reach the process as an unhandled
    // stream error, and a half-close without an exit must still disconnect
    // rather than leaving the gateway waiting on a dead transport.
    child.on("error", () => this.fail(child, new Error(DSH_TRANSPORT_ENDED)));
    child.on("exit", () => this.fail(child, new Error(DSH_TRANSPORT_ENDED)));
    child.stdin.on("error", () =>
      this.fail(child, new Error(DSH_TRANSPORT_ENDED)),
    );
    child.stdin.on("close", () =>
      this.fail(child, new Error(DSH_TRANSPORT_ENDED)),
    );
    child.stdout.on("error", () =>
      this.fail(child, new Error(DSH_TRANSPORT_ENDED)),
    );
    child.stdout.on("close", () =>
      this.fail(child, new Error(DSH_TRANSPORT_ENDED)),
    );
    child.stderr.on("error", () => {});
  }
  async stop() {
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      try {
        child.stdin.end();
      } catch {}
      const timer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {}
      }, 3000);
      timer.unref();
    });
  }
}
export class DshRpcClient {
  private pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  onNotification: (m: any) => void = () => {};
  onServerRequest: (m: any) => void = () => {};
  onRawPayload: (n: number) => void = () => {};
  onClose: (e?: Error) => void = () => {};
  private host: DshHost;
  constructor(host: DshHost) {
    this.host = host;
  }
  async connect(_ws?: string, _ssh?: string) {
    await this.host.start();
    this.host.receiver = (m) => {
      this.onRawPayload(Buffer.byteLength(JSON.stringify(m)));
      if (m.method) {
        if (m.id !== undefined) this.onServerRequest(m);
        else this.onNotification(m);
        return;
      }
      const pending = this.pending.get(m.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(m.id);
      m.error
        ? pending.reject(new Error(m.error.message))
        : pending.resolve(m.result);
    };
    this.host.closed = (e) => {
      this.close();
      this.onClose(e);
    };
  }
  replayRequests(threadId: string) {
    for (const message of this.host.requests.values())
      if (message.params?.threadId === threadId) this.onServerRequest(message);
  }
  request(method: string, params: any = {}, timeout = 20000): Promise<any> {
    const id = this.host.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out; delivery may be unknown`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  private send(m: any) {
    const child = this.host.child;
    if (!child) throw new Error("DSH disconnected");
    this.host.write(child, JSON.stringify(m) + "\n");
  }
  notify(_method: string, _params: any = {}) {} // Pocket's initialized notification has no DSH counterpart.
  respond(id: string | number, result: any) {
    this.send({ jsonrpc: "2.0", id, result });
  }
  close() {
    this.host.receiver = null;
    this.host.closed = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("DSH disconnected; delivery may be unknown"));
    }
    this.pending.clear();
  }
}
