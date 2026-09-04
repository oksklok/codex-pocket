const elements = {
  appShell: document.querySelector("#app-shell"),
  loginScreen: document.querySelector("#login-screen"),
  stoppedScreen: document.querySelector("#stopped-screen"),
  loginForm: document.querySelector("#login-form"),
  loginPin: document.querySelector("#login-pin"),
  loginError: document.querySelector("#login-error"),
  connection: document.querySelector("#connection"),
  connectionLabel: document.querySelector("#connection-label"),
  phase: document.querySelector("#phase-pill"),
  elapsed: document.querySelector("#elapsed"),
  quota: document.querySelector("#quota-chip"),
  machine: document.querySelector("#machine"),
  project: document.querySelector("#project"),
  destinationButton: document.querySelector("#destination-button"),
  destinationLabel: document.querySelector("#destination-label"),
  destinationSwitcher: document.querySelector("#destination-switcher"),
  destinationBackdrop: document.querySelector("#destination-backdrop"),
  destinationSearch: document.querySelector("#destination-search"),
  destinationClose: document.querySelector("#destination-close"),
  destinationList: document.querySelector("#destination-list"),
  modelSelect: document.querySelector("#model-select"),
  effortSelect: document.querySelector("#effort-select"),
  accessSelect: document.querySelector("#access-select"),
  historyStatus: document.querySelector("#history-status"),
  conversation: document.querySelector("#conversation"),
  jumpLatest: document.querySelector("#jump-latest"),
  planPanel: document.querySelector("#plan-panel"),
  planList: document.querySelector("#plan-list"),
  planCount: document.querySelector("#plan-count"),
  displayCommands: document.querySelector("#display-commands"),
  displayReasoning: document.querySelector("#display-reasoning"),
  displayCollaboration: document.querySelector("#display-collaboration"),
  displayImages: document.querySelector("#display-images"),
  displayCompaction: document.querySelector("#display-compaction"),
  expandCommands: document.querySelector("#expand-commands"),
  expandFiles: document.querySelector("#expand-files"),
  composer: document.querySelector("#composer"),
  messageText: document.querySelector("#message-text"),
  sendMessage: document.querySelector("#send-message"),
  steerMessage: document.querySelector("#steer-message"),
  composerStatus: document.querySelector("#composer-status"),
  attentionBanner: document.querySelector("#attention-banner"),
  queueBanner: document.querySelector("#queue-banner"),
  queueText: document.querySelector("#queue-text"),
  sendQueue: document.querySelector("#send-queue"),
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
  settingsTheme: document.querySelector("#settings-theme"),
  settingsLocalName: document.querySelector("#settings-local-name"),
  settingsMachines: document.querySelector("#settings-machines"),
  machineAdd: document.querySelector("#machine-add"),
  settingsRestart: document.querySelector("#settings-restart"),
  restartPocket: document.querySelector("#restart-pocket"),
  quitPocket: document.querySelector("#quit-pocket"),
  phoneUrls: document.querySelector("#phone-urls"),
  phoneUrlList: document.querySelector("#phone-url-list"),
  settingsStatus: document.querySelector("#settings-status"),
};

const markdown = window.markdownit({ html: false, linkify: false, breaks: true, typographer: false });
const defaultLinkOpen = markdown.renderer.rules.link_open
  || ((tokens, index, options, environment, renderer) => renderer.renderToken(tokens, index, options));
markdown.renderer.rules.link_open = (tokens, index, options, environment, renderer) => {
  const href = tokens[index].attrGet("href") || "";
  if (!/^(?:https?:|mailto:)/i.test(href)) tokens[index].attrSet("href", "#");
  tokens[index].attrSet("target", "_blank");
  tokens[index].attrSet("rel", "noopener noreferrer");
  return defaultLinkOpen(tokens, index, options, environment, renderer);
};

function renderMarkdownInto(element, value) {
  element.classList.add("markdown");
  element.innerHTML = markdown.render(String(value || ""));
}

const phaseLabels = {
  connecting: "Connecting",
  unavailable: "Unavailable",
  working: "Working",
  waiting_input: "Waiting for input",
  waiting_permission: "Waiting for approval",
  done: "Done",
  stopped: "Stopped",
  failed: "Failed",
};

let state = null;
let historyMessages = new Map();
let liveMessages = new Map();
let historyActivities = new Map();
let liveActivities = new Map();
let loadedThreads = [];
let machines = [];
let nextCursor = null;
let source = null;
let shouldFollowConversation = true;
let historyEpoch = 0;
let historyRequest = null;
let threadsRequest = null;
let machinesRequest = null;
let navigationCatalog = null;
let navigationRequest = null;
let destinationSelection = null;
let destinationError = "";
let switchingThread = false;
let switchingMachine = false;
let submittingMessage = false;
let updatingModel = false;
let updatingAccess = false;
let resolvingApproval = false;
let submittingInputRequestId = null;
const inputDrafts = new Map();
let submittingInterrupt = false;
let sendingQueuedMessage = false;
let cancellingQueue = false;
let composerError = "";
let composerNotice = "";
let settingsValue = null;
let savingSettings = false;
let restartingPocket = false;
let quittingPocket = false;
let intentionalQuit = false;
const activityDetails = new Map();
const activityDetailRequests = new Map();
const activityDetailVersions = new Map();
const terminalDetailRefreshes = new Set();

const DISPLAY_STORAGE_KEY = "codex-pocket-info-display";
const THEME_STORAGE_KEY = "codex-pocket-theme";
const displayPreferences = loadDisplayPreferences();
let selectedTheme = loadTheme();

function loadTheme() {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function applyTheme(theme = selectedTheme) {
  document.documentElement.dataset.theme = theme;
}

applyTheme();

function loadDisplayPreferences() {
  const defaults = {
    commands: true, reasoning: true, collaboration: true, images: true, compaction: true,
    expandCommands: false, expandFiles: false,
  };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(DISPLAY_STORAGE_KEY) || "{}") };
  } catch {
    return defaults;
  }
}

function saveDisplayPreferences() {
  try { localStorage.setItem(DISPLAY_STORAGE_KEY, JSON.stringify(displayPreferences)); } catch {}
}

function activityVisible(activity) {
  if (activity.kind === "reasoning") return displayPreferences.reasoning;
  if (activity.kind === "collaboration") return displayPreferences.collaboration;
  if (activity.kind === "image") return displayPreferences.images;
  if (activity.kind === "compaction") return displayPreferences.compaction;
  return displayPreferences.commands;
}

function activityExpandsByDefault(activity) {
  return (activity.kind === "command" && displayPreferences.expandCommands)
    || (activity.kind === "files" && displayPreferences.expandFiles);
}

function effortLabel(value) {
  const normalized = String(value || "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  const labels = { none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", "extra high": "Extra High", max: "Max", ultra: "Ultra" };
  return labels[normalized] || normalized.replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Effort unavailable";
}

function accessLabel(access) {
  return ({ ask: "Ask for approval", auto: "Approve for me", full: "Full access", custom: "Custom access", unavailable: "Access unavailable" })[access?.mode] || "Access unavailable";
}

function showLogin(message = "") {
  source?.close();
  source = null;
  closeSettings();
  elements.appShell.hidden = true;
  elements.stoppedScreen.hidden = true;
  elements.loginScreen.hidden = false;
  elements.loginError.textContent = message;
  elements.loginPin.focus();
}

function showStopped() {
  intentionalQuit = true;
  source?.close();
  source = null;
  closeSettings();
  elements.loginScreen.hidden = true;
  elements.appShell.hidden = true;
  elements.stoppedScreen.hidden = false;
}

async function apiFetch(url, options) {
  const response = await fetch(url, options);
  if (response.status === 401) {
    showLogin("Session expired. Enter PIN.");
    throw new Error("Authentication required");
  }
  return response;
}

function projectName(cwd) {
  const parts = String(cwd || "").split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || "—";
}

function platformLabel(value) {
  const normalized = String(value || "").toLowerCase();
  if (normalized.includes("windows")) return "Windows";
  if (normalized.includes("macos") || normalized.includes("darwin")) return "macOS";
  if (normalized.includes("linux")) return "Linux";
  const first = normalized.split(/[\/·]/).map((part) => part.trim()).find(Boolean);
  return first ? first.replace(/\b\w/g, (letter) => letter.toUpperCase()) : "";
}

function setHistoryStatus(message = "") {
  elements.historyStatus.textContent = message;
  elements.historyStatus.hidden = !message;
}

function formatElapsed(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  const total = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

function formatQuotaReset(value) {
  const reset = new Date(value);
  if (!Number.isFinite(reset.getTime())) return "unknown time";
  const now = new Date();
  const sameDay = reset.getFullYear() === now.getFullYear()
    && reset.getMonth() === now.getMonth()
    && reset.getDate() === now.getDate();
  return reset.toLocaleString([], sameDay
    ? { hour: "2-digit", minute: "2-digit" }
    : { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

function renderQuota() {
  const quota = state?.quota;
  const windows = quota?.available && Array.isArray(quota.windows) ? quota.windows : [];
  if (windows.length === 0) {
    elements.quota.replaceChildren();
    elements.quota.textContent = "Quota —";
    elements.quota.title = "Quota unavailable";
    elements.quota.setAttribute("aria-label", "Quota unavailable");
    elements.quota.classList.remove("multiple", "stale");
    return;
  }
  elements.quota.replaceChildren();
  elements.quota.classList.toggle("multiple", windows.length > 1);
  elements.quota.classList.toggle("stale", Boolean(quota.stale));
  for (const window of windows) {
    const value = Math.min(100, Math.max(0, Math.round(window.remainingPercent)));
    const item = document.createElement("span");
    item.className = "quota-window";
    const label = document.createElement("span");
    label.className = "quota-label";
    label.textContent = window.label;
    const percent = document.createElement("span");
    percent.className = "quota-percent";
    percent.textContent = `${value}%`;
    const track = document.createElement("span");
    track.className = "quota-track";
    const fill = document.createElement("span");
    fill.className = "quota-fill";
    fill.style.width = `${value}%`;
    track.append(fill);
    item.append(label, percent, track);
    elements.quota.append(item);
  }
  const source = quota.sourceMachine ? ` via ${quota.sourceMachine}` : "";
  const stale = quota.stale ? " · last known" : "";
  elements.quota.title = `${windows.map((window) => {
    const reset = window.resetsAt ? ` · resets ${formatQuotaReset(window.resetsAt)}` : "";
    return `${window.label}: ${Math.round(window.remainingPercent)}% left${reset}`;
  }).join("\n")}${source}${stale}`;
  elements.quota.setAttribute("aria-label", elements.quota.title.replaceAll("\n", "; "));
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

function renderDestinationButton() {
  const machine = machines.find((candidate) => candidate.id === state?.machineId);
  const machineName = machine?.name || state?.machine || "Machine";
  const selectedThread = loadedThreads.find((thread) => thread.id === state?.thread?.id) || state?.thread;
  const taskName = selectedThread ? threadLabel(selectedThread) : state?.connected ? "No saved task" : "Unavailable";
  elements.destinationLabel.textContent = `${machineName} / ${taskName}`;
  elements.destinationButton.title = `${machineName} / ${taskName}`;
  elements.destinationButton.disabled = switchingMachine || switchingThread || submittingMessage || updatingModel
    || updatingAccess || resolvingApproval || submittingInputRequestId || submittingInterrupt;
}

async function refreshMachines() {
  if (machinesRequest) return machinesRequest;
  machinesRequest = (async () => {
    const response = await apiFetch("/api/machines");
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || "Machines unavailable");
    machines = Array.isArray(value.machines) ? value.machines : [];
    renderDestinationButton();
  })();
  try {
    await machinesRequest;
  } finally {
    machinesRequest = null;
  }
}

function destinationTaskStatus(machine, task) {
  const current = machine.id === state?.machineId && task.id === state?.thread?.id;
  const phase = current ? state?.phase : task.phase;
  if (phase === "waiting_permission" || phase === "waiting_input") return "Waiting";
  if (phase === "failed" || /failed|error/i.test(String(task.status || ""))) return "Failed";
  if (phase === "working" || String(task.status || "").startsWith("active")) return "Working";
  return "";
}

function renderDestinationSwitcher() {
  if (elements.destinationSwitcher.hidden) return;
  elements.destinationList.replaceChildren();
  const query = elements.destinationSearch.value.trim().toLowerCase();
  const catalogMachines = Array.isArray(navigationCatalog?.machines) ? navigationCatalog.machines : [];
  if (navigationRequest && !catalogMachines.length) {
    const loading = document.createElement("p");
    loading.className = "destination-empty";
    loading.textContent = "Loading tasks…";
    elements.destinationList.append(loading);
    return;
  }
  for (const machine of catalogMachines) {
    const machineMatches = `${machine.name || ""} ${machine.platform || ""}`.toLowerCase().includes(query);
    const tasks = (Array.isArray(machine.tasks) ? machine.tasks : []).filter((task) => {
      if (!query || machineMatches) return true;
      return `${task.name || ""} ${task.preview || ""} ${task.project || ""} ${task.cwd || ""}`.toLowerCase().includes(query);
    });
    if (query && !machineMatches && !tasks.length) continue;

    const group = document.createElement("section");
    group.className = `destination-group ${machine.connected ? "" : "offline"}`;
    const heading = document.createElement("div");
    heading.className = "destination-group-heading";
    const name = document.createElement("strong");
    name.textContent = machine.name || "Machine";
    heading.append(name);
    if (!machine.connected) {
      const offline = document.createElement("span");
      offline.textContent = "Offline";
      heading.append(offline);
    }
    group.append(heading);

    for (const task of tasks) {
      const selected = machine.id === state?.machineId && task.id === state?.thread?.id;
      const row = document.createElement("button");
      row.type = "button";
      row.className = `destination-task ${selected ? "selected" : ""}`;
      row.disabled = !machine.connected || Boolean(destinationSelection);
      if (selected) row.setAttribute("aria-current", "true");
      row.title = task.cwd || task.id;
      const check = document.createElement("span");
      check.className = "destination-check";
      check.textContent = selected ? "✓" : "";
      const label = document.createElement("span");
      label.className = "destination-task-label";
      label.textContent = threadLabel(task);
      const status = document.createElement("span");
      status.className = "destination-task-status";
      status.textContent = destinationSelection?.machineId === machine.id && destinationSelection?.threadId === task.id
        ? "Opening…"
        : destinationTaskStatus(machine, task);
      row.append(check, label, status);
      row.addEventListener("click", () => selectDestination(machine.id, task.id));
      group.append(row);
    }

    if (!tasks.length) {
      const empty = document.createElement("p");
      empty.className = "destination-group-empty";
      empty.textContent = machine.connected ? (query ? "No matching saved tasks" : "No saved tasks") : "Machine unavailable";
      group.append(empty);
    }
    elements.destinationList.append(group);
  }
  if (!catalogMachines.length || (query && !elements.destinationList.childElementCount)) {
    const empty = document.createElement("p");
    empty.className = "destination-empty";
    empty.textContent = query ? "No matching tasks" : "Task catalog unavailable";
    elements.destinationList.append(empty);
  }
  if (destinationError) {
    const error = document.createElement("p");
    error.className = "destination-error";
    error.textContent = destinationError;
    elements.destinationList.prepend(error);
  }
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
    if (!response.ok) throw new Error(value.error || "Saved tasks unavailable");
    if (requestedMachineId !== state?.machineId) return;
    loadedThreads = Array.isArray(value.threads) ? value.threads : [];
    renderDestinationButton();
  })();
  threadsRequest = token;
  try {
    await token.promise;
  } catch (error) {
    if (requestedMachineId === state?.machineId) {
      loadedThreads = [];
      renderDestinationButton();
      setHistoryStatus(error.message);
    }
  } finally {
    if (threadsRequest === token) threadsRequest = null;
  }
}

async function refreshNavigationCatalog() {
  if (navigationRequest) return navigationRequest;
  navigationRequest = (async () => {
    const response = await apiFetch("/api/navigation");
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || "Task catalog unavailable");
    navigationCatalog = value;
    destinationError = "";
  })();
  try {
    await navigationRequest;
  } catch (error) {
    destinationError = error.message || "Task catalog unavailable";
  } finally {
    navigationRequest = null;
    renderDestinationSwitcher();
  }
}

function closeDestinationSwitcher() {
  if (destinationSelection) return false;
  elements.destinationSwitcher.hidden = true;
  elements.destinationBackdrop.hidden = true;
  elements.destinationButton.setAttribute("aria-expanded", "false");
  document.body.classList.remove("destination-open");
  elements.destinationSearch.value = "";
  destinationError = "";
  return true;
}

function openDestinationSwitcher() {
  if (switchingMachine || switchingThread) return;
  elements.destinationSwitcher.hidden = false;
  elements.destinationBackdrop.hidden = false;
  elements.destinationButton.setAttribute("aria-expanded", "true");
  document.body.classList.add("destination-open");
  refreshNavigationCatalog();
  renderDestinationSwitcher();
  elements.destinationSearch.focus();
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
    option.textContent = effortLabel(effort.reasoningEffort);
    option.title = effort.description || effort.reasoningEffort;
    option.selected = effort.reasoningEffort === state?.reasoningEffort;
    elements.effortSelect.append(option);
  }
  if (!efforts.length) {
    const option = document.createElement("option");
    option.textContent = effortLabel(state?.reasoningEffort);
    elements.effortSelect.append(option);
  }
  const enabled = Boolean(state?.connected && state?.thread && models.length)
    && !switchingThread
    && !updatingModel
    && !updatingAccess
    && !resolvingApproval
    && !submittingInputRequestId
    && !submittingInterrupt;
  elements.modelSelect.disabled = !enabled;
  elements.effortSelect.disabled = !enabled || !efforts.length;
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
    || resolvingApproval
    || submittingInputRequestId
    || submittingInterrupt;
  elements.accessSelect.classList.toggle("full-access", access?.mode === "full");
  elements.accessSelect.title = access?.mode === "full"
    ? "Unrestricted access to files and network"
    : access?.description || access?.profileId || "Task access";
}

function renderPlan() {
  const plan = state?.plan || [];
  const complete = plan.filter((item) => item.status === "completed").length;
  elements.planPanel.hidden = plan.length === 0;
  elements.planCount.textContent = `${complete}/${plan.length}`;
  elements.planList.replaceChildren();
  for (const item of plan) {
    const li = document.createElement("li");
    li.className = `plan-item ${item.status}`;
    li.textContent = item.step;
    elements.planList.append(li);
  }
}

function renderDisplayControls() {
  elements.displayCommands.checked = displayPreferences.commands;
  elements.displayReasoning.checked = displayPreferences.reasoning;
  elements.displayCollaboration.checked = displayPreferences.collaboration;
  elements.displayImages.checked = displayPreferences.images;
  elements.displayCompaction.checked = displayPreferences.compaction;
  elements.expandCommands.checked = displayPreferences.expandCommands;
  elements.expandFiles.checked = displayPreferences.expandFiles;
}

function renderQueue() {
  const queued = state?.queuedMessage;
  elements.queueBanner.hidden = !queued;
  if (queued) {
    elements.queueText.textContent = queued.text;
    elements.queueText.title = queued.text;
    const canSend = state?.message?.mode === "start" && state?.turn?.status !== "inProgress";
    elements.sendQueue.hidden = !canSend;
    elements.sendQueue.disabled = sendingQueuedMessage || cancellingQueue || switchingMachine || switchingThread;
    elements.sendQueue.textContent = sendingQueuedMessage ? "Sending…" : "Send";
    elements.cancelQueue.disabled = cancellingQueue || sendingQueuedMessage;
  }
}

function inputDraft(requestId, questionId) {
  let requestDraft = inputDrafts.get(requestId);
  if (!requestDraft) {
    requestDraft = new Map();
    inputDrafts.set(requestId, requestDraft);
  }
  return {
    get: () => requestDraft.get(questionId),
    set: (value) => requestDraft.set(questionId, value),
  };
}

function renderStructuredInput(pending) {
  const heading = document.createElement("div");
  heading.className = "approval-heading";
  const title = document.createElement("strong");
  title.textContent = "Input needed";
  const behavior = document.createElement("span");
  behavior.textContent = pending.blocking === false ? "Non-blocking" : "Turn paused";
  heading.append(title, behavior);
  elements.attentionBanner.append(heading);

  if (!pending.supported || !Array.isArray(pending.questions)) {
    const unsupported = document.createElement("div");
    unsupported.className = "approval-detail";
    unsupported.textContent = "Handle this request in the local Codex client.";
    elements.attentionBanner.append(unsupported);
    return;
  }
  const requestDisabled = Boolean(submittingInputRequestId || pending.resolving || state?.stoppingTurnId);

  const form = document.createElement("form");
  form.className = "structured-input-form";
  pending.questions.forEach((question, questionIndex) => {
    const draft = inputDraft(pending.id, question.id);
    const fieldset = document.createElement("fieldset");
    fieldset.className = "input-question";
    const legend = document.createElement("legend");
    legend.textContent = question.header || `Question ${questionIndex + 1}`;
    const prompt = document.createElement("div");
    prompt.className = "input-prompt";
    prompt.textContent = question.question;
    fieldset.append(legend, prompt);

    if (Array.isArray(question.options)) {
      const choices = document.createElement("div");
      choices.className = "input-choices";
      question.options.forEach((option, optionIndex) => {
        const row = document.createElement("label");
        row.className = "input-choice";
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = `input-${questionIndex}`;
        radio.checked = draft.get()?.type === "option" && draft.get()?.optionIndex === optionIndex;
        radio.disabled = requestDisabled;
        radio.addEventListener("change", () => {
          if (radio.checked) draft.set({ type: "option", optionIndex });
        });
        const copy = document.createElement("span");
        const label = document.createElement("strong");
        label.textContent = option.label;
        copy.append(label);
        if (option.description) {
          const description = document.createElement("small");
          description.textContent = option.description;
          copy.append(description);
        }
        row.append(radio, copy);
        choices.append(row);
      });
      if (question.isOther) {
        const row = document.createElement("label");
        row.className = "input-choice input-other";
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = `input-${questionIndex}`;
        radio.checked = draft.get()?.type === "other";
        radio.disabled = requestDisabled;
        const copy = document.createElement("span");
        const label = document.createElement("strong");
        label.textContent = "Other";
        const other = document.createElement("input");
        other.type = question.isSecret ? "password" : "text";
        other.maxLength = 4000;
        other.autocomplete = "off";
        other.placeholder = "Type another answer";
        other.value = draft.get()?.type === "other" ? draft.get().value || "" : "";
        other.disabled = requestDisabled;
        const selectOther = () => {
          radio.checked = true;
          draft.set({ type: "other", value: other.value });
        };
        radio.addEventListener("change", selectOther);
        other.addEventListener("focus", selectOther);
        other.addEventListener("input", selectOther);
        copy.append(label, other);
        row.append(radio, copy);
        choices.append(row);
      }
      fieldset.append(choices);
    } else {
      const answer = question.isSecret ? document.createElement("input") : document.createElement("textarea");
      answer.className = "input-free-text";
      if (question.isSecret) {
        answer.type = "password";
        answer.autocomplete = "off";
      } else {
        answer.rows = 2;
      }
      answer.maxLength = 4000;
      answer.placeholder = question.isSecret ? "Enter private answer" : "Type your answer";
      answer.value = draft.get()?.type === "text" ? draft.get().value || "" : "";
      answer.disabled = requestDisabled;
      answer.addEventListener("input", () => draft.set({ type: "text", value: answer.value }));
      fieldset.append(answer);
    }
    form.append(fieldset);
  });

  const actions = document.createElement("div");
  actions.className = "approval-actions";
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "approval-approve";
  submit.textContent = submittingInputRequestId === pending.id || pending.resolving ? "Sending…" : "Send answer";
  submit.disabled = requestDisabled;
  actions.append(submit);
  form.append(actions);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitStructuredInput(pending);
  });
  elements.attentionBanner.append(form);
}

function renderAttention() {
  const pending = state?.pending?.[0];
  const currentInputIds = new Set((state?.pending || []).filter((request) => request.kind === "input").map((request) => request.id));
  for (const requestId of inputDrafts.keys()) if (!currentInputIds.has(requestId)) inputDrafts.delete(requestId);
  elements.attentionBanner.replaceChildren();
  elements.attentionBanner.hidden = !pending;
  if (!pending) return;
  if (pending.kind === "input") {
    renderStructuredInput(pending);
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
  deny.disabled = resolvingApproval || pending.resolving || Boolean(state?.stoppingTurnId);
  deny.addEventListener("click", () => resolveApproval(pending.id, "deny"));
  const approve = document.createElement("button");
  approve.type = "button";
  approve.className = "approval-approve";
  approve.textContent = pending.resolving ? "Sending…" : "Approve";
  approve.disabled = resolvingApproval || pending.resolving || Boolean(state?.stoppingTurnId);
  approve.addEventListener("click", () => resolveApproval(pending.id, "approve"));
  actions.append(deny, approve);
  elements.attentionBanner.append(actions);
}

function renderComposer() {
  const capability = state?.message;
  const turnActive = state?.turn?.status === "inProgress" && Boolean(state?.turn?.id);
  const stopping = submittingInterrupt || (turnActive && state?.stoppingTurnId === state?.turn?.id);
  const hasText = Boolean(elements.messageText.value.trim());
  const allowed = Boolean(capability?.allowed)
    && !switchingMachine
    && !switchingThread
    && !submittingMessage
    && !updatingAccess
    && !resolvingApproval
    && !submittingInputRequestId
    && !stopping;
  elements.messageText.disabled = !state?.connected
    || !state?.thread
    || switchingMachine
    || switchingThread
    || submittingMessage
    || stopping;
  elements.steerMessage.hidden = !(turnActive && hasText);
  elements.steerMessage.disabled = !allowed;
  if (turnActive && !hasText) {
    elements.sendMessage.dataset.action = "stop";
    elements.sendMessage.textContent = stopping ? "Stopping…" : "Stop";
    elements.sendMessage.classList.add("stop-action");
    elements.sendMessage.disabled = stopping || switchingMachine || switchingThread;
  } else {
    elements.sendMessage.dataset.action = turnActive ? "queue" : "start";
    elements.sendMessage.textContent = "Send";
    elements.sendMessage.classList.remove("stop-action");
    elements.sendMessage.disabled = !allowed || !hasText;
  }
  const status = submittingMessage
    ? "Sending…"
    : stopping
      ? "Stopping the active turn…"
    : resolvingApproval
      ? "Sending approval response…"
      : submittingInputRequestId
        ? "Sending structured answer…"
      : updatingAccess
        ? "Updating access…"
    : composerError
      || composerNotice
      || (switchingMachine ? "Switching machines…" : switchingThread ? "Switching tasks…" : capability?.reason)
      || "";
  elements.composerStatus.textContent = status;
  elements.composerStatus.classList.toggle("error-text", Boolean(composerError));
  renderAttention();
  renderQueue();
}

function resizeComposer() {
  elements.messageText.style.height = "auto";
  elements.messageText.style.height = `${Math.min(elements.messageText.scrollHeight, 112)}px`;
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
  setConnection(Boolean(state.connected), state.phase === "failed" || state.phase === "unavailable");
  const phase = state.phase || "connecting";
  elements.phase.textContent = phaseLabels[phase] || phase;
  elements.phase.className = `phase-pill ${phase}`;
  const startedAt = state.turn?.startedAt;
  const completedAt = state.turn?.completedAt;
  elements.elapsed.textContent = startedAt ? formatElapsed((completedAt || Date.now()) - startedAt) : "—";
  elements.machine.textContent = [state.machine, platformLabel(state.platform)].filter(Boolean).join(" · ") || "—";
  elements.project.textContent = state.thread?.cwd || "—";
  elements.project.title = state.thread?.cwd || "";
  renderDestinationButton();
  renderDestinationSwitcher();
  renderModelControls();
  renderAccessControl();
  renderPlan();
  renderDisplayControls();
  renderQuota();
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
  renderMarkdownInto(body, message.text);
  article.append(meta, body);
  return article;
}

function detailField(label, value, className = "detail-code") {
  if (value === null || value === undefined || value === "") return null;
  const field = document.createElement("div");
  field.className = "detail-field";
  const heading = document.createElement("strong");
  heading.textContent = label;
  const content = document.createElement(className === "detail-code" ? "pre" : "div");
  content.className = className;
  content.textContent = String(value);
  field.append(heading, content);
  return field;
}

function diffNode(value) {
  const wrapper = document.createElement("div");
  wrapper.className = "detail-diff";
  for (const text of String(value || "").split("\n")) {
    const line = document.createElement("span");
    line.className = `diff-line ${text.startsWith("+") && !text.startsWith("+++") ? "add" : text.startsWith("-") && !text.startsWith("---") ? "remove" : "context"}`;
    line.textContent = text || " ";
    wrapper.append(line);
  }
  return wrapper;
}

function renderRichActivityDetail(container, activity, value) {
  container.replaceChildren();
  if (!value) return;
  if (value.loading) {
    container.append(Object.assign(document.createElement("span"), { className: "detail-note", textContent: "Loading details…" }));
    return;
  }
  if (value.error) {
    container.append(Object.assign(document.createElement("span"), { className: "detail-note", textContent: value.error }));
    return;
  }
  const detail = value.detail || {};
  const append = (node) => { if (node) container.append(node); };
  if (detail.type === "commandExecution") {
    append(detailField("Command", detail.command));
    append(detailField("Working directory", detail.cwd));
    append(detailField("Duration", detail.duration, "detail-note"));
    if (detail.exitCode !== null && detail.exitCode !== 0) append(detailField("Exit code", detail.exitCode, "detail-note"));
    append(detailField("Output", detail.output));
    if (detail.outputTruncated) append(detailField("", "Output truncated", "detail-note"));
  } else if (detail.type === "fileChange") {
    for (const change of detail.changes || []) {
      const field = document.createElement("div");
      field.className = "detail-field";
      const heading = document.createElement("div");
      heading.className = "detail-change-heading";
      const kind = document.createElement("strong");
      kind.textContent = change.kind || "modified";
      const path = document.createElement("code");
      path.textContent = change.path || "Unknown file";
      heading.append(kind, path);
      field.append(heading, diffNode(change.diff));
      container.append(field);
    }
    if (detail.truncated) append(detailField("", "Output truncated", "detail-note"));
  } else if (detail.type === "mcpToolCall" || detail.type === "dynamicToolCall") {
    append(detailField("Tool", [detail.server || detail.namespace, detail.tool].filter(Boolean).join(" / ")));
    append(detailField("Arguments", detail.arguments));
    append(detailField("Result", detail.result));
    append(detailField("Error", detail.error));
    append(detailField("Duration", detail.duration, "detail-note"));
    if (detail.truncated) append(detailField("", "Output truncated", "detail-note"));
  } else if (detail.type === "webSearch") {
    append(detailField("Query", detail.query));
    append(detailField("Action", detail.action));
    append(detailField("Results", detail.results));
    if (detail.truncated) append(detailField("", "Output truncated", "detail-note"));
  } else if (detail.type === "collabAgentToolCall") {
    append(detailField("Action", detail.tool));
    append(detailField("Prompt", detail.prompt));
    append(detailField("Runtime", [detail.model, detail.reasoningEffort].filter(Boolean).join(" · "), "detail-note"));
    append(detailField("Subagents", detail.subagents?.length ? `${detail.subagents.length}` : "", "detail-note"));
  } else if (detail.type === "imageView" || detail.type === "imageGeneration") {
    append(detailField("Image", detail.name, "detail-note"));
    append(detailField("Revised prompt", detail.revisedPrompt));
    append(detailField("Failure", detail.failure));
    if (detail.imageAvailable) {
      const image = document.createElement("img");
      const url = new URL("/api/activity/image", location.origin);
      url.searchParams.set("machineId", state.machineId);
      url.searchParams.set("threadId", state.thread.id);
      url.searchParams.set("itemId", activity.id);
      image.className = "detail-image";
      image.alt = detail.name || "Codex image";
      image.loading = "lazy";
      image.addEventListener("error", () => {
        image.replaceWith(Object.assign(document.createElement("span"), { className: "detail-note", textContent: "Image unavailable" }));
      }, { once: true });
      image.src = url.toString();
      container.append(image);
    } else {
      append(detailField("", "Image unavailable", "detail-note"));
    }
  }
}

async function loadActivityDetail(activity, force = false) {
  const epoch = historyEpoch;
  const machineId = state?.machineId;
  const threadId = state?.thread?.id;
  if (!machineId || !threadId || (!force && activityDetailRequests.has(activity.id))) return;
  const version = (activityDetailVersions.get(activity.id) || 0) + 1;
  activityDetailVersions.set(activity.id, version);
  const request = { epoch, machineId, threadId, version };
  activityDetailRequests.set(activity.id, request);
  activityDetails.set(activity.id, { expanded: true, loading: true });
  const scrollTop = elements.conversation.scrollTop;
  renderConversation({ restoreScrollTop: scrollTop });
  try {
    const url = new URL("/api/activity/detail", location.origin);
    url.searchParams.set("machineId", machineId);
    url.searchParams.set("threadId", threadId);
    url.searchParams.set("itemId", activity.id);
    const response = await apiFetch(url);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Details unavailable");
    if (activityDetailVersions.get(activity.id) !== version || activityDetailRequests.get(activity.id) !== request
      || epoch !== historyEpoch || state?.machineId !== machineId || state?.thread?.id !== threadId
      || result.machineId !== machineId || result.threadId !== threadId || result.itemId !== activity.id) return;
    activityDetails.set(activity.id, { expanded: true, detail: result.detail });
  } catch (error) {
    if (activityDetailVersions.get(activity.id) !== version || activityDetailRequests.get(activity.id) !== request
      || epoch !== historyEpoch || state?.machineId !== machineId || state?.thread?.id !== threadId) return;
    activityDetails.set(activity.id, { expanded: true, error: error.message || "Details unavailable" });
  } finally {
    if (activityDetailRequests.get(activity.id) === request) activityDetailRequests.delete(activity.id);
  }
  renderConversation({ restoreScrollTop: elements.conversation.scrollTop });
}

function refreshExpandedDetailOnTerminal(previous, activity) {
  const detail = activityDetails.get(activity.id);
  if (previous?.status !== "running" || !["completed", "failed", "interrupted"].includes(activity.status) || !detail) return;
  if (!detail.expanded) {
    activityDetailVersions.set(activity.id, (activityDetailVersions.get(activity.id) || 0) + 1);
    activityDetailRequests.delete(activity.id);
    activityDetails.delete(activity.id);
    return;
  }
  if (terminalDetailRefreshes.has(activity.id)) return;
  terminalDetailRefreshes.add(activity.id);
  loadActivityDetail(activity, true);
}

function activityNode(activity) {
  const article = document.createElement("article");
  const detailState = activityDetails.get(activity.id);
  article.className = `timeline-activity ${activity.kind} ${activity.status} ${activity.expandable ? "expandable" : ""} ${detailState?.expanded ? "expanded" : ""}`;
  article.dataset.activityId = activity.id;
  const summary = document.createElement(activity.expandable ? "button" : "div");
  summary.className = "activity-summary";
  if (activity.expandable) {
    summary.type = "button";
    summary.setAttribute("aria-expanded", String(Boolean(detailState?.expanded)));
    summary.addEventListener("click", () => {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed
        && summary.contains(selection.anchorNode) && summary.contains(selection.focusNode)) return;
      const current = activityDetails.get(activity.id);
      if (current?.expanded) {
        activityDetails.set(activity.id, { ...current, expanded: false });
        renderConversation({ restoreScrollTop: elements.conversation.scrollTop });
      } else if (current?.detail || current?.error) {
        activityDetails.set(activity.id, { ...current, expanded: true });
        renderConversation({ restoreScrollTop: elements.conversation.scrollTop });
      } else {
        loadActivityDetail(activity);
      }
    });
  }
  const heading = document.createElement("div");
  heading.className = "activity-heading";
  const kind = document.createElement("span");
  kind.className = "activity-kind";
  const labels = {
    command: "Command", tool: "Tool", search: "Search", files: "File changes",
    reasoning: "Reasoning", collaboration: "Subagents", image: "Image", compaction: "Context", review: "Review",
  };
  kind.textContent = labels[activity.kind] || "Activity";
  const activityStatus = document.createElement("span");
  activityStatus.className = "activity-status";
  activityStatus.textContent = activity.status === "interrupted" ? "Stopped" : `${activity.status.charAt(0).toUpperCase()}${activity.status.slice(1)}`;
  heading.append(kind, activityStatus);
  const label = document.createElement("div");
  label.className = "activity-label";
  label.textContent = activity.label;
  summary.append(heading, label);
  article.append(summary);
  if (activity.detail) {
    const detail = document.createElement("div");
    detail.className = "activity-detail";
    if (activity.kind === "reasoning") renderMarkdownInto(detail, activity.detail);
    else detail.textContent = activity.detail;
    article.append(detail);
  }
  if (activity.expandable && detailState?.expanded) {
    const rich = document.createElement("div");
    rich.className = "activity-rich-detail";
    renderRichActivityDetail(rich, activity, detailState);
    article.append(rich);
  }
  return article;
}

function renderConversation({ preserveScroll = null, forceBottom = false, restoreScrollTop = null } = {}) {
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
  const allActivities = new Map(historyActivities);
  for (const [id, activity] of liveActivities) allActivities.set(id, activity);
  const activities = [...allActivities.values()].filter(activityVisible);
  const timeline = [
    ...messages.map((value) => ({ type: "message", value })),
    ...activities.map((value) => ({ type: "activity", value })),
  ].sort((left, right) => (left.value.createdAt || 0) - (right.value.createdAt || 0));
  elements.conversation.replaceChildren();
  if (timeline.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No conversation history yet.";
    elements.conversation.append(empty);
    updateJumpLatest();
    return;
  }
  for (const entry of timeline) {
    elements.conversation.append(entry.type === "message" ? messageNode(entry.value) : activityNode(entry.value));
  }
  if (restoreScrollTop !== null) {
    elements.conversation.scrollTop = restoreScrollTop;
  } else if (preserveScroll) {
    const addedHeight = elements.conversation.scrollHeight - preserveScroll.scrollHeight;
    elements.conversation.scrollTop = preserveScroll.scrollTop + addedHeight;
    shouldFollowConversation = false;
  } else if (forceBottom || shouldFollowConversation) {
    elements.conversation.scrollTop = elements.conversation.scrollHeight;
    shouldFollowConversation = true;
  }
  updateJumpLatest();
}

function updateJumpLatest() {
  const distance = elements.conversation.scrollHeight - elements.conversation.scrollTop - elements.conversation.clientHeight;
  elements.jumpLatest.hidden = distance < 200;
}

function jumpToLatest() {
  shouldFollowConversation = true;
  elements.conversation.scrollTo({
    top: elements.conversation.scrollHeight,
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
  });
  updateJumpLatest();
}

function mergeState(next, renderMessages = Array.isArray(next.liveMessages) || Array.isArray(next.activities)) {
  const terminalTransitions = [];
  if (Array.isArray(next.activities)) {
    for (const activity of next.activities) {
      const previous = liveActivities.get(activity.id) || state?.activities?.find((candidate) => candidate.id === activity.id);
      if (previous?.status === "running" && ["completed", "failed", "interrupted"].includes(activity.status)) {
        terminalTransitions.push([previous, activity]);
      }
    }
  }
  if (next.message && !next.message.allowed) {
    composerError = "";
    composerNotice = "";
  }
  state = { ...(state || {}), ...next };
  if (Array.isArray(next.liveMessages)) {
    for (const message of next.liveMessages) liveMessages.set(message.id, message);
  }
  if (Array.isArray(next.activities)) {
    for (const activity of next.activities) liveActivities.set(activity.id, activity);
  }
  renderState();
  if (renderMessages) renderConversation();
  for (const [previous, activity] of terminalTransitions) refreshExpandedDetailOnTerminal(previous, activity);
}

function resetConversationState() {
  historyEpoch += 1;
  historyMessages.clear();
  liveMessages.clear();
  historyActivities.clear();
  liveActivities.clear();
  activityDetails.clear();
  activityDetailRequests.clear();
  activityDetailVersions.clear();
  terminalDetailRefreshes.clear();
  nextCursor = null;
  historyRequest = null;
  shouldFollowConversation = true;
  submittingInputRequestId = null;
  submittingInterrupt = false;
  sendingQueuedMessage = false;
  inputDrafts.clear();
  setHistoryStatus();
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
  setHistoryStatus(cursor ? "Loading earlier…" : "Loading recent…");
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
      for (const activity of turn.activities || []) historyActivities.set(activity.id, activity);
    }
    nextCursor = page.nextCursor;
    setHistoryStatus();
    renderConversation({ preserveScroll, forceBottom });
    const transcriptFits = elements.conversation.scrollHeight <= elements.conversation.clientHeight + 1;
    if (nextCursor && nextCursor !== cursor && transcriptFits) automaticCursor = nextCursor;
  } catch (error) {
    if (epoch !== historyEpoch || requestedMachineId !== state?.machineId || requestedThreadId !== state?.thread?.id) return;
    setHistoryStatus(error.message || "History unavailable");
  } finally {
    if (historyRequest === token) historyRequest = null;
  }
  if (automaticCursor && epoch === historyEpoch && requestedMachineId === state?.machineId && requestedThreadId === state?.thread?.id) {
    await loadHistory(automaticCursor, epoch, forceBottom);
  }
}

async function selectDestination(machineId, threadId) {
  if (!machineId || !threadId || switchingMachine || switchingThread || destinationSelection) return;
  if (machineId === state?.machineId && threadId === state?.thread?.id) {
    closeDestinationSwitcher();
    return;
  }
  const expectedMachineId = state?.machineId || "";
  const expectedThreadId = state?.thread?.id || "";
  const token = { machineId, threadId, expectedMachineId, expectedThreadId };
  destinationSelection = token;
  switchingMachine = machineId !== expectedMachineId;
  switchingThread = true;
  composerError = "";
  composerNotice = "";
  renderState();
  renderDestinationSwitcher();
  try {
    const response = await apiFetch("/api/navigation/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ machineId, threadId, expectedMachineId, expectedThreadId }),
    });
    const snapshot = await response.json();
    if (!response.ok) throw new Error(snapshot.error || "Could not switch tasks");
    if (destinationSelection !== token) return;
    if (snapshot.machineId !== machineId || snapshot.thread?.id !== threadId) {
      throw new Error("Task selection response did not match the requested destination");
    }
    loadedThreads = [];
    threadsRequest = null;
    applySnapshot(snapshot, false);
    switchingMachine = false;
    switchingThread = false;
    destinationSelection = null;
    closeDestinationSwitcher();
    renderState();
    await loadHistory(null, historyEpoch, true);
    await Promise.allSettled([refreshMachines(), refreshLoadedThreads()]);
    refreshNavigationCatalog();
  } catch (error) {
    if (destinationSelection !== token) return;
    const message = error.message || "Could not switch tasks";
    switchingMachine = false;
    switchingThread = false;
    destinationSelection = null;
    let accepted = false;
    try {
      const response = await apiFetch("/api/state");
      if (response.ok) {
        const snapshot = await response.json();
        accepted = snapshot.machineId === machineId && snapshot.thread?.id === threadId;
        if (accepted) {
          loadedThreads = [];
          threadsRequest = null;
        }
        applySnapshot(snapshot, true);
      }
    } catch {
      setConnection(false, true);
    }
    renderState();
    await Promise.allSettled([refreshMachines(), refreshLoadedThreads(), refreshNavigationCatalog()]);
    if (accepted) {
      closeDestinationSwitcher();
      return;
    }
    destinationError = message;
    renderDestinationSwitcher();
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
    resizeComposer();
    composerNotice = "";
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

async function sendQueuedMessage() {
  if (sendingQueuedMessage || !state?.queuedMessage || switchingMachine || switchingThread) return;
  sendingQueuedMessage = true;
  composerError = "";
  composerNotice = "Sending queued message…";
  renderState();
  try {
    const response = await apiFetch("/api/message/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ machineId: state?.machineId }),
    });
    const result = await response.json();
    if (!response.ok || !result.accepted) throw new Error(result.error || "Could not send the queued message");
    mergeState({ queuedMessage: null });
    composerNotice = "Queued message sent.";
  } catch (error) {
    composerError = error.message;
  } finally {
    sendingQueuedMessage = false;
    renderState();
  }
}

async function interruptTurn() {
  if (submittingInterrupt || switchingMachine || switchingThread || state?.turn?.status !== "inProgress") return;
  const machineId = state?.machineId;
  const expectedThreadId = state?.thread?.id;
  const expectedTurnId = state?.turn?.id;
  if (!machineId || !expectedThreadId || !expectedTurnId) return;
  submittingInterrupt = true;
  composerError = "";
  composerNotice = "";
  renderState();
  try {
    const response = await apiFetch("/api/turn/interrupt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ machineId, expectedThreadId, expectedTurnId }),
    });
    const result = await response.json();
    if (!response.ok || !result.accepted) throw new Error(result.error || "Codex did not accept the stop request");
  } catch (error) {
    composerError = error.message;
  } finally {
    submittingInterrupt = false;
    renderState();
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

async function submitStructuredInput(pending) {
  if (!pending?.id || submittingInputRequestId || switchingMachine || switchingThread) return;
  const requestDraft = inputDrafts.get(pending.id) || new Map();
  const answers = [];
  for (const question of pending.questions || []) {
    const value = requestDraft.get(question.id);
    if (!value) {
      composerError = `Answer ${question.header || "every question"} before sending.`;
      renderComposer();
      return;
    }
    if (Array.isArray(question.options)) {
      if (value.type === "option" && Number.isInteger(value.optionIndex)) {
        answers.push({ questionId: question.id, type: "option", optionIndex: value.optionIndex });
      } else if (value.type === "other" && question.isOther && String(value.value || "").trim()) {
        answers.push({ questionId: question.id, type: "other", value: value.value });
      } else {
        composerError = `Choose an answer for ${question.header || "every question"}.`;
        renderComposer();
        return;
      }
    } else if (value.type === "text" && String(value.value || "").trim()) {
      answers.push({ questionId: question.id, type: "text", value: value.value });
    } else {
      composerError = `Answer ${question.header || "every question"} before sending.`;
      renderComposer();
      return;
    }
  }

  submittingInputRequestId = pending.id;
  composerError = "";
  composerNotice = "Sending structured answer…";
  const nextPending = (state?.pending || []).map((request) => request.id === pending.id ? { ...request, resolving: true } : request);
  mergeState({ pending: nextPending });
  try {
    const response = await apiFetch("/api/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ machineId: state?.machineId, requestId: pending.id, answers }),
    });
    const result = await response.json();
    if (!response.ok || !result.accepted) throw new Error(result.error || "Codex did not accept the answer");
    composerNotice = "Answer sent.";
  } catch (error) {
    composerError = error.message;
    try {
      const response = await apiFetch("/api/state");
      if (response.ok) applySnapshot(await response.json(), false);
    } catch {
      // SSE/reconnect restores the authoritative pending request.
    }
  } finally {
    submittingInputRequestId = null;
    renderState();
  }
}

function parseEvent(event) { return JSON.parse(event.data); }

async function handleEventError() {
  if (intentionalQuit) return;
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
  if (intentionalQuit) return;
  source?.close();
  source = new EventSource("/events");
  source.addEventListener("open", () => setConnection(true));
  source.addEventListener("error", handleEventError);
  source.addEventListener("snapshot", (event) => { if (!switchingThread) applySnapshot(parseEvent(event)); });
  source.addEventListener("status", (event) => { if (!switchingThread) mergeState(parseEvent(event)); });
  source.addEventListener("thread", (event) => { if (!switchingThread) mergeState({ thread: parseEvent(event) }); });
  source.addEventListener("settings", (event) => { if (!switchingThread) mergeState(parseEvent(event)); });
  source.addEventListener("queue", (event) => { if (!switchingThread) mergeState(parseEvent(event)); });
  source.addEventListener("control", (event) => { if (!switchingThread) mergeState(parseEvent(event)); });
  source.addEventListener("quota", (event) => mergeState({ quota: parseEvent(event) }, false));
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
    const expandByDefault = index < 0 && activity.expandable && activityVisible(activity) && activityExpandsByDefault(activity);
    if (index >= 0) activities[index] = activity;
    else activities.push(activity);
    mergeState({ activities: activities.slice(-50) });
    if (expandByDefault && !activityDetails.has(activity.id)) loadActivityDetail(activity);
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
function updateInspectorButtonState() {
  const open = isMobileInspector()
    ? elements.appShell.classList.contains("inspector-open")
    : !elements.appShell.classList.contains("inspector-closed");
  elements.inspectorButton.setAttribute("aria-expanded", String(open));
  elements.inspectorButton.classList.toggle("active", open);
}
function openInspector() {
  if (isMobileInspector()) {
    elements.appShell.classList.add("inspector-open");
    elements.inspectorBackdrop.hidden = false;
  } else {
    elements.appShell.classList.remove("inspector-closed");
  }
  updateInspectorButtonState();
}
function closeInspector() {
  elements.appShell.classList.remove("inspector-open");
  elements.inspectorBackdrop.hidden = true;
  if (!isMobileInspector()) elements.appShell.classList.add("inspector-closed");
  updateInspectorButtonState();
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
    empty.textContent = "No remote machines configured.";
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
  elements.settingsTheme.value = selectedTheme;
  elements.settingsLanEnabled.checked = Boolean(value.lanEnabled);
  elements.settingsHost.value = value.host || "127.0.0.1";
  elements.settingsPort.value = String(value.port || 4173);
  elements.settingsLocalName.value = value.localName || "";
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

elements.destinationButton.addEventListener("click", () => {
  if (elements.destinationSwitcher.hidden) openDestinationSwitcher();
  else closeDestinationSwitcher();
});
elements.destinationClose.addEventListener("click", closeDestinationSwitcher);
elements.destinationBackdrop.addEventListener("click", closeDestinationSwitcher);
elements.destinationSearch.addEventListener("input", renderDestinationSwitcher);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !elements.destinationSwitcher.hidden) {
    event.preventDefault();
    if (closeDestinationSwitcher()) elements.destinationButton.focus();
  }
});
elements.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const action = elements.sendMessage.dataset.action;
  if (action === "stop") interruptTurn();
  else submitMessage(action === "queue" ? "queue" : "start");
});
elements.steerMessage.addEventListener("click", () => submitMessage("steer"));
elements.sendQueue.addEventListener("click", sendQueuedMessage);
elements.cancelQueue.addEventListener("click", cancelQueuedMessage);
elements.messageText.addEventListener("input", () => {
  composerError = "";
  composerNotice = "";
  resizeComposer();
  renderComposer();
});
elements.messageText.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && elements.messageText.value.trim()) {
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
  updateJumpLatest();
  if (!shouldFollowConversation && elements.conversation.scrollTop < 140 && nextCursor && !historyRequest) loadHistory(nextCursor, historyEpoch, false);
});
elements.jumpLatest.addEventListener("click", jumpToLatest);
elements.inspectorButton.addEventListener("click", toggleInspector);
elements.inspectorClose.addEventListener("click", closeInspector);
elements.inspectorBackdrop.addEventListener("click", closeInspector);
window.addEventListener("resize", updateInspectorButtonState);
for (const [element, key] of [
  [elements.displayCommands, "commands"],
  [elements.displayReasoning, "reasoning"],
  [elements.displayCollaboration, "collaboration"],
  [elements.displayImages, "images"],
  [elements.displayCompaction, "compaction"],
  [elements.expandCommands, "expandCommands"],
  [elements.expandFiles, "expandFiles"],
]) {
  element.addEventListener("change", () => {
    displayPreferences[key] = element.checked;
    saveDisplayPreferences();
    renderConversation();
  });
}

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
elements.settingsTheme.addEventListener("change", () => {
  selectedTheme = elements.settingsTheme.value;
  try { localStorage.setItem(THEME_STORAGE_KEY, selectedTheme); } catch {}
  applyTheme();
});
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
        localName: elements.settingsLocalName.value.trim(),
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
elements.quitPocket.addEventListener("click", async () => {
  if (quittingPocket) return;
  const hostName = settingsValue?.hostName || state?.hostName || "this Mac";
  if (!window.confirm(`Quit Codex Pocket on ${hostName}?\n\nPocket will stop and you won't be able to reconnect until Codex Pocket.app is launched again on that Mac.`)) return;
  quittingPocket = true;
  elements.quitPocket.disabled = true;
  elements.quitPocket.textContent = "Quitting Codex Pocket…";
  elements.settingsStatus.textContent = "Quitting Codex Pocket…";
  elements.settingsStatus.classList.remove("error-text");
  try {
    const response = await apiFetch("/api/shutdown", { method: "POST" });
    const result = await response.json();
    if (!response.ok || !result.shuttingDown) throw new Error(result.error || "Could not quit Pocket");
    showStopped();
  } catch (error) {
    quittingPocket = false;
    elements.quitPocket.disabled = false;
    elements.quitPocket.textContent = "Quit Codex Pocket";
    elements.settingsStatus.textContent = error.message;
    elements.settingsStatus.classList.add("error-text");
  }
});

async function startApp() {
  elements.loginScreen.hidden = true;
  elements.stoppedScreen.hidden = true;
  elements.appShell.hidden = false;
  if (isMobileInspector()) closeInspector(); else openInspector();
  try {
    const response = await apiFetch("/api/state");
    applySnapshot(await response.json(), false);
    await Promise.all([refreshMachines(), refreshLoadedThreads()]);
  } catch (error) {
    setHistoryStatus(error.message);
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
