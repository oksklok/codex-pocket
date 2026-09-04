#!/usr/bin/env node

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer, isIP } from "node:net";
import { hostname, networkInterfaces } from "node:os";
import { dirname, extname, join } from "node:path";
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
  localName: string;
  machines: MachineConfig[];
};
type MachineConfig = {
  name: string;
  ssh: string;
};
type MachineDefinition = {
  id: string;
  name: string;
  ssh: string | null;
};
type LocalConfig = {
  lanEnabled: boolean;
  host: string;
  port: number;
  pin: string | null;
  localName: string;
  machines: MachineConfig[];
};
type LocalSettings = {
  path: string;
  config: LocalConfig;
  loaded: boolean;
};
type AuthConfig = {
  required: boolean;
  pin: string | null;
  sessionId: string;
  attempts: Map<string, { failures: number; lastFailureAt: number; blockedUntil: number }>;
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
  turnId?: string;
  kind: string;
  label: string;
  status: "running" | "completed" | "failed" | "interrupted";
  detail?: string;
  expandable?: boolean;
  createdAt: number;
};
type PocketInputOption = {
  label: string;
  description: string;
};
type PocketInputQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: PocketInputOption[] | null;
};
type PocketRequest = {
  id: string;
  kind: "permission" | "input";
  label: string;
  reason?: string;
  scope?: string;
  supported: boolean;
  blocking?: boolean;
  autoResolutionMs?: number | null;
  questions?: PocketInputQuestion[];
  resolving?: boolean;
};
type PermissionProfileSummary = {
  id: string;
  description: string | null;
  allowed: boolean;
};
type PocketAccessChoice = {
  available: boolean;
  reason: string | null;
};
type PocketAccess = {
  mode: "ask" | "auto" | "full" | "custom" | "unavailable";
  profileId: string | null;
  reviewer: string | null;
  approvalPolicy: string;
  description: string | null;
  choices: {
    ask: PocketAccessChoice;
    auto: PocketAccessChoice;
    full: PocketAccessChoice;
  };
};
type PendingServerRequest = {
  rawId: string | number;
  threadId: string;
  method: string;
  params: JsonObject;
  supported: boolean;
};
type LoadedThreadSummary = {
  id: string;
  name: string;
  preview: string;
  cwd: string;
  project: string;
  status: string;
  loaded: boolean;
  updatedAt: number;
};
type PocketModel = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
  defaultReasoningEffort: string;
};
type QueuedMessage = {
  threadId: string;
  text: string;
  createdAt: number;
  error?: string;
};
type PocketState = {
  connected: boolean;
  connectionError: string | null;
  machineId: string;
  machine: string;
  transport: string;
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
  models: PocketModel[];
  access: PocketAccess;
  queuedMessage: QueuedMessage | null;
  stoppingTurnId: string | null;
  threadStatus: string;
  phase: "connecting" | "unavailable" | "working" | "waiting_input" | "waiting_permission" | "done" | "stopped" | "failed";
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
type PocketQuotaWindow = {
  id: "primary" | "secondary";
  label: string;
  remainingPercent: number;
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};
type RuntimeQuota = {
  fresh: boolean;
  accountId: string | null;
  limitId: string | null;
  limitName: string | null;
  windows: PocketQuotaWindow[];
  additionalLimitCount: number;
  credits: JsonObject | null;
  updatedAt: number;
};
type PocketQuota = {
  available: boolean;
  stale: boolean;
  sourceMachineId: string | null;
  sourceMachine: string | null;
  limitName: string | null;
  windows: PocketQuotaWindow[];
  updatedAt: number | null;
};

const MAX_TEXT = 12_000;
const MAX_MESSAGE_LENGTH = 12_000;
const MAX_INPUT_ANSWER_LENGTH = 4_000;
const MAX_LIVE_MESSAGES = 16;
const MAX_ACTIVITIES = 50;
const MAX_DETAIL_ITEMS = 200;
const MAX_DETAIL_TEXT = 96_000;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const DETAIL_ITEMS_PAGE_LIMIT = 100;
const DETAIL_ITEMS_MAX_PAGES = 20;
const ASSISTANT_FLUSH_MS = 120;
const ACCESS_SETTINGS_TIMEOUT_MS = 2_000;
const THREAD_UNSUBSCRIBE_TIMEOUT_MS = 1_000;
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_FAILURE_WINDOW_MS = 60_000;
const LOGIN_BLOCK_MS = 8_000;
const ROOT_DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT_DIR, "public");
const CONFIG_PATH = join(ROOT_DIR, ".codex-pocket.local.json");
const RUNTIME_PATH = join(ROOT_DIR, ".codex-pocket.runtime.json");
const QUIT_PATH = join(ROOT_DIR, ".codex-pocket.quit");
const LOG_PATH = join(ROOT_DIR, ".codex-pocket.log");
const SAFE_CONFIG: LocalConfig = {
  lanEnabled: false,
  host: "127.0.0.1",
  port: 4173,
  pin: null,
  localName: "",
  machines: [],
};

function usage(): never {
  console.log(`Usage: node --experimental-strip-types gateway.ts [options]

Options:
  --host ADDRESS Override saved browser bind address
  --port N       Override saved browser port
  --ws URL       Connect to an explicit app-server WebSocket
  --thread ID    Select a specific saved thread
  --help         Show this help

Environment:
  CODEX_BIN      Codex executable to spawn (default: codex)
  CODEX_POCKET_PIN Four-digit PIN required for non-loopback hosts
`);
  process.exit(0);
}

function parseArgs(args: string[], defaults: Options): Options {
  const options: Options = { ...defaults };
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

function validHost(host: unknown): host is string {
  if (typeof host !== "string" || host.length < 1 || host.length > 253 || host.trim() !== host) return false;
  return isIP(host) !== 0 || /^(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)$/i.test(host);
}

function validSshAlias(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 128
    && value.trim() === value
    && /^[a-z0-9][a-z0-9._-]*$/i.test(value);
}

function validateMachines(value: unknown): MachineConfig[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("machines must be an array");
  const aliases = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`machine ${index + 1} must be an object`);
    const candidate = entry as JsonObject;
    const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
    if (!name || name.length > 80) throw new Error(`machine ${index + 1} needs a name of 80 characters or fewer`);
    if (!validSshAlias(candidate.ssh)) throw new Error(`machine ${index + 1} needs a simple SSH alias`);
    const normalized = candidate.ssh.toLowerCase();
    if (aliases.has(normalized)) throw new Error(`duplicate SSH alias: ${candidate.ssh}`);
    aliases.add(normalized);
    return { name, ssh: candidate.ssh };
  });
}

function validateLocalConfig(value: unknown): LocalConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected a JSON object");
  const candidate = value as JsonObject;
  if (typeof candidate.lanEnabled !== "boolean") throw new Error("lanEnabled must be true or false");
  if (!validHost(candidate.host)) throw new Error("host must be a valid bind address or hostname");
  if (!Number.isInteger(candidate.port) || candidate.port < 1 || candidate.port > 65_535) {
    throw new Error("port must be between 1 and 65535");
  }
  if (candidate.pin !== null && (typeof candidate.pin !== "string" || !/^\d{4}$/.test(candidate.pin))) {
    throw new Error("pin must be exactly four numeric digits or null");
  }
  if (candidate.lanEnabled && !/^\d{4}$/.test(candidate.pin ?? "")) {
    throw new Error("LAN access requires a four-digit PIN");
  }
  const localName = candidate.localName === undefined ? "" : candidate.localName;
  if (typeof localName !== "string" || localName.trim().length > 80) {
    throw new Error("localName must be 80 characters or fewer");
  }
  return {
    lanEnabled: candidate.lanEnabled,
    host: candidate.host,
    port: candidate.port,
    pin: candidate.pin,
    localName: localName.trim(),
    machines: validateMachines(candidate.machines),
  };
}

function loadLocalSettings(): LocalSettings {
  try {
    const config = validateLocalConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
    return { path: CONFIG_PATH, config, loaded: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`Warning: ignoring invalid config at ${CONFIG_PATH}: ${compact(error, 240)}. Using safe localhost defaults.`);
    }
    return { path: CONFIG_PATH, config: { ...SAFE_CONFIG }, loaded: false };
  }
}

function saveLocalSettings(settings: LocalSettings, value: unknown, fallbackPin: string | null): LocalConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("settings must be a JSON object");
  const candidate = value as JsonObject;
  const submittedPin = candidate.pin;
  if (submittedPin !== undefined && submittedPin !== "" && (typeof submittedPin !== "string" || !/^\d{4}$/.test(submittedPin))) {
    throw new Error("PIN must be exactly four numeric digits");
  }
  const pin = typeof submittedPin === "string" && submittedPin !== ""
    ? submittedPin
    : settings.config.pin ?? fallbackPin;
  const config = validateLocalConfig({
    lanEnabled: candidate.lanEnabled,
    host: candidate.host,
    port: candidate.port,
    pin,
    localName: candidate.localName ?? settings.config.localName,
    machines: candidate.machines ?? settings.config.machines,
  });
  const temporaryPath = `${settings.path}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, settings.path);
  settings.config = config;
  settings.loaded = true;
  return config;
}

function publicSettings(settings: LocalSettings, fallbackPin: string | null): JsonObject {
  return {
    hostName: localMachineName(),
    lanEnabled: settings.config.lanEnabled,
    host: settings.config.host,
    port: settings.config.port,
    pinConfigured: /^\d{4}$/.test(settings.config.pin ?? fallbackPin ?? ""),
    localName: settings.config.localName,
    phoneUrls: phoneUrls(settings.config),
    machines: settings.config.machines.map((machine) => ({ ...machine })),
  };
}

function settingsNeedRestart(settings: LocalSettings, options: Options, auth: AuthConfig): boolean {
  const desiredHost = settings.config.lanEnabled ? settings.config.host : SAFE_CONFIG.host;
  const desiredPin = settings.config.pin;
  return desiredHost !== options.host
    || settings.config.port !== options.port
    || settings.config.localName !== options.localName
    || !secretMatches(desiredPin ?? "", auth.pin ?? "")
    || JSON.stringify(settings.config.machines) !== JSON.stringify(options.machines);
}

function browserUrl(host: string, port: number): string {
  const localHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${localHost.includes(":") ? `[${localHost}]` : localHost}:${port}`;
}

function restartUrlForRequest(request: IncomingMessage, config: LocalConfig, fallback: string): string {
  if (!config.lanEnabled) return fallback;
  try {
    const requested = new URL(`http://${request.headers.host ?? ""}`);
    const host = requested.hostname.replace(/^\[|\]$/g, "");
    if (!isLoopbackHost(host)) return `http://${host.includes(":") ? `[${host}]` : host}:${config.port}`;
  } catch {
    // Fall back to the gateway's local URL for malformed Host headers.
  }
  return fallback;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function phoneUrls(config: LocalConfig): string[] {
  return config.lanEnabled ? phoneUrlsFor(config.host, config.port) : [];
}

function phoneUrlsFor(host: string, port: number): string[] {
  if (isLoopbackHost(host)) return [];
  const addresses = host !== "0.0.0.0" && isPrivateIpv4(host)
    ? [host]
    : Object.values(networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .filter((entry) => entry.family === "IPv4" && !entry.internal && isPrivateIpv4(entry.address))
      .map((entry) => entry.address);
  return [...new Set(addresses)].sort().map((address) => `http://${address}:${port}`);
}

function writeRuntimeInfo(options: Options, controlUrl: string): void {
  writeFileSync(RUNTIME_PATH, `${JSON.stringify({
    pid: process.pid,
    host: options.host,
    port: options.port,
    localUrl: browserUrl(options.host, options.port),
    controlUrl,
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function clearRuntimeInfo(): void {
  try {
    const value = JSON.parse(readFileSync(RUNTIME_PATH, "utf8"));
    if (value?.pid === process.pid) unlinkSync(RUNTIME_PATH);
  } catch {
    // Missing or stale runtime metadata is harmless.
  }
}

function markHostQuit(): void {
  writeFileSync(QUIT_PATH, `${JSON.stringify({ pid: process.pid, requestedAt: Date.now() })}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function validateRestartTarget(config: LocalConfig, current: Options): Promise<void> {
  const host = config.lanEnabled ? config.host : SAFE_CONFIG.host;
  const port = config.port === current.port ? 0 : config.port;
  await new Promise<void>((resolve, reject) => {
    const probe = createNetServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(port, host, () => probe.close((error) => error ? reject(error) : resolve()));
  });
}

const RESTART_HELPER = String.raw`
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const [oldPid, nodePath, gatewayPath, cwd, logPath] = process.argv.slice(1);
const waitForExit = () => {
  try {
    process.kill(Number(oldPid), 0);
    setTimeout(waitForExit, 100);
  } catch {
    const env = { ...process.env };
    delete env.CODEX_POCKET_PIN;
    const log = fs.openSync(logPath, "a");
    const child = spawn(nodePath, ["--experimental-strip-types", gatewayPath], {
      cwd,
      detached: true,
      stdio: ["ignore", log, log],
      env,
    });
    child.unref();
  }
};
waitForExit();
`;

async function startRestartHandoff(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const helper = spawn(process.execPath, [
      "-e",
      RESTART_HELPER,
      String(process.pid),
      process.execPath,
      fileURLToPath(import.meta.url),
      ROOT_DIR,
      LOG_PATH,
    ], { cwd: ROOT_DIR, detached: true, stdio: "ignore", env: process.env });
    helper.once("spawn", () => {
      helper.unref();
      resolve();
    });
    helper.once("error", reject);
  });
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  const ipv4 = normalized.match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return Boolean(ipv4 && ipv4.slice(1).every((part) => Number(part) <= 255));
}

function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = String(request.socket.remoteAddress ?? "").replace(/^::ffff:/i, "");
  return isLoopbackHost(address);
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

function loginClient(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? "unknown";
}

function loginRetryAfter(auth: AuthConfig, client: string, now = Date.now()): number {
  const attempt = auth.attempts.get(client);
  if (!attempt) return 0;
  if (attempt.blockedUntil > now) return Math.ceil((attempt.blockedUntil - now) / 1000);
  if (now - attempt.lastFailureAt > LOGIN_FAILURE_WINDOW_MS) auth.attempts.delete(client);
  return 0;
}

function recordLoginFailure(auth: AuthConfig, client: string, now = Date.now()): void {
  const previous = auth.attempts.get(client);
  const failures = previous && now - previous.lastFailureAt <= LOGIN_FAILURE_WINDOW_MS ? previous.failures + 1 : 1;
  auth.attempts.set(client, {
    failures: failures >= LOGIN_FAILURE_LIMIT ? 0 : failures,
    lastFailureAt: now,
    blockedUntil: failures >= LOGIN_FAILURE_LIMIT ? now + LOGIN_BLOCK_MS : 0,
  });
}

function compact(value: unknown, limit = 240): string {
  const text = String(value ?? "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function redactSecrets(value: unknown): string {
  let text = Array.isArray(value) ? value.map(String).join(" ") : String(value ?? "");
  const secretName = String.raw`(?:[a-z0-9]+[_-])*(?:api[_-]?key|token|password|passwd|secret(?:[_-]?(?:key|access[_-]?key))?|client[_-]?secret|access[_-]?token|auth[_-]?token)`;
  const valuePattern = String.raw`(?:"[^"]*"|'[^']*'|[^\s;|&'"]+)`;
  const structuredValuePattern = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|null|true|false|-?\d+(?:\.\d+)?|[^\s,}\]\r\n#]+)`;
  // Assignment syntax is especially varied on PowerShell, where nested quoting can
  // double quote marks. Redact the rest of that shell segment instead of risking a
  // partial value leak when a credential assignment cannot be parsed perfectly.
  text = text.replace(new RegExp(String.raw`\b(${secretName}\s*=\s*)[^;|&\r\n]+`, "gi"), "$1[REDACTED]");
  text = text.replace(new RegExp(String.raw`(^|\s)(--${secretName}(?:\s*=\s*|\s+))${valuePattern}`, "gi"), "$1$2[REDACTED]");
  text = text.replace(/\b(authorization\s*:\s*(?:bearer|basic)\s+)(?:"[^"]*"|'[^']*'|[^\s;|&'"]+)/gi, "$1[REDACTED]");
  text = text.replace(/([?&](?:api[_-]?key|apikey|key|token|access[_-]?token|auth|password|secret|signature|sig|x-(?:amz|goog)-signature)=)[^&#\s'"]+/gi, "$1[REDACTED]");
  text = text.replace(
    new RegExp(String.raw`(^|[\s,{\[])(["']?)(${secretName})\2(\s*:\s*)${structuredValuePattern}`, "gi"),
    '$1$2$3$2$4"[REDACTED]"',
  );
  return text;
}

function safeSummary(value: unknown, limit = 240): string {
  return compact(redactSecrets(value), limit);
}

function boundedDetail(value: unknown, limit = MAX_DETAIL_TEXT): { text: string; truncated: boolean } {
  const text = redactSecrets(value).replace(/\r\n/g, "\n");
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true };
}

function boundedJson(value: unknown, limit = MAX_DETAIL_TEXT): { text: string; truncated: boolean } {
  if (value === null || value === undefined) return { text: "", truncated: false };
  let serialized: string;
  try {
    serialized = JSON.stringify(value, null, 2);
  } catch {
    serialized = String(value ?? "");
  }
  return boundedDetail(serialized, limit);
}

function approvalPolicyText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "granular" in value) return "granular";
  return "unknown";
}

function permissionScopeSummary(value: any): string {
  if (!value || typeof value !== "object") return "Additional access";
  const scopes: string[] = [];
  if (value.network?.enabled === true) scopes.push("Network access");
  const fileSystem = value.fileSystem;
  if (fileSystem && typeof fileSystem === "object") {
    const reads = Array.isArray(fileSystem.read) ? fileSystem.read.length : 0;
    const writes = Array.isArray(fileSystem.write) ? fileSystem.write.length : 0;
    const entries = Array.isArray(fileSystem.entries) ? fileSystem.entries : [];
    const entryReads = entries.filter((entry: any) => entry?.access === "read").length;
    const entryWrites = entries.filter((entry: any) => entry?.access === "write").length;
    if (reads + entryReads > 0) scopes.push(`Read access to ${reads + entryReads} path${reads + entryReads === 1 ? "" : "s"}`);
    if (writes + entryWrites > 0) scopes.push(`Write access to ${writes + entryWrites} path${writes + entryWrites === 1 ? "" : "s"}`);
  }
  return scopes.join(" · ") || "Additional access";
}

function emptyAccess(): PocketAccess {
  const unavailable = { available: false, reason: "Access settings are unavailable" };
  return {
    mode: "unavailable",
    profileId: null,
    reviewer: null,
    approvalPolicy: "unknown",
    description: null,
    choices: { ask: { ...unavailable }, auto: { ...unavailable }, full: { ...unavailable } },
  };
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

function loadedThreadSummary(thread: any, id: string, loaded: boolean): LoadedThreadSummary {
  const cwd = String(thread?.cwd ?? "");
  const preview = compact(thread?.preview, 180);
  const project = cwd.split(/[\\/]/).filter(Boolean).at(-1) || "Unknown project";
  return {
    id,
    name: compact(thread?.name, 180) || preview || "Untitled task",
    preview,
    cwd,
    project,
    status: statusText(thread?.status),
    loaded,
    updatedAt: numberTime(thread?.recencyAt ?? thread?.updatedAt ?? thread?.createdAt, 0),
  };
}

function isUserFacingThread(thread: any): boolean {
  if (!thread || typeof thread !== "object" || thread.ephemeral === true || thread.parentThreadId) return false;
  if (thread.source && typeof thread.source === "object" && "subAgent" in thread.source) return false;
  const sourceKind = String(thread.threadSource ?? thread.source ?? "unknown");
  return !sourceKind.toLowerCase().includes("subagent");
}

function localMachineName(): string {
  return compact(hostname().replace(/\.local$/i, ""), 80) || "Local machine";
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

function quotaWindowLabel(durationMins: number | null, fallback: string): string {
  if (!durationMins || durationMins <= 0) return fallback;
  if (durationMins % 10_080 === 0) return `${durationMins / 10_080}w`;
  if (durationMins % 1_440 === 0) return `${durationMins / 1_440}d`;
  if (durationMins % 60 === 0) return `${durationMins / 60}h`;
  return `${durationMins}m`;
}

function normalizeRateLimits(value: any): RuntimeQuota | null {
  const rateLimits = value?.rateLimits;
  if (!rateLimits || typeof rateLimits !== "object") return null;
  const windows: PocketQuotaWindow[] = [];
  for (const [id, raw, fallback] of [
    ["primary", rateLimits.primary, "Primary"],
    ["secondary", rateLimits.secondary, "Secondary"],
  ] as const) {
    if (!raw || typeof raw !== "object") continue;
    const used = Number(raw.usedPercent);
    if (!Number.isFinite(used)) continue;
    const duration = Number(raw.windowDurationMins);
    const windowDurationMins = Number.isFinite(duration) && duration > 0 ? duration : null;
    const usedPercent = Math.min(100, Math.max(0, used));
    windows.push({
      id,
      label: quotaWindowLabel(windowDurationMins, fallback),
      remainingPercent: Math.min(100, Math.max(0, 100 - usedPercent)),
      usedPercent,
      windowDurationMins,
      resetsAt: raw.resetsAt === null || raw.resetsAt === undefined ? null : numberTime(raw.resetsAt),
    });
  }
  if (windows.length === 0) return null;
  const byLimitId = value?.rateLimitsByLimitId;
  return {
    fresh: true,
    accountId: typeof value.accountId === "string" ? value.accountId : null,
    limitId: typeof rateLimits.limitId === "string" ? rateLimits.limitId : null,
    limitName: typeof rateLimits.limitName === "string" ? rateLimits.limitName : null,
    windows,
    additionalLimitCount: byLimitId && typeof byLimitId === "object" ? Math.max(0, Object.keys(byLimitId).length - 1) : 0,
    credits: rateLimits.credits && typeof rateLimits.credits === "object" ? rateLimits.credits : null,
    updatedAt: Date.now(),
  };
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
  registerAbort: (abort: () => void) => void,
  sshAlias?: string,
): Promise<Wire> {
  return new Promise((resolve, reject) => {
    const codexBin = process.env.CODEX_BIN || "codex";
    const command = sshAlias ? process.env.SSH_BIN || "ssh" : codexBin;
    const args = sshAlias
      ? ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", sshAlias, "codex", "app-server", "proxy"]
      : ["app-server", "proxy"];
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
    registerAbort(() => {
      closing = true;
      child.stdin.end();
      child.kill("SIGTERM");
    });
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
      if (text) console.error(`${sshAlias ? `${sshAlias} SSH proxy` : "app-server proxy"}: ${text}`);
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
  registerAbort: (abort: () => void) => void,
): Promise<Wire> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    registerAbort(() => socket.close());
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
  private abortTransport: (() => void) | null = null;
  private closing = false;
  private nextId = 1;
  private pending = new Map<number, PendingRpc>();
  onNotification: (message: JsonObject) => void = () => {};
  onServerRequest: (message: JsonObject) => void = () => {};
  onRawPayload: (bytes: number) => void = () => {};
  onClose: (error?: Error) => void = () => {};

  async connect(ws?: string, sshAlias?: string): Promise<void> {
    const onPayload = (payload: Buffer) => {
      this.onRawPayload(payload.length);
      try {
        this.receive(JSON.parse(payload.toString("utf8")));
      } catch (error) {
        console.error(`invalid JSON from app-server: ${compact((error as Error).message)}`);
      }
    };
    const registerAbort = (abort: () => void) => { this.abortTransport = abort; };
    this.wire = ws
      ? await connectWebSocket(ws, onPayload, (error) => this.onClose(error), registerAbort)
      : await connectProxy(onPayload, (error) => this.onClose(error), registerAbort, sshAlias);
    this.abortTransport = null;
    if (this.closing) {
      this.wire.close();
      throw new Error("app-server connection closed");
    }
  }

  request(method: string, params: JsonObject | undefined = {}, timeoutMs = 20_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.wire.send(params === undefined ? { method, id } : { method, id, params });
    });
  }

  notify(method: string, params: JsonObject = {}): void {
    this.wire.send({ method, params });
  }

  respond(id: string | number, result: JsonObject): void {
    this.wire.send({ id, result });
  }

  close(): void {
    this.closing = true;
    this.abortTransport?.();
    this.abortTransport = null;
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

function readableCommandSummary(value: unknown): string {
  let text = String(value ?? "").trim();
  if (!text) return "";
  const powerShell = text.match(/^(?:"[^"]*[\\/]|'[^']*[\\/]|[^\s"']*[\\/])?(?:powershell|pwsh)(?:\.exe)?["']?\s+([\s\S]+)$/i);
  if (powerShell) {
    const argumentsText = powerShell[1];
    if (/(?:^|\s)-(?:encodedcommand|enc)\b/i.test(argumentsText)) return "PowerShell command";
    const marker = /(?:^|\s)-(?:command|c)\s+/i.exec(argumentsText);
    if (marker) text = argumentsText.slice(marker.index + marker[0].length);
  } else {
    const cmd = text.match(/^(?:"[^"]*[\\/]?)?cmd(?:\.exe)?"?\s+\/(?:[a-z]*c|c)\s+([\s\S]+)$/i);
    const shell = text.match(/^(?:\/usr\/bin\/env\s+)?(?:[^\s"']*[\/])?(?:ba|z|da)?sh\s+(?:-[a-z]+\s+)*([\s\S]+)$/i);
    if (cmd) text = cmd[1];
    else if (shell) text = shell[1];
  }
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }
  const guardedBody = /\btry\s*\{([\s\S]*?)\}\s*finally\s*\{/i.exec(text);
  if (guardedBody?.[1]) text = guardedBody[1].trim();
  return safeSummary(text, 260);
}

function commandActionSummary(actions: unknown): string {
  if (!Array.isArray(actions) || actions.length !== 1) return "";
  const action: any = actions[0];
  if (!action || typeof action !== "object") return "";
  if (action.type === "read") return `Read ${safeSummary(action.name || String(action.path ?? "").split(/[\\/]/).at(-1), 180) || "file"}`;
  if (action.type === "listFiles") return action.path ? `List files in ${safeSummary(action.path, 180)}` : "List files";
  if (action.type === "search") return action.query ? `Search for ${safeSummary(action.query, 180)}` : "Search files";
  if (action.type === "run" && action.name) return `Run ${safeSummary(action.name, 180)}`;
  return "";
}

function pluginCommandSummary(pluginIdValue: unknown, scriptPathValue: unknown): string {
  const rawPluginId = String(pluginIdValue ?? "").trim();
  const pluginId = safeSummary(rawPluginId.replace(/@[^/@]+$/, ""), 120);
  const scriptName = safeSummary(String(scriptPathValue ?? "").split(/[\\/]/).filter(Boolean).at(-1), 120);
  if (pluginId && scriptName) return `Run ${pluginId} / ${scriptName}`;
  if (pluginId) return `Run ${pluginId}`;
  if (scriptName) return `Run ${scriptName}`;
  return "";
}

function activityFromItem(
  item: any,
  phase: "start" | "done",
  turnId?: string,
  fallbackTime = Date.now(),
): PocketActivity | null {
  if (!item || typeof item !== "object") return null;
  if (item.id === undefined || item.id === null) return null;
  const id = String(item.id);
  const doneStatus = item.status === "interrupted"
    ? "interrupted"
    : item.status === "failed" || item.status === "declined"
      ? "failed"
      : "completed";
  const status = phase === "start" ? "running" : doneStatus;
  const base = { id, turnId, status, createdAt: numberTime(item.createdAt ?? item.created_at, fallbackTime) };
  if (item.type === "commandExecution") {
    const label = commandActionSummary(item.commandActions)
      || pluginCommandSummary(item.pluginId, item.scriptPath)
      || readableCommandSummary(item.command)
      || safeSummary(item.command, 260)
      || "Run command";
    const failedExit = status === "failed" && Number.isInteger(item.exitCode) ? `exit ${item.exitCode}` : undefined;
    return { ...base, kind: "command", label, ...(failedExit ? { detail: failedExit } : {}), expandable: true };
  }
  if (item.type === "mcpToolCall") {
    return { ...base, kind: "tool", label: compact(`${item.server ?? "tool"}/${item.tool ?? "unknown"}`), expandable: true };
  }
  if (item.type === "dynamicToolCall") {
    return { ...base, kind: "tool", label: compact(`${item.namespace ? `${item.namespace}/` : ""}${item.tool ?? "unknown"}`), expandable: true };
  }
  if (item.type === "collabAgentToolCall" || item.type === "subAgentActivity") {
    const states = item.agentsStates && typeof item.agentsStates === "object" ? item.agentsStates : null;
    const agentCount = states ? Object.keys(states).length : Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.length : 0;
    const subagentName = String(item.agentPath ?? "").split("/").filter(Boolean).at(-1);
    const labels: Record<string, string> = {
      started: `Started subagent${subagentName ? ` ${subagentName}` : ""}`,
      interacted: `Interacted with subagent${subagentName ? ` ${subagentName}` : ""}`,
      interrupted: `Interrupted subagent${subagentName ? ` ${subagentName}` : ""}`,
      completed: `Completed subagent${subagentName ? ` ${subagentName}` : ""}`,
    };
    return {
      ...base,
      kind: "collaboration",
      label: labels[item.kind] ?? compact(item.tool ?? "Subagent activity"),
      ...(agentCount ? { detail: `${agentCount} subagent${agentCount === 1 ? "" : "s"}` } : {}),
      expandable: item.type === "collabAgentToolCall",
    };
  }
  if (item.type === "webSearch") {
    return { ...base, kind: "search", label: safeSummary(item.query, 260) || "Web search", expandable: true };
  }
  if (item.type === "fileChange") {
    const paths = Array.isArray(item.changes) ? item.changes.length : 0;
    return { ...base, kind: "files", label: `Edited ${paths} file${paths === 1 ? "" : "s"}`, expandable: true };
  }
  if (item.type === "reasoning") {
    const summary = Array.isArray(item.summary)
      ? item.summary.map((part: unknown) => boundedText(part, 600)).filter(Boolean).join("\n")
      : "";
    if (!summary) return null;
    return { ...base, kind: "reasoning", label: "Reasoning summary", detail: boundedText(summary, 1_200) };
  }
  if (item.type === "imageView") {
    const name = String(item.path ?? "").split(/[\\/]/).filter(Boolean).at(-1) || "image";
    return { ...base, kind: "image", label: `Viewed ${name}`, expandable: true };
  }
  if (item.type === "imageGeneration") {
    return { ...base, kind: "image", label: phase === "start" ? "Generating image" : "Generated image", expandable: true };
  }
  if (item.type === "contextCompaction") {
    return { ...base, kind: "compaction", label: phase === "start" ? "Compacting context" : "Context compacted" };
  }
  if (item.type === "enteredReviewMode") {
    return { ...base, kind: "review", label: `Entered review mode${item.review ? `: ${safeSummary(item.review, 220)}` : ""}` };
  }
  if (item.type === "exitedReviewMode") {
    return { ...base, kind: "review", label: `Exited review mode${item.review ? `: ${safeSummary(item.review, 220)}` : ""}` };
  }
  return null;
}

function normalizeHistoryTurn(turn: any): JsonObject {
  const completedAt = turn?.completedAt ? numberTime(turn.completedAt, 0) : null;
  const createdAt = numberTime(turn?.createdAt ?? turn?.created_at, completedAt ?? 0);
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const messages = items
    .map((item: any, index: number) => messageFromItem(item, String(turn.id), true, createdAt + index)).filter(Boolean);
  const activities = items
    .map((item: any, index: number) => activityFromItem(item, "done", String(turn.id), createdAt + index)).filter(Boolean);
  return {
    id: String(turn?.id ?? ""),
    status: String(turn?.status ?? "unknown"),
    createdAt,
    completedAt,
    error: compact(turn?.error?.message ?? turn?.error, 400) || null,
    messages,
    activities,
  };
}

function durationLabel(milliseconds: unknown): string | null {
  const value = Number(milliseconds);
  if (!Number.isFinite(value) || value < 0) return null;
  if (value < 1_000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1_000)}s`;
}

function changeKind(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as JsonObject;
    if (typeof record.type === "string") return record.type;
    return Object.keys(record)[0] ?? "modified";
  }
  return "modified";
}

function activityDetailFromItem(item: any): JsonObject | null {
  if (!item || typeof item !== "object") return null;
  if (item.type === "commandExecution") {
    const command = boundedDetail(item.command, 12_000);
    const output = boundedDetail(item.aggregatedOutput ?? "", MAX_DETAIL_TEXT);
    return {
      type: "commandExecution",
      command: command.text,
      cwd: boundedDetail(item.cwd ?? "", 4_000).text,
      output: output.text,
      outputTruncated: output.truncated,
      status: String(item.status ?? "completed"),
      exitCode: Number.isInteger(item.exitCode) ? item.exitCode : null,
      duration: durationLabel(item.durationMs),
    };
  }
  if (item.type === "fileChange") {
    let remaining = MAX_DETAIL_TEXT;
    let truncated = false;
    const changes = (Array.isArray(item.changes) ? item.changes : []).slice(0, 100).map((change: any) => {
      const value = boundedDetail(change?.diff ?? "", Math.max(0, remaining));
      remaining = Math.max(0, remaining - value.text.length);
      truncated ||= value.truncated;
      return {
        path: boundedDetail(change?.path ?? "Unknown file", 4_000).text,
        kind: changeKind(change?.kind),
        diff: value.text,
      };
    });
    if (Array.isArray(item.changes) && item.changes.length > changes.length) truncated = true;
    return { type: "fileChange", status: String(item.status ?? "completed"), changes, truncated };
  }
  if (item.type === "mcpToolCall") {
    const argumentsValue = boundedJson(item.arguments);
    const resultValue = boundedJson(item.result);
    return {
      type: "mcpToolCall",
      server: safeSummary(item.server, 240),
      tool: safeSummary(item.tool, 240),
      arguments: argumentsValue.text,
      result: resultValue.text,
      error: boundedDetail(item.error?.message ?? "", 8_000).text,
      truncated: argumentsValue.truncated || resultValue.truncated,
      duration: durationLabel(item.durationMs),
    };
  }
  if (item.type === "dynamicToolCall") {
    const argumentsValue = boundedJson(item.arguments);
    const resultValue = boundedJson(item.contentItems);
    return {
      type: "dynamicToolCall",
      namespace: safeSummary(item.namespace, 240),
      tool: safeSummary(item.tool, 240),
      arguments: argumentsValue.text,
      result: resultValue.text,
      success: typeof item.success === "boolean" ? item.success : null,
      truncated: argumentsValue.truncated || resultValue.truncated,
      duration: durationLabel(item.durationMs),
    };
  }
  if (item.type === "webSearch") {
    const action = boundedJson(item.action, 24_000);
    const results = boundedJson(item.results, MAX_DETAIL_TEXT - action.text.length);
    return {
      type: "webSearch",
      query: boundedDetail(item.query ?? "", 8_000).text,
      action: action.text,
      results: results.text,
      truncated: action.truncated || results.truncated,
    };
  }
  if (item.type === "collabAgentToolCall") {
    const states = item.agentsStates && typeof item.agentsStates === "object"
      ? Object.values(item.agentsStates).map((agent: any) => ({ status: agent?.status ?? agent?.state ?? "unknown" }))
      : [];
    return {
      type: "collabAgentToolCall",
      tool: safeSummary(item.tool, 240),
      prompt: boundedDetail(item.prompt ?? "", 24_000).text,
      model: safeSummary(item.model, 240),
      reasoningEffort: safeSummary(item.reasoningEffort, 120),
      subagents: states,
    };
  }
  if (item.type === "imageView" || item.type === "imageGeneration") {
    return {
      type: item.type,
      name: String(item.path ?? item.savedPath ?? "").split(/[\\/]/).filter(Boolean).at(-1) || "Image",
      revisedPrompt: boundedDetail(item.revisedPrompt ?? "", 24_000).text,
      imageAvailable: Boolean(item.path || item.savedPath || item.result),
      failure: boundedJson(item.failure, 8_000).text,
    };
  }
  return null;
}

const IMAGE_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

function imageTypeForPath(path: string): string | null {
  return IMAGE_TYPES.get(extname(path).toLowerCase()) ?? null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function readRemoteImage(sshAlias: string, remotePath: string, windows: boolean): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const command = process.env.SSH_BIN || "ssh";
    const encodedPath = Buffer.from(remotePath, "utf8").toString("base64");
    const windowsScript = `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'));$b=[IO.File]::ReadAllBytes($p);[Console]::OpenStandardOutput().Write($b,0,$b.Length)`;
    const remoteCommand = windows
      ? `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(windowsScript, "utf16le").toString("base64")}`
      : `cat -- ${shellQuote(remotePath)}`;
    const child = spawn(command, ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", sshAlias, remoteCommand], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let length = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks));
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("Image unavailable"));
    }, 15_000);
    child.stdout.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > MAX_IMAGE_BYTES) {
        child.kill("SIGTERM");
        finish(new Error("Image unavailable"));
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", () => finish(new Error("Image unavailable")));
    child.once("exit", (code) => finish(code === 0 && length > 0 ? undefined : new Error("Image unavailable")));
  });
}

function normalizeInputQuestions(params: JsonObject): PocketInputQuestion[] | null {
  if (!Array.isArray(params.questions) || params.questions.length < 1 || params.questions.length > 3) return null;
  const ids = new Set<string>();
  const questions: PocketInputQuestion[] = [];
  for (const value of params.questions) {
    if (!value || typeof value !== "object") return null;
    const id = typeof value.id === "string" ? value.id : "";
    if (!id || ids.has(id) || typeof value.header !== "string" || typeof value.question !== "string") return null;
    ids.add(id);
    let options: PocketInputOption[] | null = null;
    if (value.options !== null && value.options !== undefined) {
      if (!Array.isArray(value.options) || value.options.length > 20) return null;
      options = [];
      for (const option of value.options) {
        if (!option || typeof option !== "object" || typeof option.label !== "string" || typeof option.description !== "string") return null;
        options.push({
          label: safeSummary(option.label, 240),
          description: safeSummary(option.description, 500),
        });
      }
      if (options.length === 0 && value.isOther !== true) return null;
    }
    questions.push({
      id,
      header: safeSummary(value.header, 160),
      question: safeSummary(value.question, 1_000),
      isOther: value.isOther === true,
      isSecret: value.isSecret === true,
      options,
    });
  }
  return questions;
}

class MachineRuntime {
  readonly state: PocketState;
  private rpc: RpcClient | null = null;
  private subscribers = new Set<ServerResponse>();
  private assistantFlushes = new Map<string, { delta: string; timer: NodeJS.Timeout }>();
  private canAcceptDirectInput = false;
  private loadedThreads: LoadedThreadSummary[] = [];
  private options: Options;
  private definition: MachineDefinition;
  private shuttingDown = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private selectionQueue: Promise<void> = Promise.resolve();
  private startingQueuedMessage = false;
  private permissionProfiles: PermissionProfileSummary[] = [];
  private allowedReviewers: string[] | null = null;
  private pendingServerRequests = new Map<string, PendingServerRequest>();
  private itemCache = new Map<string, { turnId: string; item: JsonObject }>();
  private itemTurns = new Map<string, string>();
  private settingsRevision = 0;
  private settingsWaiters = new Set<() => void>();
  private technicalConnectionError: string | null = null;
  private quota: RuntimeQuota | null = null;
  private quotaRefreshTimer: NodeJS.Timeout | null = null;
  private onQuotaChange: () => void;

  constructor(options: Options, definition: MachineDefinition, onQuotaChange: () => void) {
    this.options = options;
    this.definition = definition;
    this.onQuotaChange = onQuotaChange;
    this.state = {
      connected: false,
      connectionError: null,
      machineId: definition.id,
      machine: definition.name,
      transport: definition.ssh ? `SSH · ${definition.ssh}` : "Local",
      platform: "unknown",
      userAgent: "unknown",
      thread: null,
      model: "Not exposed",
      reasoningEffort: "Not exposed",
      models: [],
      access: emptyAccess(),
      queuedMessage: null,
      stoppingTurnId: null,
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

  async stop(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.quotaRefreshTimer) clearTimeout(this.quotaRefreshTimer);
    this.quotaRefreshTimer = null;
    for (const pending of this.assistantFlushes.values()) clearTimeout(pending.timer);
    this.assistantFlushes.clear();
    const rpc = this.rpc;
    const threadId = this.state.thread?.id;
    if (rpc && threadId && this.state.connected) {
      try {
        const result = await rpc.request("thread/unsubscribe", { threadId }, THREAD_UNSUBSCRIBE_TIMEOUT_MS);
        console.log(`${this.definition.name}: thread unsubscribe ${result?.status ?? "completed"}`);
      } catch (error) {
        console.warn(`${this.definition.name}: thread unsubscribe skipped: ${compact(error, 180)}`);
      }
    }
    if (this.rpc === rpc) this.rpc = null;
    rpc?.close();
    for (const response of this.subscribers) response.end();
    this.subscribers.clear();
  }

  addSubscriber(response: ServerResponse, sendSnapshot = true): void {
    this.subscribers.add(response);
    if (sendSnapshot) this.writeSse(response, "snapshot", this.snapshot());
  }

  removeSubscriber(response: ServerResponse): void {
    this.subscribers.delete(response);
  }

  snapshot(): JsonObject {
    const snapshot = JSON.parse(JSON.stringify(this.state));
    delete snapshot.metrics;
    snapshot.message = this.messageCapability();
    return snapshot;
  }

  diagnostics(): JsonObject {
    return JSON.parse(JSON.stringify({
      ...this.state.metrics,
      technicalConnectionError: this.technicalConnectionError,
      access: this.state.access,
      permissionProfiles: this.permissionProfiles,
    }));
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
    for (const turn of turns) {
      for (const activity of Array.isArray(turn.activities) ? turn.activities : []) {
        this.itemTurns.set(String(activity.id), String(turn.id));
      }
    }
    return { machineId: this.definition.id, threadId, turns, nextCursor: page?.nextCursor ?? null };
  }

  async activityDetail(threadIdValue: unknown, itemIdValue: unknown): Promise<JsonObject> {
    const { threadId, itemId, item } = await this.resolveActivityItem(threadIdValue, itemIdValue);
    const detail = activityDetailFromItem(item);
    if (!detail) throw new Error("No details are available for this activity");
    return { machineId: this.definition.id, threadId, itemId, detail };
  }

  async activityImage(threadIdValue: unknown, itemIdValue: unknown): Promise<{ mimeType: string; data: Buffer }> {
    const { item } = await this.resolveActivityItem(threadIdValue, itemIdValue);
    if (item.type !== "imageView" && item.type !== "imageGeneration") throw new Error("Image unavailable");
    if (item.type === "imageGeneration" && typeof item.result === "string" && item.result.length > 0) {
      if (item.result.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 16 || !/^[A-Za-z0-9+/=\r\n]+$/.test(item.result)) {
        throw new Error("Image unavailable");
      }
      const data = Buffer.from(item.result, "base64");
      if (data.length < 1 || data.length > MAX_IMAGE_BYTES) throw new Error("Image unavailable");
      return { mimeType: "image/png", data };
    }
    const surfacedPath = String(item.type === "imageView" ? item.path ?? "" : item.savedPath ?? "");
    const mimeType = imageTypeForPath(surfacedPath);
    if (!surfacedPath || !mimeType) throw new Error("Image unavailable");
    let data: Buffer;
    if (this.definition.ssh) {
      data = await readRemoteImage(this.definition.ssh, surfacedPath, /windows/i.test(this.state.platform));
    } else {
      const stat = statSync(surfacedPath);
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_IMAGE_BYTES) throw new Error("Image unavailable");
      data = readFileSync(surfacedPath);
    }
    if (data.length < 1 || data.length > MAX_IMAGE_BYTES) throw new Error("Image unavailable");
    return { mimeType, data };
  }

  async listLoadedThreads(): Promise<LoadedThreadSummary[]> {
    if (!this.rpc || !this.state.connected) return [];
    return JSON.parse(JSON.stringify(await this.refreshLoadedThreads()));
  }

  machineSummary(): JsonObject {
    return {
      id: this.definition.id,
      name: this.definition.name,
      ssh: this.definition.ssh,
      transport: this.state.transport,
      platform: this.state.platform,
      connected: this.state.connected,
      connectionError: this.state.connectionError,
      loadedTaskCount: this.loadedThreads.length,
      selectedThreadId: this.state.thread?.id ?? null,
    };
  }

  quotaSnapshot(): RuntimeQuota | null {
    return this.quota ? JSON.parse(JSON.stringify(this.quota)) : null;
  }

  selectThread(threadId: string): Promise<JsonObject> {
    const selection = this.selectionQueue.then(
      () => this.selectThreadNow(threadId),
      () => this.selectThreadNow(threadId),
    );
    this.selectionQueue = selection.then(() => {}, () => {});
    return selection;
  }

  sendMessage(text: unknown, action: unknown): Promise<JsonObject> {
    const operation = this.selectionQueue.then(
      () => this.sendMessageNow(text, action),
      () => this.sendMessageNow(text, action),
    );
    this.selectionQueue = operation.then(() => {}, () => {});
    return operation;
  }

  interruptTurn(expectedThreadId: unknown, expectedTurnId: unknown): Promise<JsonObject> {
    const operation = this.selectionQueue.then(
      () => this.interruptTurnNow(expectedThreadId, expectedTurnId),
      () => this.interruptTurnNow(expectedThreadId, expectedTurnId),
    );
    this.selectionQueue = operation.then(() => {}, () => {});
    return operation;
  }

  sendQueuedMessage(): Promise<JsonObject> {
    const operation = this.selectionQueue.then(
      () => this.sendQueuedMessageNow(),
      () => this.sendQueuedMessageNow(),
    );
    this.selectionQueue = operation.then(() => {}, () => {});
    return operation;
  }

  cancelQueuedMessage(): JsonObject {
    if (!this.state.queuedMessage) return { cancelled: false, queuedMessage: null };
    this.state.queuedMessage = null;
    this.broadcast("queue", { queuedMessage: null, message: this.messageCapability() });
    return { cancelled: true, queuedMessage: null };
  }

  updateThreadSettings(model: unknown, effort: unknown): Promise<JsonObject> {
    const operation = this.selectionQueue.then(
      () => this.updateThreadSettingsNow(model, effort),
      () => this.updateThreadSettingsNow(model, effort),
    );
    this.selectionQueue = operation.then(() => {}, () => {});
    return operation;
  }

  updateAccess(mode: unknown): Promise<JsonObject> {
    const operation = this.selectionQueue.then(
      () => this.updateAccessNow(mode),
      () => this.updateAccessNow(mode),
    );
    this.selectionQueue = operation.then(() => {}, () => {});
    return operation;
  }

  resolveApproval(requestId: unknown, decision: unknown): Promise<JsonObject> {
    const operation = this.selectionQueue.then(
      () => this.resolveApprovalNow(requestId, decision),
      () => this.resolveApprovalNow(requestId, decision),
    );
    this.selectionQueue = operation.then(() => {}, () => {});
    return operation;
  }

  resolveInput(requestId: unknown, answers: unknown): Promise<JsonObject> {
    const operation = this.selectionQueue.then(
      () => this.resolveInputNow(requestId, answers),
      () => this.resolveInputNow(requestId, answers),
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
    this.state.stoppingTurnId = null;
    this.state.connectionError = null;
    this.state.phase = "connecting";
    this.permissionProfiles = [];
    this.allowedReviewers = null;
    this.state.pending = [];
    this.pendingServerRequests.clear();
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
      await rpc.connect(this.definition.ssh ? undefined : this.options.ws, this.definition.ssh ?? undefined);
      const initialized = await rpc.request("initialize", {
        clientInfo: { name: "codex_pocket_gateway", title: "Codex Pocket Gateway", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      rpc.notify("initialized");
      this.state.userAgent = compact(initialized?.userAgent, 180) || "Codex app-server";
      this.state.platform = [initialized?.platformFamily, initialized?.platformOs].filter(Boolean).join(" / ") || "unknown";
      this.technicalConnectionError = null;
      await Promise.all([this.loadModels(), this.loadAccessConstraints()]);
      const loadedThreads = await this.refreshLoadedThreads();
      const active = loadedThreads.find((thread) => thread.status.startsWith("active"));
      const preferred = this.options.thread && loadedThreads.some((thread) => thread.id === this.options.thread)
        ? this.options.thread
        : undefined;
      const targetId = preferred ?? active?.id ?? loadedThreads[0]?.id;
      this.state.connected = true;
      this.state.connectionError = null;
      await this.refreshQuota();
      if (!targetId) {
        this.resetThreadState();
        this.state.thread = null;
        this.state.threadStatus = "idle";
        this.state.connectionError = null;
        this.state.phase = "done";
        this.broadcast("snapshot", this.snapshot());
        console.log(`${this.definition.name}: connected; no saved tasks`);
        return;
      }
      await this.attachLoadedThread(String(targetId), false);
      this.options.thread = String(targetId);
      this.state.connectionError = null;
      this.state.phase = this.computePhase();
      this.broadcast("snapshot", this.snapshot());
    } catch (error) {
      rpc.onClose = () => {};
      rpc.close();
      if (this.rpc === rpc) this.rpc = null;
      if (this.quota) this.quota.fresh = false;
      const technicalError = error instanceof Error ? error.message : String(error);
      this.technicalConnectionError = technicalError;
      this.state.connectionError = this.definition.ssh
        ? `Could not connect to ${this.definition.name}. Make sure “ssh ${this.definition.ssh}” works from this Mac.`
        : "Shared Codex runtime unavailable. Pocket will retry automatically.";
      this.loadedThreads = [];
      this.resetThreadState();
      this.state.thread = null;
      this.state.threadStatus = "disconnected";
      this.state.phase = "unavailable";
      this.onQuotaChange();
      this.broadcast("snapshot", this.snapshot());
      console.error(`${this.definition.name} attach failed: ${technicalError}`);
      this.scheduleReconnect();
    }
  }

  private handleClose(error?: Error): void {
    if (this.shuttingDown) return;
    this.rpc = null;
    if (this.quota) this.quota.fresh = false;
    this.state.connected = false;
    this.technicalConnectionError = error?.message ?? "app-server connection closed";
    this.state.connectionError = this.definition.ssh
      ? `Connection to ${this.definition.name} dropped. Pocket will retry automatically.`
      : "Shared Codex runtime unavailable. Pocket will retry automatically.";
    this.loadedThreads = [];
    this.resetThreadState();
    this.state.thread = null;
    this.state.threadStatus = "disconnected";
    this.state.phase = "unavailable";
    this.onQuotaChange();
    this.broadcast("snapshot", this.snapshot());
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((error) => console.error(error));
    }, 5_000);
  }

  private async refreshQuota(): Promise<void> {
    if (!this.rpc || !this.state.connected) return;
    try {
      const result = await this.rpc.request("account/rateLimits/read", undefined, 5_000);
      const normalized = normalizeRateLimits(result);
      if (!normalized) throw new Error("rate-limit response did not contain supported windows");
      this.quota = normalized;
      this.onQuotaChange();
    } catch (error) {
      if (this.quota) this.quota.fresh = false;
      console.warn(`${this.definition.name}: quota unavailable: ${compact(error, 180)}`);
      this.onQuotaChange();
    }
  }

  private scheduleQuotaRefresh(): void {
    if (this.shuttingDown || this.quotaRefreshTimer) return;
    this.quotaRefreshTimer = setTimeout(() => {
      this.quotaRefreshTimer = null;
      void this.refreshQuota();
    }, 150);
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
    const loadedIds = new Set<string>(Array.isArray(loaded?.data)
      ? loaded.data.map((value: any) => String(value?.id ?? value))
      : []);
    this.loadedThreads = threads
      .filter(isUserFacingThread)
      .map((thread: any) => loadedThreadSummary(thread, String(thread.id), loadedIds.has(String(thread.id))))
      .sort((left, right) => {
        const leftPriority = left.status.startsWith("active") ? 2 : left.loaded ? 1 : 0;
        const rightPriority = right.status.startsWith("active") ? 2 : right.loaded ? 1 : 0;
        return rightPriority - leftPriority || right.updatedAt - left.updatedAt;
      });
    return this.loadedThreads;
  }

  private async loadModels(): Promise<void> {
    if (!this.rpc) throw new Error("gateway is not connected to app-server");
    const models: PocketModel[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.rpc.request("model/list", { cursor, limit: 100, includeHidden: false });
      for (const value of Array.isArray(page?.data) ? page.data : []) {
        if (!value || value.hidden === true || !value.model) continue;
        models.push({
          id: String(value.id ?? value.model),
          model: String(value.model),
          displayName: compact(value.displayName ?? value.model, 120),
          description: compact(value.description, 240),
          supportedReasoningEfforts: Array.isArray(value.supportedReasoningEfforts)
            ? value.supportedReasoningEfforts.map((option: any) => ({
              reasoningEffort: String(option.reasoningEffort),
              description: compact(option.description, 180),
            }))
            : [],
          defaultReasoningEffort: String(value.defaultReasoningEffort ?? ""),
        });
      }
      cursor = page?.nextCursor ? String(page.nextCursor) : null;
    } while (cursor);
    this.state.models = models;
  }

  private async loadAccessConstraints(): Promise<void> {
    if (!this.rpc) throw new Error("gateway is not connected to app-server");
    try {
      const response = await this.rpc.request("configRequirements/read", {});
      const allowed = response?.requirements?.allowedApprovalsReviewers;
      this.allowedReviewers = Array.isArray(allowed) ? allowed.map(String) : null;
    } catch {
      this.allowedReviewers = null;
    }
  }

  private async loadPermissionProfiles(cwd: string): Promise<PermissionProfileSummary[]> {
    if (!this.rpc) throw new Error("gateway is not connected to app-server");
    const profiles: PermissionProfileSummary[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.rpc.request("permissionProfile/list", { cwd, cursor, limit: 100 });
      for (const value of Array.isArray(page?.data) ? page.data : []) {
        if (!value?.id) continue;
        profiles.push({
          id: String(value.id),
          description: safeSummary(value.description, 240) || null,
          allowed: value.allowed === true,
        });
      }
      cursor = page?.nextCursor ? String(page.nextCursor) : null;
    } while (cursor);
    this.permissionProfiles = profiles;
    return profiles;
  }

  private async selectThreadNow(threadId: string): Promise<JsonObject> {
    const requestedId = String(threadId ?? "").trim();
    if (!requestedId) throw new Error("threadId is required");
    const availableThreads = await this.refreshLoadedThreads();
    if (!availableThreads.some((thread) => thread.id === requestedId)) {
      throw new Error("selected task is not available in this Codex runtime");
    }
    if (this.state.thread?.id === requestedId) return this.snapshot();
    await this.attachLoadedThread(requestedId, true);
    this.options.thread = requestedId;
    return this.snapshot();
  }

  private async updateThreadSettingsNow(modelValue: unknown, effortValue: unknown): Promise<JsonObject> {
    if (!this.rpc || !this.state.thread) throw new Error("Codex is disconnected");
    const model = String(modelValue ?? "").trim();
    const effort = String(effortValue ?? "").trim();
    const catalogModel = this.state.models.find((candidate) => candidate.model === model);
    if (!catalogModel) throw new Error("selected model is not available from this app-server");
    if (!catalogModel.supportedReasoningEfforts.some((option) => option.reasoningEffort === effort)) {
      throw new Error("selected reasoning effort is not available for this model");
    }
    await this.rpc.request("thread/settings/update", { threadId: this.state.thread.id, model, effort });
    this.state.model = model;
    this.state.reasoningEffort = effort;
    const payload = {
      model,
      reasoningEffort: effort,
      appliesTo: this.state.turn?.status === "inProgress" ? "next_turn" : "current",
    };
    this.broadcast("settings", payload);
    return { updated: true, ...payload };
  }

  private updateAccessFromCodex(value: any): void {
    const active = value?.activePermissionProfile ?? null;
    const profileId = active?.id ? String(active.id) : null;
    const profileExtends = active?.extends ? String(active.extends) : null;
    const reviewer = value?.approvalsReviewer ? String(value.approvalsReviewer) : null;
    const fullProfile = this.permissionProfiles.find((profile) => profile.id === ":danger-full-access")
      ?? this.permissionProfiles.find((profile) => profile.id === ":full-access");
    const workspaceProfile = this.permissionProfiles.find((profile) => profile.id === ":workspace");
    const sandbox = value?.sandboxPolicy ?? value?.sandbox;
    const isFull = profileId === fullProfile?.id
      || profileExtends === fullProfile?.id
      || sandbox?.type === "dangerFullAccess";
    const currentRestricted = Boolean(profileId) && !isFull;
    const reviewerAllowed = (candidate: string) => !this.allowedReviewers || this.allowedReviewers.includes(candidate);
    const restrictedAvailable = currentRestricted || workspaceProfile?.allowed === true;
    const restrictedReason = restrictedAvailable ? null : "The normal workspace profile is unavailable on this machine or project";
    const askAvailable = restrictedAvailable && reviewerAllowed("user");
    const autoAvailable = restrictedAvailable && reviewerAllowed("auto_review");
    const profile = this.permissionProfiles.find((candidate) => candidate.id === profileId);
    this.state.access = {
      mode: isFull ? "full" : reviewer === "auto_review" ? "auto" : reviewer === "user" ? "ask" : "custom",
      profileId,
      reviewer,
      approvalPolicy: approvalPolicyText(value?.approvalPolicy),
      description: profile?.description ?? null,
      choices: {
        ask: {
          available: askAvailable,
          reason: askAvailable ? null : restrictedReason ?? "Manual approval review is constrained on this machine",
        },
        auto: {
          available: autoAvailable,
          reason: autoAvailable ? null : restrictedReason ?? "Automatic approval review is constrained on this machine",
        },
        full: {
          available: fullProfile?.allowed === true,
          reason: fullProfile?.allowed === true
            ? null
            : fullProfile ? "Full access is constrained on this machine or project" : "Full access is not available from this app-server",
        },
      },
    };
  }

  private waitForSettingsUpdate(revision: number): Promise<boolean> {
    if (this.settingsRevision !== revision) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (updated: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.settingsWaiters.delete(onUpdate);
        resolve(updated);
      };
      const onUpdate = () => finish(true);
      const timer = setTimeout(() => finish(false), ACCESS_SETTINGS_TIMEOUT_MS);
      this.settingsWaiters.add(onUpdate);
      if (this.settingsRevision !== revision) finish(true);
    });
  }

  private async updateAccessNow(value: unknown): Promise<JsonObject> {
    if (!this.rpc || !this.state.thread) throw new Error("Codex is disconnected");
    const mode = String(value ?? "");
    if (mode !== "ask" && mode !== "auto" && mode !== "full") throw new Error("unknown access mode");
    const choice = this.state.access.choices[mode];
    if (!choice.available) throw new Error(choice.reason ?? "That access mode is unavailable");
    const threadId = this.state.thread.id;
    const params: JsonObject = { threadId };
    if (mode === "full") {
      const fullProfile = this.permissionProfiles.find((profile) => profile.id === ":danger-full-access" && profile.allowed)
        ?? this.permissionProfiles.find((profile) => profile.id === ":full-access" && profile.allowed);
      if (!fullProfile) throw new Error("Full access is unavailable on this machine or project");
      params.permissions = fullProfile.id;
      params.approvalPolicy = "never";
    } else {
      params.approvalsReviewer = mode === "auto" ? "auto_review" : "user";
      params.approvalPolicy = "on-request";
      if (this.state.access.mode === "full") {
        const workspaceProfile = this.permissionProfiles.find((profile) => profile.id === ":workspace" && profile.allowed);
        if (!workspaceProfile) throw new Error("The normal workspace profile is unavailable on this machine or project");
        params.permissions = workspaceProfile.id;
      }
    }
    const revision = this.settingsRevision;
    await this.rpc.request("thread/settings/update", params);
    const confirmed = await this.waitForSettingsUpdate(revision);
    if (!confirmed) {
      if (this.state.thread?.id !== threadId || !this.rpc) throw new Error("selected task changed while access was updating");
      const resumed = await this.rpc.request("thread/resume", { threadId, excludeTurns: true });
      this.updateAccessFromCodex(resumed);
      this.broadcast("settings", {
        model: this.state.model,
        reasoningEffort: this.state.reasoningEffort,
        access: this.state.access,
        appliesTo: this.state.turn?.status === "inProgress" ? "next_turn" : "current",
      });
    }
    return {
      updated: true,
      access: this.state.access,
      appliesTo: this.state.turn?.status === "inProgress" ? "next_turn" : "current",
    };
  }

  private approvalResponse(pending: PendingServerRequest, decision: "approve" | "deny"): JsonObject | null {
    switch (pending.method) {
      case "item/commandExecution/requestApproval": {
        const mapped = decision === "approve" ? "accept" : "decline";
        return { decision: mapped };
      }
      case "item/fileChange/requestApproval":
        return { decision: decision === "approve" ? "accept" : "decline" };
      case "item/permissions/requestApproval": {
        if (decision === "deny") return { permissions: {}, scope: "turn" };
        const requested = pending.params.permissions;
        if (!requested || typeof requested !== "object") return null;
        const permissions: JsonObject = {};
        if (requested.network && typeof requested.network === "object") permissions.network = requested.network;
        if (requested.fileSystem && typeof requested.fileSystem === "object") permissions.fileSystem = requested.fileSystem;
        return { permissions, scope: "turn" };
      }
      case "execCommandApproval":
      case "applyPatchApproval":
        return {
          decision: decision === "approve"
            ? "approved"
            : { denied: { rejection: "Denied in Codex Pocket" } },
        };
      default:
        return null;
    }
  }

  private async resolveApprovalNow(requestIdValue: unknown, decisionValue: unknown): Promise<JsonObject> {
    if (!this.rpc || !this.state.thread) throw new Error("Codex is disconnected");
    if (this.state.stoppingTurnId) throw new Error("This turn is stopping");
    const requestId = String(requestIdValue ?? "");
    const decision = String(decisionValue ?? "");
    if (!requestId || (decision !== "approve" && decision !== "deny")) throw new Error("invalid approval response");
    const pending = this.pendingServerRequests.get(requestId);
    const visible = this.state.pending.find((request) => request.id === requestId);
    if (!pending || !visible || pending.threadId !== this.state.thread.id) throw new Error("This approval request is no longer pending");
    if (visible.resolving) throw new Error("This approval response is already being sent");
    const result = this.approvalResponse(pending, decision);
    if (!pending.supported || !result) throw new Error("This request must be handled in the local Codex client");
    visible.resolving = true;
    this.broadcast("request", { pending: this.state.pending, phase: this.state.phase, message: this.messageCapability() });
    this.rpc.respond(pending.rawId, result);
    return { accepted: true, requestId, decision };
  }

  private async resolveInputNow(requestIdValue: unknown, answersValue: unknown): Promise<JsonObject> {
    if (!this.rpc || !this.state.thread) throw new Error("Codex is disconnected");
    if (this.state.stoppingTurnId) throw new Error("This turn is stopping");
    const requestId = String(requestIdValue ?? "");
    if (!requestId || !Array.isArray(answersValue)) throw new Error("invalid structured input response");
    const pending = this.pendingServerRequests.get(requestId);
    const visible = this.state.pending.find((request) => request.id === requestId && request.kind === "input");
    if (!pending || !visible || pending.threadId !== this.state.thread.id) throw new Error("This input request is no longer pending");
    if (visible.resolving) throw new Error("This input response is already being sent");
    if (!pending.supported || pending.method !== "item/tool/requestUserInput" || !visible.supported) {
      throw new Error("This request must be handled in the local Codex client");
    }
    const questions = normalizeInputQuestions(pending.params);
    if (!questions) throw new Error("This structured input request is unsupported");
    if (answersValue.length !== questions.length) throw new Error("Answer every question before sending");

    const submissions = new Map<string, JsonObject>();
    for (const value of answersValue) {
      if (!value || typeof value !== "object") throw new Error("invalid structured input answer");
      const questionId = String(value.questionId ?? "");
      if (!questionId || submissions.has(questionId)) throw new Error("Each question must have exactly one answer");
      submissions.set(questionId, value);
    }

    const answers: JsonObject = {};
    for (const [questionIndex, question] of questions.entries()) {
      const submission = submissions.get(question.id);
      if (!submission) throw new Error("Answer every question before sending");
      let answer = "";
      if (question.options) {
        if (submission.type === "option") {
          const index = Number(submission.optionIndex);
          if (!Number.isInteger(index) || index < 0 || index >= question.options.length) {
            throw new Error(`Choose a valid option for ${question.header || "the question"}`);
          }
          answer = String(pending.params.questions[questionIndex].options[index].label);
        } else if (submission.type === "other" && question.isOther && typeof submission.value === "string") {
          answer = submission.value.replace(/\r\n/g, "\n");
        } else {
          throw new Error(`Choose a valid option for ${question.header || "the question"}`);
        }
      } else if (submission.type === "text" && typeof submission.value === "string") {
        answer = submission.value.replace(/\r\n/g, "\n");
      } else {
        throw new Error(`Enter a valid answer for ${question.header || "the question"}`);
      }
      if (!answer.trim()) throw new Error(`Answer ${question.header || "every question"} before sending`);
      if (answer.length > MAX_INPUT_ANSWER_LENGTH) {
        throw new Error(`An answer exceeds ${MAX_INPUT_ANSWER_LENGTH.toLocaleString()} characters`);
      }
      answers[question.id] = { answers: [answer] };
    }

    visible.resolving = true;
    this.broadcast("request", { pending: this.state.pending, phase: this.state.phase, message: this.messageCapability() });
    this.rpc.respond(pending.rawId, { answers });
    return { accepted: true, requestId };
  }

  private async sendMessageNow(value: unknown, requestedAction: unknown): Promise<JsonObject> {
    if (typeof value !== "string") throw new Error("message text is required");
    const text = value.replace(/\r\n/g, "\n");
    if (!text.trim()) throw new Error("message text is required");
    if (text.length > MAX_MESSAGE_LENGTH) throw new Error(`message exceeds ${MAX_MESSAGE_LENGTH.toLocaleString()} characters`);
    if (!this.rpc || !this.state.thread) throw new Error("Codex is disconnected");
    const capability = this.messageCapability();
    if (!capability.allowed || !capability.mode) throw new Error(capability.reason ?? "This task cannot accept a message right now");

    const threadId = this.state.thread.id;
    const input = [{ type: "text", text, text_elements: [] }];
    const action = String(requestedAction ?? capability.mode);
    if (action === "queue") {
      if (capability.mode !== "steer") throw new Error("Queue next is only available while a turn is active");
      this.state.queuedMessage = { threadId, text, createdAt: Date.now() };
      const payload = { queuedMessage: this.state.queuedMessage, message: this.messageCapability() };
      this.broadcast("queue", payload);
      return { accepted: true, mode: "queue", ...payload };
    }
    if (action === "steer") {
      if (capability.mode !== "steer") throw new Error("There is no active turn to steer");
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

    if (action !== "start" || capability.mode !== "start") throw new Error("This task is not idle");

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
      stoppingTurnId: this.state.stoppingTurnId,
      phase: this.state.phase,
      plan: this.state.plan,
      activities: this.state.activities,
      message,
    });
    return { accepted: true, mode: "start", turnId: this.state.turn.id, turn: this.state.turn, phase: this.state.phase, message };
  }

  private async interruptTurnNow(expectedThreadId: unknown, expectedTurnId: unknown): Promise<JsonObject> {
    if (!this.rpc || !this.state.thread) throw new Error("Codex is disconnected");
    if (String(expectedThreadId ?? "") !== this.state.thread.id) {
      throw new Error("The selected task changed before Stop was received");
    }
    const turn = this.state.turn;
    if (!turn || turn.status !== "inProgress" || !turn.id) throw new Error("There is no active turn to stop");
    if (String(expectedTurnId ?? "") !== turn.id) {
      throw new Error("The active turn changed before Stop was received");
    }
    if (this.state.stoppingTurnId) throw new Error("This turn is already stopping");
    const threadId = this.state.thread.id;
    const turnId = turn.id;
    this.state.stoppingTurnId = turnId;
    this.broadcast("control", { stoppingTurnId: turnId, message: this.messageCapability() });
    try {
      await this.rpc.request("turn/interrupt", { threadId, turnId });
      return { accepted: true };
    } catch (error) {
      if (this.state.stoppingTurnId === turnId) {
        this.state.stoppingTurnId = null;
        this.broadcast("control", { stoppingTurnId: null, message: this.messageCapability() });
      }
      throw error;
    }
  }

  private async sendQueuedMessageNow(): Promise<JsonObject> {
    if (!this.state.thread) throw new Error("Codex is disconnected");
    if (!this.state.queuedMessage) throw new Error("There is no queued message to send");
    if (this.state.turn?.status === "inProgress") throw new Error("Stop or finish the active turn first");
    const started = await this.startQueuedMessage(this.state.thread.id);
    if (!started) throw new Error(this.state.queuedMessage?.error ?? "Could not send the queued message");
    return { accepted: true, queuedMessage: null };
  }

  private async attachLoadedThread(threadId: string, broadcastReset: boolean): Promise<void> {
    if (!this.rpc) throw new Error("gateway is not connected to app-server");
    const summary = this.loadedThreads.find((thread) => thread.id === threadId);
    if (!summary) throw new Error("selected task is not available in this Codex runtime");
    const changed = this.state.thread?.id !== threadId;
    const previousThreadId = changed ? this.state.thread?.id : null;
    if (previousThreadId) {
      try {
        await this.rpc.request("thread/unsubscribe", { threadId: previousThreadId }, THREAD_UNSUBSCRIBE_TIMEOUT_MS);
      } catch (error) {
        console.warn(`${this.definition.name}: previous task unsubscribe skipped: ${compact(error, 180)}`);
      }
    }
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
    this.updateModel(resumed);
    try {
      await this.loadPermissionProfiles(this.state.thread.cwd);
      this.updateAccessFromCodex(resumed);
    } catch (error) {
      this.permissionProfiles = [];
      this.state.access = emptyAccess();
      this.state.access.description = compact(error instanceof Error ? error.message : String(error), 240);
    }
    if (this.canAcceptDirectInput && this.state.threadStatus.startsWith("active") && this.state.turn?.status !== "inProgress") {
      await this.loadActiveTurn();
    }
    this.state.phase = this.computePhase();
    if (broadcastReset) this.broadcast("snapshot", this.snapshot());
    console.log(`${this.definition.name}: attached to ${this.state.thread.id} (${this.state.thread.name})`);
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
    if (!this.state.thread) return;
    const requestThreadId = String(params.threadId ?? params.conversationId ?? "");
    if (requestThreadId && requestThreadId !== this.state.thread.id) return;
    let request: PocketRequest | null = null;
    let supported = false;
    if (method === "item/commandExecution/requestApproval") {
      supported = true;
      request = {
        id: String(message.id),
        kind: "permission",
        label: safeSummary(params.command ?? "Command execution", 240),
        reason: safeSummary(params.reason, 220) || undefined,
        scope: params.additionalPermissions ? permissionScopeSummary(params.additionalPermissions) : undefined,
        supported,
      };
    } else if (method === "item/fileChange/requestApproval") {
      supported = true;
      request = {
        id: String(message.id),
        kind: "permission",
        label: "File changes requested",
        reason: safeSummary(params.reason, 220) || undefined,
        scope: params.grantRoot ? "Additional write access" : undefined,
        supported,
      };
    } else if (method === "item/permissions/requestApproval") {
      supported = Boolean(params.permissions && typeof params.permissions === "object");
      request = {
        id: String(message.id),
        kind: "permission",
        label: "Additional permissions requested",
        reason: safeSummary(params.reason, 220) || undefined,
        scope: permissionScopeSummary(params.permissions),
        supported,
      };
    } else if (method === "execCommandApproval") {
      supported = true;
      request = {
        id: String(message.id),
        kind: "permission",
        label: safeSummary(params.command ?? "Command execution", 240),
        reason: safeSummary(params.reason, 220) || undefined,
        supported,
      };
    } else if (method === "applyPatchApproval") {
      supported = true;
      const count = params.fileChanges && typeof params.fileChanges === "object" ? Object.keys(params.fileChanges).length : 0;
      request = {
        id: String(message.id),
        kind: "permission",
        label: count ? `File changes to ${count} path${count === 1 ? "" : "s"}` : "File changes requested",
        reason: safeSummary(params.reason, 220) || undefined,
        supported,
      };
    } else if (method === "item/tool/requestUserInput") {
      const questions = normalizeInputQuestions(params);
      const isBlocking = typeof params.isBlocking === "boolean" ? params.isBlocking : null;
      const autoResolutionMs = params.autoResolutionMs === null || params.autoResolutionMs === undefined
        ? null
        : Number(params.autoResolutionMs);
      supported = Boolean(
        questions
        && isBlocking !== null
        && typeof params.turnId === "string"
        && params.turnId
        && typeof params.itemId === "string"
        && params.itemId
        && (autoResolutionMs === null || (Number.isSafeInteger(autoResolutionMs) && autoResolutionMs >= 0)),
      );
      const questionCount = Array.isArray(params.questions) ? params.questions.length : 0;
      request = {
        id: String(message.id),
        kind: "input",
        label: `${questionCount || 1} structured input request${questionCount === 1 ? "" : "s"}`,
        supported,
        blocking: isBlocking ?? true,
        autoResolutionMs,
        questions: questions ?? undefined,
      };
    } else if (method.includes("requestUserInput") || method.includes("requestInput")) {
      request = {
        id: String(message.id),
        kind: "input",
        label: "Unsupported structured input request",
        supported: false,
        blocking: true,
      };
    } else if (method.includes("Approval") || method.includes("requestApproval")) {
      request = {
        id: String(message.id),
        kind: "permission",
        label: "Unsupported approval request · handle in the local Codex client",
        supported: false,
      };
    }
    if (!request) return;
    if (request.kind === "permission" || request.kind === "input") {
      this.pendingServerRequests.set(request.id, {
        rawId: message.id,
        threadId: requestThreadId || this.state.thread.id,
        method,
        params,
        supported,
      });
    }
    this.state.pending = [...this.state.pending.filter((candidate) => candidate.id !== request!.id), request];
    this.state.phase = this.computePhase();
    this.broadcast("request", { pending: this.state.pending, phase: this.state.phase, message: this.messageCapability() });
  }

  private handleNotification(message: JsonObject): void {
    const method = String(message.method ?? "");
    const params = message.params ?? {};
    if (method === "account/rateLimits/updated") {
      this.scheduleQuotaRefresh();
      return;
    }
    if (params.threadId && String(params.threadId) !== this.state.thread?.id) return;
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
      case "thread/settings/updated":
        this.updateModel(params.threadSettings);
        this.updateAccessFromCodex(params.threadSettings);
        this.settingsRevision += 1;
        for (const resolve of [...this.settingsWaiters]) resolve();
        this.broadcast("settings", {
          model: this.state.model,
          reasoningEffort: this.state.reasoningEffort,
          access: this.state.access,
          appliesTo: this.state.turn?.status === "inProgress" ? "next_turn" : "current",
        });
        break;
      case "turn/started":
        this.updateModel(params.turn);
        this.state.stoppingTurnId = null;
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
        this.pendingServerRequests.clear();
        this.state.phase = "working";
        this.broadcast("turn", {
          turn: this.state.turn,
          stoppingTurnId: this.state.stoppingTurnId,
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
        this.pendingServerRequests.clear();
        this.state.stoppingTurnId = null;
        this.state.activities = this.state.activities.map((activity) => activity.status === "running"
          ? {
              ...activity,
              status: status === "interrupted" ? "interrupted" : status === "failed" ? "failed" : "completed",
              ...(status === "interrupted" ? { detail: "Stopped with turn" } : {}),
            }
          : activity);
        this.state.phase = error || status === "failed" ? "failed" : status === "interrupted" ? "stopped" : "done";
        this.flushAllAssistantDeltas();
        this.broadcast("turn", {
          turn: this.state.turn,
          stoppingTurnId: this.state.stoppingTurnId,
          phase: this.state.phase,
          activities: this.state.activities,
          message: this.messageCapability(),
        });
        if (status !== "interrupted"
          && !this.startingQueuedMessage
          && this.state.thread
          && this.state.queuedMessage?.threadId === this.state.thread.id) {
          const operation = this.selectionQueue.then(() => this.startQueuedMessage(this.state.thread!.id));
          this.selectionQueue = operation.then(() => {}, () => {});
        }
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
        this.pendingServerRequests.delete(String(params.requestId));
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

  private rememberItem(item: any, turnId: string): void {
    if (!item || typeof item !== "object" || item.id === undefined || item.id === null) return;
    const itemId = String(item.id);
    this.itemCache.delete(itemId);
    this.itemCache.set(itemId, { turnId, item });
    this.itemTurns.set(itemId, turnId);
    while (this.itemCache.size > MAX_DETAIL_ITEMS) {
      const oldest = this.itemCache.keys().next().value;
      if (oldest === undefined) break;
      this.itemCache.delete(oldest);
    }
  }

  private async resolveActivityItem(threadIdValue: unknown, itemIdValue: unknown): Promise<{ threadId: string; itemId: string; item: JsonObject }> {
    if (!this.rpc || !this.state.thread) throw new Error("Codex is disconnected");
    const threadId = String(threadIdValue ?? "");
    const itemId = String(itemIdValue ?? "");
    if (!threadId || threadId !== this.state.thread.id) throw new Error("The selected task changed; close this detail and try again");
    if (!itemId || itemId.length > 512) throw new Error("Invalid activity");
    const cached = this.itemCache.get(itemId);
    if (cached) return { threadId, itemId, item: cached.item };
    const knownTurnId = this.itemTurns.get(itemId);
    let cursor: string | null = null;
    for (let pageIndex = 0; pageIndex < DETAIL_ITEMS_MAX_PAGES; pageIndex += 1) {
      const page = await this.rpc.request("thread/items/list", {
        threadId,
        ...(knownTurnId ? { turnId: knownTurnId } : {}),
        cursor,
        limit: DETAIL_ITEMS_PAGE_LIMIT,
        sortDirection: "desc",
      });
      for (const entry of Array.isArray(page?.data) ? page.data : []) {
        const turnId = String(entry?.turnId ?? knownTurnId ?? "");
        this.rememberItem(entry?.item, turnId);
        if (String(entry?.item?.id ?? "") === itemId) return { threadId, itemId, item: entry.item };
      }
      cursor = page?.nextCursor ? String(page.nextCursor) : null;
      if (!cursor) break;
    }
    throw new Error("Activity details are unavailable");
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
    this.rememberItem(item, itemTurnId);
    const activity = activityFromItem(item, phase, itemTurnId);
    if (!activity) return;
    const index = this.state.activities.findIndex((candidate) => candidate.id === activity.id);
    if (index >= 0) this.state.activities[index] = { ...activity, createdAt: this.state.activities[index].createdAt };
    else this.state.activities.push(activity);
    this.state.activities = this.state.activities.slice(-MAX_ACTIVITIES);
    const stored = this.state.activities.find((candidate) => candidate.id === activity.id);
    if (stored) this.broadcast("activity", stored);
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
    this.pendingServerRequests.clear();
    this.itemCache.clear();
    this.itemTurns.clear();
    this.state.liveMessages = [];
    this.state.model = "Not exposed";
    this.state.reasoningEffort = "Not exposed";
    this.state.access = emptyAccess();
    this.state.queuedMessage = null;
    this.state.stoppingTurnId = null;
    this.startingQueuedMessage = false;
    this.canAcceptDirectInput = false;
  }

  private async startQueuedMessage(threadId: string): Promise<boolean> {
    if (this.startingQueuedMessage) return false;
    const queued = this.state.queuedMessage;
    if (!queued || queued.threadId !== threadId || this.state.thread?.id !== threadId || !this.rpc) return false;
    this.startingQueuedMessage = true;
    try {
      const input = [{ type: "text", text: queued.text, text_elements: [] }];
      const result = await this.rpc.request("turn/start", { threadId, input });
      if (this.state.thread?.id !== threadId || this.state.queuedMessage !== queued) return;
      this.state.queuedMessage = null;
      const turn = result?.turn ?? {};
      this.state.turn = {
        id: String(turn.id ?? this.state.turn?.id ?? ""),
        status: String(turn.status ?? "inProgress"),
        startedAt: numberTime(turn.createdAt ?? turn.startedAt),
        completedAt: null,
        error: null,
      };
      this.state.phase = "working";
      this.broadcast("queue", { queuedMessage: null, message: this.messageCapability() });
      this.broadcast("turn", {
        turn: this.state.turn,
        stoppingTurnId: this.state.stoppingTurnId,
        phase: this.state.phase,
        plan: this.state.plan,
        activities: this.state.activities,
        message: this.messageCapability(),
      });
      return true;
    } catch (error) {
      if (this.state.queuedMessage === queued) {
        this.state.queuedMessage = {
          ...queued,
          error: compact(error instanceof Error ? error.message : String(error), 240),
        };
        this.broadcast("queue", { queuedMessage: this.state.queuedMessage, message: this.messageCapability() });
      }
      return false;
    } finally {
      this.startingQueuedMessage = false;
    }
  }

  private upsertLiveMessage(message: PocketMessage): void {
    const index = this.state.liveMessages.findIndex((candidate) => candidate.id === message.id);
    if (index >= 0) this.state.liveMessages[index] = { ...message, createdAt: this.state.liveMessages[index].createdAt };
    else this.state.liveMessages.push(message);
    this.state.liveMessages = this.state.liveMessages.slice(-MAX_LIVE_MESSAGES);
  }

  private updateModel(value: any): void {
    if (!value || typeof value !== "object") return;
    const model = value.model ?? value.modelId ?? value.config?.model;
    const effort = value.reasoningEffort ?? value.reasoning_effort ?? value.effort ?? value.config?.reasoningEffort;
    if (model) this.state.model = String(model);
    if (effort) this.state.reasoningEffort = String(effort);
  }

  private computePhase(): PocketState["phase"] {
    if (this.state.connectionError && !this.state.connected) return "unavailable";
    if (this.state.pending.some((request) => request.kind === "permission")) return "waiting_permission";
    if (this.state.pending.some((request) => request.kind === "input" && request.blocking !== false)) return "waiting_input";
    if (this.state.turn?.error || this.state.turn?.status === "failed") return "failed";
    if (this.state.turn?.status === "interrupted") return "stopped";
    if (this.state.turn?.status === "inProgress" || this.state.threadStatus.startsWith("active")) return "working";
    return this.state.connected ? "done" : "connecting";
  }

  private messageCapability(): JsonObject {
    if (!this.state.connected || !this.rpc) return { allowed: false, mode: null, reason: "Codex is disconnected" };
    if (!this.state.thread) return { allowed: false, mode: null, reason: "No task is selected" };
    if (this.state.stoppingTurnId) return { allowed: false, mode: null, reason: "Stopping the active turn…" };
    if (this.state.pending.some((request) => request.kind === "permission")) {
      return { allowed: false, mode: null, reason: "Resolve the pending permission request in Codex first" };
    }
    if (this.state.pending.some((request) => request.kind === "input" && request.blocking !== false)) {
      return { allowed: false, mode: null, reason: "Answer the structured input request first" };
    }
    if (this.state.phase === "failed") return { allowed: false, mode: null, reason: "This task cannot accept a message while failed" };
    if (!this.canAcceptDirectInput) {
      return { allowed: false, mode: null, reason: "This task does not accept direct input" };
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

class PocketGateway {
  private runtimes = new Map<string, MachineRuntime>();
  private selectedMachineId = "local";
  private subscribers = new Set<ServerResponse>();
  private operationQueue: Promise<void> = Promise.resolve();
  private quota: PocketQuota = {
    available: false,
    stale: false,
    sourceMachineId: null,
    sourceMachine: null,
    limitName: null,
    windows: [],
    updatedAt: null,
  };
  private lastGoodQuota: PocketQuota | null = null;
  private warnedAccountMismatch = false;
  private warnedShapeMismatch = false;

  constructor(options: Options) {
    const definitions: MachineDefinition[] = [
      { id: "local", name: options.localName || localMachineName(), ssh: null },
      ...options.machines.map((machine) => ({ id: `ssh:${machine.ssh}`, name: machine.name, ssh: machine.ssh })),
    ];
    for (const definition of definitions) {
      const runtimeOptions: Options = {
        ...options,
        ws: definition.id === "local" ? options.ws : undefined,
        thread: definition.id === "local" ? options.thread : undefined,
      };
      this.runtimes.set(definition.id, new MachineRuntime(runtimeOptions, definition, () => this.refreshQuotaSource()));
    }
  }

  get state(): PocketState {
    return this.selected().state;
  }

  async start(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map((runtime) => runtime.start()));
  }

  async stop(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map((runtime) => runtime.stop()));
    this.subscribers.clear();
  }

  addSubscriber(response: ServerResponse): void {
    this.subscribers.add(response);
    this.selected().addSubscriber(response, false);
    this.writeSse(response, "snapshot", this.snapshot());
    response.on("close", () => {
      this.subscribers.delete(response);
      for (const runtime of this.runtimes.values()) runtime.removeSubscriber(response);
    });
  }

  snapshot(): JsonObject {
    return { ...this.selected().snapshot(), hostName: localMachineName(), quota: this.quota };
  }

  hostStatus(options: Options): JsonObject {
    return {
      running: true,
      hostName: localMachineName(),
      localUrl: browserUrl(options.host, options.port),
      phoneUrls: phoneUrlsFor(options.host, options.port),
      quota: this.quota,
    };
  }

  diagnostics(): JsonObject {
    return {
      selectedMachineId: this.selectedMachineId,
      machines: Object.fromEntries([...this.runtimes].map(([id, runtime]) => [id, runtime.diagnostics()])),
    };
  }

  listMachines(): JsonObject[] {
    return [...this.runtimes.values()].map((runtime) => ({
      ...runtime.machineSummary(),
      selected: runtime.state.machineId === this.selectedMachineId,
    }));
  }

  async navigationCatalog(): Promise<JsonObject> {
    const machines = await Promise.all([...this.runtimes.entries()].map(async ([id, runtime]) => {
      const summary = runtime.machineSummary();
      let tasks: LoadedThreadSummary[] = [];
      let catalogAvailable = false;
      if (summary.connected) {
        try {
          tasks = await runtime.listLoadedThreads();
          catalogAvailable = true;
        } catch {
          // The normal switcher stays concise; diagnostics/logs retain technical failures.
        }
      }
      return {
        id,
        name: summary.name,
        platform: summary.platform,
        local: id === "local",
        connected: Boolean(runtime.state.connected),
        catalogAvailable,
        selected: id === this.selectedMachineId,
        tasks: tasks.map((task) => {
          const attached = task.id === runtime.state.thread?.id;
          return {
            id: task.id,
            name: task.name,
            preview: task.preview,
            cwd: task.cwd,
            project: task.project,
            loaded: task.loaded,
            status: attached ? runtime.state.threadStatus : task.status,
            phase: attached ? runtime.state.phase : null,
            updatedAt: task.updatedAt,
            selected: id === this.selectedMachineId && task.id === runtime.state.thread?.id,
          };
        }),
      };
    }));
    return {
      selectedMachineId: this.selectedMachineId,
      selectedThreadId: this.state.thread?.id ?? null,
      machines,
    };
  }

  selectDestination(
    machineId: unknown,
    threadId: unknown,
    expectedMachineId: unknown,
    expectedThreadId: unknown,
  ): Promise<JsonObject> {
    return this.enqueue(async () => {
      const requestedMachineId = String(machineId ?? "").trim();
      const requestedThreadId = String(threadId ?? "").trim();
      const expectedMachine = String(expectedMachineId ?? "").trim();
      const expectedThread = String(expectedThreadId ?? "").trim();
      if (!requestedMachineId || !requestedThreadId) throw new Error("machineId and threadId are required");
      if (expectedMachine !== this.selectedMachineId || expectedThread !== String(this.state.thread?.id ?? "")) {
        throw new Error("selected task changed; refresh and try again");
      }
      const next = this.runtimes.get(requestedMachineId);
      if (!next) throw new Error("selected machine is not configured");
      if (!next.state.connected) throw new Error("selected machine is unavailable");

      await next.selectThread(requestedThreadId);
      if (requestedMachineId !== this.selectedMachineId) {
        const previous = this.selected();
        for (const response of this.subscribers) previous.removeSubscriber(response);
        this.selectedMachineId = requestedMachineId;
        for (const response of this.subscribers) next.addSubscriber(response, false);
        this.refreshQuotaSource();
        const snapshot = this.snapshot();
        for (const response of this.subscribers) this.writeSse(response, "snapshot", snapshot);
      }
      return this.snapshot();
    });
  }

  selectMachine(machineId: unknown): Promise<JsonObject> {
    return this.enqueue(async () => {
      const requestedId = String(machineId ?? "").trim();
      const next = this.runtimes.get(requestedId);
      if (!next) throw new Error("selected machine is not configured");
      if (requestedId === this.selectedMachineId) return this.snapshot();
      const previous = this.selected();
      for (const response of this.subscribers) previous.removeSubscriber(response);
      this.selectedMachineId = requestedId;
      for (const response of this.subscribers) next.addSubscriber(response, false);
      this.refreshQuotaSource();
      const snapshot = this.snapshot();
      for (const response of this.subscribers) this.writeSse(response, "snapshot", snapshot);
      return snapshot;
    });
  }

  async history(cursor: string | null, limit: number, machineId?: unknown): Promise<JsonObject> {
    return this.requireSelected(machineId).history(cursor, limit);
  }

  async activityDetail(machineId: unknown, threadId: unknown, itemId: unknown): Promise<JsonObject> {
    return this.requireSelected(machineId).activityDetail(threadId, itemId);
  }

  async activityImage(machineId: unknown, threadId: unknown, itemId: unknown): Promise<{ mimeType: string; data: Buffer }> {
    return this.requireSelected(machineId).activityImage(threadId, itemId);
  }

  async listLoadedThreads(machineId?: unknown): Promise<LoadedThreadSummary[]> {
    return this.requireSelected(machineId).listLoadedThreads();
  }

  selectThread(machineId: unknown, threadId: string): Promise<JsonObject> {
    return this.enqueue(() => this.requireSelected(machineId).selectThread(threadId));
  }

  sendMessage(machineId: unknown, text: unknown, action: unknown): Promise<JsonObject> {
    return this.enqueue(() => this.requireSelected(machineId).sendMessage(text, action));
  }

  interruptTurn(machineId: unknown, expectedThreadId: unknown, expectedTurnId: unknown): Promise<JsonObject> {
    return this.enqueue(() => this.requireSelected(machineId).interruptTurn(expectedThreadId, expectedTurnId));
  }

  sendQueuedMessage(machineId: unknown): Promise<JsonObject> {
    return this.enqueue(() => this.requireSelected(machineId).sendQueuedMessage());
  }

  cancelQueuedMessage(machineId: unknown): Promise<JsonObject> {
    return this.enqueue(async () => this.requireSelected(machineId).cancelQueuedMessage());
  }

  updateThreadSettings(machineId: unknown, model: unknown, effort: unknown): Promise<JsonObject> {
    return this.enqueue(() => this.requireSelected(machineId).updateThreadSettings(model, effort));
  }

  updateAccess(machineId: unknown, mode: unknown): Promise<JsonObject> {
    return this.enqueue(() => this.requireSelected(machineId).updateAccess(mode));
  }

  resolveApproval(machineId: unknown, requestId: unknown, decision: unknown): Promise<JsonObject> {
    return this.enqueue(() => this.requireSelected(machineId).resolveApproval(requestId, decision));
  }

  resolveInput(machineId: unknown, requestId: unknown, answers: unknown): Promise<JsonObject> {
    return this.enqueue(() => this.requireSelected(machineId).resolveInput(requestId, answers));
  }

  countBrowserPayload(payload: Buffer | string): void {
    this.selected().countBrowserPayload(payload);
  }

  private selected(): MachineRuntime {
    return this.runtimes.get(this.selectedMachineId)!;
  }

  private requireSelected(machineId: unknown): MachineRuntime {
    const requestedId = String(machineId ?? "").trim();
    if (!requestedId) throw new Error("machineId is required");
    if (requestedId !== this.selectedMachineId) throw new Error("selected machine changed; refresh and try again");
    return this.selected();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => {}, () => {});
    return result;
  }

  private refreshQuotaSource(): void {
    const connected = [...this.runtimes.entries()].filter(([, runtime]) => {
      const quota = runtime.quotaSnapshot();
      return runtime.state.connected && quota?.fresh;
    });
    const selected = connected.find(([id]) => id === this.selectedMachineId) ?? connected[0];
    const accountIds = new Set(connected.map(([, runtime]) => runtime.quotaSnapshot()?.accountId).filter(Boolean));
    if (accountIds.size > 1 && !this.warnedAccountMismatch) {
      this.warnedAccountMismatch = true;
      console.warn("Quota warning: connected runtimes report different accounts; using one source without aggregation.");
    }
    const shapes = new Set(connected.map(([, runtime]) => runtime.quotaSnapshot()?.windows.map((window) => window.windowDurationMins).join(",")));
    if (shapes.size > 1 && !this.warnedShapeMismatch) {
      this.warnedShapeMismatch = true;
      console.warn("Quota warning: connected runtimes report incompatible limit windows; using one source without aggregation.");
    }
    let next: PocketQuota;
    if (selected) {
      const [machineId, runtime] = selected;
      const value = runtime.quotaSnapshot()!;
      next = {
        available: true,
        stale: false,
        sourceMachineId: machineId,
        sourceMachine: runtime.state.machine,
        limitName: value.limitName,
        windows: value.windows,
        updatedAt: value.updatedAt,
      };
      this.lastGoodQuota = next;
    } else if (this.lastGoodQuota) {
      next = { ...this.lastGoodQuota, stale: true };
    } else {
      next = {
        available: false,
        stale: false,
        sourceMachineId: null,
        sourceMachine: null,
        limitName: null,
        windows: [],
        updatedAt: null,
      };
    }
    if (JSON.stringify(next) === JSON.stringify(this.quota)) return;
    this.quota = next;
    for (const response of this.subscribers) this.writeSse(response, "quota", this.quota);
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

function sendControlJson(response: ServerResponse, statusCode: number, value: unknown): void {
  const payload = Buffer.from(JSON.stringify(value));
  response.writeHead(statusCode, {
    ...securityHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": payload.length,
  });
  response.end(payload);
}

function sendImage(response: ServerResponse, value: { mimeType: string; data: Buffer }, gateway: PocketGateway): void {
  gateway.countBrowserPayload(value.data);
  response.writeHead(200, {
    ...securityHeaders(),
    "Content-Type": value.mimeType,
    "Cache-Control": "private, no-store",
    "Content-Length": value.data.length,
  });
  response.end(value.data);
}

function handleControlRequest(
  request: IncomingMessage,
  response: ServerResponse,
  gateway: PocketGateway,
  options: Options,
  stopPocket: () => void,
  quitPocket: () => void,
): void {
  if (!isLoopbackRequest(request)) {
    sendControlJson(response, 403, { error: "loopback access only" });
    return;
  }
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (method === "GET" && url.pathname === "/host-status") {
    sendControlJson(response, 200, gateway.hostStatus(options));
    return;
  }
  if (method === "POST" && url.pathname === "/shutdown") {
    try {
      quitPocket();
      sendControlJson(response, 202, { shuttingDown: true });
    } catch (error) {
      sendControlJson(response, 409, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (method === "POST" && url.pathname === "/stop") {
    try {
      stopPocket();
      sendControlJson(response, 202, { stopping: true });
    } catch (error) {
      sendControlJson(response, 409, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  sendControlJson(response, 404, { error: "not found" });
}

function staticPath(pathname: string): string | null {
  if (pathname === "/") return join(PUBLIC_DIR, "index.html");
  if (pathname === "/app.js") return join(PUBLIC_DIR, "app.js");
  if (pathname === "/styles.css") return join(PUBLIC_DIR, "styles.css");
  if (pathname === "/pocket-mark.svg") return join(PUBLIC_DIR, "pocket-mark.svg");
  if (pathname === "/vendor/markdown-it.min.js") return join(ROOT_DIR, "node_modules", "markdown-it", "dist", "markdown-it.min.js");
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
  settings: LocalSettings,
  options: Options,
  restartPocket: () => Promise<{ localUrl: string }>,
  quitPocket: () => void,
  isShuttingDown: () => boolean,
): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (method === "GET" && url.pathname === "/api/auth") {
    sendJson(response, 200, { required: auth.required, authenticated: isAuthenticated(request, auth) }, gateway);
    return;
  }
  if (method === "GET" && url.pathname === "/api/host-status") {
    if (!isLoopbackRequest(request)) {
      sendJson(response, 403, { error: "loopback access only" }, gateway);
      return;
    }
    sendJson(response, 200, gateway.hostStatus(options), gateway);
    return;
  }
  if (method === "POST" && url.pathname === "/api/login") {
    const client = loginClient(request);
    const retryAfter = auth.required ? loginRetryAfter(auth, client) : 0;
    if (retryAfter > 0) {
      sendJson(response, 429, { error: `Too many attempts. Try again in ${retryAfter} seconds.` }, gateway, {
        "Retry-After": String(retryAfter),
      });
      return;
    }
    const body = await readJsonBody(request);
    const accepted = !auth.required || (typeof body.pin === "string" && auth.pin !== null && secretMatches(body.pin, auth.pin));
    if (!accepted) {
      if (auth.required) recordLoginFailure(auth, client);
      sendJson(response, 401, { error: "Invalid PIN" }, gateway);
      return;
    }
    auth.attempts.delete(client);
    sendJson(response, 200, { authenticated: true }, gateway, {
      "Set-Cookie": `codex_pocket_session=${auth.sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
    });
    return;
  }
  const loopbackHostShutdown = url.pathname === "/api/shutdown" && method === "POST" && isLoopbackRequest(request);
  if ((url.pathname.startsWith("/api/") || url.pathname === "/events")
    && !loopbackHostShutdown
    && !isAuthenticated(request, auth)) {
    sendJson(response, 401, { error: "Authentication required" }, gateway);
    return;
  }
  if (url.pathname === "/api/shutdown" && method === "POST") {
    try {
      quitPocket();
      sendJson(response, 202, { shuttingDown: true }, gateway);
    } catch (error) {
      sendJson(response, 409, { error: error instanceof Error ? error.message : String(error) }, gateway);
    }
    return;
  }
  if (isShuttingDown() && (url.pathname.startsWith("/api/") || url.pathname === "/events")) {
    sendJson(response, 503, { error: "Codex Pocket is stopping" }, gateway);
    return;
  }
  if (url.pathname === "/api/activity/detail" && method === "GET") {
    try {
      sendJson(response, 200, await gateway.activityDetail(
        url.searchParams.get("machineId"),
        url.searchParams.get("threadId"),
        url.searchParams.get("itemId"),
      ), gateway);
    } catch (error) {
      sendJson(response, 409, { error: error instanceof Error ? error.message : String(error) }, gateway);
    }
    return;
  }
  if (url.pathname === "/api/activity/image" && method === "GET") {
    try {
      sendImage(response, await gateway.activityImage(
        url.searchParams.get("machineId"),
        url.searchParams.get("threadId"),
        url.searchParams.get("itemId"),
      ), gateway);
    } catch {
      sendJson(response, 404, { error: "Image unavailable" }, gateway);
    }
    return;
  }
  if (url.pathname === "/api/settings" && method === "GET") {
    sendJson(response, 200, {
      settings: publicSettings(settings, auth.pin),
      effective: { host: options.host, port: options.port, pinRequired: auth.required },
      restartRequired: settingsNeedRestart(settings, options, auth),
    }, gateway);
    return;
  }
  if (url.pathname === "/api/settings" && method === "POST") {
    try {
      const config = saveLocalSettings(settings, await readJsonBody(request), auth.pin);
      sendJson(response, 200, {
        saved: true,
        restartRequired: true,
        settings: publicSettings(settings, config.pin),
      }, gateway);
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) }, gateway);
    }
    return;
  }
  if (url.pathname === "/api/restart" && method === "POST") {
    try {
      const result = await restartPocket();
      sendJson(response, 202, {
        restarting: true,
        localUrl: restartUrlForRequest(request, settings.config, result.localUrl),
      }, gateway);
    } catch (error) {
      sendJson(response, 409, { error: error instanceof Error ? error.message : String(error) }, gateway);
    }
    return;
  }
  if (method === "POST" && url.pathname === "/api/message") {
    try {
      const body = await readJsonBody(request);
      sendJson(response, 202, await gateway.sendMessage(body.machineId, body.text, body.action), gateway);
    } catch (error) {
      sendJson(response, 409, { error: error instanceof Error ? error.message : String(error) }, gateway);
    }
    return;
  }
  if (method === "POST" && url.pathname === "/api/turn/interrupt") {
    try {
      const body = await readJsonBody(request);
      sendJson(response, 202, await gateway.interruptTurn(
        body.machineId,
        body.expectedThreadId,
        body.expectedTurnId,
      ), gateway);
    } catch (error) {
      sendJson(response, 409, { error: error instanceof Error ? error.message : String(error) }, gateway);
    }
    return;
  }
  if (method === "POST" && url.pathname === "/api/message/queue") {
    try {
      const body = await readJsonBody(request);
      sendJson(response, 202, await gateway.sendQueuedMessage(body.machineId), gateway);
    } catch (error) {
      sendJson(response, 409, { error: error instanceof Error ? error.message : String(error) }, gateway);
    }
    return;
  }
  if (method === "DELETE" && url.pathname === "/api/message/queue") {
    try {
      sendJson(response, 200, await gateway.cancelQueuedMessage(url.searchParams.get("machineId")), gateway);
    } catch (error) {
      sendJson(response, 409, { error: error instanceof Error ? error.message : String(error) }, gateway);
    }
    return;
  }
  if (method === "POST" && url.pathname === "/api/thread/settings") {
    try {
      const body = await readJsonBody(request);
      sendJson(response, 200, await gateway.updateThreadSettings(body.machineId, body.model, body.effort), gateway);
    } catch (error) {
      sendJson(response, 409, { error: error instanceof Error ? error.message : String(error) }, gateway);
    }
    return;
  }
  if (method === "POST" && url.pathname === "/api/thread/access") {
    try {
      const body = await readJsonBody(request);
      sendJson(response, 200, await gateway.updateAccess(body.machineId, body.mode), gateway);
    } catch (error) {
      sendJson(response, 409, { error: error instanceof Error ? error.message : String(error) }, gateway);
    }
    return;
  }
  if (method === "POST" && url.pathname === "/api/approval") {
    try {
      const body = await readJsonBody(request);
      sendJson(response, 202, await gateway.resolveApproval(body.machineId, body.requestId, body.decision), gateway);
    } catch (error) {
      sendJson(response, 409, { error: error instanceof Error ? error.message : String(error) }, gateway);
    }
    return;
  }
  if (method === "POST" && url.pathname === "/api/input") {
    try {
      const body = await readJsonBody(request);
      sendJson(response, 202, await gateway.resolveInput(body.machineId, body.requestId, body.answers), gateway);
    } catch (error) {
      sendJson(response, 409, { error: error instanceof Error ? error.message : String(error) }, gateway);
    }
    return;
  }
  if (method === "POST" && url.pathname === "/api/thread") {
    try {
      const body = await readJsonBody(request);
      sendJson(response, 200, await gateway.selectThread(body.machineId, String(body.threadId ?? "")), gateway);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes("not currently loaded") || message.includes("required") || message.includes("selected machine") ? 409 : 400;
      sendJson(response, status, { error: message }, gateway);
    }
    return;
  }
  if (method === "POST" && url.pathname === "/api/navigation/select") {
    try {
      const body = await readJsonBody(request);
      sendJson(response, 200, await gateway.selectDestination(
        body.machineId,
        body.threadId,
        body.expectedMachineId,
        body.expectedThreadId,
      ), gateway);
    } catch (error) {
      sendJson(response, 409, { error: error instanceof Error ? error.message : String(error) }, gateway);
    }
    return;
  }
  if (method === "POST" && url.pathname === "/api/machine") {
    try {
      const body = await readJsonBody(request);
      sendJson(response, 200, await gateway.selectMachine(body.machineId), gateway);
    } catch (error) {
      sendJson(response, 409, { error: error instanceof Error ? error.message : String(error) }, gateway);
    }
    return;
  }
  if (method !== "GET" && method !== "HEAD") {
    sendJson(response, 405, { error: "unsupported method" }, gateway);
    return;
  }
  if (url.pathname === "/healthz") {
    sendJson(response, 200, { ok: true, selectedConnected: gateway.state.connected }, gateway);
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
      sendJson(response, 200, { threads: await gateway.listLoadedThreads(url.searchParams.get("machineId")) }, gateway);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, message.includes("selected machine") ? 409 : 503, { error: message }, gateway);
    }
    return;
  }
  if (url.pathname === "/api/machines") {
    sendJson(response, 200, { machines: gateway.listMachines() }, gateway);
    return;
  }
  if (url.pathname === "/api/navigation") {
    sendJson(response, 200, await gateway.navigationCatalog(), gateway);
    return;
  }
  if (url.pathname === "/api/history") {
    const cursor = url.searchParams.get("cursor");
    const rawLimit = Number(url.searchParams.get("limit") ?? 6);
    const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 20) : 6;
    try {
      sendJson(response, 200, await gateway.history(cursor, limit, url.searchParams.get("machineId")), gateway);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, message.includes("selected machine") ? 409 : 503, { error: message }, gateway);
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
  const settings = loadLocalSettings();
  const options = parseArgs(process.argv.slice(2), {
    host: settings.config.lanEnabled ? settings.config.host : SAFE_CONFIG.host,
    port: settings.config.port,
    localName: settings.config.localName,
    machines: settings.config.machines,
  });
  const authRequired = !isLoopbackHost(options.host);
  const pin = Object.prototype.hasOwnProperty.call(process.env, "CODEX_POCKET_PIN")
    ? process.env.CODEX_POCKET_PIN ?? ""
    : settings.config.pin ?? "";
  if (authRequired && !/^\d{4}$/.test(pin)) {
    throw new Error("LAN listening requires a valid four-digit PIN in Settings or CODEX_POCKET_PIN");
  }
  const auth: AuthConfig = {
    required: authRequired,
    pin: /^\d{4}$/.test(pin) ? pin : null,
    sessionId: randomBytes(32).toString("hex"),
    attempts: new Map(),
  };
  for (const required of ["index.html", "styles.css", "app.js", "pocket-mark.svg"]) {
    readFileSync(join(PUBLIC_DIR, required));
  }
  readFileSync(join(ROOT_DIR, "node_modules", "markdown-it", "dist", "markdown-it.min.js"));
  const gateway = new PocketGateway(options);
  let restartPocket: () => Promise<{ localUrl: string }>;
  let stopPocket: () => void;
  let quitPocket: () => void;
  let shuttingDown = false;
  const server = createServer((request, response) => {
    handleRequest(
      request,
      response,
      gateway,
      auth,
      settings,
      options,
      () => restartPocket(),
      () => quitPocket(),
      () => shuttingDown,
    ).catch((error) => {
      if (!response.headersSent) sendJson(response, 500, { error: compact(error, 400) }, gateway);
      else response.end();
    });
  });
  const controlServer = createServer((request, response) => {
    handleControlRequest(request, response, gateway, options, () => stopPocket(), () => quitPocket());
  });
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    const forceExit = setTimeout(() => process.exit(0), 2_000);
    forceExit.unref();
    shutdownPromise = (async () => {
      await gateway.stop();
      clearRuntimeInfo();
      await Promise.all([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) => controlServer.close(() => resolve())),
      ]);
      clearTimeout(forceExit);
      process.exit(0);
    })();
    return shutdownPromise;
  };
  restartPocket = async () => {
    if (shuttingDown) throw new Error("Pocket is already restarting");
    await validateRestartTarget(settings.config, options);
    await startRestartHandoff();
    const localUrl = browserUrl(
      settings.config.lanEnabled ? settings.config.host : SAFE_CONFIG.host,
      settings.config.port,
    );
    shuttingDown = true;
    setTimeout(() => void shutdown(), 350).unref();
    return { localUrl };
  };
  stopPocket = () => {
    if (shuttingDown) throw new Error("Pocket is already stopping");
    shuttingDown = true;
    setTimeout(() => void shutdown(), 75).unref();
  };
  quitPocket = () => {
    if (shuttingDown) throw new Error("Pocket is already stopping");
    markHostQuit();
    shuttingDown = true;
    setTimeout(() => void shutdown(), 75).unref();
  };
  await new Promise<void>((resolve, reject) => {
    controlServer.once("error", reject);
    controlServer.listen(0, "127.0.0.1", () => resolve());
  });
  const controlAddress = controlServer.address();
  if (!controlAddress || typeof controlAddress === "string") throw new Error("could not create local control endpoint");
  const controlUrl = `http://127.0.0.1:${controlAddress.port}`;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.host, () => resolve());
    });
  } catch (error) {
    await new Promise<void>((resolve) => controlServer.close(() => resolve()));
    throw error;
  }
  try {
    writeRuntimeInfo(options, controlUrl);
  } catch (error) {
    console.warn(`Warning: could not write runtime metadata: ${compact(error, 240)}`);
  }
  {
    const displayHost = options.host.includes(":") ? `[${options.host}]` : options.host;
    console.log(`Codex Pocket: http://${displayHost}:${options.port}`);
    console.log(`Native control: ${controlUrl}`);
    console.log(`Network: ${authRequired ? "LAN access enabled" : "localhost only"}; PIN protection ${authRequired ? "enabled" : "disabled"}`);
    if (settings.loaded) console.log(`Config: ${settings.path}`);
    if (authRequired) {
      console.warn("Warning: LAN control uses plain HTTP; use it only on a trusted network.");
    }
  }
  process.once("exit", clearRuntimeInfo);
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  await gateway.start();
}

main().catch((error) => {
  console.error(`gateway failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
