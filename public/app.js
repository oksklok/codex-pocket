const elements = {
  connection: document.querySelector("#connection"),
  connectionLabel: document.querySelector("#connection-label"),
  phase: document.querySelector("#phase-pill"),
  elapsed: document.querySelector("#elapsed"),
  statusDetail: document.querySelector("#status-detail"),
  machine: document.querySelector("#machine"),
  project: document.querySelector("#project"),
  thread: document.querySelector("#thread"),
  model: document.querySelector("#model"),
  loadOlder: document.querySelector("#load-older"),
  conversation: document.querySelector("#conversation"),
  planList: document.querySelector("#plan-list"),
  planCount: document.querySelector("#plan-count"),
  activityList: document.querySelector("#activity-list"),
  rawBytes: document.querySelector("#raw-bytes"),
  rawMessages: document.querySelector("#raw-messages"),
  browserBytes: document.querySelector("#browser-bytes"),
  browserMessages: document.querySelector("#browser-messages"),
  reduction: document.querySelector("#reduction"),
};

const phaseLabels = {
  connecting: "Connecting",
  working: "Working",
  waiting_input: "Waiting for input",
  waiting_permission: "Waiting for permission",
  done: "Done",
  failed: "Failed",
};

let state = null;
let historyMessages = new Map();
let liveMessages = new Map();
let nextCursor = null;
let source = null;
let shouldFollowConversation = true;

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function formatElapsed(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  const total = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

function projectName(cwd) {
  const parts = String(cwd || "").split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || "—";
}

function setConnection(connected, failed = false) {
  elements.connection.className = `connection ${connected ? "connected" : failed ? "failed" : ""}`;
  elements.connectionLabel.textContent = connected ? "Live" : failed ? "Disconnected" : "Connecting";
}

function renderState() {
  if (!state) return;
  setConnection(Boolean(state.connected), state.phase === "failed");
  const phase = state.phase || "connecting";
  elements.phase.textContent = phaseLabels[phase] || phase;
  elements.phase.className = `phase-pill ${phase}`;
  elements.machine.textContent = state.platform || state.machine || "—";
  elements.project.textContent = projectName(state.thread?.cwd);
  elements.project.title = state.thread?.cwd || "";
  elements.thread.textContent = state.thread?.name || "—";
  elements.thread.title = state.thread?.id || "";
  const effort = state.reasoningEffort && state.reasoningEffort !== "Not exposed" ? ` · ${state.reasoningEffort}` : "";
  elements.model.textContent = `${state.model || "Not exposed"}${effort}`;
  const pending = state.pending?.[0];
  elements.statusDetail.textContent = state.connectionError
    || pending?.label
    || (state.activities?.findLast((activity) => activity.status === "running")?.label)
    || (state.turn?.error)
    || (state.thread ? `${state.thread.name} · ${state.threadStatus}` : "Waiting for a loaded task.");
  renderPlan();
  renderActivities();
  renderMetrics();
}

function renderPlan() {
  const plan = state?.plan || [];
  const complete = plan.filter((item) => item.status === "completed").length;
  elements.planCount.textContent = `${complete}/${plan.length}`;
  elements.planList.replaceChildren();
  if (plan.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-state";
    empty.textContent = "No plan is active.";
    elements.planList.append(empty);
    return;
  }
  for (const item of plan) {
    const li = document.createElement("li");
    li.className = `plan-item ${item.status}`;
    li.textContent = item.step;
    elements.planList.append(li);
  }
}

function renderActivities() {
  const activities = [...(state?.activities || [])].reverse();
  elements.activityList.replaceChildren();
  if (activities.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-state";
    empty.textContent = "No command or tool activity.";
    elements.activityList.append(empty);
    return;
  }
  for (const activity of activities) {
    const li = document.createElement("li");
    li.className = `activity-item ${activity.status}`;
    const kind = document.createElement("span");
    kind.className = "activity-kind";
    kind.textContent = `${activity.kind} · ${activity.status}`;
    const label = document.createElement("span");
    label.textContent = activity.label;
    li.append(kind, label);
    if (activity.detail) {
      const detail = document.createElement("span");
      detail.className = "activity-detail";
      detail.textContent = activity.detail;
      li.append(detail);
    }
    elements.activityList.append(li);
  }
}

function renderMetrics() {
  const metrics = state?.metrics || {};
  const raw = Number(metrics.rawBytes || 0);
  const browser = Number(metrics.browserBytes || 0);
  elements.rawBytes.textContent = formatBytes(raw);
  elements.rawMessages.textContent = `${Number(metrics.rawMessages || 0).toLocaleString()} messages`;
  elements.browserBytes.textContent = formatBytes(browser);
  elements.browserMessages.textContent = `${Number(metrics.browserMessages || 0).toLocaleString()} messages`;
  if (raw <= 0) elements.reduction.textContent = "—";
  else elements.reduction.textContent = `${Math.max(0, (1 - browser / raw) * 100).toFixed(1)}%`;
}

function messageNode(message) {
  const article = document.createElement("article");
  article.className = `message ${message.role} ${message.complete ? "" : "streaming"}`;
  article.dataset.messageId = message.id;
  const meta = document.createElement("div");
  meta.className = "message-meta";
  const role = document.createElement("span");
  role.textContent = message.role === "assistant" ? "Codex" : "You";
  const time = document.createElement("time");
  if (message.createdAt) {
    time.dateTime = new Date(message.createdAt).toISOString();
    time.textContent = new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  meta.append(role, time);
  const body = document.createElement("div");
  body.className = "message-body";
  body.textContent = message.text;
  article.append(meta, body);
  return article;
}

function renderConversation() {
  const wasNearBottom = elements.conversation.scrollHeight - elements.conversation.scrollTop - elements.conversation.clientHeight < 80;
  const all = new Map(historyMessages);
  for (const [id, message] of liveMessages) all.set(id, message);
  const messages = [...all.values()].sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0));
  elements.conversation.replaceChildren();
  if (messages.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No conversation history yet.";
    elements.conversation.append(empty);
    return;
  }
  for (const message of messages) elements.conversation.append(messageNode(message));
  if (shouldFollowConversation || wasNearBottom) {
    elements.conversation.scrollTop = elements.conversation.scrollHeight;
    shouldFollowConversation = false;
  }
}

function mergeState(next) {
  state = { ...(state || {}), ...next };
  if (Array.isArray(next.liveMessages)) {
    for (const message of next.liveMessages) liveMessages.set(message.id, message);
  }
  renderState();
  renderConversation();
}

function applySnapshot(next) {
  const previousThreadId = state?.thread?.id;
  const nextThreadId = next?.thread?.id;
  const threadChanged = Boolean(previousThreadId && nextThreadId && previousThreadId !== nextThreadId);
  if (threadChanged) {
    historyMessages.clear();
    liveMessages.clear();
    nextCursor = null;
    shouldFollowConversation = true;
    elements.loadOlder.hidden = true;
    elements.loadOlder.disabled = true;
  }
  mergeState(next);
  if (threadChanged) loadHistory();
}

async function loadHistory(cursor = null) {
  const requestedThreadId = state?.thread?.id;
  elements.loadOlder.disabled = true;
  elements.loadOlder.textContent = cursor ? "Loading…" : "Load older";
  try {
    const url = new URL("/api/history", location.origin);
    url.searchParams.set("limit", "2");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetch(url);
    const page = await response.json();
    if (!response.ok) throw new Error(page.error || "History unavailable");
    if (!requestedThreadId || requestedThreadId !== state?.thread?.id || page.threadId !== requestedThreadId) return;
    for (const turn of page.turns || []) {
      for (const message of turn.messages || []) historyMessages.set(message.id, message);
    }
    nextCursor = page.nextCursor;
    elements.loadOlder.hidden = !nextCursor;
    elements.loadOlder.disabled = !nextCursor;
    elements.loadOlder.textContent = "Load older";
    renderConversation();
  } catch (error) {
    if (requestedThreadId !== state?.thread?.id) return;
    elements.loadOlder.hidden = false;
    elements.loadOlder.disabled = false;
    elements.loadOlder.textContent = "Retry history";
    elements.statusDetail.textContent = error.message;
  }
}

function parseEvent(event) {
  return JSON.parse(event.data);
}

function connectEvents() {
  source?.close();
  source = new EventSource("/events");
  source.addEventListener("open", () => setConnection(true));
  source.addEventListener("error", () => setConnection(false, true));
  source.addEventListener("snapshot", (event) => applySnapshot(parseEvent(event)));
  source.addEventListener("status", (event) => mergeState(parseEvent(event)));
  source.addEventListener("thread", (event) => mergeState({ thread: parseEvent(event) }));
  source.addEventListener("turn", (event) => {
    const value = parseEvent(event);
    mergeState(value);
  });
  source.addEventListener("plan", (event) => mergeState({ plan: parseEvent(event) }));
  source.addEventListener("request", (event) => mergeState(parseEvent(event)));
  source.addEventListener("activity", (event) => {
    const activity = parseEvent(event);
    const activities = [...(state.activities || [])];
    const index = activities.findIndex((candidate) => candidate.id === activity.id);
    if (index >= 0) activities[index] = activity;
    else activities.push(activity);
    mergeState({ activities: activities.slice(-10) });
  });
  source.addEventListener("message", (event) => {
    const message = parseEvent(event);
    liveMessages.set(message.id, message);
    renderConversation();
  });
  source.addEventListener("assistant_delta", (event) => {
    const value = parseEvent(event);
    const existing = liveMessages.get(value.id) || {
      id: value.id,
      role: "assistant",
      text: "",
      createdAt: Date.now(),
      complete: false,
    };
    existing.text += value.delta;
    existing.complete = false;
    liveMessages.set(value.id, existing);
    renderConversation();
  });
  source.addEventListener("metrics", (event) => mergeState({ metrics: parseEvent(event) }));
}

elements.loadOlder.addEventListener("click", () => {
  if (nextCursor) loadHistory(nextCursor);
});

elements.conversation.addEventListener("scroll", () => {
  shouldFollowConversation = elements.conversation.scrollHeight - elements.conversation.scrollTop - elements.conversation.clientHeight < 80;
});

setInterval(() => {
  const startedAt = state?.turn?.startedAt;
  const completedAt = state?.turn?.completedAt;
  elements.elapsed.textContent = startedAt ? formatElapsed((completedAt || Date.now()) - startedAt) : "—";
}, 1_000);

async function start() {
  try {
    const response = await fetch("/api/state");
    mergeState(await response.json());
  } catch (error) {
    elements.statusDetail.textContent = error.message;
    setConnection(false, true);
  }
  await loadHistory();
  connectEvents();
}

start();
