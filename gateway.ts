#!/usr/bin/env node

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, extname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

type JsonObject = Record<string, any>;
type PendingRpc = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};
type Wire = {
  send(message: JsonObject): void;
  close(): void;
};
type Options = {
  host: string;
  port: number;
  ws?: string;
  thread?: string;
};
type AuthConfig = {
  required: boolean;
  token: string | null;
  sessionId: string;
};
type PocketMessage = {
  id: string;
  turnId?: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
  complete: boolean;
};
type PocketActivity = {
  id: string;
  kind: string;
  label: string;
  status: "running" | "completed" | "failed";
  detail?: string;
};
type PocketRequest = {
  id: string;
  kind: "permission" | "input";
  label: string;
};
type LoadedThreadSummary = {
  id: string;
  name: string;
  preview: string;
  cwd: string;
  project: string;
  status: string;
};
type PocketState = {
  connected: boolean;
  connectionError: string | null;
  machine: string;
  platform: string;
  userAgent: string;
  thread: null | {
    id: string;
    name: string;
    cwd: string;
    source: string;
  };
  model: string;
  reasoningEffort: string;
  threadStatus: string;
  phase: "connecting" | "working" | "waiting_input" | "waiting_permission" | "done" | "failed";
  turn: null | {
    id: string;
    status: string;
    startedAt: number | null;
    completedAt: number | null;
    error: string | null;
  };
  plan: Array<{ step: string; status: string }>;
  activities: PocketActivity[];
  pending: PocketRequest[];
  liveMessages: PocketMessage[];
  metrics: {
    rawBytes: number;
    rawMessages: number;
    browserBytes: number;
    browserMessages: number;
    startedAt: number;
  };
};

const MAX_TEXT = 12_000;
const MAX_MESSAGE_LENGTH = 12_000;
const MAX_LIVE_MESSAGES = 16;
const MAX_ACTIVITIES = 10;
const ASSISTANT_FLUSH_MS = 120;
const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));

function usage(): never {
  console.log(`Usage: node --experimental-strip-types gateway.ts [options]

Options:
  --host ADDRESS Browser bind address (default: 127.0.0.1)
  --port N       Browser port (default: 4173)
  --ws URL       Connect to an explicit app-server WebSocket
  --thread ID    Select a specific loaded thread
  --help         Show this help

Environment:
  CODEX_BIN      Codex executable to spawn (default: codex)
  CODEX_POCKET_TOKEN Shared token required for non-loopback hosts
`);
  process.exit(0);
}

function parseArgs(args: string[]): Options {
  const options: Options = { host: "127.0.0.1", port: 4173 };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const next = () => {
      const value = args[++index];
      if (value === undefined) throw new Error(`${flag} requires a value`);
      return value;
    };
    if (flag === "--help" || flag === "-h") usage();
    else if (flag === "--host") options.host = next();
    else if (flag === "--ws") options.ws = next();
    else if (flag === "--thread") options.thread = next();
    else if (flag === "--port") {
      const port = Number(next());
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("--port expects a valid port");
      options.port = port;
    } else throw new Error(`unknown option: ${flag}`);
  }
  return options;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  const ipv4 = normalized.match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return Boolean(ipv4 && ipv4.slice(1).every((part) => Number(part) <= 255));
}

function secretMatches(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function cookieValue(request: IncomingMessage, name: string): string | null {
  for (const entry of String(request.headers.cookie ?? "").split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0 || entry.slice(0, separator).trim() !== name) continue;
    return entry.slice(separator + 1).trim();
  }
  return null;
}

function isAuthenticated(request: IncomingMessage, auth: AuthConfig): boolean {
  if (!auth.required) return true;
  const session = cookieValue(request, "codex_pocket_session");
  return Boolean(session && secretMatches(session, auth.sessionId));
}

function compact(value: unknown, limit = 240): string {
  const text = String(value ?? "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function safeSummary(value: unknown, limit = 240): string {
  let text = Array.isArray(value) ? value.map(String).join(" ") : String(value ?? "");
  const secretName = String.raw`(?:[a-z0-9]+[_-])*(?:api[_-]?key|token|password|passwd|secret(?:[_-]?(?:key|access[_-]?key))?|client[_-]?secret|access[_-]?token|auth[_-]?token)`;
  const valuePattern = String.raw`(?:"[^"]*"|'[^']*'|[^\s;|&'"]+)`;
  text = text.replace(new RegExp(String.raw`\b(${secretName}\s*=\s*)${valuePattern}`, "gi"), "$1[REDACTED]");
  text = text.replace(new RegExp(String.raw`(^|\s)(--${secretName}(?:\s*=\s*|\s+))${valuePattern}`, "gi"), "$1$2[REDACTED]");
  text = text.replace(/\b(authorization\s*:\s*(?:bearer|basic)\s+)(?:"[^"]*"|'[^']*'|[^\s;|&'"]+)/gi, "$1[REDACTED]");
  text = text.replace(/([?&](?:api[_-]?key|apikey|key|token|access[_-]?token|auth|password|secret|signature|sig|x-(?:amz|goog)-signature)=)[^&#\s'"]+/gi, "$1[REDACTED]");
  return compact(text, limit);
}

function boundedText(value: unknown, limit = MAX_TEXT): string {
  const text = String(value ?? "").replace(/\r\n/g, "\n").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[message truncated by Codex Pocket]`;
}

function statusText(status: any): string {
  if (typeof status === "string") return status;
  if (!status || typeof status !== "object") return "unknown";
  const flags = Array.isArray(status.activeFlags) && status.activeFlags.length > 0
    ? `:${status.activeFlags.join(",")}`
    : "";
  return `${status.type ?? "unknown"}${flags}`;
}

function loadedThreadSummary(thread: any, id: string): LoadedThreadSummary {
  const cwd = String(thread?.cwd ?? "");
  const preview = compact(thread?.preview, 180);
  return {
    id,
    name: compact(thread?.name, 180) || preview || "Untitled task",
    preview,
    cwd,
    project: basename(cwd) || "Unknown project",
    status: statusText(thread?.status),
  };
}

function readText(value: any): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(readText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.inputText === "string") return value.inputText;
  if (typeof value.outputText === "string") return value.outputText;
  if (value.content !== undefined) return readText(value.content);
  if (value.message !== undefined) return readText(value.message);
  return "";
}

function numberTime(value: unknown, fallback = Date.now()): number {
  if (typeof value === "number" && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
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
  onPayload: (payload: Buffer) => void,
  onClose: (error?: Error) => void,
): Promise<Wire> {
  return new Promise((resolve, reject) => {
    const codexBin = process.env.CODEX_BIN || "codex";
    const child: ChildProcessWithoutNullStreams = spawn(codexBin, ["app-server", "proxy"], {
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
          closing = true;
          child.stdin.end();
          return;
        }
        if (opcode === 0x9) {
          sendFrame(0x0a, payload);
          continue;
        }
        if (opcode === 0x0a) continue;
        if (opcode === 0x1 && final) onPayload(payload);
        else if (opcode === 0x1) {
          fragmentedOpcode = opcode;
          fragments = [payload];
        } else if (opcode === 0x0 && fragmentedOpcode !== null) {
          fragments.push(payload);
          if (final) {
            if (fragmentedOpcode === 0x1) onPayload(Buffer.concat(fragments));
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
          const error = new Error(`app-server proxy WebSocket upgrade failed: ${compact(header, 300)}`);
          reject(error);
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
      if (text) console.error(`app-server proxy: ${text}`);
    });
    child.once("error", (error) => {
      if (!settled) reject(error);
      else if (!closing) onClose(error);
    });
    child.once("exit", (code, signal) => {
      if (!settled) reject(new Error(`app-server proxy exited before connecting (${signal ?? code})`));
      else if (!closing) onClose(new Error(`app-server proxy closed (${signal ?? code})`));
    });
    child.once("spawn", () => {
      child.stdin.write(
        `GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${websocketKey}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
  });
}

function connectWebSocket(
  url: string,
  onPayload: (payload: Buffer) => void,
  onClose: (error?: Error) => void,
): Promise<Wire> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let opened = false;
    socket.addEventListener("open", () => {
      opened = true;
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
      const data = typeof event.data === "string" ? Buffer.from(event.data) : Buffer.from(event.data as ArrayBuffer);
      onPayload(data);
    });
    socket.addEventListener("error", () => {
      const error = new Error(`WebSocket connection failed: ${url}`);
      if (!opened) reject(error);
      else onClose(error);
    });
    socket.addEventListener("close", () => {
      if (opened) onClose();
    });
  });
}

class RpcClient {
  private wire!: Wire;
  private nextId = 1;
  private pending = new Map<number, PendingRpc>();
  onNotification: (message: JsonObject) => void = () => {};
  onServerRequest: (message: JsonObject) => void = () => {};
  onRawPayload: (bytes: number) => void = () => {};
  onClose: (error?: Error) => void = () => {};

  async connect(ws?: string): Promise<void> {
    const onPayload = (payload: Buffer) => {
      this.onRawPayload(payload.length);
      try {
        this.receive(JSON.parse(payload.toString("utf8")));
      } catch (error) {
        console.error(`invalid JSON from app-server: ${compact((error as Error).message)}`);
      }
    };
    this.wire = ws
      ? await connectWebSocket(ws, onPayload, (error) => this.onClose(error))
      : await connectProxy(onPayload, (error) => this.onClose(error));
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
    this.wire?.close();
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("app-server connection closed"));
      this.pending.delete(id);
    }
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
    if (message.id !== undefined && message.method) this.onServerRequest(message);
    else if (message.method) this.onNotification(message);
  }
}

function messageFromItem(item: any, turnId?: string, complete = true, fallbackTime = Date.now()): PocketMessage | null {
  if (!item || (item.type !== "userMessage" && item.type !== "agentMessage")) return null;
  const text = boundedText(readText(item));
  if (!text) return null;
  return {
    id: String(item.id ?? `${item.type}-${randomBytes(6).toString("hex")}`),
    turnId,
    role: item.type === "userMessage" ? "user" : "assistant",
    text,
    createdAt: numberTime(item.createdAt ?? item.created_at, fallbackTime),
    complete,
  };
}

function activityFromItem(item: any, phase: "start" | "done"): PocketActivity | null {
  if (!item || typeof item !== "object") return null;
  const id = String(item.id ?? `${item.type}-${randomBytes(4).toString("hex")}`);
  const doneStatus = item.status === "failed" || item.status === "declined" ? "failed" : "completed";
  const status = phase === "start" ? "running" : doneStatus;
  if (item.type === "commandExecution") {
    const outputBytes = Buffer.byteLength(String(item.aggregatedOutput ?? ""));
    const detail = phase === "done"
      ? `exit ${item.exitCode ?? "–"} · ${outputBytes.toLocaleString()} output bytes suppressed`
      : undefined;
    return { id, kind: "command", label: safeSummary(item.command, 260), status, detail };
  }
  if (item.type === "mcpToolCall") {
    return { id, kind: "tool", label: compact(`${item.server ?? "tool"}/${item.tool ?? "unknown"}`), status };
  }
  if (item.type === "dynamicToolCall") {
    return { id, kind: "tool", label: compact(`${item.namespace ? `${item.namespace}/` : ""}${item.tool ?? "unknown"}`), status };
  }
  if (item.type === "collabAgentToolCall") {
    return { id, kind: "collaboration", label: compact(item.tool ?? "collaboration"), status };
  }
  if (item.type === "webSearch") {
    return { id, kind: "search", label: compact(item.query, 260), status };
  }
  if (item.type === "fileChange") {
    const paths = Array.isArray(item.changes) ? item.changes.length : 0;
    return { id, kind: "files", label: `${paths} changed path${paths === 1 ? "" : "s"} (diff suppressed)`, status };
  }
  return null;
}

function normalizeHistoryTurn(turn: any): JsonObject {
  const completedAt = turn?.completedAt ? numberTime(turn.completedAt, 0) : null;
  const createdAt = numberTime(turn?.createdAt ?? turn?.created_at, completedAt ?? 0);
  const messages = Array.isArray(turn?.items)
    ? turn.items.map((item: any) => messageFromItem(item, String(turn.id), true, createdAt)).filter(Boolean)
    : [];
  return {
    id: String(turn?.id ?? ""),
    status: String(turn?.status ?? "unknown"),
    createdAt,
    completedAt,
    error: compact(turn?.error?.message ?? turn?.error, 400) || null,
    messages,
  };
}

class PocketGateway {
  readonly state: PocketState;
  private rpc: RpcClient | null = null;
  private subscribers = new Set<ServerResponse>();
  private assistantFlushes = new Map<string, { delta: string; timer: NodeJS.Timeout }>();
  private canAcceptDirectInput = false;
  private loadedThreads: LoadedThreadSummary[] = [];
  private options: Options;
  private shuttingDown = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private selectionQueue: Promise<void> = Promise.resolve();

  constructor(options: Options) {
    this.options = options;
    this.state = {
      connected: false,
      connectionError: null,
      machine: "local",
      platform: "unknown",
      userAgent: "unknown",
      thread: null,
      model: "Not exposed",
      reasoningEffort: "Not exposed",
      threadStatus: "connecting",
      phase: "connecting",
      turn: null,
      plan: [],
      activities: [],
      pending: [],
      liveMessages: [],
      metrics: {
        rawBytes: 0,
        rawMessages: 0,
        browserBytes: 0,
        browserMessages: 0,
        startedAt: Date.now(),
      },
    };
  }

  async start(): Promise<void> {
    await this.connect();
  }

  stop(): void {
    this.shuttingDown = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const pending of this.assistantFlushes.values()) clearTimeout(pending.timer);
    this.assistantFlushes.clear();
    this.rpc?.close();
    for (const response of this.subscribers) response.end();
    this.subscribers.clear();
  }

  addSubscriber(response: ServerResponse): void {
    this.subscribers.add(response);
    this.writeSse(response, "snapshot", this.snapshot());
    response.on("close", () => this.subscribers.delete(response));
  }

  snapshot(): JsonObject {
    const snapshot = JSON.parse(JSON.stringify(this.state));
    delete snapshot.metrics;
    snapshot.message = this.messageCapability();
    return snapshot;
  }

  diagnostics(): JsonObject {
    return JSON.parse(JSON.stringify(this.state.metrics));
  }

  async history(cursor: string | null, limit: number): Promise<JsonObject> {
    if (!this.rpc || !this.state.thread) throw new Error("gateway is not attached to a thread");
    const threadId = this.state.thread.id;
    const page = await this.rpc.request("thread/turns/list", {
      threadId,
      cursor,
      limit,
      sortDirection: "desc",
      itemsView: "summary",
    });
    const turns = Array.isArray(page?.data) ? page.data.map(normalizeHistoryTurn).reverse() : [];
    return { threadId, turns, nextCursor: page?.nextCursor ?? null };
  }

  async listLoadedThreads(): Promise<LoadedThreadSummary[]> {
    return JSON.parse(JSON.stringify(await this.refreshLoadedThreads()));
  }

  selectThread(threadId: string): Promise<JsonObject> {
    const selection = this.selectionQueue.then(
      () => this.selectThreadNow(threadId),
      () => this.selectThreadNow(threadId),
    );
    this.selectionQueue = selection.then(() => {}, () => {});
    return selection;
  }

  sendMessage(text: unknown): Promise<JsonObject> {
    const operation = this.selectionQueue.then(
      () => this.sendMessageNow(text),
      () => this.sendMessageNow(text),
    );
    this.selectionQueue = operation.then(() => {}, () => {});
    return operation;
  }

  countBrowserPayload(payload: Buffer | string): void {
    this.state.metrics.browserBytes += Buffer.byteLength(payload);
    this.state.metrics.browserMessages += 1;
  }

  private async connect(): Promise<void> {
    if (this.rpc) {
      this.rpc.onClose = () => {};
      this.rpc.close();
      this.rpc = null;
    }
    this.state.connected = false;
    this.canAcceptDirectInput = false;
    this.state.connectionError = null;
    this.state.phase = "connecting";
    this.broadcast("status", this.statusPayload());
    const rpc = new RpcClient();
    this.rpc = rpc;
    rpc.onRawPayload = (bytes) => {
      this.state.metrics.rawBytes += bytes;
      this.state.metrics.rawMessages += 1;
    };
    rpc.onNotification = (message) => this.handleNotification(message);
    rpc.onServerRequest = (message) => this.handleServerRequest(message);
    rpc.onClose = (error) => {
      if (this.rpc === rpc) this.handleClose(error);
    };
    try {
      await rpc.connect(this.options.ws);
      const initialized = await rpc.request("initialize", {
        clientInfo: { name: "codex_pocket_gateway", title: "Codex Pocket Gateway", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      rpc.notify("initialized");
      this.state.userAgent = compact(initialized?.userAgent, 180) || "Codex app-server";
      this.state.platform = [initialized?.platformFamily, initialized?.platformOs].filter(Boolean).join(" / ") || "unknown";
      this.state.machine = initialized?.platformOs || initialized?.platformFamily || "local";
      const loadedThreads = await this.refreshLoadedThreads();
      const active = loadedThreads.find((thread) => thread.status.startsWith("active"));
      const targetId = this.options.thread ?? active?.id ?? loadedThreads[0]?.id;
      if (!targetId) throw new Error("no loaded Codex thread is available");
      await this.attachLoadedThread(String(targetId), false);
      this.state.connected = true;
      this.state.connectionError = null;
      this.state.phase = this.computePhase();
      this.broadcast("snapshot", this.snapshot());
    } catch (error) {
      rpc.onClose = () => {};
      rpc.close();
      if (this.rpc === rpc) this.rpc = null;
      this.state.connectionError = error instanceof Error ? error.message : String(error);
      this.state.phase = "failed";
      this.broadcast("status", this.statusPayload());
      console.error(`gateway attach failed: ${this.state.connectionError}`);
      this.scheduleReconnect();
    }
  }

  private handleClose(error?: Error): void {
    if (this.shuttingDown) return;
    this.rpc = null;
    this.state.connected = false;
    this.state.connectionError = error?.message ?? "app-server connection closed";
    this.state.phase = "failed";
    this.broadcast("status", this.statusPayload());
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((error) => console.error(error));
    }, 2_000);
  }

  private async refreshLoadedThreads(): Promise<LoadedThreadSummary[]> {
    if (!this.rpc) throw new Error("gateway is not connected to app-server");
    const [listed, loaded] = await Promise.all([
      this.rpc.request("thread/list", {
        limit: 100,
        sortKey: "recency_at",
        sortDirection: "desc",
      }),
      this.rpc.request("thread/loaded/list", { limit: 100 }),
    ]);
    const threads = Array.isArray(listed?.data) ? listed.data : [];
    const byId = new Map(threads.map((thread: any) => [String(thread.id), thread]));
    const loadedIds: string[] = Array.isArray(loaded?.data) ? loaded.data.map(String) : [];
    this.loadedThreads = loadedIds
      .map((id) => loadedThreadSummary(byId.get(id), id))
      .sort((left, right) => {
        const leftIndex = threads.findIndex((thread: any) => String(thread.id) === left.id);
        const rightIndex = threads.findIndex((thread: any) => String(thread.id) === right.id);
        return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex);
      });
    return this.loadedThreads;
  }

  private async selectThreadNow(threadId: string): Promise<JsonObject> {
    const requestedId = String(threadId ?? "").trim();
    if (!requestedId) throw new Error("threadId is required");
    const loadedThreads = await this.refreshLoadedThreads();
    if (!loadedThreads.some((thread) => thread.id === requestedId)) {
      throw new Error("selected thread is not currently loaded");
    }
    if (this.state.thread?.id === requestedId) return this.snapshot();
    await this.attachLoadedThread(requestedId, true);
    this.options.thread = requestedId;
    return this.snapshot();
  }

  private async sendMessageNow(value: unknown): Promise<JsonObject> {
    if (typeof value !== "string") throw new Error("message text is required");
    const text = value.replace(/\r\n/g, "\n");
    if (!text.trim()) throw new Error("message text is required");
    if (text.length > MAX_MESSAGE_LENGTH) throw new Error(`message exceeds ${MAX_MESSAGE_LENGTH.toLocaleString()} characters`);
    if (!this.rpc || !this.state.thread) throw new Error("Codex is disconnected");
    const capability = this.messageCapability();
    if (!capability.allowed || !capability.mode) throw new Error(capability.reason ?? "This task cannot accept a message right now");

    const threadId = this.state.thread.id;
    const input = [{ type: "text", text, text_elements: [] }];
    if (capability.mode === "steer") {
      const expectedTurnId = this.state.turn?.id;
      if (!expectedTurnId) throw new Error("The active turn is not ready for a follow-up");
      const result = await this.rpc.request("turn/steer", { threadId, expectedTurnId, input });
      return {
        accepted: true,
        mode: "steer",
        turnId: String(result?.turnId ?? expectedTurnId),
        message: this.messageCapability(),
      };
    }

    const result = await this.rpc.request("turn/start", { threadId, input });
    const turn = result?.turn ?? {};
    this.state.turn = {
      id: String(turn.id ?? ""),
      status: String(turn.status ?? "inProgress"),
      startedAt: numberTime(turn.createdAt ?? turn.startedAt),
      completedAt: null,
      error: null,
    };
    this.state.phase = "working";
    const message = this.messageCapability();
    this.broadcast("turn", {
      turn: this.state.turn,
      phase: this.state.phase,
      plan: this.state.plan,
      activities: this.state.activities,
      message,
    });
    return { accepted: true, mode: "start", turnId: this.state.turn.id, turn: this.state.turn, phase: this.state.phase, message };
  }

  private async attachLoadedThread(threadId: string, broadcastReset: boolean): Promise<void> {
    if (!this.rpc) throw new Error("gateway is not connected to app-server");
    const summary = this.loadedThreads.find((thread) => thread.id === threadId);
    if (!summary) throw new Error("selected thread is not currently loaded");
    const changed = this.state.thread?.id !== threadId;
    if (changed) this.resetThreadState();
    this.state.thread = {
      id: summary.id,
      name: summary.name,
      cwd: summary.cwd,
      source: "unknown",
    };
    this.state.threadStatus = summary.status;
    this.state.connectionError = null;
    this.state.phase = this.computePhase();
    if (changed && broadcastReset) this.broadcast("snapshot", this.snapshot());

    const resumed = await this.rpc.request("thread/resume", { threadId, excludeTurns: true });
    const thread = resumed?.thread ?? {};
    const resumedId = String(thread.id ?? threadId);
    if (resumedId !== threadId) throw new Error("app-server resumed an unexpected thread");
    this.state.thread = {
      id: resumedId,
      name: compact(thread.name ?? thread.preview, 180) || summary.name,
      cwd: String(thread.cwd ?? summary.cwd),
      source: String(thread.source ?? "unknown"),
    };
    this.canAcceptDirectInput = thread.canAcceptDirectInput === true;
    this.state.threadStatus = statusText(thread.status ?? summary.status);
    this.updateModel(thread);
    if (this.canAcceptDirectInput && this.state.threadStatus.startsWith("active") && this.state.turn?.status !== "inProgress") {
      await this.loadActiveTurn();
    }
    this.state.phase = this.computePhase();
    if (broadcastReset) this.broadcast("snapshot", this.snapshot());
    console.log(`attached to ${this.state.thread.id} (${this.state.thread.name})`);
  }

  private async loadActiveTurn(): Promise<void> {
    if (!this.rpc || !this.state.thread) return;
    const page = await this.rpc.request("thread/turns/list", {
      threadId: this.state.thread.id,
      cursor: null,
      limit: 5,
      sortDirection: "desc",
      itemsView: "summary",
    });
    const turn = Array.isArray(page?.data) ? page.data.find((candidate: any) => candidate?.status === "inProgress") : null;
    if (!turn) return;
    this.state.turn = {
      id: String(turn.id ?? ""),
      status: "inProgress",
      startedAt: numberTime(turn.createdAt ?? turn.startedAt),
      completedAt: null,
      error: null,
    };
  }

  private handleServerRequest(message: JsonObject): void {
    const method = String(message.method ?? "");
    const params = message.params ?? {};
    let request: PocketRequest | null = null;
    if (method.includes("requestApproval")) {
      request = {
        id: String(message.id),
        kind: "permission",
        label: safeSummary(params.reason ?? params.command ?? "Permission requested", 240),
      };
    } else if (method.includes("requestUserInput") || method.includes("requestInput")) {
      const questionCount = Array.isArray(params.questions) ? params.questions.length : 1;
      request = { id: String(message.id), kind: "input", label: `${questionCount} input request${questionCount === 1 ? "" : "s"}` };
    }
    if (!request) return;
    this.state.pending = [...this.state.pending.filter((candidate) => candidate.id !== request!.id), request];
    this.state.phase = this.computePhase();
    this.broadcast("request", { pending: this.state.pending, phase: this.state.phase, message: this.messageCapability() });
  }

  private handleNotification(message: JsonObject): void {
    const method = String(message.method ?? "");
    const params = message.params ?? {};
    if (this.state.thread && params.threadId && String(params.threadId) !== this.state.thread.id) return;
    switch (method) {
      case "thread/status/changed":
        this.state.threadStatus = statusText(params.status);
        this.state.phase = this.computePhase();
        this.broadcast("status", this.statusPayload());
        break;
      case "thread/name/updated":
        if (this.state.thread && params.name) {
          this.state.thread.name = compact(params.name, 180);
          this.broadcast("thread", this.state.thread);
        }
        break;
      case "turn/started":
        this.updateModel(params.turn);
        this.state.turn = {
          id: String(params.turn?.id ?? params.turnId ?? ""),
          status: String(params.turn?.status ?? "inProgress"),
          startedAt: numberTime(params.turn?.createdAt ?? params.turn?.startedAt),
          completedAt: null,
          error: null,
        };
        this.state.plan = [];
        this.state.activities = [];
        this.state.pending = [];
        this.state.phase = "working";
        this.broadcast("turn", {
          turn: this.state.turn,
          phase: this.state.phase,
          plan: this.state.plan,
          activities: this.state.activities,
          message: this.messageCapability(),
        });
        break;
      case "turn/completed": {
        const turn = params.turn ?? {};
        this.updateModel(turn);
        const status = String(turn.status ?? "completed");
        const error = compact(turn.error?.message ?? turn.error, 400) || null;
        this.state.turn = {
          id: String(turn.id ?? params.turnId ?? this.state.turn?.id ?? ""),
          status,
          startedAt: this.state.turn?.startedAt ?? null,
          completedAt: Date.now(),
          error,
        };
        this.state.pending = [];
        this.state.phase = error || status === "failed" ? "failed" : "done";
        this.flushAllAssistantDeltas();
        this.broadcast("turn", { turn: this.state.turn, phase: this.state.phase, message: this.messageCapability() });
        break;
      }
      case "turn/plan/updated":
        this.state.plan = Array.isArray(params.plan)
          ? params.plan.slice(0, 30).map((entry: any) => ({ step: compact(entry.step, 300), status: String(entry.status ?? "pending") }))
          : [];
        this.broadcast("plan", this.state.plan);
        break;
      case "item/agentMessage/delta":
        this.queueAssistantDelta(String(params.itemId), String(params.turnId ?? this.state.turn?.id ?? ""), String(params.delta ?? ""));
        break;
      case "item/started":
      case "item/completed":
        this.handleItem(params.item, params.turnId, method === "item/started" ? "start" : "done");
        break;
      case "serverRequest/resolved":
        this.state.pending = this.state.pending.filter((request) => request.id !== String(params.requestId));
        this.state.phase = this.computePhase();
        this.broadcast("request", { pending: this.state.pending, phase: this.state.phase, message: this.messageCapability() });
        break;
      case "error":
        this.state.connectionError = compact(params.error?.message ?? params.message ?? params, 400);
        this.state.phase = "failed";
        this.broadcast("status", this.statusPayload());
        break;
      default:
        break;
    }
  }

  private handleItem(item: any, turnId: unknown, phase: "start" | "done"): void {
    const itemTurnId = String(turnId ?? this.state.turn?.id ?? "");
    if (item?.type === "agentMessage" && phase === "done") {
      this.flushAssistantDelta(String(item.id));
      const existing = this.state.liveMessages.find((message) => message.id === String(item.id));
      const message = messageFromItem(item, itemTurnId, true) ?? existing;
      if (message) {
        message.complete = true;
        this.upsertLiveMessage(message);
        this.broadcast("message", message);
      }
      return;
    }
    if (item?.type === "userMessage") {
      const message = messageFromItem(item, itemTurnId, phase === "done");
      if (message) {
        this.upsertLiveMessage(message);
        this.broadcast("message", message);
      }
      return;
    }
    const activity = activityFromItem(item, phase);
    if (!activity) return;
    const index = this.state.activities.findIndex((candidate) => candidate.id === activity.id);
    if (index >= 0) this.state.activities[index] = activity;
    else this.state.activities.push(activity);
    this.state.activities = this.state.activities.slice(-MAX_ACTIVITIES);
    this.broadcast("activity", activity);
  }

  private queueAssistantDelta(itemId: string, turnId: string, delta: string): void {
    if (!delta) return;
    let message = this.state.liveMessages.find((candidate) => candidate.id === itemId);
    if (!message) {
      message = { id: itemId, turnId, role: "assistant", text: "", createdAt: Date.now(), complete: false };
      this.upsertLiveMessage(message);
    }
    message.text = boundedText(`${message.text}${delta}`);
    const queued = this.assistantFlushes.get(itemId);
    if (queued) {
      queued.delta += delta;
      return;
    }
    const timer = setTimeout(() => this.flushAssistantDelta(itemId), ASSISTANT_FLUSH_MS);
    this.assistantFlushes.set(itemId, { delta, timer });
  }

  private flushAssistantDelta(itemId: string): void {
    const queued = this.assistantFlushes.get(itemId);
    if (!queued) return;
    clearTimeout(queued.timer);
    this.assistantFlushes.delete(itemId);
    this.broadcast("assistant_delta", { id: itemId, delta: boundedText(queued.delta, 4_000) });
  }

  private flushAllAssistantDeltas(): void {
    for (const itemId of [...this.assistantFlushes.keys()]) this.flushAssistantDelta(itemId);
  }

  private resetThreadState(): void {
    for (const queued of this.assistantFlushes.values()) clearTimeout(queued.timer);
    this.assistantFlushes.clear();
    this.state.turn = null;
    this.state.plan = [];
    this.state.activities = [];
    this.state.pending = [];
    this.state.liveMessages = [];
    this.state.model = "Not exposed";
    this.state.reasoningEffort = "Not exposed";
    this.canAcceptDirectInput = false;
  }

  private upsertLiveMessage(message: PocketMessage): void {
    const index = this.state.liveMessages.findIndex((candidate) => candidate.id === message.id);
    if (index >= 0) this.state.liveMessages[index] = message;
    else this.state.liveMessages.push(message);
    this.state.liveMessages = this.state.liveMessages.slice(-MAX_LIVE_MESSAGES);
  }

  private updateModel(value: any): void {
    if (!value || typeof value !== "object") return;
    const model = value.model ?? value.modelId ?? value.config?.model;
    const effort = value.reasoningEffort ?? value.reasoning_effort ?? value.config?.reasoningEffort;
    if (model) this.state.model = String(model);
    if (effort) this.state.reasoningEffort = String(effort);
  }

  private computePhase(): PocketState["phase"] {
    if (this.state.connectionError && !this.state.connected) return "failed";
    if (this.state.pending.some((request) => request.kind === "permission")) return "waiting_permission";
    if (this.state.pending.some((request) => request.kind === "input")) return "waiting_input";
    if (this.state.turn?.error || this.state.turn?.status === "failed") return "failed";
    if (this.state.turn?.status === "inProgress" || this.state.threadStatus.startsWith("active")) return "working";
    return this.state.connected ? "done" : "connecting";
  }

  private messageCapability(): JsonObject {
    if (!this.state.connected || !this.rpc) return { allowed: false, mode: null, reason: "Codex is disconnected" };
    if (!this.state.thread) return { allowed: false, mode: null, reason: "No loaded task is selected" };
    if (this.state.pending.some((request) => request.kind === "permission")) {
      return { allowed: false, mode: null, reason: "Resolve the pending permission request in Codex first" };
    }
    if (this.state.pending.some((request) => request.kind === "input")) {
      return { allowed: false, mode: null, reason: "Answer the structured input request in Codex first" };
    }
    if (this.state.phase === "failed") return { allowed: false, mode: null, reason: "This task cannot accept a message while failed" };
    if (!this.canAcceptDirectInput) {
      return { allowed: false, mode: null, reason: "This loaded task does not accept direct input" };
    }
    if (this.state.turn?.status === "inProgress") return { allowed: true, mode: "steer", reason: null };
    if (this.state.threadStatus.startsWith("active")) {
      return { allowed: false, mode: null, reason: "The active turn is not ready for a follow-up" };
    }
    return { allowed: true, mode: "start", reason: null };
  }

  private statusPayload(): JsonObject {
    return {
      connected: this.state.connected,
      connectionError: this.state.connectionError,
      threadStatus: this.state.threadStatus,
      phase: this.state.phase,
      message: this.messageCapability(),
    };
  }

  private broadcast(event: string, data: unknown): void {
    for (const response of this.subscribers) this.writeSse(response, event, data);
  }

  private writeSse(response: ServerResponse, event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    response.write(payload);
    this.countBrowserPayload(payload);
  }
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

function securityHeaders(): Record<string, string> {
  return {
    "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  value: unknown,
  gateway: PocketGateway,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = Buffer.from(JSON.stringify(value));
  gateway.countBrowserPayload(payload);
  response.writeHead(statusCode, {
    ...securityHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": payload.length,
    ...extraHeaders,
  });
  response.end(payload);
}

function staticPath(pathname: string): string | null {
  if (pathname === "/") return join(PUBLIC_DIR, "index.html");
  if (pathname === "/app.js") return join(PUBLIC_DIR, "app.js");
  if (pathname === "/styles.css") return join(PUBLIC_DIR, "styles.css");
  return null;
}

async function readJsonBody(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 65_536) throw new Error("request body is too large");
    chunks.push(buffer);
  }
  if (length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("request body must be valid JSON");
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  gateway: PocketGateway,
  auth: AuthConfig,
): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (method === "GET" && url.pathname === "/api/auth") {
    sendJson(response, 200, { required: auth.required, authenticated: isAuthenticated(request, auth) }, gateway);
    return;
  }
  if (method === "POST" && url.pathname === "/api/login") {
    const body = await readJsonBody(request);
    const accepted = !auth.required || (typeof body.token === "string" && auth.token !== null && secretMatches(body.token, auth.token));
    if (!accepted) {
      sendJson(response, 401, { error: "Invalid access token" }, gateway);
      return;
    }
    sendJson(response, 200, { authenticated: true }, gateway, {
      "Set-Cookie": `codex_pocket_session=${auth.sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
    });
    return;
  }
  if ((url.pathname.startsWith("/api/") || url.pathname === "/events") && !isAuthenticated(request, auth)) {
    sendJson(response, 401, { error: "Authentication required" }, gateway);
    return;
  }
  if (method === "POST" && url.pathname === "/api/message") {
    try {
      const body = await readJsonBody(request);
      sendJson(response, 202, await gateway.sendMessage(body.text), gateway);
    } catch (error) {
      sendJson(response, 409, { error: error instanceof Error ? error.message : String(error) }, gateway);
    }
    return;
  }
  if (method === "POST" && url.pathname === "/api/thread") {
    try {
      const body = await readJsonBody(request);
      sendJson(response, 200, await gateway.selectThread(String(body.threadId ?? "")), gateway);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes("not currently loaded") || message.includes("required") ? 409 : 400;
      sendJson(response, status, { error: message }, gateway);
    }
    return;
  }
  if (method !== "GET" && method !== "HEAD") {
    sendJson(response, 405, { error: "unsupported method" }, gateway);
    return;
  }
  if (url.pathname === "/healthz") {
    sendJson(response, gateway.state.connected ? 200 : 503, { ok: gateway.state.connected }, gateway);
    return;
  }
  if (url.pathname === "/api/state") {
    sendJson(response, 200, gateway.snapshot(), gateway);
    return;
  }
  if (url.pathname === "/api/diagnostics") {
    sendJson(response, 200, gateway.diagnostics(), gateway);
    return;
  }
  if (url.pathname === "/api/threads") {
    try {
      sendJson(response, 200, { threads: await gateway.listLoadedThreads() }, gateway);
    } catch (error) {
      sendJson(response, 503, { error: error instanceof Error ? error.message : String(error) }, gateway);
    }
    return;
  }
  if (url.pathname === "/api/history") {
    const cursor = url.searchParams.get("cursor");
    const rawLimit = Number(url.searchParams.get("limit") ?? 6);
    const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 20) : 6;
    try {
      sendJson(response, 200, await gateway.history(cursor, limit), gateway);
    } catch (error) {
      sendJson(response, 503, { error: error instanceof Error ? error.message : String(error) }, gateway);
    }
    return;
  }
  if (url.pathname === "/events") {
    response.writeHead(200, {
      ...securityHeaders(),
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.write("retry: 1000\n\n");
    gateway.countBrowserPayload("retry: 1000\n\n");
    gateway.addSubscriber(response);
    return;
  }
  const filePath = staticPath(url.pathname);
  if (!filePath) {
    sendJson(response, 404, { error: "not found" }, gateway);
    return;
  }
  try {
    const stat = statSync(filePath);
    response.writeHead(200, {
      ...securityHeaders(),
      "Content-Type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
      "Content-Length": stat.size,
    });
    if (method === "HEAD") response.end();
    else createReadStream(filePath).pipe(response);
  } catch {
    sendJson(response, 404, { error: "not found" }, gateway);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const authRequired = !isLoopbackHost(options.host);
  const token = process.env.CODEX_POCKET_TOKEN ?? "";
  if (authRequired && !token) throw new Error("CODEX_POCKET_TOKEN is required when --host is not loopback");
  const auth: AuthConfig = {
    required: authRequired,
    token: authRequired ? token : null,
    sessionId: randomBytes(32).toString("hex"),
  };
  for (const required of ["index.html", "styles.css", "app.js"]) readFileSync(join(PUBLIC_DIR, required));
  const gateway = new PocketGateway(options);
  const server = createServer((request, response) => {
    handleRequest(request, response, gateway, auth).catch((error) => {
      if (!response.headersSent) sendJson(response, 500, { error: compact(error, 400) }, gateway);
      else response.end();
    });
  });
  server.listen(options.port, options.host, () => {
    const displayHost = options.host.includes(":") ? `[${options.host}]` : options.host;
    console.log(`Codex Pocket: http://${displayHost}:${options.port}`);
    if (!isLoopbackHost(options.host)) {
      console.warn("Warning: LAN control uses plain HTTP; use it only on a trusted network.");
    }
  });
  const shutdown = () => {
    gateway.stop();
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await gateway.start();
}

main().catch((error) => {
  console.error(`gateway failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
