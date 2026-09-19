// Pocket's existing event vocabulary, projected from DSH's durable facts.
export const DSH_VERSION = "0.1.6-alpha.2";
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
export function projectEvents(events) {
  const turns = [],
    calls = new Map();
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
      if (d.name === "web_search")
        Object.assign(item, {
          type: "webSearch",
          query: args.query ?? args.queries?.join("; "),
          action: args,
        });
      calls.set(d.callId, item);
      turn.items.push(item);
    }
    if (e.type === "tool/result") {
      for (const r of d.message.content ?? []) {
        const item = calls.get(r.toolCallId ?? r.callId ?? r.id);
        if (!item) continue;
        Object.assign(item, {
          status: r.isError ? "failed" : "completed",
          success: !r.isError,
          contentItems: r.content,
          aggregatedOutput: textContent(r.content),
          results: r.content,
        });
      }
    }
    if (e.type === "compaction/start")
      turn.items.push({
        type: "contextCompaction",
        id: `compaction-${e.seq}`,
        createdAt: e.time,
        status: "inProgress",
      });
    if (e.type === "compaction/end") {
      const item = turn.items.findLast(
        (i) => i.type === "contextCompaction" && i.status === "inProgress",
      );
      if (item) item.status = d.error ? "failed" : "completed";
    }
  }
  return turns;
}
