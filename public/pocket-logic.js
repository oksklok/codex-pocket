export function destinationTaskStatus(machine, task, currentState) {
  const selected = machine.id === currentState?.machineId && task.id === currentState?.thread?.id;
  const phase = selected ? currentState?.phase : task.phase;
  if (phase === "waiting_permission" || phase === "waiting_input") return "Waiting";
  if (phase === "working") return "Working";
  if (phase === "failed") return "Failed";
  if (phase === "stopped") return "Stopped";
  if (phase === "done") return "Done";
  if (selected) return "";
  const status = String(task.status || "");
  if (status.startsWith("active")) return "Working";
  if (/failed|error/i.test(status)) return "Failed";
  if (/interrupted|stopped/i.test(status)) return "Stopped";
  return "";
}

export function preserveMessageCreatedAt(existing, incoming) {
  if (!existing || !Number.isFinite(existing.createdAt)) return { ...incoming };
  return { ...incoming, createdAt: existing.createdAt };
}

export function historyTurnTimestamp(turn, fallback) {
  return turn?.createdAt ?? turn?.created_at ?? turn?.startedAt ?? turn?.started_at ?? fallback;
}

export function shouldShowWorkingFallback(phase, visibleActivities, activeTurnId) {
  if (phase !== "working") return false;
  return !visibleActivities.some((activity) => activity.status === "running"
    && (!activeTurnId || !activity.turnId || activity.turnId === activeTurnId));
}

export function orderTranscriptEntries(entries) {
  const chronological = entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const timeDifference = (left.entry.value.createdAt || 0) - (right.entry.value.createdAt || 0);
      return timeDifference || left.index - right.index;
    });
  const groups = [];
  const groupsByTurn = new Map();
  for (const item of chronological) {
    const turnId = item.entry.value.turnId;
    if (!turnId) {
      groups.push([item]);
      continue;
    }
    let group = groupsByTurn.get(turnId);
    if (!group) {
      group = [];
      groupsByTurn.set(turnId, group);
      groups.push(group);
    }
    group.push(item);
  }
  return groups.flatMap((group) => {
    const ordinary = [];
    const finalAnswers = [];
    for (const item of group) {
      const isFinalAnswer = item.entry.type === "message"
        && item.entry.value.role === "assistant"
        && item.entry.value.phase === "final_answer";
      (isFinalAnswer ? finalAnswers : ordinary).push(item.entry);
    }
    return [...ordinary, ...finalAnswers];
  });
}

export function isUnsupportedMethodError(message) {
  return /(?:method[^\n]*not found|unsupported[^\n]*method|-32601)/i.test(String(message || ""));
}

export function pocketPhase({ connectionError, connected, pending, turn, threadStatus }) {
  if (connectionError && !connected) return "unavailable";
  if (pending.some((request) => request.kind === "permission")) return "waiting_permission";
  if (pending.some((request) => request.kind === "input" && request.blocking !== false)) return "waiting_input";
  if (turn?.status === "inProgress" || String(threadStatus || "").startsWith("active")) return "working";
  if (turn?.error || turn?.status === "failed") return "failed";
  if (turn?.status === "interrupted") return "stopped";
  return connected ? "done" : "connecting";
}
