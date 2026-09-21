import { fork, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { lstatSync, readFileSync } from "node:fs";

export const DEEPSEEK_MODEL = "deepseek-flash";
export const DEEPSEEK_HOME = join(homedir(), ".codex-pocket", "deepseek");
// Host-owned credential file used when DEEPSEEK_API_KEY is not supplied explicitly.
export const DEEPSEEK_KEY_DIR = join(homedir(), ".codex-pocket", "secrets");
export const DEEPSEEK_KEY_PATH = join(DEEPSEEK_KEY_DIR, "deepseek-api-key");
export const DEEPSEEK_KEY_HINT = `Create ${DEEPSEEK_KEY_PATH} with directory permissions 700 and file permissions 600.`;
export const DEEPSEEK_PROVIDER = {
  name: "DeepSeek", base_url: "https://api.deepseek.com", wire_api: "responses",
  env_key: "DEEPSEEK_API_KEY", requires_openai_auth: false, supports_websockets: false, supports_standalone_web_search: false,
};
// Official account-wide balance endpoint; queried from the host with the resolved credential only.
export const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
export const DEEPSEEK_BALANCE_TIMEOUT_MS = 5_000;
export const DEEPSEEK_BALANCE_REFRESH_MS = 60_000;
// Only sanitized balance fields ever leave the host: currency codes, amounts, availability and freshness.
export type DeepSeekBalanceEntry = { currency: string; total: string };
export type DeepSeekBalance = {
  available: boolean;
  stale: boolean;
  isAvailable: boolean | null;
  entries: DeepSeekBalanceEntry[];
  updatedAt: number | null;
};
export const EMPTY_DEEPSEEK_BALANCE: DeepSeekBalance = { available: false, stale: false, isAvailable: null, entries: [], updatedAt: null };
// Names and patterns every DeepSeek child strips from its environment.
export const DEEPSEEK_SHELL_ENV_EXCLUDE = ["DEEPSEEK_API_KEY", "OPENAI_*", "CODEX_*TOKEN*"];

export function normalizeDeepseekKey(value: unknown, source: string): string {
  if (typeof value !== "string") throw new Error(`DeepSeek API key from ${source} must be text`);
  if (/[\r\n\0]/.test(value)) throw new Error(`DeepSeek API key from ${source} must be a single line without control characters`);
  const key = value.trim();
  if (!key) throw new Error(`DeepSeek API key from ${source} is empty`);
  return key;
}

export function readDeepseekKeyFile(path = DEEPSEEK_KEY_PATH): string {
  let stats;
  try { stats = lstatSync(path); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new Error(`DeepSeek is enabled but no API key file exists at ${path}, and DEEPSEEK_API_KEY is not set. ${DEEPSEEK_KEY_HINT}`);
    }
    throw new Error(`DeepSeek API key file could not be inspected (${code ?? "unknown error"}): ${path}`);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(`DeepSeek API key path must be a regular file, not a link or directory: ${path}`);
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) throw new Error(`DeepSeek API key file must be owned by the current user: ${path}`);
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) throw new Error(`DeepSeek API key file must not be accessible by other users; run chmod 600 ${path}`);
  if (stats.size > 4096) throw new Error(`DeepSeek API key file is unexpectedly large: ${path}`);
  let content: string;
  try { content = readFileSync(path, "utf8"); }
  catch { throw new Error(`DeepSeek API key file could not be read: ${path}`); }
  // One key with an optional single trailing newline; anything else is a configuration mistake.
  return normalizeDeepseekKey(content.replace(/\r?\n$/, ""), `file ${path}`);
}

// Credential source classification: a resolved key, a configuration error, or nothing at all.
// An explicitly supplied environment key always wins; an invalid value is reported instead of
// silently switching sources, while a simply absent credential is not an error.
export function deepseekCredentialStatus(env = process.env, path = DEEPSEEK_KEY_PATH): { key?: string; error?: string } {
  if (Object.prototype.hasOwnProperty.call(env, "DEEPSEEK_API_KEY")) {
    try { return { key: normalizeDeepseekKey(env.DEEPSEEK_API_KEY, "the DEEPSEEK_API_KEY environment variable") }; }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  }
  try { lstatSync(path); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return {};
    return { error: `DeepSeek API key file could not be inspected (${code ?? "unknown error"}): ${path}` };
  }
  try { return { key: readDeepseekKeyFile(path) }; }
  catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}

// Also used for ordinary children: opting in must not give the OpenAI/SSH runtime this key.
export function withoutDeepseekKey(env = process.env): NodeJS.ProcessEnv {
  const clean = { ...env };
  delete clean.DEEPSEEK_API_KEY;
  return clean;
}

export function deepseekEnvironment(env = process.env, home = DEEPSEEK_HOME, supplied?: string): NodeJS.ProcessEnv {
  const key = supplied ? normalizeDeepseekKey(supplied, "the resolved DeepSeek credential") : env.DEEPSEEK_API_KEY?.trim();
  if (!key) throw new Error(`DeepSeek needs DEEPSEEK_API_KEY in the host environment, or a host key file. ${DEEPSEEK_KEY_HINT} See docs/deepseek.md.`);
  if (/[\r\n\0]/.test(key)) throw new Error("DEEPSEEK_API_KEY must contain a single API key, without embedded newlines");
  const clean = withoutDeepseekKey(env);
  for (const name of Object.keys(clean)) {
    if (/^(OPENAI_|CODEX_|CHATGPT_)/i.test(name)) delete clean[name];
  }
  return { ...clean, CODEX_HOME: home, DEEPSEEK_API_KEY: key };
}

export function deepseekConfig(home = DEEPSEEK_HOME): Record<string, any> {
  return {
    model: DEEPSEEK_MODEL, model_provider: "deepseek", model_catalog_json: join(home, "models.json"),
    model_reasoning_effort: "high", web_search: "disabled", review_model: DEEPSEEK_MODEL,
    sqlite_home: home, log_dir: join(home, "logs"), allow_login_shell: false,
    "model_providers.deepseek": DEEPSEEK_PROVIDER,
    "shell_environment_policy.exclude": [...DEEPSEEK_SHELL_ENV_EXCLUDE],
    "features.multi_agent": false, "features.remote_control": false,
  };
}

function toml(value: any): string {
  if (Array.isArray(value)) return `[${value.map(toml).join(", ")}]`;
  if (value && typeof value === "object") return `{ ${Object.entries(value).map(([k, v]) => `${k} = ${toml(v)}`).join(", ")} }`;
  return JSON.stringify(value);
}

export function deepseekArgs(home = DEEPSEEK_HOME): string[] {
  return Object.entries(deepseekConfig(home)).flatMap(([key, value]) => ["-c", `${key}=${toml(value)}`]);
}

function matchesExcludedName(pattern: string, name: string): boolean {
  const source = pattern.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${source}$`, "i").test(name);
}

// shell_environment_policy.set runs after exclude, so an entry there can reintroduce a stripped name.
function reintroducesCredential(set: unknown): boolean {
  const names = Array.isArray(set) ? set : set && typeof set === "object" ? Object.keys(set) : [];
  return names.some(name => DEEPSEEK_SHELL_ENV_EXCLUDE.some(pattern => matchesExcludedName(pattern, String(name))));
}

export function assertDeepseekConfig(config: any, home = DEEPSEEK_HOME): void {
  const provider = config?.model_providers?.deepseek;
  if (config?.model_provider !== "deepseek" || config?.model !== DEEPSEEK_MODEL
    || config?.model_catalog_json !== join(home, "models.json")
    || !provider || Object.keys(provider).some(k => !(k in DEEPSEEK_PROVIDER) && provider[k] != null)
    || Object.entries(DEEPSEEK_PROVIDER).some(([k, v]) => provider[k] !== v)
    || config?.web_search !== "disabled"
    || config?.sqlite_home !== home || config?.log_dir !== join(home, "logs")
    || config?.allow_login_shell !== false
    || Object.keys(config?.mcp_servers ?? {}).length > 0 || config?.notify?.length > 0 || config?.hooks
    || config?.experimental_thread_store || config?.experimental_thread_store_endpoint
    || !config?.shell_environment_policy?.exclude?.includes("DEEPSEEK_API_KEY")
    || reintroducesCredential(config?.shell_environment_policy?.set)) {
    throw new Error("DeepSeek isolation check failed: effective project configuration must use Pocket's DeepSeek provider, model catalog, endpoint and shell credential exclusion.");
  }
}

export function constrainDeepseekRequest(method: string, params: Record<string, any>, home = DEEPSEEK_HOME): Record<string, any> {
  if (params.model && params.model !== DEEPSEEK_MODEL) throw new Error("This runtime only supports deepseek-flash");
  if (params.effort && !["low", "high", "max"].includes(params.effort)) throw new Error("DeepSeek supports low, high or max effort");
  if (params.approvalsReviewer === "auto_review") throw new Error("Automatic approval review is unavailable for DeepSeek; use Ask or Full access");
  if (["thread/start", "thread/resume"].includes(method)) {
    const config = deepseekConfig(home);
    // Resume keeps the task's chosen effort; high is only the initial default.
    if (method === "thread/resume") delete config.model_reasoning_effort;
    return { ...params, model: DEEPSEEK_MODEL, modelProvider: "deepseek", config, approvalsReviewer: "user", serviceTier: null };
  }
  if (method === "command/exec") return { ...params, env: { ...params.env, DEEPSEEK_API_KEY: null, OPENAI_API_KEY: null } };
  return params;
}

// Reduce the account balance payload to currency/amount pairs plus availability. Anything the contract
// does not pin down (multiple currencies, non-numeric amounts, missing fields) is dropped rather than guessed.
export function sanitizeDeepseekBalance(payload: unknown, now = Date.now()): DeepSeekBalance | null {
  const data = payload as { is_available?: unknown; balance_infos?: unknown } | null | undefined;
  if (!data || typeof data !== "object" || !Array.isArray(data.balance_infos)) return null;
  const entries: DeepSeekBalanceEntry[] = [];
  for (const info of data.balance_infos) {
    if (!info || typeof info !== "object") continue;
    const currency = typeof (info as any).currency === "string" ? (info as any).currency.trim().toUpperCase() : "";
    const raw = (info as any).total_balance;
    const total = typeof raw === "string" ? raw.trim() : typeof raw === "number" && Number.isFinite(raw) ? String(raw) : "";
    if (!/^[A-Z]{2,8}$/.test(currency) || !/^-?\d+(?:\.\d+)?$/.test(total)) continue;
    entries.push({ currency, total });
  }
  if (!entries.length) return null;
  return {
    available: true,
    stale: false,
    isAvailable: typeof data.is_available === "boolean" ? data.is_available : null,
    entries,
    updatedAt: now,
  };
}

// One host-wide cache with one shared in-flight request, so several browser clients and the refresh
// timer never multiply upstream calls. A failure keeps the last-known value marked stale, never zero.
export class DeepSeekBalanceMonitor {
  private key: string;
  private cache: DeepSeekBalance | null = null;
  private inflight: Promise<DeepSeekBalance | null> | null = null;
  private controller: AbortController | null = null;
  // Attempt time, tracked separately from the successful updatedAt, so failed refreshes cool down too.
  private lastAttemptAt: number | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly minIntervalMs: number;
  constructor(
    credentials: { key?: string; error?: string } = {},
    options: { fetchImpl?: typeof fetch; now?: () => number; timeoutMs?: number; minIntervalMs?: number } = {},
  ) {
    this.key = typeof credentials.key === "string" ? credentials.key : "";
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? DEEPSEEK_BALANCE_TIMEOUT_MS;
    // Bound on-demand refreshes so repeated client connects or quota changes cannot become a fetch loop.
    this.minIntervalMs = options.minIntervalMs ?? 5_000;
    if (credentials.error) this.key = "";
  }

  get enabled(): boolean {
    return Boolean(this.key);
  }

  snapshot(): DeepSeekBalance | null {
    return this.cache ? { ...this.cache, entries: this.cache.entries.map((entry) => ({ ...entry })) } : null;
  }

  refresh(force = false): Promise<DeepSeekBalance | null> {
    if (this.inflight) return this.inflight;
    if (!this.key) return Promise.resolve(this.cache);
    const now = this.now();
    // The cooldown covers an empty cache and an expired last-known value: every attempt, success or
    // failure (network error, non-2xx including 429, malformed body or timeout), sets the attempt time.
    if (!force && this.lastAttemptAt !== null && now - this.lastAttemptAt < this.minIntervalMs) {
      return Promise.resolve(this.snapshot());
    }
    this.lastAttemptAt = now;
    const controller = new AbortController();
    this.controller = controller;
    this.inflight = this.request(controller).finally(() => {
      if (this.controller === controller) this.controller = null;
      this.inflight = null;
    });
    return this.inflight;
  }

  private async request(controller: AbortController): Promise<DeepSeekBalance | null> {
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(DEEPSEEK_BALANCE_URL, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.key}`, Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`balance request failed with status ${response.status}`);
      const parsed = sanitizeDeepseekBalance(await response.json(), this.now());
      if (!parsed) throw new Error("balance response did not match the documented shape");
      this.cache = parsed;
      return this.snapshot();
    } catch {
      // Keep a last-known balance clearly marked as stale; a failure is never rendered as zero.
      if (this.cache) this.cache = { ...this.cache, stale: true };
      return this.snapshot();
    } finally {
      clearTimeout(timer);
    }
  }

  stop(): void {
    this.controller?.abort();
    this.controller = null;
  }
}
