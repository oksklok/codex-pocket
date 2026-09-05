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

export function normalizeAsyncQuestions(questions) {
  if (!Array.isArray(questions)) return [];
  // The protocol uses string titles and nullable arrays of string options.
  return questions.slice(0, 10).filter((question) => typeof question?.title === "string" && question.title.trim()).map((question) => ({
    title: question.title.slice(0, 2000),
    options: Array.isArray(question.options) ? question.options.filter((option) => typeof option === "string").slice(0, 20).map((option) => option.slice(0, 500)) : [],
  }));
}

export function asyncAnswerText(title, answer) {
  return `In response to: ${title}\n\n${answer}`;
}

export function resolvedAsyncAnswer(message, index, messages, answers = {}) {
  const recorded = answers[message.id]?.[index];
  if (recorded !== undefined) return recorded;
  const prefix = asyncAnswerText(message.questions[index].title, "");
  const response = messages.find((candidate) => candidate.role === "user"
    && candidate.createdAt >= message.createdAt && candidate.text.startsWith(prefix));
  return response ? response.text.slice(prefix.length) : null;
}

export function reconcileSubmission(submissionId, snapshot, requested = {}) {
  const receipt = snapshot.submission;
  if (receipt?.id === submissionId) {
    if (receipt.status === "accepted") return "accepted";
    if (receipt.status === "rejected") return "rejected";
  }
  if (!requested.threadId || snapshot.machineId !== requested.machineId || snapshot.thread?.id !== requested.threadId) return "unknown";
  if (requested.question) {
    const question = requested.question;
    return snapshot.asyncAnswers?.[question.messageId]?.[question.index] === question.answer.trim() ? "accepted" : "unknown";
  }
  const text = requested.text?.replace(/\r\n/g, "\n");
  if (!text) return "unknown";
  if (requested.action === "queue" && snapshot.queuedMessage?.threadId === requested.threadId && snapshot.queuedMessage.text === text) return "accepted";
  const previousIds = new Set(requested.previousMessageIds || []);
  const landed = (snapshot.liveMessages || []).some((message) => message.role === "user" && message.text === text
    && !previousIds.has(message.id) && message.turnId
    && (requested.action === "steer" ? message.turnId === requested.turnId
      : snapshot.turn?.id !== requested.turnId && message.turnId === snapshot.turn?.id));
  if (landed) return "accepted";
  return "unknown";
}

export function historyTurnTimestamp(turn, fallback) {
  return turn?.createdAt ?? turn?.created_at ?? turn?.startedAt ?? turn?.started_at ?? fallback;
}

export function mergeActivities(existing, incoming) {
  const activities = new Map(existing.map((activity) => [activity.id, activity]));
  for (const activity of incoming) {
    const previous = activities.get(activity.id);
    activities.set(activity.id, previous ? {
      ...previous,
      ...activity,
      createdAt: previous.createdAt,
      detail: activity.detail || previous.detail,
      status: previous.status !== "running" && activity.status === "running" ? previous.status : activity.status,
    } : activity);
  }
  return [...activities.values()];
}

export function orderTranscriptEntries(entries) {
  const chronological = entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const timeDifference = (left.entry.value.createdAt || 0) - (right.entry.value.createdAt || 0);
      return timeDifference || left.index - right.index;
    });
  const groups = [];
  for (const item of chronological) {
    const turnId = item.entry.value.turnId;
    const previousGroup = groups.at(-1);
    if (turnId && previousGroup?.turnId === turnId) previousGroup.items.push(item);
    else groups.push({ turnId: turnId || null, items: [item] });
  }
  return groups.flatMap((group) => {
    const ordinary = [];
    const finalAnswers = [];
    for (const item of group.items) {
      const isFinalAnswer = item.entry.type === "message"
        && item.entry.value.role === "assistant"
        && item.entry.value.phase === "final_answer"
        && item.entry.value.delivery !== "async";
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
