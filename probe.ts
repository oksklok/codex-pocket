#!/usr/bin/env node

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import process from "node:process";

type JsonObject = Record<string, any>;
type Pending = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type Options = {
  ws?: string;
  ssh?: string;
  thread?: string;
  historyPages: number;
  historyLimit: number;
  monitorSeconds: number;
  listOnly: boolean;
  startTurn?: string;
  steer?: string;
  interrupt: boolean;
};

type Wire = {
  send(message: JsonObject): void;
  close(): void;
};

const startedAt = Date.now();
let inboundBytes = 0;
let inboundMessages = 0;
const methodCounts = new Map<string, number>();
const assistantBuffers = new Map<string, string>();

function usage(): never {
  console.log(`Usage: node --experimental-strip-types probe.ts [options]

Connects to the managed Codex app-server through the supported stdio proxy.
Use --ws only for a separately started loopback WebSocket listener.

Options:
  --ws URL                 Connect directly to ws:// or wss:// instead of the daemon proxy
  --ssh HOST               Launch the app-server proxy through normal SSH stdio
  --thread ID              Select a thread instead of the newest active/loaded thread
  --history-pages N        Paginated history pages to fetch (default: 1)
  --history-limit N        Turns per page (default: 5)
  --monitor-seconds N      Observe live events after setup (default: 20; 0 exits immediately)
  --list-only              Initialize and list threads, but do not resume one
  --start-turn TEXT        Start a safe test turn on the selected thread
  --steer TEXT             Steer the selected thread's active turn
  --interrupt              Interrupt the selected thread's active turn
  --help                   Show this help

Environment:
  CODEX_BIN                Codex executable to spawn (default: codex)
  SSH_BIN                  SSH executable to spawn for --ssh (default: ssh)
`);
  process.exit(0);
}

function parsePositiveInt(flag: string, raw: string | undefined, allowZero = false): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`${flag} expects ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
  return value;
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    historyPages: 1,
    historyLimit: 5,
    monitorSeconds: 20,
    listOnly: false,
    interrupt: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const next = () => {
      const value = args[++index];
      if (value === undefined) throw new Error(`${flag} requires a value`);
      return value;
    };

    if (flag === "--help" || flag === "-h") usage();
    else if (flag === "--ws") options.ws = next();
    else if (flag === "--ssh") {
      const host = next();
      if (!host || host.startsWith("-")) throw new Error("--ssh expects an SSH host or configured alias");
      options.ssh = host;
    }
    else if (flag === "--thread") options.thread = next();
    else if (flag === "--history-pages") options.historyPages = parsePositiveInt(flag, next());
    else if (flag === "--history-limit") options.historyLimit = parsePositiveInt(flag, next());
    else if (flag === "--monitor-seconds") options.monitorSeconds = parsePositiveInt(flag, next(), true);
    else if (flag === "--list-only") options.listOnly = true;
    else if (flag === "--start-turn") options.startTurn = next();
    else if (flag === "--steer") options.steer = next();
    else if (flag === "--interrupt") options.interrupt = true;
    else throw new Error(`unknown option: ${flag}`);
  }

  return options;
}

function compact(value: unknown, limit = 180): string {
  const text = String(value ?? "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function shortId(value: unknown): string {
  const text = String(value ?? "-");
  return text.length > 14 ? `${text.slice(0, 8)}…${text.slice(-4)}` : text;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
}

function statusText(status: any): string {
  if (typeof status === "string") return status;
  if (!status || typeof status !== "object") return "unknown";
  const flags = Array.isArray(status.activeFlags) ? `:${status.activeFlags.join(",")}` : "";
  return `${status.type ?? "unknown"}${flags}`;
}

function itemSummary(item: any, phase: "start" | "done"): string | null {
  if (!item || typeof item !== "object") return null;
  const id = shortId(item.id);

  switch (item.type) {
    case "agentMessage":
      return phase === "done"
        ? `assistant ${id}: ${compact(item.text || assistantBuffers.get(String(item.id)), 700)}`
        : null;
    case "commandExecution":
      return phase === "start"
        ? `command start ${id}: ${compact(item.command)}`
        : `command done ${id}: status=${item.status} exit=${item.exitCode ?? "-"} duration=${item.durationMs ?? "-"}ms output=${formatBytes(Buffer.byteLength(String(item.aggregatedOutput ?? "")))}`;
    case "fileChange":
      return `file change ${phase} ${id}: ${Array.isArray(item.changes) ? item.changes.length : 0} path(s), status=${item.status ?? "-"}`;
    case "mcpToolCall":
      return `tool ${phase} ${id}: ${item.server}/${item.tool} status=${item.status ?? "-"} duration=${item.durationMs ?? "-"}ms`;
    case "dynamicToolCall":
      return `tool ${phase} ${id}: ${item.namespace ? `${item.namespace}/` : ""}${item.tool} status=${item.status ?? "-"}`;
    case "collabAgentToolCall":
      return `collab ${phase} ${id}: ${item.tool} status=${item.status ?? "-"}`;
    case "webSearch":
      return `web search ${phase} ${id}: ${compact(item.query)}`;
    case "plan":
      return phase === "done" ? `plan ${id}: ${compact(item.text, 400)}` : null;
    case "reasoning":
      return phase === "done" ? `reasoning ${id}: ${Array.isArray(item.summary) ? item.summary.length : 0} summary part(s) suppressed` : null;
    case "contextCompaction":
      return `context compaction ${phase} ${id}`;
    case "userMessage":
    case "hookPrompt":
      return null;
    default:
      return `item ${phase} ${id}: ${item.type ?? "unknown"}`;
  }
}

function printServerRequest(message: JsonObject): void {
  const params = message.params ?? {};
  const base = `request ${message.method} id=${shortId(message.id)} thread=${shortId(params.threadId)} turn=${shortId(params.turnId)}`;
  if (message.method === "item/commandExecution/requestApproval") {
    console.log(`${base} command=${compact(params.command)} reason=${compact(params.reason) || "-"}`);
  } else if (message.method === "item/fileChange/requestApproval") {
    console.log(`${base} reason=${compact(params.reason) || "-"}`);
  } else if (message.method === "item/tool/requestUserInput") {
    console.log(`${base} questions=${Array.isArray(params.questions) ? params.questions.length : 0} blocking=${Boolean(params.isBlocking)}`);
  } else if (message.method === "item/permissions/requestApproval") {
    console.log(`${base} reason=${compact(params.reason) || "-"}`);
  } else {
    console.log(base);
  }
}

function printNotification(message: JsonObject): void {
  const method = String(message.method ?? "unknown");
  const params = message.params ?? {};
  methodCounts.set(method, (methodCounts.get(method) ?? 0) + 1);

  switch (method) {
    case "thread/started":
      console.log(`thread subscribed ${shortId(params.thread?.id)} status=${statusText(params.thread?.status)}`);
      break;
    case "thread/status/changed":
      console.log(`thread ${shortId(params.threadId)} status=${statusText(params.status)}`);
      break;
    case "turn/started":
      console.log(`turn start ${shortId(params.turn?.id)} thread=${shortId(params.threadId)} status=${params.turn?.status}`);
      break;
    case "turn/completed":
      console.log(`turn done ${shortId(params.turn?.id)} thread=${shortId(params.threadId)} status=${params.turn?.status}${params.turn?.error ? ` error=${compact(params.turn.error.message ?? params.turn.error)}` : ""}`);
      break;
    case "turn/plan/updated": {
      const steps = Array.isArray(params.plan)
        ? params.plan.map((step: any) => `${step.status}:${compact(step.step, 80)}`).join(" | ")
        : "";
      console.log(`plan update ${shortId(params.turnId)}: ${steps}`);
      break;
    }
    case "item/agentMessage/delta":
      if (!assistantBuffers.has(String(params.itemId))) console.log(`assistant streaming ${shortId(params.itemId)}`);
      assistantBuffers.set(
        String(params.itemId),
        `${assistantBuffers.get(String(params.itemId)) ?? ""}${String(params.delta ?? "")}`,
      );
      break;
    case "item/started":
    case "item/completed": {
      const summary = itemSummary(params.item, method === "item/started" ? "start" : "done");
      if (summary) console.log(summary);
      break;
    }
    case "serverRequest/resolved":
      console.log(`request resolved id=${shortId(params.requestId)} thread=${shortId(params.threadId)}`);
      break;
    case "error":
      console.log(`server error: ${compact(params.error?.message ?? params.message ?? params, 400)}`);
      break;
    case "warning":
    case "deprecationNotice":
    case "configWarning":
      console.log(`${method}: ${compact(params.message ?? params, 300)}`);
      break;
    case "item/commandExecution/outputDelta":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/summaryPartAdded":
    case "item/reasoning/textDelta":
    case "turn/diff/updated":
    case "rawResponseItem/completed":
    case "rawResponse/completed":
      break;
    default:
      break;
  }
}

function clientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const length = payload.length;
  const headerLength = length < 126 ? 2 : length <= 0xffff ? 4 : 10;
  const frame = Buffer.alloc(headerLength + 4 + length);
  frame[0] = 0x80 | opcode;

  if (length < 126) {
    frame[1] = 0x80 | length;
  } else if (length <= 0xffff) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(length, 2);
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(length), 2);
  }

  const maskOffset = headerLength;
  mask.copy(frame, maskOffset);
  for (let index = 0; index < length; index += 1) {
    frame[maskOffset + 4 + index] = payload[index] ^ mask[index % 4];
  }
  return frame;
}

function connectProxy(
  onMessage: (message: JsonObject) => void,
  onDisconnect: (error: Error) => void,
  sshHost?: string,
): Promise<Wire> {
  return new Promise((resolve, reject) => {
    const codexBin = process.env.CODEX_BIN || "codex";
    const command = sshHost ? process.env.SSH_BIN || "ssh" : codexBin;
    const args = sshHost ? ["-T", sshHost, "codex", "app-server", "proxy"] : ["app-server", "proxy"];
    const child: ChildProcessWithoutNullStreams = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const websocketKey = randomBytes(16).toString("base64");
    const expectedAccept = createHash("sha1")
      .update(`${websocketKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    let settled = false;
    let closing = false;
    let fragmentedOpcode: number | null = null;
    let fragments: Buffer[] = [];

    const sendFrame = (opcode: number, payload: Buffer) => child.stdin.write(clientFrame(opcode, payload));
    const deliver = (payload: Buffer) => {
      inboundBytes += payload.length;
      inboundMessages += 1;
      try {
        onMessage(JSON.parse(payload.toString("utf8")));
      } catch (error) {
        console.error(`invalid JSON from app-server: ${compact((error as Error).message)}`);
      }
    };

    const parseFrames = () => {
      for (;;) {
        if (buffer.length < 2) return;
        const first = buffer[0];
        const second = buffer[1];
        const final = (first & 0x80) !== 0;
        const opcode = first & 0x0f;
        const masked = (second & 0x80) !== 0;
        let length = second & 0x7f;
        let offset = 2;

        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          const longLength = buffer.readBigUInt64BE(2);
          if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("WebSocket frame is too large");
          length = Number(longLength);
          offset = 10;
        }

        const maskLength = masked ? 4 : 0;
        if (buffer.length < offset + maskLength + length) return;
        const mask = masked ? buffer.subarray(offset, offset + 4) : null;
        offset += maskLength;
        const payload = Buffer.from(buffer.subarray(offset, offset + length));
        buffer = buffer.subarray(offset + length);
        if (mask) {
          for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
        }

        if (opcode === 0x8) {
          child.stdin.end();
          return;
        }
        if (opcode === 0x9) {
          sendFrame(0x0a, payload);
          continue;
        }
        if (opcode === 0x0a) continue;

        if (opcode === 0x1 && final) {
          deliver(payload);
        } else if (opcode === 0x1) {
          fragmentedOpcode = opcode;
          fragments = [payload];
        } else if (opcode === 0x0 && fragmentedOpcode !== null) {
          fragments.push(payload);
          if (final) {
            if (fragmentedOpcode === 0x1) deliver(Buffer.concat(fragments));
            fragmentedOpcode = null;
            fragments = [];
          }
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const header = buffer.subarray(0, headerEnd).toString("utf8");
        buffer = buffer.subarray(headerEnd + 4);
        const accept = /^sec-websocket-accept:\s*(.+)$/im.exec(header)?.[1]?.trim();
        if (!/^HTTP\/1\.1 101\b/m.test(header) || accept !== expectedAccept) {
          reject(new Error(`app-server proxy WebSocket upgrade failed: ${compact(header, 300)}`));
          child.kill("SIGTERM");
          return;
        }
        upgraded = true;
        settled = true;
        resolve({
          send(message) {
            sendFrame(0x1, Buffer.from(JSON.stringify(message), "utf8"));
          },
          close() {
            closing = true;
            sendFrame(0x8, Buffer.alloc(0));
            child.stdin.end();
            child.kill("SIGTERM");
          },
        });
      }
      parseFrames();
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const text = compact(chunk, 400);
      if (text) console.error(`${sshHost ? `ssh ${sshHost}` : "proxy"}: ${text}`);
    });
    child.once("error", (error) => {
      if (!settled) reject(error);
      else if (!closing) onDisconnect(error);
    });
    child.once("exit", (code, signal) => {
      if (!settled) reject(new Error(`app-server proxy exited before connecting (${signal ?? code})`));
      else if (!closing) onDisconnect(new Error(`app-server proxy disconnected (${signal ?? code})`));
    });

    child.once("spawn", () => {
      child.stdin.write(
        `GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${websocketKey}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
  });
}

function connectWebSocket(url: string, onMessage: (message: JsonObject) => void): Promise<Wire> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener("open", () => {
      resolve({
        send(message) {
          socket.send(JSON.stringify(message));
        },
        close() {
          socket.close();
        },
      });
    });
    socket.addEventListener("message", (event) => {
      const raw = String(event.data);
      inboundBytes += Buffer.byteLength(raw);
      inboundMessages += 1;
      try {
        onMessage(JSON.parse(raw));
      } catch (error) {
        console.error(`invalid JSON from app-server: ${compact((error as Error).message)}`);
      }
    });
    socket.addEventListener("error", () => reject(new Error(`WebSocket connection failed: ${url}`)));
  });
}

class RpcClient {
  private wire!: Wire;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;

  async connect(onDisconnect: (error: Error) => void, ws?: string, sshHost?: string): Promise<void> {
    const receive = (message: JsonObject) => this.receive(message);
    const disconnect = (error: Error) => {
      this.closed = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      onDisconnect(error);
    };
    this.wire = ws ? await connectWebSocket(ws, receive) : await connectProxy(receive, disconnect, sshHost);
  }

  request(method: string, params: JsonObject = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 20_000);
      this.pending.set(id, { resolve, reject, timer });
      this.wire.send({ method, id, params });
    });
  }

  notify(method: string, params: JsonObject = {}): void {
    this.wire.send({ method, params });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.wire.close();
  }

  private receive(message: JsonObject): void {
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const id = Number(message.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (message.error) pending.reject(new Error(`${message.error.message ?? "request failed"} (${message.error.code ?? "no code"})`));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      printServerRequest(message);
      return;
    }
    if (message.method) printNotification(message);
  }
}

let activeRpc: RpcClient | undefined;

function printThreadList(threads: any[], loadedIds: string[]): void {
  const loaded = new Set(loadedIds);
  console.log(`threads: ${threads.length}; loaded: ${loadedIds.length}`);
  for (const thread of threads.slice(0, 12)) {
    console.log(
      `  ${shortId(thread.id)} ${loaded.has(thread.id) ? "loaded" : "stored"} status=${statusText(thread.status)} source=${thread.source ?? "-"} cwd=${compact(thread.cwd, 60)} name=${compact(thread.name ?? thread.preview, 80)}`,
    );
  }
  if (threads.length > 12) console.log(`  … ${threads.length - 12} more thread(s) not printed`);
}

function printHistoryPage(page: any, pageNumber: number): string | null {
  const turns = Array.isArray(page?.data) ? page.data : [];
  console.log(`history page ${pageNumber}: ${turns.length} turn(s), next=${page?.nextCursor ? "yes" : "no"}`);
  for (const turn of turns) {
    const itemTypes = Array.isArray(turn.items) ? turn.items.map((item: any) => item.type).join(",") : "";
    console.log(`  turn ${shortId(turn.id)} status=${turn.status} items=${itemTypes || "none"}`);
  }
  return page?.nextCursor ?? null;
}

function printStats(): void {
  const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
  const topMethods = [...methodCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([method, count]) => `${method}=${count}`)
    .join(", ");
  console.log(`raw inbound: ${formatBytes(inboundBytes)} in ${inboundMessages} message(s) over ${elapsedSeconds.toFixed(1)}s (${formatBytes(Math.round(inboundBytes / elapsedSeconds))}/s)`);
  if (topMethods) console.log(`top live methods: ${topMethods}`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.ws && options.ssh) throw new Error("use either --ws or --ssh, not both");
  const rpc = new RpcClient();
  let disconnectError: Error | undefined;
  let signalDisconnect!: () => void;
  const disconnected = new Promise<void>((resolve) => {
    signalDisconnect = resolve;
  });
  await rpc.connect(
    (error) => {
      disconnectError = error;
      signalDisconnect();
    },
    options.ws,
    options.ssh,
  );
  activeRpc = rpc;

  let closed = false;
  const shutdown = () => {
    if (closed) return;
    closed = true;
    rpc.close();
    activeRpc = undefined;
    printStats();
  };
  process.once("SIGINT", () => {
    shutdown();
    process.exit(130);
  });

  const initialized = await rpc.request("initialize", {
    clientInfo: { name: "codex_pocket_probe", title: "Codex Pocket Probe", version: "0.0.0" },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
    },
  });
  rpc.notify("initialized");
  console.log(`initialized: ${initialized.userAgent} on ${initialized.platformFamily}/${initialized.platformOs}`);

  const listed = await rpc.request("thread/list", {
    limit: 50,
    sortKey: "recency_at",
    sortDirection: "desc",
  });
  const loaded = await rpc.request("thread/loaded/list", { limit: 100 });
  const threads = Array.isArray(listed.data) ? listed.data : [];
  const loadedIds = Array.isArray(loaded.data) ? loaded.data : [];
  printThreadList(threads, loadedIds);

  if (options.listOnly) {
    shutdown();
    return;
  }

  const activeThread = threads.find((thread: any) => thread.status?.type === "active");
  const targetId = options.thread ?? activeThread?.id ?? loadedIds[0];
  if (!targetId) {
    throw new Error(
      "no live thread is loaded in this app-server; start one with `codex --remote unix://` or pass --thread explicitly",
    );
  }
  console.log(`selected thread id: ${targetId}`);

  const resumed = await rpc.request("thread/resume", { threadId: targetId, excludeTurns: true });
  console.log(
    `resumed ${shortId(resumed.thread.id)} without turns: returned=${resumed.thread.turns?.length ?? 0} status=${statusText(resumed.thread.status)} directInput=${resumed.thread.canAcceptDirectInput ?? "unknown"}`,
  );

  let cursor: string | null = null;
  let activeTurnId: string | undefined;
  for (let pageNumber = 1; pageNumber <= options.historyPages; pageNumber += 1) {
    const page = await rpc.request("thread/turns/list", {
      threadId: targetId,
      cursor,
      limit: options.historyLimit,
      sortDirection: "desc",
      itemsView: "summary",
    });
    const turns = Array.isArray(page.data) ? page.data : [];
    activeTurnId ??= turns.find((turn: any) => turn.status === "inProgress")?.id;
    cursor = printHistoryPage(page, pageNumber);
    if (!cursor) break;
  }

  if (options.startTurn) {
    const result = await rpc.request("turn/start", {
      threadId: targetId,
      input: [{ type: "text", text: options.startTurn, text_elements: [] }],
    });
    activeTurnId = result.turn.id;
    console.log(`turn/start accepted: ${shortId(activeTurnId)}`);
  }

  if (options.steer) {
    if (!activeTurnId) throw new Error("--steer requires an active turn visible in recent history");
    const result = await rpc.request("turn/steer", {
      threadId: targetId,
      expectedTurnId: activeTurnId,
      input: [{ type: "text", text: options.steer, text_elements: [] }],
    });
    console.log(`turn/steer accepted: ${shortId(result.turnId)}`);
  }

  if (options.interrupt) {
    if (!activeTurnId) throw new Error("--interrupt requires an active turn visible in recent history");
    await rpc.request("turn/interrupt", { threadId: targetId, turnId: activeTurnId });
    console.log(`turn/interrupt accepted: ${shortId(activeTurnId)}`);
  }

  if (options.monitorSeconds > 0) {
    const monitorStartBytes = inboundBytes;
    const monitorStartMessages = inboundMessages;
    console.log(`monitoring compact events for ${options.monitorSeconds}s…`);
    let monitorTimer!: NodeJS.Timeout;
    const monitoring = new Promise<void>((resolve) => {
      monitorTimer = setTimeout(resolve, options.monitorSeconds * 1000);
    });
    await Promise.race([monitoring, disconnected]);
    clearTimeout(monitorTimer);
    if (disconnectError) throw disconnectError;
    console.log(
      `monitor inbound: ${formatBytes(inboundBytes - monitorStartBytes)} in ${inboundMessages - monitorStartMessages} message(s)`,
    );
  }
  shutdown();
}

main().catch((error) => {
  activeRpc?.close();
  activeRpc = undefined;
  console.error(`probe failed: ${error instanceof Error ? error.message : String(error)}`);
  printStats();
  process.exitCode = 1;
});
