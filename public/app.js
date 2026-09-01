const elements = {
  appShell: document.querySelector("#app-shell"),
  loginScreen: document.querySelector("#login-screen"),
  loginForm: document.querySelector("#login-form"),
  loginPin: document.querySelector("#login-pin"),
  loginError: document.querySelector("#login-error"),
  connection: document.querySelector("#connection"),
  connectionLabel: document.querySelector("#connection-label"),
  phase: document.querySelector("#phase-pill"),
  elapsed: document.querySelector("#elapsed"),
  statusDetail: document.querySelector("#status-detail"),
  machine: document.querySelector("#machine"),
  project: document.querySelector("#project"),
  thread: document.querySelector("#thread"),
  threadSelect: document.querySelector("#thread-select"),
  threadCount: document.querySelector("#thread-count"),
  model: document.querySelector("#model"),
  historyStatus: document.querySelector("#history-status"),
  conversation: document.querySelector("#conversation"),
  workspace: document.querySelector("#workspace"),
  sidebar: document.querySelector("#sidebar"),
  planPanel: document.querySelector("#plan-panel"),
  planList: document.querySelector("#plan-list"),
  planCount: document.querySelector("#plan-count"),
  activityPanel: document.querySelector("#activity-panel"),
  activityList: document.querySelector("#activity-list"),
  composer: document.querySelector("#composer"),
  messageText: document.querySelector("#message-text"),
  sendMessage: document.querySelector("#send-message"),
  composerStatus: document.querySelector("#composer-status"),
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
let loadedThreads = [];
let nextCursor = null;
let source = null;
let shouldFollowConversation = true;
let historyEpoch = 0;
let historyRequest = null;
let threadsRequest = null;
let switchingThread = false;
let submittingMessage = false;
let composerError = "";
let composerNotice = "";

function showLogin(message = "") {
  source?.close();
  source = null;
  elements.appShell.hidden = true;
  elements.loginScreen.hidden = false;
  elements.loginError.textContent = message;
  elements.loginPin.focus();
}

async function apiFetch(url, options) {
  const response = await fetch(url, options);
  if (response.status === 401) {
    showLogin("Enter the four-digit PIN to continue.");
    throw new Error("Authentication required");
  }
  return response;
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

function threadLabel(thread) {
  const project = thread.project || projectName(thread.cwd);
  const name = thread.name || thread.preview || "Untitled task";
  const label = project && project !== "—" && project !== name ? `${project} — ${name}` : name;
  return thread.status && thread.status !== "unknown" ? `${label} (${thread.status})` : label;
}

function renderThreadSelector() {
  const selectedId = state?.thread?.id || "";
  elements.threadSelect.replaceChildren();
  if (loadedThreads.length === 0) {
    const option = document.createElement("option");
    option.textContent = "No loaded tasks";
    elements.threadSelect.append(option);
    elements.threadSelect.disabled = true;
    elements.threadCount.textContent = "No tasks are loaded in the shared runtime.";
    return;
  }
  for (const thread of loadedThreads) {
    const option = document.createElement("option");
    option.value = thread.id;
    option.textContent = threadLabel(thread);
    option.title = thread.cwd || thread.id;
    option.selected = thread.id === selectedId;
    elements.threadSelect.append(option);
  }
  elements.threadSelect.disabled = switchingThread || submittingMessage;
  elements.threadCount.textContent = `${loadedThreads.length} loaded task${loadedThreads.length === 1 ? "" : "s"}`;
}

async function refreshLoadedThreads() {
  if (threadsRequest) return threadsRequest;
  threadsRequest = (async () => {
    const response = await apiFetch("/api/threads");
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || "Loaded tasks unavailable");
    loadedThreads = Array.isArray(value.threads) ? value.threads : [];
    renderThreadSelector();
  })();
  try {
    await threadsRequest;
  } catch (error) {
    elements.threadCount.textContent = error.message;
  } finally {
    threadsRequest = null;
  }
}

function setConnection(connected, failed = false) {
  elements.connection.className = `connection ${connected ? "connected" : failed ? "failed" : ""}`;
  elements.connectionLabel.textContent = connected ? "Live" : failed ? "Disconnected" : "Connecting";
}

function renderState() {
  if (!state) return;
  const selectedThread = loadedThreads.find((thread) => thread.id === state.thread?.id);
  if (selectedThread) {
    selectedThread.name = state.thread?.name || selectedThread.name;
    selectedThread.cwd = state.thread?.cwd || selectedThread.cwd;
    selectedThread.project = projectName(selectedThread.cwd);
    selectedThread.status = state.threadStatus || selectedThread.status;
  }
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
  renderThreadSelector();
  renderComposer();
}

function renderComposer() {
  const capability = state?.message;
  const allowed = Boolean(capability?.allowed) && !switchingThread && !submittingMessage;
  elements.messageText.disabled = !allowed;
  elements.sendMessage.disabled = !allowed || !elements.messageText.value.trim();
  const status = submittingMessage
    ? "Sending…"
    : composerError
      || composerNotice
      || (switchingThread ? "Switching tasks…" : capability?.reason)
      || (capability?.mode === "steer" ? "Send a follow-up to the active turn." : "Start a new turn.");
  elements.composerStatus.textContent = status;
  elements.composerStatus.classList.toggle("error-text", Boolean(composerError));
}

function updateSecondaryVisibility() {
  const empty = elements.planPanel.hidden && elements.activityPanel.hidden;
  elements.sidebar.hidden = empty;
  elements.workspace.classList.toggle("secondary-empty", empty);
}

function renderPlan() {
  const plan = state?.plan || [];
  const complete = plan.filter((item) => item.status === "completed").length;
  elements.planCount.textContent = `${complete}/${plan.length}`;
  elements.planList.replaceChildren();
  elements.planPanel.hidden = plan.length === 0;
  if (plan.length === 0) {
    updateSecondaryVisibility();
    return;
  }
  for (const item of plan) {
    const li = document.createElement("li");
    li.className = `plan-item ${item.status}`;
    li.textContent = item.step;
    elements.planList.append(li);
  }
  updateSecondaryVisibility();
}

function renderActivities() {
  const activities = [...(state?.activities || [])].reverse();
  elements.activityList.replaceChildren();
  elements.activityPanel.hidden = activities.length === 0;
  if (activities.length === 0) {
    updateSecondaryVisibility();
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
  updateSecondaryVisibility();
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

function renderConversation({ preserveScroll = null, forceBottom = false } = {}) {
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
  if (preserveScroll) {
    const addedHeight = elements.conversation.scrollHeight - preserveScroll.scrollHeight;
    elements.conversation.scrollTop = preserveScroll.scrollTop + addedHeight;
    shouldFollowConversation = false;
  } else if (forceBottom || shouldFollowConversation) {
    elements.conversation.scrollTop = elements.conversation.scrollHeight;
    shouldFollowConversation = true;
  }
}

function mergeState(next, renderMessages = Array.isArray(next.liveMessages)) {
  if (next.message && !next.message.allowed) {
    composerError = "";
    composerNotice = "";
  }
  state = { ...(state || {}), ...next };
  if (Array.isArray(next.liveMessages)) {
    for (const message of next.liveMessages) liveMessages.set(message.id, message);
  }
  renderState();
  if (renderMessages) renderConversation();
}

function resetConversationState() {
  historyEpoch += 1;
  historyMessages.clear();
  liveMessages.clear();
  nextCursor = null;
  historyRequest = null;
  shouldFollowConversation = true;
  elements.historyStatus.textContent = "";
}

function applySnapshot(next, loadChangedHistory = true) {
  const previousThreadId = state?.thread?.id;
  const nextThreadId = next?.thread?.id;
  const threadChanged = previousThreadId !== nextThreadId && Boolean(previousThreadId || nextThreadId);
  if (threadChanged) {
    resetConversationState();
  }
  mergeState(next, true);
  if (threadChanged && loadChangedHistory && nextThreadId) loadHistory(null, historyEpoch, true);
}

async function loadHistory(cursor = null, epoch = historyEpoch, forceBottom = false) {
  const requestedThreadId = state?.thread?.id;
  if (!requestedThreadId || historyRequest?.epoch === epoch) return;
  const token = { epoch };
  let automaticCursor = null;
  historyRequest = token;
  elements.historyStatus.textContent = cursor ? "Loading earlier…" : "Loading recent…";
  try {
    const url = new URL("/api/history", location.origin);
    url.searchParams.set("limit", "2");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await apiFetch(url);
    const page = await response.json();
    if (!response.ok) throw new Error(page.error || "History unavailable");
    if (epoch !== historyEpoch || requestedThreadId !== state?.thread?.id || page.threadId !== requestedThreadId) return;
    const preserveScroll = cursor ? {
      scrollHeight: elements.conversation.scrollHeight,
      scrollTop: elements.conversation.scrollTop,
    } : null;
    for (const turn of page.turns || []) {
      for (const message of turn.messages || []) historyMessages.set(message.id, message);
    }
    nextCursor = page.nextCursor;
    elements.historyStatus.textContent = nextCursor ? "Scroll up for earlier messages" : "Start of task";
    renderConversation({ preserveScroll, forceBottom });
    const transcriptFits = elements.conversation.scrollHeight <= elements.conversation.clientHeight + 1;
    if (nextCursor && nextCursor !== cursor && transcriptFits) automaticCursor = nextCursor;
  } catch (error) {
    if (epoch !== historyEpoch || requestedThreadId !== state?.thread?.id) return;
    elements.historyStatus.textContent = "History unavailable";
    elements.statusDetail.textContent = error.message;
  } finally {
    if (historyRequest === token) historyRequest = null;
  }
  if (automaticCursor && epoch === historyEpoch && requestedThreadId === state?.thread?.id) {
    await loadHistory(automaticCursor, epoch, forceBottom);
  }
}

async function selectThread(threadId) {
  if (!threadId || threadId === state?.thread?.id || switchingThread) return;
  const selected = loadedThreads.find((thread) => thread.id === threadId);
  switchingThread = true;
  composerError = "";
  composerNotice = "";
  source?.close();
  source = null;
  resetConversationState();
  state = {
    ...(state || {}),
    connectionError: null,
    thread: {
      id: threadId,
      name: selected?.name || selected?.preview || "Switching task",
      cwd: selected?.cwd || "",
      source: "unknown",
    },
    threadStatus: selected?.status || "unknown",
    phase: "connecting",
    turn: null,
    plan: [],
    activities: [],
    pending: [],
    liveMessages: [],
    model: "Not exposed",
    reasoningEffort: "Not exposed",
  };
  renderState();
  renderConversation({ forceBottom: true });
  elements.statusDetail.textContent = "Switching loaded task…";
  try {
    const response = await apiFetch("/api/thread", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId }),
    });
    const snapshot = await response.json();
    if (!response.ok) throw new Error(snapshot.error || "Could not switch tasks");
    applySnapshot(snapshot, false);
    switchingThread = false;
    renderThreadSelector();
    renderComposer();
    connectEvents();
    await loadHistory(null, historyEpoch, true);
    await refreshLoadedThreads();
  } catch (error) {
    switchingThread = false;
    renderComposer();
    elements.statusDetail.textContent = error.message;
    try {
      const response = await apiFetch("/api/state");
      applySnapshot(await response.json(), true);
    } catch {
      setConnection(false, true);
    }
    renderThreadSelector();
    connectEvents();
  }
}

function parseEvent(event) {
  return JSON.parse(event.data);
}

async function handleEventError() {
  setConnection(false, true);
  try {
    const response = await fetch("/api/auth");
    const auth = await response.json();
    if (auth.required && !auth.authenticated) showLogin("Your session expired. Enter the PIN again.");
  } catch {
    // The normal EventSource retry handles transient gateway outages.
  }
}

function connectEvents() {
  source?.close();
  source = new EventSource("/events");
  source.addEventListener("open", () => setConnection(true));
  source.addEventListener("error", handleEventError);
  source.addEventListener("snapshot", (event) => {
    if (!switchingThread) applySnapshot(parseEvent(event));
  });
  source.addEventListener("status", (event) => {
    if (!switchingThread) mergeState(parseEvent(event));
  });
  source.addEventListener("thread", (event) => {
    if (!switchingThread) mergeState({ thread: parseEvent(event) });
  });
  source.addEventListener("turn", (event) => {
    if (switchingThread) return;
    const value = parseEvent(event);
    if (value.turn?.status && value.turn.status !== "inProgress") composerNotice = "";
    mergeState(value);
  });
  source.addEventListener("plan", (event) => {
    if (!switchingThread) mergeState({ plan: parseEvent(event) });
  });
  source.addEventListener("request", (event) => {
    if (!switchingThread) mergeState(parseEvent(event));
  });
  source.addEventListener("activity", (event) => {
    if (switchingThread) return;
    const activity = parseEvent(event);
    const activities = [...(state.activities || [])];
    const index = activities.findIndex((candidate) => candidate.id === activity.id);
    if (index >= 0) activities[index] = activity;
    else activities.push(activity);
    mergeState({ activities: activities.slice(-10) });
  });
  source.addEventListener("message", (event) => {
    if (switchingThread) return;
    const message = parseEvent(event);
    liveMessages.set(message.id, message);
    renderConversation();
  });
  source.addEventListener("assistant_delta", (event) => {
    if (switchingThread) return;
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
}

elements.threadSelect.addEventListener("change", () => {
  selectThread(elements.threadSelect.value);
});

elements.threadSelect.addEventListener("focus", () => {
  refreshLoadedThreads();
});

elements.composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = elements.messageText.value;
  if (!text.trim() || submittingMessage || switchingThread) return;
  submittingMessage = true;
  composerError = "";
  composerNotice = "";
  renderComposer();
  renderThreadSelector();
  try {
    const response = await apiFetch("/api/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const result = await response.json();
    if (!response.ok || !result.accepted) throw new Error(result.error || "Codex did not accept the message");
    elements.messageText.value = "";
    composerNotice = result.mode === "steer" ? "Follow-up accepted." : "Message accepted.";
    mergeState({
      ...(result.turn ? { turn: result.turn } : {}),
      ...(result.phase ? { phase: result.phase } : {}),
      ...(result.message ? { message: result.message } : {}),
    });
  } catch (error) {
    composerError = error.message;
  } finally {
    submittingMessage = false;
    renderComposer();
    renderThreadSelector();
  }
});

elements.messageText.addEventListener("input", () => {
  composerError = "";
  composerNotice = "";
  renderComposer();
});

elements.messageText.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});

elements.conversation.addEventListener("scroll", () => {
  shouldFollowConversation = elements.conversation.scrollHeight - elements.conversation.scrollTop - elements.conversation.clientHeight < 80;
  if (!shouldFollowConversation && elements.conversation.scrollTop < 140 && nextCursor && !historyRequest) {
    loadHistory(nextCursor, historyEpoch, false);
  }
});

setInterval(() => {
  const startedAt = state?.turn?.startedAt;
  const completedAt = state?.turn?.completedAt;
  elements.elapsed.textContent = startedAt ? formatElapsed((completedAt || Date.now()) - startedAt) : "—";
}, 1_000);

async function startApp() {
  elements.loginScreen.hidden = true;
  elements.appShell.hidden = false;
  try {
    const [response] = await Promise.all([apiFetch("/api/state"), refreshLoadedThreads()]);
    applySnapshot(await response.json(), false);
  } catch (error) {
    elements.statusDetail.textContent = error.message;
    setConnection(false, true);
  }
  await loadHistory(null, historyEpoch, true);
  connectEvents();
}

elements.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = elements.loginForm.querySelector("button");
  button.disabled = true;
  elements.loginError.textContent = "Checking…";
  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: elements.loginPin.value }),
    });
    const result = await response.json();
    if (!response.ok || !result.authenticated) throw new Error(result.error || "Could not sign in");
    elements.loginPin.value = "";
    location.reload();
  } catch (error) {
    elements.loginError.textContent = error.message;
    button.disabled = false;
  }
});

elements.loginPin.addEventListener("input", () => {
  elements.loginPin.value = elements.loginPin.value.replace(/\D/g, "").slice(0, 4);
  elements.loginError.textContent = "";
});

async function start() {
  try {
    const response = await fetch("/api/auth");
    const auth = await response.json();
    if (auth.required && !auth.authenticated) {
      showLogin();
      return;
    }
    await startApp();
  } catch (error) {
    showLogin(`Gateway unavailable: ${error.message}`);
  }
}

start();
