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
  if ((stats.mode & 0o077) !== 0) throw new Error(`DeepSeek API key file must not be accessible by other users; run chmod 600 ${path}`);
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

// Strict resolution for callers that already know DeepSeek should be available.
export function resolveDeepseekKey(env = process.env, path = DEEPSEEK_KEY_PATH): string {
  const status = deepseekCredentialStatus(env, path);
  if (status.error) throw new Error(status.error);
  if (!status.key) throw new Error(`DeepSeek has no API key. Set DEEPSEEK_API_KEY or add the host key file. ${DEEPSEEK_KEY_HINT}`);
  return status.key;
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

export class DeepSeekHost {
  readonly home: string;
  readonly socket: string;
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private stopping = false;
  private key: string;
  private keyError: string | null = null;
  private env: NodeJS.ProcessEnv;
  // Credentials arrive pre-resolved from the gateway; process.env is never modified.
  constructor(home = DEEPSEEK_HOME, env = process.env, credentials?: { key?: string; error?: string }) {
    this.env = { ...env };
    this.home = home;
    this.socket = join(home, "pocket.sock");
    if (credentials?.error) {
      this.key = "";
      this.keyError = credentials.error;
    } else if (typeof credentials?.key === "string") {
      try { this.key = normalizeDeepseekKey(credentials.key, "the host key file"); }
      catch (error) { this.key = ""; this.keyError = error instanceof Error ? error.message : String(error); }
    } else if (Object.prototype.hasOwnProperty.call(this.env, "DEEPSEEK_API_KEY")) {
      try { this.key = normalizeDeepseekKey(this.env.DEEPSEEK_API_KEY, "the DEEPSEEK_API_KEY environment variable"); }
      catch (error) { this.key = ""; this.keyError = error instanceof Error ? error.message : String(error); }
    } else {
      this.key = "";
      this.keyError = `DeepSeek is enabled but no API key is available. Set DEEPSEEK_API_KEY in the host environment, or add the host key file. ${DEEPSEEK_KEY_HINT} See docs/deepseek.md.`;
    }
  }

  redact(text: string): string {
    return this.key ? text.split(this.key).join("[REDACTED]") : text;
  }

  private resolvedEnvironment(): NodeJS.ProcessEnv {
    if (this.keyError) throw new Error(this.keyError);
    return deepseekEnvironment(this.env, this.home, this.key);
  }

  proxyOptions() {
    return { env: this.resolvedEnvironment(), args: [...deepseekArgs(this.home), "--sock", this.socket], cwd: this.home };
  }

  async start(): Promise<void> {
    if (this.stopping) throw new Error("DeepSeek runtime is stopping");
    if (this.starting) return this.starting;
    if (this.child) return;
    const env = this.resolvedEnvironment();
    this.starting = this.launch(env).finally(() => { this.starting = null; });
    return this.starting;
  }

  private async launch(env: NodeJS.ProcessEnv): Promise<void> {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    if (this.stopping) throw new Error("DeepSeek runtime is stopping");
    // The supervisor takes the exclusive ownership lock before writing configuration.
    const child = fork(fileURLToPath(new URL("./deepseek-server.mjs", import.meta.url)), [], {
      env, cwd: this.home, stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [],
    });
    this.child = child;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("DeepSeek server startup timed out")); }, 15_000);
      child.once("error", () => { clearTimeout(timer); this.child = null; reject(new Error("Could not launch the isolated DeepSeek server")); });
      child.once("exit", () => { clearTimeout(timer); if (this.child === child) this.child = null; reject(new Error("DeepSeek server exited during startup")); });
      child.on("message", (message: any) => {
        if (message?.type === "ready") { clearTimeout(timer); resolve(); }
        if (message?.type === "error") { clearTimeout(timer); reject(new Error(this.redact(String(message.message)))); }
      });
      child.send({
        bin: this.env.CODEX_BIN || "codex", socket: this.socket, args: deepseekArgs(this.home),
        config: Object.entries(deepseekConfig(this.home)).map(([k, v]) => `${k} = ${toml(v)}`).join("\n") + "\n",
        catalog: readFileSync(new URL("./deepseek-models.json", import.meta.url), "utf8"),
      });
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    await new Promise<void>(resolve => {
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
    });
  }
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
