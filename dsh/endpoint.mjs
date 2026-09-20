// The single machine-side DSH home and its private attach/control endpoints. Shared by the runtime
// owner and the attach/control clients so all of them resolve the same home, lock and sockets.
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DSH_HOME =
  process.env.POCKET_DSH_HOME || join(homedir(), ".codex-pocket", "dsh");
export const isWindows = process.platform === "win32";
export const LOCK_PATH = join(DSH_HOME, "pocket-owner");
export const LOG_PATH = join(DSH_HOME, "pocket-runtime.log");

// The adapter directory (this file's directory). The deployment maintenance marker sits beside it
// so an attach client can refuse to launch from a half-swapped installation.
const adapterRoot = dirname(fileURLToPath(import.meta.url));
export const MAINTENANCE_MARKER = join(dirname(adapterRoot), ".pocket-deploying");

// The gateway attach endpoint and a separate status/control endpoint. Keeping them apart means a
// deployment status check never evicts the attached gateway or receives its pending requests.
const pipeName = (suffix) =>
  `\\\\.\\pipe\\codex-pocket-dsh-${suffix}-${createHash("sha256").update(DSH_HOME).digest("hex").slice(0, 16)}`;
export const SOCKET_PATH = isWindows
  ? pipeName("attach")
  : join(DSH_HOME, "pocket-runtime.sock");
export const CONTROL_SOCKET_PATH = isWindows
  ? pipeName("control")
  : join(DSH_HOME, "pocket-control.sock");
