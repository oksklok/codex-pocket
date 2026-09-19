// The single machine-side DSH home and its private attach endpoint. Shared by the runtime owner and
// the attach client so both resolve the same home, lock and socket.
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const DSH_HOME =
  process.env.POCKET_DSH_HOME || join(homedir(), ".codex-pocket", "dsh");
export const isWindows = process.platform === "win32";
export const LOCK_PATH = join(DSH_HOME, "pocket-owner");
export const LOG_PATH = join(DSH_HOME, "pocket-runtime.log");
// A private local endpoint only: a Unix socket on POSIX, a per-home named pipe on Windows.
export const SOCKET_PATH = isWindows
  ? `\\\\.\\pipe\\codex-pocket-dsh-${createHash("sha256").update(DSH_HOME).digest("hex").slice(0, 16)}`
  : join(DSH_HOME, "pocket-runtime.sock");
