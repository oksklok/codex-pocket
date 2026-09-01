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
  machineSelect: document.querySelector("#machine-select"),
  project: document.querySelector("#project"),
  thread: document.querySelector("#thread"),
  threadSelect: document.querySelector("#thread-select"),
  threadCount: document.querySelector("#thread-count"),
  model: document.querySelector("#model"),
  accessProfile: document.querySelector("#access-profile"),
  modelSelect: document.querySelector("#model-select"),
  effortSelect: document.querySelector("#effort-select"),
  accessSelect: document.querySelector("#access-select"),
  nextTurnLabel: document.querySelector("#next-turn-label"),
  historyStatus: document.querySelector("#history-status"),
  conversation: document.querySelector("#conversation"),
  planList: document.querySelector("#plan-list"),
  planCount: document.querySelector("#plan-count"),
  planEmpty: document.querySelector("#plan-empty"),
  activityList: document.querySelector("#activity-list"),
  activityEmpty: document.querySelector("#activity-empty"),
  composer: document.querySelector("#composer"),
  messageText: document.querySelector("#message-text"),
  sendMessage: document.querySelector("#send-message"),
  queueMessage: document.querySelector("#queue-message"),
  composerStatus: document.querySelector("#composer-status"),
  attentionBanner: document.querySelector("#attention-banner"),
  queueBanner: document.querySelector("#queue-banner"),
  queueText: document.querySelector("#queue-text"),
  cancelQueue: document.querySelector("#cancel-queue"),
  inspectorButton: document.querySelector("#inspector-button"),
  inspectorClose: document.querySelector("#inspector-close"),
  inspectorBackdrop: document.querySelector("#inspector-backdrop"),
  settingsButton: document.querySelector("#settings-button"),
  settingsScreen: document.querySelector("#settings-screen"),
  settingsForm: document.querySelector("#settings-form"),
  settingsClose: document.querySelector("#settings-close"),
  settingsCancel: document.querySelector("#settings-cancel"),
  settingsSave: document.querySelector("#settings-save"),
  settingsLanEnabled: document.querySelector("#settings-lan-enabled"),
  settingsHost: document.querySelector("#settings-host"),
  settingsPort: document.querySelector("#settings-port"),
  settingsPin: document.querySelector("#settings-pin"),
  settingsPinState: document.querySelector("#settings-pin-state"),
  settingsMachines: document.querySelector("#settings-machines"),
  machineAdd: document.querySelector("#machine-add"),
  settingsRestart: document.querySelector("#settings-restart"),
  restartPocket: document.querySelector("#restart-pocket"),
  phoneUrls: document.querySelector("#phone-urls"),
  phoneUrlList: document.querySelector("#phone-url-list"),
  settingsStatus: document.querySelector("#settings-status"),
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
let machines = [];
let nextCursor = null;
let source = null;
let shouldFollowConversation = true;
let historyEpoch = 0;
let historyRequest = null;
let threadsRequest = null;
let machinesRequest = null;
let switchingThread = false;
let switchingMachine = false;
let submittingMessage = false;
let updatingModel = false;
let updatingAccess = false;
let resolvingApproval = false;
let cancellingQueue = false;
let composerError = "";
let composerNotice = "";
let settingsValue = null;
let savingSettings = false;
let restartingPocket = false;

function showLogin(message = "") {
  source?.close();
  source = null;
  closeSettings();
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

function projectName(cwd) {
  const parts = String(cwd || "").split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || "—";
}

function formatElapsed(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  const total = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

function threadLabel(thread) {
  const project = thread.project || projectName(thread.cwd);
  const name = thread.name || thread.preview || "Untitled task";
  return project && project !== "—" && project !== name ? `${project} — ${name}` : name;
}

function setConnection(connected, failed = false) {
  elements.connection.className = `connection ${connected ? "connected" : failed ? "failed" : ""}`;
  elements.connectionLabel.textContent = connected ? "Live" : failed ? "Disconnected" : "Connecting";
}

function renderMachineSelector() {
  const selectedId = state?.machineId || "local";
  elements.machineSelect.replaceChildren();
  for (const machine of machines) {
    const option = document.createElement("option");
    option.value = machine.id;
    option.textContent = machine.connected ? machine.name : `${machine.name} · Offline`;
    option.title = machine.ssh ? `SSH · ${machine.ssh}` : "Local Codex runtime";
    option.selected = machine.id === selectedId;
    elements.machineSelect.append(option);
  }
  elements.machineSelect.disabled = machines.length < 2 || switchingMachine || switchingThread || submittingMessage || updatingModel || updatingAccess || resolvingApproval;
}

async function refreshMachines() {
  if (machinesRequest) return machinesRequest;
  machinesRequest = (async () => {
    const response = await apiFetch("/api/machines");
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || "Machines unavailable");
    machines = Array.isArray(value.machines) ? value.machines : [];
    renderMachineSelector();
  })();
  try {
    await machinesRequest;
  } finally {
    machinesRequest = null;
  }
}

function renderThreadSelector() {
  const selectedId = state?.thread?.id || "";
  elements.threadSelect.replaceChildren();
  if (loadedThreads.length === 0) {
    const option = document.createElement("option");
    option.textContent = state?.connected ? "No loaded tasks" : "Machine unavailable";
    elements.threadSelect.append(option);
    elements.threadSelect.disabled = true;
    elements.threadCount.textContent = state?.connected ? "No loaded tasks" : state?.connectionError || "Machine unavailable";
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
  elements.threadSelect.disabled = switchingMachine || switchingThread || submittingMessage || updatingModel || updatingAccess || resolvingApproval || !state?.connected;
  elements.threadCount.textContent = `${loadedThreads.length} loaded task${loadedThreads.length === 1 ? "" : "s"}`;
}

async function refreshLoadedThreads() {
  const requestedMachineId = state?.machineId || "local";
  if (threadsRequest?.machineId === requestedMachineId) return threadsRequest.promise;
  const token = { machineId: requestedMachineId, promise: null };
  token.promise = (async () => {
    const url = new URL("/api/threads", location.origin);
    url.searchParams.set("machineId", requestedMachineId);
    const response = await apiFetch(url);
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || "Loaded tasks unavailable");
    if (requestedMachineId !== state?.machineId) return;
    loadedThreads = Array.isArray(value.threads) ? value.threads : [];
    renderThreadSelector();
  })();
  threadsRequest = token;
  try {
    await token.promise;
  } catch (error) {
    if (requestedMachineId === state?.machineId) {
      loadedThreads = [];
      renderThreadSelector();
      elements.threadCount.textContent = error.message;
    }
  } finally {
    if (threadsRequest === token) threadsRequest = null;
  }
}

function currentCatalogModel(modelName = state?.model) {
  return (state?.models || []).find((candidate) => candidate.model === modelName);
}

function renderModelControls() {
  const models = state?.thread ? state?.models || [] : [];
  elements.modelSelect.replaceChildren();
  for (const model of models) {
    const option = document.createElement("option");
    option.value = model.model;
    option.textContent = model.displayName || model.model;
    option.title = model.description || model.model;
    option.selected = model.model === state?.model;
    elements.modelSelect.append(option);
  }
  if (!models.length) {
    const option = document.createElement("option");
    option.textContent = state?.model || "Model unavailable";
    elements.modelSelect.append(option);
  }

  const selectedModel = currentCatalogModel(elements.modelSelect.value || state?.model);
  const efforts = selectedModel?.supportedReasoningEfforts || [];
  elements.effortSelect.replaceChildren();
  for (const effort of efforts) {
    const option = document.createElement("option");
    option.value = effort.reasoningEffort;
    option.textContent = effort.reasoningEffort;
    option.title = effort.description || effort.reasoningEffort;
    option.selected = effort.reasoningEffort === state?.reasoningEffort;
    elements.effortSelect.append(option);
  }
  if (!efforts.length) {
    const option = document.createElement("option");
    option.textContent = state?.reasoningEffort || "Effort unavailable";
    elements.effortSelect.append(option);
  }
  const enabled = Boolean(state?.connected && state?.thread && models.length)
    && !switchingThread
    && !updatingModel
    && !updatingAccess
    && !resolvingApproval;
  elements.modelSelect.disabled = !enabled;
  elements.effortSelect.disabled = !enabled || !efforts.length;
  elements.nextTurnLabel.hidden = state?.turn?.status !== "inProgress";
}

function renderAccessControl() {
  const access = state?.access;
  const modes = [
    { value: "ask", label: "Ask for approval" },
    { value: "auto", label: "Approve for me" },
    { value: "full", label: "Full access" },
  ];
  elements.accessSelect.replaceChildren();
  for (const mode of modes) {
    const choice = access?.choices?.[mode.value];
    const option = document.createElement("option");
    option.value = mode.value;
    option.textContent = choice?.available === false ? `${mode.label} · unavailable` : mode.label;
    option.disabled = choice?.available !== true;
    option.title = choice?.reason || (mode.value === "full" ? "Unrestricted access to files and network" : mode.label);
    option.selected = access?.mode === mode.value;
    elements.accessSelect.append(option);
  }
  if (access?.mode === "custom" || access?.mode === "unavailable") {
    const option = document.createElement("option");
    option.value = access.mode;
    option.textContent = access.mode === "custom" ? "Custom access" : "Access unavailable";
    option.selected = true;
    option.disabled = true;
    elements.accessSelect.prepend(option);
  }
  elements.accessSelect.disabled = !state?.connected
    || !state?.thread
    || switchingMachine
    || switchingThread
    || updatingAccess
    || resolvingApproval;
  elements.accessSelect.classList.toggle("full-access", access?.mode === "full");
  elements.accessSelect.title = access?.mode === "full"
    ? "Unrestricted access to files and network"
    : access?.description || access?.profileId || "Task access";
}

function renderPlan() {
  const plan = state?.plan || [];
  const complete = plan.filter((item) => item.status === "completed").length;
  elements.planCount.textContent = `${complete}/${plan.length}`;
  elements.planList.replaceChildren();
  elements.planEmpty.hidden = plan.length > 0;
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
  elements.activityEmpty.hidden = activities.length > 0;
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

function renderQueue() {
  const queued = state?.queuedMessage;
  elements.queueBanner.hidden = !queued;
  if (queued) {
    elements.queueText.textContent = queued.text;
    elements.queueText.title = queued.text;
    elements.cancelQueue.disabled = cancellingQueue;
  }
}

function renderAttention() {
  const pending = state?.pending?.[0];
  elements.attentionBanner.replaceChildren();
  elements.attentionBanner.hidden = !pending;
  if (!pending) return;
  if (pending.kind !== "permission") {
    const text = document.createElement("span");
    text.textContent = `Input needed: ${pending.label}`;
    elements.attentionBanner.append(text);
    return;
  }
  const heading = document.createElement("div");
  heading.className = "approval-heading";
  const title = document.createElement("strong");
  title.textContent = "Approval needed";
  const count = document.createElement("span");
  const total = state.pending.filter((request) => request.kind === "permission").length;
  count.textContent = total > 1 ? `1 of ${total}` : "";
  heading.append(title, count);
  const label = document.createElement("div");
  label.className = "approval-label";
  label.textContent = pending.label;
  elements.attentionBanner.append(heading, label);
  if (pending.reason) {
    const reason = document.createElement("div");
    reason.className = "approval-detail";
    reason.textContent = pending.reason;
    elements.attentionBanner.append(reason);
  }
  if (pending.scope) {
    const scope = document.createElement("div");
    scope.className = "approval-scope";
    scope.textContent = pending.scope;
    elements.attentionBanner.append(scope);
  }
  if (!pending.supported) {
    const unsupported = document.createElement("div");
    unsupported.className = "approval-detail";
    unsupported.textContent = "Handle this request in the local Codex client.";
    elements.attentionBanner.append(unsupported);
    return;
  }
  const actions = document.createElement("div");
  actions.className = "approval-actions";
  const deny = document.createElement("button");
  deny.type = "button";
  deny.className = "approval-deny";
  deny.textContent = "Deny";
  deny.disabled = resolvingApproval || pending.resolving;
  deny.addEventListener("click", () => resolveApproval(pending.id, "deny"));
  const approve = document.createElement("button");
  approve.type = "button";
  approve.className = "approval-approve";
  approve.textContent = pending.resolving ? "Sending…" : "Approve";
  approve.disabled = resolvingApproval || pending.resolving;
  approve.addEventListener("click", () => resolveApproval(pending.id, "approve"));
  actions.append(deny, approve);
  elements.attentionBanner.append(actions);
}

function renderComposer() {
  const capability = state?.message;
  const allowed = Boolean(capability?.allowed)
    && !switchingMachine
    && !switchingThread
    && !submittingMessage
    && !updatingAccess
    && !resolvingApproval;
  const active = capability?.mode === "steer";
  elements.messageText.disabled = !allowed;
  elements.sendMessage.disabled = !allowed || !elements.messageText.value.trim();
  elements.sendMessage.textContent = active ? "Steer now" : "Send";
  elements.queueMessage.hidden = !active;
  elements.queueMessage.disabled = !allowed || !elements.messageText.value.trim();
  const status = submittingMessage
    ? "Sending…"
    : resolvingApproval
      ? "Sending approval response…"
      : updatingAccess
        ? "Updating access…"
    : composerError
      || composerNotice
      || (switchingMachine ? "Switching machines…" : switchingThread ? "Switching tasks…" : capability?.reason)
      || (active ? "Send immediately, or keep one message for the next turn." : "Start a new turn.");
  elements.composerStatus.textContent = status;
  elements.composerStatus.classList.toggle("error-text", Boolean(composerError));
  renderAttention();
  renderQueue();
}

function renderState() {
  if (!state) return;
  const selectedMachine = machines.find((machine) => machine.id === state.machineId);
  if (selectedMachine) {
    selectedMachine.connected = Boolean(state.connected);
    selectedMachine.connectionError = state.connectionError || null;
    selectedMachine.selectedThreadId = state.thread?.id || null;
    selectedMachine.loadedTaskCount = loadedThreads.length;
  }
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
  const startedAt = state.turn?.startedAt;
  const completedAt = state.turn?.completedAt;
  elements.elapsed.textContent = startedAt ? formatElapsed((completedAt || Date.now()) - startedAt) : "—";
  elements.machine.textContent = [state.machine, state.transport, state.platform].filter(Boolean).join(" · ") || "—";
  elements.project.textContent = projectName(state.thread?.cwd);
  elements.project.title = state.thread?.cwd || "";
  elements.thread.textContent = state.thread?.name || "—";
  elements.thread.title = state.thread?.id || "";
  const effort = state.reasoningEffort && state.reasoningEffort !== "Not exposed" ? ` · ${state.reasoningEffort}` : "";
  elements.model.textContent = `${state.model || "Not exposed"}${effort}`;
  elements.accessProfile.textContent = state.access?.profileId
    ? `${state.access.profileId} · ${state.access.reviewer || "unknown reviewer"}`
    : "—";
  const pending = state.pending?.[0];
  elements.statusDetail.textContent = state.connectionError
    || pending?.label
    || state.activities?.findLast((activity) => activity.status === "running")?.label
    || state.turn?.error
    || (state.thread ? `${state.thread.name} · ${state.threadStatus}` : state.connected ? "No loaded tasks on this machine." : "Machine unavailable.");
  renderMachineSelector();
  renderThreadSelector();
  renderModelControls();
  renderAccessControl();
  renderPlan();
  renderActivities();
  renderComposer();
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
  const ordered = [...all.values()].sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0));
  const deduplicated = new Map();
  for (const message of ordered) {
    const key = message.turnId
      ? `${message.turnId}\u0000${message.role}\u0000${message.text}`
      : `id\u0000${message.id}`;
    deduplicated.set(key, message);
  }
  const messages = [...deduplicated.values()].sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0));
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
  const previousMachineId = state?.machineId;
  const previousThreadId = state?.thread?.id;
  const nextMachineId = next?.machineId;
  const nextThreadId = next?.thread?.id;
  const taskChanged = previousMachineId !== nextMachineId || previousThreadId !== nextThreadId;
  if (taskChanged) resetConversationState();
  mergeState(next, true);
  if (taskChanged && loadChangedHistory && nextThreadId) loadHistory(null, historyEpoch, true);
}

async function loadHistory(cursor = null, epoch = historyEpoch, forceBottom = false) {
  const requestedMachineId = state?.machineId;
  const requestedThreadId = state?.thread?.id;
  if (!requestedMachineId || !requestedThreadId || historyRequest?.epoch === epoch) return;
  const token = { epoch };
  let automaticCursor = null;
  historyRequest = token;
  elements.historyStatus.textContent = cursor ? "Loading earlier…" : "Loading recent…";
  try {
    const url = new URL("/api/history", location.origin);
    url.searchParams.set("limit", "2");
    url.searchParams.set("machineId", requestedMachineId);
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await apiFetch(url);
    const page = await response.json();
    if (!response.ok) throw new Error(page.error || "History unavailable");
    if (epoch !== historyEpoch
      || requestedMachineId !== state?.machineId
      || requestedThreadId !== state?.thread?.id
      || page.machineId !== requestedMachineId
      || page.threadId !== requestedThreadId) return;
    const preserveScroll = cursor ? { scrollHeight: elements.conversation.scrollHeight, scrollTop: elements.conversation.scrollTop } : null;
    for (const turn of page.turns || []) {
      for (const message of turn.messages || []) historyMessages.set(message.id, message);
    }
    nextCursor = page.nextCursor;
    elements.historyStatus.textContent = nextCursor ? "Scroll up for earlier messages" : "Start of task";
    renderConversation({ preserveScroll, forceBottom });
    const transcriptFits = elements.conversation.scrollHeight <= elements.conversation.clientHeight + 1;
    if (nextCursor && nextCursor !== cursor && transcriptFits) automaticCursor = nextCursor;
  } catch (error) {
    if (epoch !== historyEpoch || requestedMachineId !== state?.machineId || requestedThreadId !== state?.thread?.id) return;
    elements.historyStatus.textContent = "History unavailable";
    elements.statusDetail.textContent = error.message;
  } finally {
    if (historyRequest === token) historyRequest = null;
  }
  if (automaticCursor && epoch === historyEpoch && requestedMachineId === state?.machineId && requestedThreadId === state?.thread?.id) {
    await loadHistory(automaticCursor, epoch, forceBottom);
  }
}

async function selectMachine(machineId) {
  if (!machineId || machineId === state?.machineId || switchingMachine || switchingThread) return;
  const selected = machines.find((machine) => machine.id === machineId);
  switchingMachine = true;
  composerError = "";
  composerNotice = "";
  source?.close();
  source = null;
  resetConversationState();
  loadedThreads = [];
  threadsRequest = null;
  state = {
    ...(state || {}),
    machineId,
    machine: selected?.name || "Switching machine",
    transport: selected?.transport || (selected?.ssh ? `SSH · ${selected.ssh}` : "Local"),
    connected: false,
    connectionError: null,
    thread: null,
    threadStatus: "connecting",
    phase: "connecting",
    turn: null,
    plan: [],
    activities: [],
    pending: [],
    liveMessages: [],
    queuedMessage: null,
    model: "Not exposed",
    reasoningEffort: "Not exposed",
    models: [],
    access: null,
  };
  renderState();
  renderConversation({ forceBottom: true });
  elements.statusDetail.textContent = `Switching to ${selected?.name || "machine"}…`;
  try {
    const response = await apiFetch("/api/machine", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ machineId }),
    });
    const snapshot = await response.json();
    if (!response.ok) throw new Error(snapshot.error || "Could not switch machines");
    applySnapshot(snapshot, false);
    switchingMachine = false;
    await Promise.all([refreshMachines(), refreshLoadedThreads()]);
    renderState();
    connectEvents();
    await loadHistory(null, historyEpoch, true);
  } catch (error) {
    switchingMachine = false;
    elements.statusDetail.textContent = error.message;
    try {
      const response = await apiFetch("/api/state");
      applySnapshot(await response.json(), true);
      await Promise.all([refreshMachines(), refreshLoadedThreads()]);
    } catch {
      setConnection(false, true);
    }
    renderState();
    connectEvents();
  }
}

async function selectThread(threadId) {
  if (!threadId || threadId === state?.thread?.id || switchingMachine || switchingThread) return;
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
    thread: { id: threadId, name: selected?.name || selected?.preview || "Switching task", cwd: selected?.cwd || "", source: "unknown" },
    threadStatus: selected?.status || "unknown",
    phase: "connecting",
    turn: null,
    plan: [],
    activities: [],
    pending: [],
    liveMessages: [],
    queuedMessage: null,
    model: "Not exposed",
    reasoningEffort: "Not exposed",
    access: null,
  };
  renderState();
  renderConversation({ forceBottom: true });
  elements.statusDetail.textContent = "Switching loaded task…";
  try {
    const response = await apiFetch("/api/thread", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ machineId: state?.machineId, threadId }),
    });
    const snapshot = await response.json();
    if (!response.ok) throw new Error(snapshot.error || "Could not switch tasks");
    applySnapshot(snapshot, false);
    switchingThread = false;
    renderState();
    connectEvents();
    await loadHistory(null, historyEpoch, true);
    await refreshLoadedThreads();
  } catch (error) {
    switchingThread = false;
    elements.statusDetail.textContent = error.message;
    try {
      const response = await apiFetch("/api/state");
      applySnapshot(await response.json(), true);
    } catch {
      setConnection(false, true);
    }
    renderState();
    connectEvents();
  }
}

async function submitMessage(action) {
  const text = elements.messageText.value;
  if (!text.trim() || submittingMessage || switchingMachine || switchingThread) return;
  submittingMessage = true;
  composerError = "";
  composerNotice = "";
  renderState();
  try {
    const response = await apiFetch("/api/message", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ machineId: state?.machineId, text, action }),
    });
    const result = await response.json();
    if (!response.ok || !result.accepted) throw new Error(result.error || "Codex did not accept the message");
    elements.messageText.value = "";
    composerNotice = result.mode === "queue" ? "Saved for the next turn." : result.mode === "steer" ? "Steered the active turn." : "Message accepted.";
    mergeState({
      ...(result.turn ? { turn: result.turn } : {}),
      ...(result.phase ? { phase: result.phase } : {}),
      ...(result.message ? { message: result.message } : {}),
      ...(Object.hasOwn(result, "queuedMessage") ? { queuedMessage: result.queuedMessage } : {}),
    });
  } catch (error) {
    composerError = error.message;
  } finally {
    submittingMessage = false;
    renderState();
  }
}

async function cancelQueuedMessage() {
  if (cancellingQueue) return;
  cancellingQueue = true;
  renderQueue();
  try {
    const url = new URL("/api/message/queue", location.origin);
    url.searchParams.set("machineId", state?.machineId || "");
    const response = await apiFetch(url, { method: "DELETE" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not cancel queued message");
    mergeState({ queuedMessage: null });
    composerNotice = "Queued message cancelled.";
  } catch (error) {
    composerError = error.message;
  } finally {
    cancellingQueue = false;
    renderComposer();
  }
}

async function updateThreadSettings(model, effort) {
  if (updatingModel || switchingMachine || switchingThread || !state?.thread) return;
  updatingModel = true;
  composerError = "";
  composerNotice = "Updating model settings…";
  renderState();
  try {
    const response = await apiFetch("/api/thread/settings", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ machineId: state?.machineId, model, effort }),
    });
    const result = await response.json();
    if (!response.ok || !result.updated) throw new Error(result.error || "Could not update model settings");
    composerNotice = result.appliesTo === "next_turn" ? "Model settings saved for the next turn." : "Model settings updated.";
    mergeState({ model: result.model, reasoningEffort: result.reasoningEffort });
  } catch (error) {
    composerError = error.message;
  } finally {
    updatingModel = false;
    renderState();
  }
}

async function updateAccess(mode) {
  if (updatingAccess || switchingMachine || switchingThread || !state?.thread) return;
  updatingAccess = true;
  composerError = "";
  composerNotice = "Updating access…";
  renderState();
  try {
    const response = await apiFetch("/api/thread/access", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ machineId: state?.machineId, mode }),
    });
    const result = await response.json();
    if (!response.ok || !result.updated) throw new Error(result.error || "Could not update access");
    composerNotice = result.appliesTo === "next_turn" ? "Access saved for the next turn." : "Access updated.";
    mergeState({ access: result.access });
  } catch (error) {
    composerError = error.message;
  } finally {
    updatingAccess = false;
    renderState();
  }
}

async function resolveApproval(requestId, decision) {
  if (resolvingApproval || switchingMachine || switchingThread || !requestId) return;
  resolvingApproval = true;
  composerError = "";
  composerNotice = decision === "approve" ? "Approving…" : "Denying…";
  const pending = (state?.pending || []).map((request) => request.id === requestId ? { ...request, resolving: true } : request);
  mergeState({ pending });
  try {
    const response = await apiFetch("/api/approval", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ machineId: state?.machineId, requestId, decision }),
    });
    const result = await response.json();
    if (!response.ok || !result.accepted) throw new Error(result.error || "Codex did not accept the approval response");
    composerNotice = decision === "approve" ? "Approval sent." : "Denial sent.";
  } catch (error) {
    composerError = error.message;
    try {
      const response = await apiFetch("/api/state");
      if (response.ok) applySnapshot(await response.json(), false);
    } catch {
      // SSE/reconnect will restore the authoritative pending state.
    }
  } finally {
    resolvingApproval = false;
    renderState();
  }
}

function parseEvent(event) { return JSON.parse(event.data); }

async function handleEventError() {
  setConnection(false, true);
  try {
    const response = await fetch("/api/auth");
    const auth = await response.json();
    if (auth.required && !auth.authenticated) showLogin("Your session expired. Enter the PIN again.");
  } catch {
    // EventSource retries transient gateway outages itself.
  }
}

function connectEvents() {
  source?.close();
  source = new EventSource("/events");
  source.addEventListener("open", () => setConnection(true));
  source.addEventListener("error", handleEventError);
  source.addEventListener("snapshot", (event) => { if (!switchingThread) applySnapshot(parseEvent(event)); });
  source.addEventListener("status", (event) => { if (!switchingThread) mergeState(parseEvent(event)); });
  source.addEventListener("thread", (event) => { if (!switchingThread) mergeState({ thread: parseEvent(event) }); });
  source.addEventListener("settings", (event) => { if (!switchingThread) mergeState(parseEvent(event)); });
  source.addEventListener("queue", (event) => { if (!switchingThread) mergeState(parseEvent(event)); });
  source.addEventListener("turn", (event) => {
    if (switchingThread) return;
    const value = parseEvent(event);
    if (value.turn?.status && value.turn.status !== "inProgress") composerNotice = "";
    mergeState(value);
  });
  source.addEventListener("plan", (event) => { if (!switchingThread) mergeState({ plan: parseEvent(event) }); });
  source.addEventListener("request", (event) => { if (!switchingThread) mergeState(parseEvent(event)); });
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
    const existing = liveMessages.get(value.id) || { id: value.id, role: "assistant", text: "", createdAt: Date.now(), complete: false };
    existing.text += value.delta;
    existing.complete = false;
    liveMessages.set(value.id, existing);
    renderConversation();
  });
}

function isMobileInspector() { return matchMedia("(max-width: 860px)").matches; }
function openInspector() {
  if (isMobileInspector()) {
    elements.appShell.classList.add("inspector-open");
    elements.inspectorBackdrop.hidden = false;
  } else {
    elements.appShell.classList.remove("inspector-closed");
  }
  elements.inspectorButton.setAttribute("aria-expanded", "true");
}
function closeInspector() {
  elements.appShell.classList.remove("inspector-open");
  elements.inspectorBackdrop.hidden = true;
  if (!isMobileInspector()) elements.appShell.classList.add("inspector-closed");
  elements.inspectorButton.setAttribute("aria-expanded", "false");
}
function toggleInspector() {
  const open = isMobileInspector()
    ? elements.appShell.classList.contains("inspector-open")
    : !elements.appShell.classList.contains("inspector-closed");
  if (open) closeInspector(); else openInspector();
}

function closeSettings() {
  elements.settingsScreen.hidden = true;
  document.body.classList.remove("settings-open");
}

function machineSettingsValue() {
  return [...elements.settingsMachines.querySelectorAll(".machine-settings-row")].map((row) => ({
    name: row.querySelector("[data-machine-name]").value.trim(),
    ssh: row.querySelector("[data-machine-ssh]").value.trim(),
  }));
}

function renderMachineSettings(values) {
  elements.settingsMachines.replaceChildren();
  const configured = Array.isArray(values) ? values : [];
  if (!configured.length) {
    const empty = document.createElement("p");
    empty.className = "machine-settings-empty";
    empty.textContent = "Only This Mac is configured.";
    elements.settingsMachines.append(empty);
    return;
  }
  configured.forEach((machine, index) => {
    const row = document.createElement("div");
    row.className = "machine-settings-row";
    const name = document.createElement("input");
    name.dataset.machineName = "";
    name.type = "text";
    name.maxLength = 80;
    name.placeholder = "Name";
    name.setAttribute("aria-label", `Machine ${index + 1} name`);
    name.required = true;
    name.value = machine.name || "";
    const ssh = document.createElement("input");
    ssh.dataset.machineSsh = "";
    ssh.type = "text";
    ssh.maxLength = 128;
    ssh.pattern = "[A-Za-z0-9][A-Za-z0-9._-]*";
    ssh.placeholder = "SSH alias";
    ssh.autocomplete = "off";
    ssh.spellcheck = false;
    ssh.setAttribute("aria-label", `Machine ${index + 1} SSH alias`);
    ssh.required = true;
    ssh.value = machine.ssh || "";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-button";
    remove.setAttribute("aria-label", `Remove ${machine.name || `machine ${index + 1}`}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      const next = machineSettingsValue();
      next.splice(index, 1);
      renderMachineSettings(next);
    });
    row.append(name, ssh, remove);
    elements.settingsMachines.append(row);
  });
}

function renderSettings(value) {
  settingsValue = value;
  elements.settingsLanEnabled.checked = Boolean(value.lanEnabled);
  elements.settingsHost.value = value.host || "127.0.0.1";
  elements.settingsPort.value = String(value.port || 4173);
  elements.settingsPin.value = "";
  elements.settingsPin.placeholder = value.pinConfigured ? "Leave blank to keep current PIN" : "Enter 4 digits";
  elements.settingsPinState.textContent = value.pinConfigured ? "PIN configured. Enter a new PIN only to change it." : "No PIN configured.";
  renderMachineSettings(value.machines);
  elements.phoneUrlList.replaceChildren();
  const urls = Array.isArray(value.phoneUrls) ? value.phoneUrls : [];
  for (const url of urls) {
    const link = document.createElement("a");
    link.href = url;
    link.textContent = url;
    elements.phoneUrlList.append(link);
  }
  elements.phoneUrls.hidden = urls.length === 0;
}

async function openSettings() {
  elements.settingsScreen.hidden = false;
  document.body.classList.add("settings-open");
  elements.settingsStatus.textContent = "Loading settings…";
  elements.settingsStatus.classList.remove("error-text");
  elements.settingsRestart.hidden = true;
  try {
    const response = await apiFetch("/api/settings");
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Settings unavailable");
    renderSettings(result.settings);
    elements.settingsRestart.hidden = !result.restartRequired;
    elements.settingsStatus.textContent = "";
    elements.settingsLanEnabled.focus();
  } catch (error) {
    elements.settingsStatus.textContent = error.message;
    elements.settingsStatus.classList.add("error-text");
  }
}

elements.machineSelect.addEventListener("change", () => selectMachine(elements.machineSelect.value));
elements.machineSelect.addEventListener("focus", refreshMachines);
elements.threadSelect.addEventListener("change", () => selectThread(elements.threadSelect.value));
elements.threadSelect.addEventListener("focus", refreshLoadedThreads);
elements.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  submitMessage(state?.message?.mode === "steer" ? "steer" : "start");
});
elements.queueMessage.addEventListener("click", () => submitMessage("queue"));
elements.cancelQueue.addEventListener("click", cancelQueuedMessage);
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
elements.modelSelect.addEventListener("change", () => {
  const model = currentCatalogModel(elements.modelSelect.value);
  const efforts = model?.supportedReasoningEfforts || [];
  const effort = efforts.some((option) => option.reasoningEffort === state?.reasoningEffort)
    ? state.reasoningEffort
    : model?.defaultReasoningEffort || efforts[0]?.reasoningEffort;
  if (model && effort) updateThreadSettings(model.model, effort);
});
elements.effortSelect.addEventListener("change", () => updateThreadSettings(elements.modelSelect.value, elements.effortSelect.value));
elements.accessSelect.addEventListener("change", () => updateAccess(elements.accessSelect.value));
elements.conversation.addEventListener("scroll", () => {
  shouldFollowConversation = elements.conversation.scrollHeight - elements.conversation.scrollTop - elements.conversation.clientHeight < 80;
  if (!shouldFollowConversation && elements.conversation.scrollTop < 140 && nextCursor && !historyRequest) loadHistory(nextCursor, historyEpoch, false);
});
elements.inspectorButton.addEventListener("click", toggleInspector);
elements.inspectorClose.addEventListener("click", closeInspector);
elements.inspectorBackdrop.addEventListener("click", closeInspector);

setInterval(() => {
  const startedAt = state?.turn?.startedAt;
  const completedAt = state?.turn?.completedAt;
  elements.elapsed.textContent = startedAt ? formatElapsed((completedAt || Date.now()) - startedAt) : "—";
}, 1_000);

elements.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = elements.loginForm.querySelector("button");
  button.disabled = true;
  elements.loginError.textContent = "Checking…";
  try {
    const response = await fetch("/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: elements.loginPin.value }),
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

elements.settingsButton.addEventListener("click", openSettings);
elements.settingsClose.addEventListener("click", closeSettings);
elements.settingsCancel.addEventListener("click", closeSettings);
elements.settingsScreen.addEventListener("click", (event) => { if (event.target === elements.settingsScreen) closeSettings(); });
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!elements.settingsScreen.hidden) closeSettings(); else closeInspector();
});
elements.settingsLanEnabled.addEventListener("change", () => {
  if (elements.settingsLanEnabled.checked && elements.settingsHost.value === "127.0.0.1") elements.settingsHost.value = "0.0.0.0";
});
elements.settingsPin.addEventListener("input", () => {
  elements.settingsPin.value = elements.settingsPin.value.replace(/\D/g, "").slice(0, 4);
  elements.settingsStatus.textContent = "";
  elements.settingsStatus.classList.remove("error-text");
});
elements.machineAdd.addEventListener("click", () => {
  const next = machineSettingsValue();
  next.push({ name: "", ssh: "" });
  renderMachineSettings(next);
  elements.settingsMachines.querySelector(".machine-settings-row:last-child [data-machine-name]")?.focus();
});
elements.settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (savingSettings) return;
  const pin = elements.settingsPin.value;
  if (elements.settingsLanEnabled.checked && !settingsValue?.pinConfigured && !/^\d{4}$/.test(pin)) {
    elements.settingsStatus.textContent = "Set a four-digit PIN before enabling LAN access.";
    elements.settingsStatus.classList.add("error-text");
    elements.settingsPin.focus();
    return;
  }
  savingSettings = true;
  elements.settingsSave.disabled = true;
  elements.settingsStatus.textContent = "Saving…";
  elements.settingsStatus.classList.remove("error-text");
  try {
    const response = await apiFetch("/api/settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lanEnabled: elements.settingsLanEnabled.checked,
        host: elements.settingsHost.value.trim(),
        port: Number(elements.settingsPort.value),
        pin,
        machines: machineSettingsValue(),
      }),
    });
    const result = await response.json();
    if (!response.ok || !result.saved) throw new Error(result.error || "Could not save settings");
    renderSettings(result.settings);
    elements.settingsRestart.hidden = !result.restartRequired;
    elements.settingsStatus.textContent = "Settings saved.";
  } catch (error) {
    elements.settingsStatus.textContent = error.message;
    elements.settingsStatus.classList.add("error-text");
  } finally {
    savingSettings = false;
    elements.settingsSave.disabled = false;
  }
});
elements.restartPocket.addEventListener("click", async () => {
  if (restartingPocket) return;
  restartingPocket = true;
  elements.restartPocket.disabled = true;
  elements.settingsStatus.textContent = "Preparing restart…";
  elements.settingsStatus.classList.remove("error-text");
  try {
    const response = await apiFetch("/api/restart", { method: "POST" });
    const result = await response.json();
    if (!response.ok || !result.restarting || !result.localUrl) throw new Error(result.error || "Could not restart Pocket");
    elements.settingsStatus.textContent = "Restarting Pocket…";
    setTimeout(() => location.assign(result.localUrl), 900);
  } catch (error) {
    restartingPocket = false;
    elements.restartPocket.disabled = false;
    elements.settingsStatus.textContent = error.message;
    elements.settingsStatus.classList.add("error-text");
  }
});

async function startApp() {
  elements.loginScreen.hidden = true;
  elements.appShell.hidden = false;
  try {
    const response = await apiFetch("/api/state");
    applySnapshot(await response.json(), false);
    await Promise.all([refreshMachines(), refreshLoadedThreads()]);
  } catch (error) {
    elements.statusDetail.textContent = error.message;
    setConnection(false, true);
  }
  await loadHistory(null, historyEpoch, true);
  connectEvents();
}

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
