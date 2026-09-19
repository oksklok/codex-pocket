// Run on the execution machine, including when stdin/stdout travel over SSH.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  mkdirSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  unlinkSync,
} from "node:fs";

const root = dirname(fileURLToPath(import.meta.url));
const home =
  process.env.POCKET_DSH_HOME || join(homedir(), ".codex-pocket", "dsh");
let child, lock;
try {
  const version = JSON.parse(
    readFileSync(
      join(root, "node_modules/@deepseek-ai/dsh/package.json"),
      "utf8",
    ),
  ).version;
  if (version !== "0.1.6-alpha.2")
    throw new Error(
      "Install the locked Pocket DSH dependencies with npm ci in dsh/",
    );
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (
    lstatSync(home).isSymbolicLink() ||
    (process.platform !== "win32" && lstatSync(home).mode & 0o077)
  )
    throw new Error("DSH home must be a private, non-symlink directory");
  lock = join(home, "pocket-owner");
  const fd = openSync(lock, "wx", 0o600);
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  const keyPath = join(
    homedir(),
    ".codex-pocket",
    "secrets",
    "deepseek-api-key",
  );
  let key;
  if (Object.hasOwn(process.env, "DEEPSEEK_API_KEY"))
    key = process.env.DEEPSEEK_API_KEY;
  else {
    const stat = lstatSync(keyPath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 4096 ||
      (process.platform !== "win32" && stat.mode & 0o077) ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("Unsafe execution-machine DeepSeek credential file");
    key = readFileSync(keyPath, "utf8").replace(/\r?\n$/, "");
  }
  if (!key?.trim() || /[\r\n\0]/.test(key))
    throw new Error("Invalid execution-machine DeepSeek credential");
  key = key.trim();
  const credentialPath = join(home, ".credentials.yaml");
  try {
    const st = lstatSync(credentialPath);
    if (
      st.isSymbolicLink() ||
      !st.isFile() ||
      (process.platform !== "win32" && st.mode & 0o077) ||
      (process.getuid && st.uid !== process.getuid())
    )
      throw new Error("Unsafe DSH credential path");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  // A managed secret store, never a tool-process environment or profile setting.
  writeFileSync(
    credentialPath,
    JSON.stringify({
      version: 1,
      refs: { DEEPSEEK_API_KEY: key },
      records: {},
    }) + "\n",
    { mode: 0o600 },
  );
  const patchPath = join(home, "pocket.patch.yml");
  try {
    const st = lstatSync(patchPath);
    if (!st.isFile() || st.isSymbolicLink())
      throw new Error("Unsafe DSH patch path");
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
  process.stdin.pipe(child.stdin);
  // Only complete machine frames leave the execution machine. Diagnostics stay generic.
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      process.stdout.write(
        line
          .split(JSON.stringify(key).slice(1, -1))
          .join("[REDACTED]")
          .split(key)
          .join("[REDACTED]") + "\n",
      );
    }
  });
  child.stderr.resume();
  const stop = () => {
    child.stdin.end();
    child.kill("SIGTERM");
  };
  process.stdout.on("error", stop);
  process.stdin.on("error", stop);
  child.stdin.on("error", () => {});
  process.on("SIGHUP", stop);
  child.on("error", () => {
    process.stderr.write("DSH failed to launch\n");
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    try {
      unlinkSync(lock);
    } catch {}
    process.exit(code ?? 1);
  });
  for (const sig of ["SIGTERM", "SIGINT"])
    process.on(sig, () => child.kill("SIGTERM"));
} catch (e) {
  // Never include arbitrary upstream error details or credential content.
  process.stderr.write(
    "Pocket DSH setup failed; check the pinned installation, credential permissions, and private home ownership.\n",
  );
  if (lock) {
    try {
      if (readFileSync(lock, "utf8") === String(process.pid)) unlinkSync(lock);
    } catch {}
  }
  process.exitCode = 1;
}
