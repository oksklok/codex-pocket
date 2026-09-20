import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// Pocket's existing event vocabulary, projected from DSH's durable facts.
// Ownership/control commands also load this module from a staged adapter without dependencies.
export const DSH_VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL("./node_modules/@deepseek-ai/dsh/package.json", import.meta.url), "utf8")).version; }
  catch { return "Unavailable"; }
})();
// Bumped whenever the gateway and the execution-side adapter must be upgraded together. The gateway
// refuses an adapter it does not understand so a partial rollout cannot activate a mismatch.
export const DSH_ADAPTER_PROTOCOL = 2;
export function sessionId(value) {
  if (
    typeof value !== "string" ||
    !/^dsh-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      value,
    )
  )
    throw new Error(
      "Not a Pocket DSH session; legacy Codex DeepSeek sessions cannot resume in DSH",
    );
  return value;
}
export function permission(value, current = "workspace-write") {
  if (value.sandbox !== undefined || value.sandboxPolicy !== undefined)
    throw new Error("Use a supported DSH permission preset");
  if (
    value.approvalsReviewer !== undefined &&
    !["user", "auto_review"].includes(value.approvalsReviewer)
  )
    throw new Error("Unsupported DSH approval reviewer");
  if (value.approvalsReviewer === "auto_review")
    throw new Error("DSH automatic approval review is not configured");
  if (
    value.approvalPolicy !== undefined &&
    !["on-request", "never"].includes(value.approvalPolicy)
  )
    throw new Error("Unsupported DSH approval policy");
  if (
    [":danger-full-access", ":full-access"].includes(value.permissions) &&
    value.approvalPolicy === "on-request"
  )
    throw new Error("Refusing an approval-required Full access mapping");
  if (value.permissions === ":workspace" && value.approvalPolicy === "never")
    throw new Error(
      "Refusing an approval-required workspace mapping without approvals",
    );
  if (
    value.permissions === ":danger-full-access" ||
    value.permissions === ":full-access"
  )
    return "danger-full-access";
  if (
    value.permissions === ":workspace" ||
    value.approvalPolicy === "on-request"
  )
    return "workspace-write";
  if (value.permissions !== undefined)
    throw new Error("Unsupported DSH permission profile");
  if (value.approvalPolicy === "never" && current !== "danger-full-access")
    throw new Error(
      "Refusing to convert an approval-required profile to Full access",
    );
  return current;
}
export function textContent(content) {
  return (content ?? [])
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

// DSH tools whose calls Pocket classifies outside the generic Tool category, and the argument that
// names what they searched for.
const SEARCH_TOOLS = { web_search: "query", web_fetch: "url", grep: "pattern", glob: "pattern" };
const FILE_TOOLS = new Set(["write", "edit", "str_replace_editor"]);
// Subagent tools render under Pocket's Subagents category; the value is the call-time kind.
const SUBAGENT_TOOLS = { subagent: "started", send_message: "interacted", interrupt_agent: "interrupted" };

function addedLines(text) {
  const value = String(text ?? "");
  return value ? value.split("\n").map((line) => `+${line}`).join("\n") : "";
}

// A bounded line diff for Pocket's existing File Changes renderer. DSH passes hunk-sized old/new
// text, so this stays small; a create has no prior text and is all additions.
function diffText(oldText, newText) {
  const after = String(newText ?? "");
  if (oldText === null || oldText === undefined) return addedLines(after);
  const before = String(oldText);
  if (before === after) return "";
  const a = before ? before.split("\n") : [];
  const b = after ? after.split("\n") : [];
  // Hunk-sized text stays exact; a pathologically large pair falls back to a coarse replace so the
  // projection never allocates a quadratic table for one tool result.
  if (a.length * b.length > 1_000_000) {
    return [...a.map((line) => `-${line}`), ...b.map((line) => `+${line}`)].join("\n");
  }
  const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = b.length - 1; j >= 0; j -= 1)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const lines = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { lines.push(` ${a[i]}`); i += 1; j += 1; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { lines.push(`-${a[i]}`); i += 1; }
    else { lines.push(`+${b[j]}`); j += 1; }
  }
  while (i < a.length) { lines.push(`-${a[i]}`); i += 1; }
  while (j < b.length) { lines.push(`+${b[j]}`); j += 1; }
  return lines.join("\n");
}

// One File Changes entry per file: DSH emits one diff per hunk, but Pocket's renderer and its
// "Edited N files" label count files.
function changesFromDiffs(diffs) {
  const byPath = new Map();
  for (const diff of Array.isArray(diffs) ? diffs : []) {
    if (!diff || typeof diff.path !== "string" || !diff.path) continue;
    const text = diffText(diff.oldText, diff.newText);
    const entry = byPath.get(diff.path);
    if (entry) {
      if (text) entry.parts.push(text);
      continue;
    }
    byPath.set(diff.path, {
      path: diff.path,
      add: diff.oldText === null || diff.oldText === undefined,
      parts: text ? [text] : [],
    });
  }
  return [...byPath.values()].map(({ path, add, parts }) => ({ path, kind: add ? "add" : "update", diff: parts.join("\n") }));
}

// The change a call intends before any result exists, so a pending or failed edit still shows the
// real target file instead of the raw arguments.
function intendedChanges(name, args) {
  if (!args || typeof args !== "object") return [];
  if (name === "write" && typeof args.file_path === "string")
    return changesFromDiffs([{ path: args.file_path, oldText: null, newText: args.content ?? "" }]);
  if (name === "edit" && typeof args.file_path === "string")
    return changesFromDiffs([{ path: args.file_path, oldText: typeof args.old_string === "string" ? args.old_string : null, newText: args.new_string ?? "" }]);
  if (name === "str_replace_editor" && typeof args.path === "string") {
    if (args.command === "create") return changesFromDiffs([{ path: args.path, oldText: null, newText: args.file_text ?? "" }]);
    if (args.command === "str_replace") return changesFromDiffs([{ path: args.path, oldText: args.old_str ?? null, newText: args.new_str ?? "" }]);
    if (args.command === "insert") return changesFromDiffs([{ path: args.path, oldText: null, newText: args.new_str ?? "" }]);
  }
  return [];
}

export function projectEvents(events, cwd) {
  const turns = [],
    calls = new Map(),
    compactions = new Map();
  let turn;
  for (const e of events) {
    const d = e.data;
    if (e.type === "turn/start") {
      turn = {
        id: String(d.turn),
        status: "inProgress",
        createdAt: e.time,
        items: [],
      };
      turns.push(turn);
    }
    if (!turn) continue;
    if (e.type === "turn/end") {
      turn.status =
        d.reason.kind === "completed"
          ? "completed"
          : /abort|cancel|interrupt/.test(d.reason.kind)
            ? "interrupted"
            : "failed";
      turn.completedAt = e.time;
      if (turn.status === "failed")
        turn.error = {
          message: d.reason.error?.message ?? d.reason.message ?? d.reason.kind,
        };
    }
    if (e.type === "user/message" && d.source?.kind === "user")
      turn.items.push({
        type: "userMessage",
        id: d.id,
        content: d.content,
        createdAt: e.time,
      });
    if (e.type === "assistant/message")
      turn.items.push({
        type: "agentMessage",
        id: `assistant-${d.turn}-${d.step}`,
        text: textContent(d.message.content),
        createdAt: e.time,
      });
    if (e.type === "tool/call") {
      let args;
      try {
        args = JSON.parse(d.arguments);
      } catch {
        args = d.arguments;
      }
      const item = {
        type: "dynamicToolCall",
        id: d.callId,
        namespace: "DSH",
        tool: d.name,
        arguments: args,
        status: "inProgress",
        createdAt: e.time,
      };
      if (/^(bash|pwsh)$/.test(d.name))
        Object.assign(item, {
          type: "commandExecution",
          command: args.command ?? args.script ?? d.arguments,
        });
      if (d.name === "read_image") Object.assign(item, { type: "imageView" });
      const searchKey = SEARCH_TOOLS[d.name];
      if (searchKey)
        Object.assign(item, {
          type: "webSearch",
          query: args?.[searchKey] ?? args?.query ?? args?.queries?.join("; "),
          action: args,
        });
      if (FILE_TOOLS.has(d.name)) {
        const changes = intendedChanges(d.name, args);
        // Requested, not yet applied: the call view shows the intended target; a result with
        // authoritative metadata replaces it with the applied hunks.
        if (changes.length) Object.assign(item, { type: "fileChange", changes, applied: null });
      }
      const subagentKind = SUBAGENT_TOOLS[d.name];
      if (subagentKind)
        Object.assign(item, {
          type: "collabAgentToolCall",
          kind: subagentKind,
          tool: d.name,
          prompt: args?.prompt ?? args?.message ?? "",
          model: args?.model,
          reasoningEffort: args?.reasoning_effort ?? args?.reasoningEffort,
        });
      calls.set(d.callId, item);
      turn.items.push(item);
    }
    if (e.type === "tool/result") {
      // The applied file diff rides the opaque result metadata and replays identically from the
      // durable session log. A result without it (failure, or a create with no before-image) keeps
      // the call-time changes instead of pretending they were applied.
      const meta = d.meta;
      for (const r of d.message.content ?? []) {
        const item = calls.get(r.toolCallId ?? r.callId ?? r.id);
        if (!item) continue;
        Object.assign(item, {
          status: r.isError ? "failed" : "completed",
          success: !r.isError,
          contentItems: r.content,
          aggregatedOutput: textContent(r.content),
          results: r.content,
          resultMeta: meta,
          error: d.error,
        });
        if (item.type === "imageView") {
          if (!r.isError && r.content?.some(block => block.type === "image") && typeof item.arguments?.file_path === "string" && cwd) {
            item.path = resolve(cwd, item.arguments.file_path);
          } else if (r.isError) item.failure = d.error ?? textContent(r.content);
        }
        if (item.type === "fileChange") {
          const applied = changesFromDiffs(Array.isArray(meta?.diffs) ? meta.diffs : []);
          if (r.isError) {
            Object.assign(item, { applied: false });
          } else if (applied.length) {
            // The durable result metadata is authoritative for the applied change.
            Object.assign(item, { changes: applied, applied: true, unchanged: false });
          } else if (meta?.operation === "create") {
            // A create has no before-image; the whole file is the applied addition.
            Object.assign(item, { changes: intendedChanges(item.tool, item.arguments), applied: true, unchanged: false });
          } else if (meta && typeof meta === "object" && "diffs" in meta) {
            // An update with no hunks: the file content did not change.
            Object.assign(item, { changes: [], applied: true, unchanged: true });
          }
          // No metadata and no error keeps the requested changes as unconfirmed.
        }
        // A completed subagent tool call is not proof that its background agent finished.
      }
    }
    if (e.type === "compaction/start") {
      const item = {
        type: "contextCompaction",
        id: `compaction-${e.seq}`,
        compactionId: d.compactionId,
        createdAt: e.time,
        status: "inProgress",
      };
      compactions.set(d.compactionId ?? e.seq, item);
      turn.items.push(item);
    }
    if (e.type === "compaction/end") {
      const item = compactions.get(d.compactionId);
      if (item) {
        item.status = d.error ? "failed" : "completed";
        item.error = d.error;
      }
    }
  }
  return turns;
}
