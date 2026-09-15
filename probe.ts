#!/usr/bin/env node

import { RpcClient } from "./gateway.ts";
import process from "node:process";

type JsonObject = Record<string, any>;
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
  rpc.onRawPayload = bytes => { inboundBytes += bytes; inboundMessages += 1; };
  rpc.onNotification = printNotification;
  rpc.onServerRequest = printServerRequest;
  rpc.onClose = error => { disconnectError = error; signalDisconnect(); };
  await rpc.connect(options.ws, options.ssh);
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
