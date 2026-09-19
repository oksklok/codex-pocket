import {
  compareTaskOrder,
  sortModelsForDisplay,
  resolveModelEffort,
  createSelectionHold,
  usageLimitMessage,
  enterSubmits,
  destinationTaskStatus,
  mergeActivities,
  orderTranscriptEntries,
  preserveMessageCreatedAt,
  reconcileSubmission,
  reconcileConfirmedSteers,
  imageInputs, MAX_INPUT_IMAGES, MAX_INPUT_IMAGE_BYTES,
  fileInputs, MAX_INPUT_FILES, MAX_INPUT_FILE_BYTES, MAX_INPUT_FILES_BYTES,
  resolvedAsyncAnswer,
  rememberComposerDraft,
  machineCatalogAlias,
  sidebarMachineCatalog as sidebarMachineCatalogFor,
} from "./pocket-logic.js";

const elements = {
  showContext: document.querySelector("#show-context"),
  showQuota: document.querySelector("#show-quota"),
  context: document.querySelector("#context-chip"),
  contextPercent: document.querySelector("#context-percent"),
  contextFill: document.querySelector("#context-fill"),
  runtimeReason: document.querySelector("#runtime-reason"),
  imagePicker: document.querySelector("#image-picker"),
  attachImage: document.querySelector("#attach-image"),
  composerImages: document.querySelector("#composer-images"),
  queueImages: document.querySelector("#queue-images"),
  appShell: document.querySelector("#app-shell"),
  loginScreen: document.querySelector("#login-screen"),
  stoppedScreen: document.querySelector("#stopped-screen"),
  loginForm: document.querySelector("#login-form"),
  loginPin: document.querySelector("#login-pin"),
  loginPinReveal: document.querySelector("#login-pin-reveal"),
  loginError: document.querySelector("#login-error"),
  connection: document.querySelector("#connection"),
  connectionLabel: document.querySelector("#connection-label"),
  phase: document.querySelector("#phase-pill"),
  elapsed: document.querySelector("#elapsed"),
  quota: document.querySelector("#quota-chip"),
  machine: document.querySelector("#machine"),
  project: document.querySelector("#project"),
  destinationButton: document.querySelector("#destination-button"),
  tasksToggle: document.querySelector("#tasks-toggle"),
  destinationLabel: document.querySelector("#destination-label"),
  destinationProvider: document.querySelector("#destination-provider"),
  destinationSwitcher: document.querySelector("#destination-switcher"),
  destinationBackdrop: document.querySelector("#destination-backdrop"),
  destinationSearch: document.querySelector("#destination-search"),
  destinationClose: document.querySelector("#destination-close"),
  showArchived: document.querySelector("#show-archived"),
  destinationList: document.querySelector("#destination-list"),
  modelSelect: document.querySelector("#model-select"),
  modelSlot: document.querySelector("#model-slot"),
  effortSelect: document.querySelector("#effort-select"),
  accessSelect: document.querySelector("#access-select"),
  provider: document.querySelector("#provider"),
  historyStatus: document.querySelector("#history-status"),
  conversation: document.querySelector("#conversation"),
  jumpLatest: document.querySelector("#jump-latest"),
  planPanel: document.querySelector("#plan-panel"),
  planList: document.querySelector("#plan-list"),
  planCount: document.querySelector("#plan-count"),
  displayFiles: document.querySelector("#display-files"),
  displayCommands: document.querySelector("#display-command"),
  displayTool: document.querySelector("#display-tool"),
  displaySearch: document.querySelector("#display-search"),
  displayReview: document.querySelector("#display-review"),
  displayShowAll: document.querySelector("#display-show-all"),
  displayHideAll: document.querySelector("#display-hide-all"),
  displayReasoning: document.querySelector("#display-reasoning"),
  displayCollaboration: document.querySelector("#display-collaboration"),
  displayImages: document.querySelector("#display-images"),
  displayCompaction: document.querySelector("#display-compaction"),
  composer: document.querySelector("#composer"),
  composerZone: document.querySelector(".composer-zone"),
  composerInput: document.querySelector(".composer-input"),
  expandComposer: document.querySelector("#expand-composer"),
  composerActions: document.querySelector(".composer-actions"),
  enterSends: document.querySelector("#enter-sends"),
  imageViewer: document.querySelector("#image-viewer"),
  viewerImage: document.querySelector("#viewer-image"),
  closeImage: document.querySelector("#close-image"),
  messageText: document.querySelector("#message-text"),
  sendMessage: document.querySelector("#send-message"),
  destinationRefresh: document.querySelector("#destination-refresh"),
  composerStatus: document.querySelector("#composer-status"),
  attentionBanner: document.querySelector("#attention-banner"),
  queueBanner: document.querySelector("#queue-banner"),
  queueText: document.querySelector("#queue-text"),
  sendQueue: document.querySelector("#send-queue"),
  cancelQueue: document.querySelector("#cancel-queue"),
  inspectorButton: document.querySelector("#inspector-button"),
  inspectorClose: document.querySelector("#inspector-close"),
  inspectorEmpty: document.querySelector("#inspector-empty"),
  inspector: document.querySelector("#sidebar"),
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
  settingsDeepseekSection: document.querySelector("#settings-deepseek"),
  settingsDeepseekError: document.querySelector("#settings-deepseek-error"),
  machineAdd: document.querySelector("#machine-add"),
  machineReorder: document.querySelector("#machine-reorder"),
  machineReorderCancel: document.querySelector("#machine-reorder-cancel"),
  machineReorderSave: document.querySelector("#machine-reorder-save"),
  machinesFooterActions: document.querySelector("#machines-footer-actions"),
  machineReorderActions: document.querySelector("#machines-footer-reorder"),
  machinesFooter: document.querySelector(".machines-footer"),
  machinesError: document.querySelector("#machines-error"),
  machinesRestart: document.querySelector("#machines-restart"),
  confirmDialog: document.querySelector("#confirm-dialog"),
  confirmForm: document.querySelector("#confirm-form"),
  confirmTitle: document.querySelector("#confirm-title"),
  confirmMessage: document.querySelector("#confirm-message"),
  confirmCancel: document.querySelector("#confirm-cancel"),
  confirmSubmit: document.querySelector("#confirm-submit"),
  machineDialog: document.querySelector("#machine-dialog"),
  machineDialogForm: document.querySelector("#machine-dialog-form"),
  machineDialogTitle: document.querySelector("#machine-dialog-title"),
  machineDialogHost: document.querySelector("#machine-dialog-host"),
  machineDialogNameField: document.querySelector("#machine-dialog-name-field"),
  machineDialogName: document.querySelector("#machine-dialog-name"),
  machineDialogSshField: document.querySelector("#machine-dialog-ssh-field"),
  machineDialogSsh: document.querySelector("#machine-dialog-ssh"),
  machineDialogMacField: document.querySelector("#machine-dialog-mac-field"),
  machineDialogMac: document.querySelector("#machine-dialog-mac"),
  machineDialogSshHelp: document.querySelector("#machine-dialog-ssh-help"),
  machineDialogMacHelp: document.querySelector("#machine-dialog-mac-help"),
  machineDialogError: document.querySelector("#machine-dialog-error"),
  machineDialogRemove: document.querySelector("#machine-dialog-remove"),
  machineDialogCancel: document.querySelector("#machine-dialog-cancel"),
  machineDialogSubmit: document.querySelector("#machine-dialog-submit"),
  settingsRestart: document.querySelector("#settings-restart"),
  restartPocket: document.querySelector("#restart-pocket"),
  quitPocket: document.querySelector("#quit-pocket"),
  phoneUrls: document.querySelector("#phone-urls"),
  phoneUrlList: document.querySelector("#phone-url-list"),
  settingsStatus: document.querySelector("#settings-status"),
};

// One Pocket-styled confirmation dialog replaces native window.confirm for confirmable actions.
let confirmResolve = null;
function pocketConfirm({ title, message, confirmLabel, danger = false }) {
  elements.confirmTitle.textContent = title;
  elements.confirmMessage.textContent = message;
  elements.confirmSubmit.textContent = confirmLabel || "Confirm";
  elements.confirmSubmit.className = danger ? "danger-button" : "primary-button";
  return new Promise((resolve) => {
    if (confirmResolve) { const previous = confirmResolve; confirmResolve = null; previous(false); }
    confirmResolve = resolve;
    elements.confirmDialog.showModal();
    elements.confirmCancel.focus();
  });
}
function settleConfirm(result) {
  const resolve = confirmResolve;
  confirmResolve = null;
  if (elements.confirmDialog.open) elements.confirmDialog.close();
  resolve?.(result);
}
elements.confirmForm.addEventListener("submit", (event) => { event.preventDefault(); settleConfirm(true); });
elements.confirmCancel.addEventListener("click", () => settleConfirm(false));
elements.confirmDialog.addEventListener("cancel", (event) => { event.preventDefault(); settleConfirm(false); });

const markdown = window.markdownit({ html: false, linkify: false, breaks: true, typographer: false });
const defaultImage = markdown.renderer.rules.image;
markdown.renderer.rules.image = (tokens, index, options, environment, renderer) => {
  const token = tokens[index];
  const src = token.attrGet("src") || "";
  if (src.startsWith("/") && !src.startsWith("//") && environment.message?.role === "assistant") {
    const imageIndex = environment.imageIndex++;
    if (imageIndex >= 10) return markdown.utils.escapeHtml(token.content || "Image unavailable");
    const url = new URL("/api/message/image", location.origin);
    url.searchParams.set("machineId", state.machineId);
    url.searchParams.set("threadId", state.thread.id);
    url.searchParams.set("messageId", environment.message.id);
    url.searchParams.set("index", imageIndex);
    token.attrSet("src", url.pathname + url.search);
  } else return markdown.utils.escapeHtml(token.content || "Image unavailable");
  return defaultImage(tokens, index, options, environment, renderer);
};
const defaultLinkOpen = markdown.renderer.rules.link_open
  || ((tokens, index, options, environment, renderer) => renderer.renderToken(tokens, index, options));
markdown.renderer.rules.link_open = (tokens, index, options, environment, renderer) => {
  const href = tokens[index].attrGet("href") || "";
  if (!/^(?:https?:|mailto:)/i.test(href)) tokens[index].attrSet("data-unsupported-link", "true");
  tokens[index].attrSet("target", "_blank");
  tokens[index].attrSet("rel", "noopener noreferrer");
  return defaultLinkOpen(tokens, index, options, environment, renderer);
};

function renderMarkdownInto(element, value, message = null) {
  element.classList.add("markdown");
  element.innerHTML = markdown.render(String(value || ""), { message, imageIndex: 0 });
  for (const link of element.querySelectorAll("a[data-unsupported-link]")) link.replaceWith(...link.childNodes);
  for (const table of element.querySelectorAll("table")) {
    const scroll = document.createElement("div");
    scroll.className = "table-scroll";
    table.replaceWith(scroll);
    scroll.append(table);
  }
  for (const img of element.querySelectorAll("img")) enableImageViewer(img);
}

function enableImageViewer(img) {
  img.loading = "lazy";
  img.addEventListener("error", () => img.replaceWith(document.createTextNode(`${img.alt || "Image"} (unavailable)`)), { once: true });
  img.tabIndex = 0;
  img.setAttribute("role", "button");
  img.setAttribute("aria-label", `Open image: ${img.alt || "Image"}`);
  img.addEventListener("click", () => openImage(img));
  img.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openImage(img); } });
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
const NEAR_BOTTOM_PX = 200;
let shouldFollowConversation = true;
let transcriptUpwardScroll = 0;
let transcriptScrollBottomGap = 0;
let transcriptScrollTop = 0;
let transcriptScrollElement = null;
// Send-scoped navigation guard: a confirmed send may re-anchor an untouched view, but deliberate
// reading after the send wins. The token lives for one composer submission (including recovery).
let pendingSendNavigation = null;
let historyEpoch = 0;
let historyRequest = null;
let threadsRequest = null;
let machinesRequest = null;
// Active and archived catalogs are independent; mutations invalidate both.
const navigationCatalogs = [null, null];
const navigationRequests = [null, null];
const navigationErrors = ["", ""];
let navigationEpoch = 0;
let destinationSelection = null;
let taskActionTarget = null;
let destinationTaskError = null;
let newTaskLeaveWarning = null;
let taskActionBusy = false;
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
let selectedImages = [];
let selectedFiles = [];
const composerDrafts = new Map();
const draftKey = (machineId, threadId) => threadId ? JSON.stringify([machineId, threadId]) : null;
let readingAttachments = false;
let attachmentDeliveryUnknown = false;
let enterSends = !matchMedia("(max-width: 860px)").matches;
try { const saved = localStorage.getItem("codex-pocket-enter-sends"); if (saved !== null) enterSends = saved !== "false"; } catch {}
elements.enterSends.checked = enterSends;
const translucentUI = document.querySelector("#translucent-ui");
try { translucentUI.checked = localStorage.getItem("codex-pocket-translucent-ui") !== "false"; } catch {}
document.documentElement.dataset.translucent = String(translucentUI.checked);
for (const [toggle, meter, key] of [[elements.showContext, elements.context, "context"], [elements.showQuota, elements.quota, "quota"]]) {
  try { toggle.checked = localStorage.getItem(`codex-pocket-show-${key}`) !== "false"; } catch {}
  meter.hidden = !toggle.checked;
}
const showProjects = document.querySelector("#show-projects");
try { showProjects.checked = localStorage.getItem("codex-pocket-show-projects") === "true"; } catch {}
let projectsVisible = showProjects.checked;
const showMachineControls = document.querySelector("#show-machine-controls");
try { showMachineControls.checked = localStorage.getItem("codex-pocket-show-machine-controls") !== "false"; } catch {}
let machineControlsVisible = showMachineControls.checked;
let composerExpanded = false;
let composing = false;
let deferredTranscript = false;
const viewer = setupImageViewer(elements.imageViewer, elements.viewerImage, elements.closeImage);
const transcriptNodes = new Map();
const heldTranscriptNodes = new Set();
const selectionHold = createSelectionHold(() => {
  elements.appShell.classList.remove("transcript-selection-held");
  heldTranscriptNodes.clear();
  flushDeferredTranscript();
});
let queueDeliveryUnknown = false;
let unresolvedSubmission = null;
const unresolvedSubmissions = new Map();
function rememberUnresolvedSubmission(pending) {
  const key = pending ? draftKey(pending.requested.machineId, pending.requested.threadId) : draftKey(state?.machineId, state?.thread?.id);
  if (pending) unresolvedSubmissions.set(key, pending);
  else unresolvedSubmissions.delete(key);
  if (key === draftKey(state?.machineId, state?.thread?.id)) unresolvedSubmission = pending;
}
const asyncDrafts = new Map();

function openImage(img) {
  viewer.open(img);
}

function toggleComposer({ refocus = true } = {}) {
  const textarea = elements.messageText;
  const { selectionStart, selectionEnd, selectionDirection, scrollTop } = textarea;
  composerExpanded = !composerExpanded;
  elements.composerZone.classList.toggle("expanded-composer", composerExpanded);
  elements.expandComposer.setAttribute("aria-label", composerExpanded ? "Exit Fullscreen Composer" : "Expand Composer");
  elements.expandComposer.setAttribute("aria-expanded", String(composerExpanded));
  fitExpandedComposer();
  resizeComposer();
  // A programmatic collapse must not steal focus (and its mobile jump) from a reader who navigated away.
  if (!refocus) return;
  textarea.focus({ preventScroll: true });
  textarea.setSelectionRange(selectionStart, selectionEnd, selectionDirection);
  textarea.scrollTop = scrollTop;
}

function fitExpandedComposer() {
  const viewport = window.visualViewport;
  for (const [name, value] of [["--composer-height", viewport?.height ?? innerHeight], ["--composer-top", viewport?.offsetTop ?? 0]]) {
    if (composerExpanded) elements.composerZone.style.setProperty(name, `${value}px`);
    else elements.composerZone.style.removeProperty(name);
  }
}
let settingsValue = null;
let settingsBaseline = null;
let settingsDisplayDraft = null;
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
  document.querySelector('meta[name="theme-color"]').content = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
}

applyTheme();
matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => applyTheme());

function loadDisplayPreferences() {
  const defaults = {
    command: true, tool: true, search: true, review: true, files: true, reasoning: true, collaboration: true, images: true, compaction: true,
  };
  try {
    const saved = JSON.parse(localStorage.getItem(DISPLAY_STORAGE_KEY) || "{}") || {};
    for (const key of ["command", "tool", "search", "review"]) {
      if (!Object.hasOwn(saved, key)) saved[key] = saved.commands ?? true;
    }
    return { ...defaults, ...saved };
  } catch {
    return defaults;
  }
}

function saveDisplayPreferences() {
  try { localStorage.setItem(DISPLAY_STORAGE_KEY, JSON.stringify(displayPreferences)); } catch {}
}

function activityVisible(activity) {
  if (activity.kind === "files") return displayPreferences.files;
  if (activity.kind === "reasoning") return displayPreferences.reasoning;
  if (activity.kind === "collaboration") return displayPreferences.collaboration;
  if (activity.kind === "image") return displayPreferences.images;
  if (activity.kind === "compaction") return displayPreferences.compaction;
  if (activity.kind === "command") return displayPreferences.command;
  if (activity.kind === "tool") return displayPreferences.tool;
  if (activity.kind === "search") return displayPreferences.search;
  if (activity.kind === "review") return displayPreferences.review;
  return false;
}

function effortLabel(value) {
  const normalized = String(value || "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  const labels = { "not exposed": "Unavailable", none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", "extra high": "Extra High", max: "Max", ultra: "Ultra" };
  return labels[normalized] || normalized.replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Unavailable";
}

// Access choices share one label set so the same mode never appears with two spellings.
const ACCESS_MODES = [
  { value: "ask", label: "Ask for Approval" },
  { value: "auto", label: "Approve for Me" },
  { value: "full", label: "Full Access" },
];
const accessModeLabel = (mode) => ACCESS_MODES.find((entry) => entry.value === mode)?.label
  || (mode === "custom" ? "Custom Access" : "Unavailable");

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

async function postMessageAction(url, body) {
  const composerSubmission = ["start", "queue", "steer"].includes(body.action);
  if (composerSubmission) rememberUnresolvedSubmission(null);
  const submissionId = `${state?.submissionEpoch}-${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  const requested = { ...body, threadId: body.threadId ?? state?.thread?.id, turnId: state?.turn?.id,
    text: body.text ?? state?.queuedMessage?.text, images: body.images ?? state?.queuedMessage?.images, files: body.files ?? state?.queuedMessage?.files, previousMessageIds: [...historyMessages.keys(), ...liveMessages.keys()] };
  const requestedEpoch = historyEpoch;
  const sendNavigation = composerSubmission
    ? { machineId: requested.machineId, threadId: requested.threadId, overridden: false }
    : null;
  if (sendNavigation) pendingSendNavigation = sendNavigation;
  const current = () => requestedEpoch === historyEpoch && requested.machineId === state?.machineId && requested.threadId === state?.thread?.id;
  const confirmed = (result) => {
    if (url === "/api/message" && requested.action === "start"
      && newTaskLeaveWarning?.machineId === requested.machineId
      && newTaskLeaveWarning?.threadId === requested.threadId) {
      newTaskLeaveWarning = null;
      renderDestinationSwitcher(true);
    }
    const sameTask = requested.machineId === state?.machineId && requested.threadId === state?.thread?.id;
    // A reader who navigated after pressing Send keeps their place; an untouched view still lands on the new turn.
    const keepReading = Boolean(sendNavigation?.overridden) && sameTask;
    if (composerSubmission && composerExpanded && sameTask) toggleComposer({ refocus: !keepReading });
    if ((requested.action === "steer" || (requested.action === "start" && url === "/api/message"))
      && requested.text && !requested.images?.length && !requested.files?.length
      && sameTask) {
      const id = `confirmed-steer-${submissionId}`;
      liveMessages.set(id, { id, role: "user", text: requested.text.replace(/\r\n/g, "\n"),
        turnId: result.turnId || requested.turnId, createdAt: Date.now(), complete: true,
        confirmedSteer: { previousMessageIds: requested.previousMessageIds } });
      renderConversation();
    }
    if (composerSubmission && sameTask && !keepReading) jumpToLatest(true);
    settleSendNavigation(sendNavigation);
    return result;
  };
  let response, result;
  try {
    response = await apiFetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, submissionId }), signal: AbortSignal.timeout(25000),
    });
    result = await response.json();
    if (!response.ok && ["unknown", "pending"].includes(result.submission?.status)) {
      const error = new Error(result.error || "Delivery could not be confirmed");
      error.deliveryUnknown = true;
      throw error;
    }
  } catch (error) {
    if (!error.deliveryUnknown && !(error instanceof TypeError) && !["AbortError", "TimeoutError"].includes(error.name)) {
      settleSendNavigation(sendNavigation);
      throw error;
    }
    let snapshot;
    try {
      const recovered = await apiFetch(`/api/state?submissionId=${encodeURIComponent(submissionId)}`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (!recovered.ok) throw new Error("State unavailable");
      snapshot = await recovered.json();
      if (current() && snapshot.machineId === requested.machineId && snapshot.thread?.id === requested.threadId) applySnapshot(snapshot);
      connectEvents();
    } catch {
      const failure = new Error("Connection lost; delivery could not be confirmed. Check the task before sending again.");
      if (composerSubmission) rememberUnresolvedSubmission({ submissionId, requested, confirmed, queued: url === "/api/message/queue" || body.action === "queue", warning: failure.message });
      connectEvents();
      failure.deliveryUnknown = true;
      throw failure;
    }
    const outcome = reconcileSubmission(submissionId, snapshot, requested);
    if (outcome === "accepted") return confirmed({ accepted: true, recovered: true, turnId: snapshot.submission?.turnId });
    const failure = new Error(outcome === "rejected"
      ? snapshot.submission.error || "Message was not sent. Please send again."
      : "Connection restored; delivery is still unconfirmed. Check the task before sending again.");
    failure.deliveryUnknown = outcome === "unknown";
    if (composerSubmission && failure.deliveryUnknown) rememberUnresolvedSubmission({ submissionId, requested, confirmed, queued: url === "/api/message/queue" || body.action === "queue", warning: failure.message });
    if (!failure.deliveryUnknown) settleSendNavigation(sendNavigation);
    throw failure;
  }
  if (!response.ok || !result.accepted) {
    settleSendNavigation(sendNavigation);
    throw new Error(result.error || "Codex did not accept the message");
  }
  return confirmed(result);
}

// Recheck only the one unresolved composer submission, once per SSE reconnect.
async function recoverUnresolvedSubmission() {
  // A reload or another client can recover the gateway's retained submission too.
  const queued = state?.queuedMessage;
  if (!unresolvedSubmission && queued?.deliveryUnknown && queued.submission?.id) {
    rememberUnresolvedSubmission({ submissionId: queued.submission.id,
      requested: { ...queued.submission.requested, queueId: queued.id ?? String(queued.createdAt) },
      queued: true, confirmed: () => {}, warning: queued.error || "Delivery unconfirmed. Check the task before sending again." });
  }
  const pending = unresolvedSubmission;
  if (!pending || pending.checking) return;
  pending.checking = true;
  try {
    const response = await apiFetch(`/api/state?submissionId=${encodeURIComponent(pending.submissionId)}`, {
      cache: "no-store", signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return;
    const snapshot = await response.json();
    if (unresolvedSubmission !== pending || destinationSelection || taskActionTarget) return;
    const { requested } = pending;
    if (requested.machineId !== state?.machineId || requested.threadId !== state?.thread?.id) return;
    const outcome = reconcileSubmission(pending.submissionId, snapshot, requested);
    if (snapshot.machineId !== requested.machineId || snapshot.thread?.id !== requested.threadId) return;
    applySnapshot(snapshot);
    if (requested.machineId !== state?.machineId || requested.threadId !== state?.thread?.id) return;
    if (outcome === "unknown") {
      composerError = "Delivery unconfirmed. Check the task before sending again.";
      pending.warning = "Delivery unconfirmed. Check the task before sending again.";
      // Snapshot queue updates must not enable an ambiguously delivered queue/attachment again.
      attachmentDeliveryUnknown = Boolean(requested.images?.length || requested.files?.length);
      queueDeliveryUnknown = pending.queued && (!requested.queueId
        || requested.queueId === (state?.queuedMessage?.id ?? String(state?.queuedMessage?.createdAt)));
    } else {
      rememberUnresolvedSubmission(null);
      attachmentDeliveryUnknown = false;
      queueDeliveryUnknown = false;
      if (outcome === "accepted") {
        pending.confirmed({ accepted: true, recovered: true, turnId: snapshot.submission?.turnId });
        if (elements.messageText.value === requested.text
          && JSON.stringify(selectedImages) === JSON.stringify(requested.images || [])
          && JSON.stringify(selectedFiles) === JSON.stringify(requested.files || [])) {
          elements.messageText.value = "";
          selectedImages = [];
          selectedFiles = [];
          composerDrafts.delete(draftKey(requested.machineId, requested.threadId));
          resizeComposer();
        }
        if (composerError === pending.warning) composerError = "";
      } else {
        if (pending.restoreDraft && !elements.messageText.value && !selectedImages.length && !selectedFiles.length) {
          elements.messageText.value = requested.text;
          rememberComposerDraft(composerDrafts, draftKey(requested.machineId, requested.threadId), { text: requested.text, images: [] });
          resizeComposer();
        }
        composerError = snapshot.submission?.error || "Message was not sent. Please send again.";
      }
    }
    renderState();
  } catch {
    // Keep the current warning; another actual reconnect may check again.
  } finally {
    pending.checking = false;
  }
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
  // Explicit English, 24-hour formatting in the browser's own timezone: same-day shows the time
  // alone, otherwise the English weekday precedes it (matching the Mac menu's EEE HH:mm).
  return reset.toLocaleString("en-GB", sameDay
    ? { hour: "2-digit", minute: "2-digit" }
    : { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

// The DeepSeek account-wide balance replaces the subscription windows in the same top-bar slot.
const BALANCE_SYMBOLS = { CNY: "¥", USD: "$", EUR: "€", GBP: "£", JPY: "¥" };
function formatBalanceEntry(entry) {
  return `${BALANCE_SYMBOLS[entry.currency] ?? `${entry.currency} `}${entry.total}`;
}

function renderBalanceQuota(balance) {
  elements.quota.replaceChildren();
  elements.quota.classList.remove("multiple");
  elements.quota.classList.add("balance");
  const entries = Array.isArray(balance.entries) ? balance.entries : [];
  const usable = Boolean(balance.available) && entries.length > 0;
  const insufficient = balance.isAvailable === false;
  elements.quota.classList.toggle("stale", !usable || Boolean(balance.stale));
  elements.quota.classList.toggle("insufficient", insufficient);
  // The word stays muted; the amount carries the same bright weight as a quota percentage.
  const label = document.createElement("span");
  label.className = "quota-label";
  label.textContent = "Balance";
  const text = document.createElement("span");
  text.className = "quota-balance-text";
  // A non-shrinking flag keeps insufficient funds recognizable even when the amount truncates.
  if (insufficient) {
    const flag = document.createElement("span");
    flag.className = "balance-flag";
    flag.setAttribute("aria-hidden", "true");
    flag.textContent = "!";
    elements.quota.append(flag);
  }
  elements.quota.append(label, text);
  if (!usable) {
    // A failed or malformed fetch is never rendered as a zero balance.
    text.textContent = "—";
    elements.quota.title = "DeepSeek balance unavailable";
    elements.quota.setAttribute("aria-label", "DeepSeek balance unavailable");
    return;
  }
  text.textContent = entries.map(formatBalanceEntry).join(" · ");
  const funds = insufficient ? " · insufficient funds" : "";
  const stale = balance.stale ? " · last known" : "";
  elements.quota.title = `DeepSeek account balance: ${entries.map((entry) => `${entry.currency} ${entry.total}`).join(", ")}${funds}${stale}`;
  elements.quota.setAttribute("aria-label", elements.quota.title);
}

function renderQuota() {
  const quota = state?.quota;
  if (quota?.balance) { renderBalanceQuota(quota.balance); return; }
  const windows = quota?.available && Array.isArray(quota.windows) ? quota.windows : [];
  elements.quota.classList.remove("balance", "insufficient");
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
  return thread.name || "Untitled Task";
}

// Providers are explicit metadata; an unknown provider shows no label instead of a guess.
function providerName(provider) {
  if (provider === "deepseek") return "DeepSeek";
  if (provider === "openai") return "OpenAI";
  return null;
}

// Providers are plain secondary metadata after a separator, never a bordered badge.
function providerLabel(provider) {
  const label = providerName(provider);
  if (!label) return null;
  const meta = document.createElement("span");
  meta.className = "provider-label";
  meta.textContent = label;
  return meta;
}

// One choice is a value, not a picker: render read-only text until a second option exists.
function renderChoiceControl(slot, { entries, selected, ariaLabel, id, disabled, emptyLabel = "Unavailable", onChange }) {
  slot.replaceChildren();
  const label = slot.closest(".form-field")?.querySelector("label") || null;
  if (entries.length <= 1) {
    const value = document.createElement("p");
    value.id = `${id}-static`;
    value.className = "select-static";
    value.setAttribute("aria-label", ariaLabel);
    // A flex container clips direct text without an ellipsis, so the value lives in its own
    // shrinking element; the full value stays in the DOM and in the accessible name.
    const text = document.createElement("span");
    text.className = "select-static-text";
    text.textContent = entries.length ? entries[0].label : emptyLabel;
    value.append(text);
    if (disabled) value.classList.add("disabled");
    slot.append(value);
    if (label) label.setAttribute("for", value.id);
    return null;
  }
  const select = document.createElement("select");
  select.id = id;
  select.setAttribute("aria-label", ariaLabel);
  select.disabled = Boolean(disabled);
  for (const entry of entries) {
    const option = new Option(entry.label, entry.value);
    select.add(option);
  }
  if (entries.some((entry) => entry.value === selected)) select.value = selected;
  // Listen directly on the control so synthetic change events without bubbling still work.
  if (typeof onChange === "function") select.addEventListener("change", () => onChange(select.value));
  slot.append(select);
  if (label) label.setAttribute("for", select.id);
  return select;
}

function setConnection(connected, failed = false) {
  elements.connection.className = `connection ${connected ? "connected" : failed ? "failed" : ""}`;
  elements.connectionLabel.textContent = connected ? "Live" : failed ? "Disconnected" : "Connecting";
}

function renderDestinationButton() {
  const machine = machines.find((candidate) => candidate.id === state?.machineId);
  const machineName = machine?.name || state?.machine || "Machine";
  const provider = providerName(machine?.provider);
  const selectedThread = loadedThreads.find((thread) => thread.id === state?.thread?.id) || state?.thread;
  // With no task selected, show only the machine name: no placeholder text and no provider suffix.
  const hasTask = Boolean(state?.thread);
  // Match task rows: the provider suffix only disambiguates machines exposing several providers.
  const group = machine?.group || machine?.id;
  const providers = new Set(machines
    .filter((candidate) => (candidate.group || candidate.id) === group)
    .map((candidate) => providerName(candidate.provider))
    .filter(Boolean));
  elements.destinationLabel.textContent = hasTask ? `${machineName} / ${threadLabel(selectedThread || state.thread)}` : machineName;
  const showProvider = hasTask && provider && providers.size > 1;
  elements.destinationProvider.textContent = showProvider ? provider : "";
  elements.destinationProvider.hidden = !showProvider;
  // Wide layouts render plain text, so only the narrow selector carries a disabled state.
  elements.destinationButton.disabled = submittingMessage || updatingModel
    || updatingAccess || resolvingApproval || submittingInputRequestId || submittingInterrupt;
}

async function refreshMachines() {
  if (machinesRequest) return machinesRequest;
  const machineStateAtStart = machines;
  machinesRequest = (async () => {
    const response = await apiFetch("/api/machines");
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || "Machines unavailable");
    if (machines === machineStateAtStart) machines = Array.isArray(value.machines) ? value.machines : [];
    renderDestinationButton();
    renderDestinationSwitcher();
  })();
  try {
    await machinesRequest;
  } finally {
    machinesRequest = null;
  }
}

let archivedTasks = false;
const collapsedMachines = new Set();
try {
  const saved = JSON.parse(localStorage.getItem("codex-pocket-collapsed-machines") || "[]");
  if (Array.isArray(saved) && saved.every(id => typeof id === "string")) for (const id of saved) collapsedMachines.add(id);
} catch {}
let destinationRenderKey = null;
// Row status keeps the accent treatment except for the states that carry their own meaning. Full
// rendering and the status-only fast update share this rule so the two can never drift.
function taskStatusClassName(value) {
  if (value === "Failed") return "destination-task-status danger";
  if (value === "Waiting" || value === "Stopped") return "destination-task-status warning";
  return "destination-task-status";
}
function renderDestinationSwitcher(force = false) {
  if (elements.destinationSwitcher.hidden && !force) return;
  const archived = archivedTasks;
  const slot = Number(archived);
  const navigationCatalog = navigationCatalogs[slot];
  const navigationRequest = navigationRequests[slot];
  elements.destinationRefresh.disabled = Boolean(navigationRequest);
  // Transcript/usage updates do not change the catalog. Keep open menus and focus.
  const renderKey = JSON.stringify([
    [...collapsedMachines], navigationCatalog, machines.map(machine => [machine.id, machine.connected, machine.canWake]), elements.destinationSearch.value, Boolean(navigationRequest),
    [...taskTerminalResults], state?.machineId, state?.thread?.id, destinationSelection && [destinationSelection.machineId, destinationSelection.threadId], taskActionBusy,
    taskActionTarget && [taskActionTarget.machineId, taskActionTarget.threadId, taskActionTarget.action], destinationTaskError, newTaskLeaveWarning, archived, projectsVisible, navigationErrors[slot],
    machineConfig.saved, machineConfig.restartRequired, machineConfig.localName, machineConfig.headless,
    machineReorderMode, machineReorderBusy, machineReorderDraft, machineControlsVisible,
  ]);
  if (renderKey === destinationRenderKey) {
    const status = elements.destinationList.querySelector('.destination-task[aria-current="true"] .destination-task-status');
    if (status && !destinationSelection) {
      const statusText = destinationTaskStatus(
        { id: state?.machineId }, { id: state?.thread?.id }, state, taskTerminalResults.get(draftKey(state?.machineId, state?.thread?.id)));
      status.className = taskStatusClassName(statusText);
      status.textContent = statusText;
    }
    return;
  }
  destinationRenderKey = renderKey;
  elements.destinationList.replaceChildren();
  // The saved configuration and the running connections are distinct: surface a restart hint here
  // rather than restarting on the user's behalf.
  elements.machinesRestart.hidden = !machineConfig.restartRequired;
  syncMachineFooterVisibility();
  const query = elements.destinationSearch.value.trim().toLowerCase();
  const catalogMachines = Array.isArray(navigationCatalog?.machines) ? navigationCatalog.machines : [];
  if (navigationRequest && !catalogMachines.length) {
    const loading = document.createElement("p");
    loading.className = "destination-empty";
    loading.textContent = archived ? "Loading archived tasks…" : "Loading tasks…";
    elements.destinationList.append(loading);
    return;
  }
  // Reorder mode shows every machine name and nothing else; search, Archived and expansion wait.
  if (machineReorderMode) {
    renderMachineReorderList(catalogMachines);
    return;
  }
  const displayMachines = sidebarMachineCatalog(catalogMachines);
  // Collect one visual group per physical machine; each provider stays its own runtime underneath.
  const visualGroups = [];
  const groupsByKey = new Map();
  for (const catalogMachine of displayMachines) {
    const latest = machines.find(machine => machine.id === catalogMachine.id);
    const entry = { ...catalogMachine, ...(latest ? { connected: latest.connected, canWake: latest.canWake ?? catalogMachine.canWake } : {}) };
    const key = entry.group || entry.id;
    let visual = groupsByKey.get(key);
    if (!visual) {
      visual = { key, name: entry.name || "Machine", host: false, providers: [], members: [] };
      groupsByKey.set(key, visual);
      visualGroups.push(visual);
    }
    visual.members.push(entry);
    if (entry.local === true) visual.host = true;
    const provider = providerName(entry.provider);
    if (provider && !visual.providers.includes(provider)) visual.providers.push(provider);
  }

  for (const visual of visualGroups) {
    const multiProvider = visual.providers.length > 1;
    // Physical-machine matching and provider matching stay separate: the machine name shows all
    // of that machine's tasks, a provider name shows only that provider's tasks.
    const machineMatch = Boolean(query) && (`${visual.name} ${visual.members.map(member => member.platform || "").join(" ")}`).toLowerCase().includes(query);
    const providerMatch = Boolean(query) && visual.providers.some(provider => provider.toLowerCase().includes(query));
    const taskMatches = (task) => `${task.name || ""} ${task.preview || ""} ${task.project || ""} ${task.cwd || ""}`.toLowerCase().includes(query);
    // One visibility rule for normal rows and for the pending-delete row restored below.
    const rowVisible = (member, task) => !query || machineMatch
      || (providerName(member.provider) || "").toLowerCase().includes(query) || taskMatches(task);
    const rows = [];
    for (const member of visual.members) {
      for (const task of (Array.isArray(member.tasks) ? member.tasks : [])) {
        if (!rowVisible(member, task)) continue;
        rows.push({ member, task });
      }
    }
    const pendingDelete = taskActionTarget?.action === "delete" && taskActionTarget.archived === archived ? taskActionTarget : null;
    const pendingMember = pendingDelete ? visual.members.find(member => member.id === pendingDelete.machineId) : null;
    // A refresh may omit the task before its delete response arrives; restore it only while the
    // current query would still show it.
    if (pendingMember && pendingDelete.task && rowVisible(pendingMember, pendingDelete.task)
      && !rows.some(entry => entry.member === pendingMember && entry.task.id === pendingDelete.threadId)) {
      rows.push({ member: pendingMember, task: pendingDelete.task });
    }
    // One global order per physical machine: the existing comparator, then the runtime id.
    rows.sort((left, right) => compareTaskOrder(left.task, right.task) || String(left.member.id).localeCompare(String(right.member.id)));
    if (pendingDelete) {
      const index = rows.findIndex(entry => entry.member.id === pendingDelete.machineId && entry.task.id === pendingDelete.threadId);
      // Capture and pin the visible slot for this query, after hidden rows are removed.
      if (pendingDelete.query !== query) {
        pendingDelete.query = query;
        pendingDelete.position = index;
      }
      if (index >= 0 && pendingDelete.position >= 0) rows.splice(pendingDelete.position, 0, ...rows.splice(index, 1));
    }
    const tasks = rows.map(entry => entry.task);
    if ((archived || (query && !machineMatch && !providerMatch)) && !tasks.length) continue;

    const connected = visual.members.some(member => member.connected);
    const catalogAvailable = visual.members.some(member => member.connected && member.catalogAvailable !== false);
    const availability = !connected
      ? "Offline"
      : !catalogAvailable
        ? "Tasks Unavailable"
        : "";
    const machine = {
      ...visual.members[0],
      id: visual.key,
      name: visual.name,
      local: visual.host,
      provider: null,
      connected,
      catalogAvailable,
      canWake: visual.members.some(member => member.canWake),
      connectionError: visual.members.find(member => member.local && member.connectionError)?.connectionError || null,
    };
    const group = document.createElement("section");
    group.className = `destination-group ${!machine.connected ? "offline" : !catalogAvailable ? "unavailable" : ""}`;
    const savedIndex = Number.isInteger(machine.savedIndex) ? machine.savedIndex : -1;
    // Only saved SSH machines are reorderable; the host (and machines awaiting restart) stay pinned.
    if (!machine.local && savedIndex >= 0) group.dataset.savedIndex = String(savedIndex);
    if (machine.pending || machine.pendingRemoval || machine.pendingConfig || machine.hostPending) {
      group.classList.add("pending-config");
    }
    const heading = document.createElement("div");
    heading.className = "destination-group-heading";
    const name = document.createElement("strong");
    name.className = "machine-name";
    name.textContent = machine.name || "Machine";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "machine-toggle";
    toggle.dataset.machineId = machine.id;
    const collapsed = !query && collapsedMachines.has(machine.id);
    group.classList.toggle("collapsed", collapsed);
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m9 5 7 7-7 7"/></svg>';
    toggle.append(name);
    // The host designation stays in the accessibility text and Settings, not as a visible pill.
    if (machine.local === true) {
      toggle.append(Object.assign(document.createElement("span"), { className: "sr-only", textContent: " Host" }));
    }
    toggle.addEventListener("click", () => {
      if (collapsedMachines.has(machine.id)) collapsedMachines.delete(machine.id);
      else collapsedMachines.add(machine.id);
      try { localStorage.setItem("codex-pocket-collapsed-machines", JSON.stringify([...collapsedMachines])); } catch {}
      renderDestinationSwitcher();
      [...elements.destinationList.querySelectorAll(".machine-toggle")].find(button => button.dataset.machineId === machine.id)?.focus();
    });
    const controls = Object.assign(document.createElement("div"), { className: "machine-header-controls" });
    // Chevron + name, then Info, then the inline status; Wake/New Task stay at the far right.
    const nameBlock = Object.assign(document.createElement("div"), { className: "machine-name-block" });
    nameBlock.append(toggle);
    // Archived view is a task-management surface: no setup controls, but Wake still applies.
    if (machineControlsVisible && !archived) {
      const info = document.createElement("button");
      info.type = "button";
      info.className = "icon-button machine-info";
      info.setAttribute("aria-label", machine.local ? `Host details for ${machine.name}` : `Machine details for ${machine.name}`);
      info.title = "Machine details";
      info.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.75h.01"/></svg>';
      info.addEventListener("click", () => openMachineDetails(machine, info));
      nameBlock.append(info);
    }
    if (availability) {
      const availabilityStatus = document.createElement("span");
      availabilityStatus.className = "machine-status";
      availabilityStatus.textContent = availability;
      nameBlock.append(availabilityStatus);
    }
    heading.append(nameBlock, controls);
    // Wake stays a machine action at the far right and always targets the live runtime id.
    if (!machine.local && !machine.connected && machine.canWake && machine.id.startsWith("ssh:")) {
      const wakeAction = Object.assign(document.createElement("div"), { className: "wake-action" });
      const wake = Object.assign(document.createElement("button"), { type: "button", className: "icon-button", title: `Wake ${machine.name}` });
      wake.setAttribute("aria-label", `Wake ${machine.name}`);
      wake.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3v9M6.3 5.7a8 8 0 1 0 11.4 0"/></svg>';
      wake.addEventListener("click", async () => {
        wake.disabled = true;
        wakeAction.querySelector(".wake-feedback")?.remove();
        const feedback = Object.assign(document.createElement("span"), { className: "wake-feedback" });
        feedback.setAttribute("role", "status");
        wakeAction.append(feedback);
        try {
          const response = await apiFetch("/api/machines/wake", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ machineId: machine.id }) });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || "Could not send Wake packet");
          feedback.textContent = "Wake packet sent";
          setTimeout(() => feedback.remove(), 4000);
        } catch (error) { feedback.textContent = error instanceof Error ? error.message : String(error); }
        finally { wake.disabled = false; }
      });
      wakeAction.append(wake);
      controls.append(wakeAction);
    }
    const create = document.createElement("button");
    create.type = "button";
    create.className = "icon-button machine-create";
    create.setAttribute("aria-label", "New task");
    create.title = "New task";
    create.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
    // Any create busy for one of this physical machine's runtimes disables its own + control only.
    const creatingHere = taskActionBusy && taskActionTarget?.action === "create"
      && visual.members.some(member => member.id === taskActionTarget.machineId);
    create.disabled = !machine.connected || creatingHere;
    create.addEventListener("click", () => newTask(visual));
    if (!archived) controls.append(create);
    group.append(heading);
    // Auto-attach ownership failures belong to a task, not the machine catalog.
    // Only a failed manual selection surfaces ownership here, with its Retry target.
    if (machine.local && machine.connectionError
      && !/another Codex runtime|active writer/i.test(machine.connectionError)) {
      group.append(Object.assign(document.createElement("p"), {
        className: "destination-empty error-text", textContent: machine.connectionError,
      }));
    }

    // Rows carry their real runtime identity even though the group is ordered globally.
    for (const { member, task } of rows) {
      const memberCatalogAvailable = member.connected && member.catalogAvailable !== false;
      const selected = member.id === state?.machineId && task.id === state?.thread?.id;
      const row = document.createElement("button");
      row.type = "button";
      row.className = `destination-task ${selected ? "selected" : ""}`;
      const rowUnavailable = !member.connected || !memberCatalogAvailable || Boolean(destinationSelection) || (taskActionBusy && taskActionTarget?.machineId === member.id && taskActionTarget?.threadId === task.id);
      // Archived rows are non-selectable but still read like normal task-list content.
      if (task.archived && !rowUnavailable) row.classList.add("archived-available");
      row.disabled = rowUnavailable || task.archived;
      if (selected) row.setAttribute("aria-current", "true");
      if (task.cwd) row.title = task.cwd;
      const check = document.createElement("span");
      check.className = "destination-check";
      if (selected) check.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg>';
      const label = document.createElement("span");
      label.className = "destination-task-label";
      const taskName = document.createElement("span");
      taskName.className = "destination-task-name";
      taskName.append(Object.assign(document.createElement("span"), { className: "destination-task-text", textContent: threadLabel(task) }));
      // Provider labels appear on rows only when this machine actually exposes several.
      if (multiProvider) {
        const taskProvider = providerLabel(member.provider);
        if (taskProvider) taskName.append(taskProvider);
      }
      label.append(taskName);
      const taskError = [newTaskLeaveWarning, destinationTaskError].find(error => error?.machineId === member.id && error?.threadId === task.id)?.message || "";
      if (taskError) label.append(Object.assign(document.createElement("small"), { className: "task-selection-error", textContent: taskError }));
      else if (projectsVisible) {
        const project = task.project || projectName(task.cwd);
        if (project && project !== "—") label.append(Object.assign(document.createElement("small"), { className: "task-project", textContent: project }));
      }
      const status = document.createElement("span");
      const statusText = destinationSelection?.machineId === member.id && destinationSelection?.threadId === task.id
        ? "Opening…"
        : taskActionTarget?.machineId === member.id && taskActionTarget?.threadId === task.id ? `${taskActionTarget.action === "rename" ? "Renaming" : taskActionTarget.action === "delete" ? "Deleting" : taskActionTarget.action === "archive" ? "Archiving" : "Unarchiving"}…`
        : destinationTaskStatus(member, task, state, taskTerminalResults.get(draftKey(member.id, task.id)));
      status.className = taskStatusClassName(statusText);
      status.textContent = statusText;
      row.append(check, label, status);
      row.addEventListener("click", () => selectDestination(member.id, task.id));
      const entry = document.createElement("div");
      entry.className = "destination-entry";
      entry.append(row);
      const actions = document.createElement("details");
      actions.className = "task-actions";
      const summary = document.createElement("summary");
      summary.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>';
      // Same-name tasks across providers stay distinguishable to assistive tech.
      const taskProvider = multiProvider ? providerName(member.provider) : null;
      summary.setAttribute("aria-label", `Actions for ${taskProvider ? `${task.name} [${taskProvider}]` : task.name}`);
      actions.append(summary);
      const menu = document.createElement("div");
      menu.className = "task-action-menu";
      actions.append(menu);
      summary.addEventListener("click", (event) => {
        event.preventDefault();
        closeTaskMenus(actions);
        actions.open = !actions.open;
        if (!actions.open) return;
        // Measure and position synchronously, before the open menu can paint.
        const anchor = summary.getBoundingClientRect();
        // Anchor vertically to the task row boundary with a 4px gap so the menu never overlaps it.
        const row = summary.closest(".destination-entry")?.querySelector(".destination-task") || summary;
        const rowBox = row.getBoundingClientRect();
        const drawer = elements.destinationSwitcher.getBoundingClientRect();
        const bounds = elements.destinationList.getBoundingClientRect();
        const bottom = Math.min(bounds.bottom, window.innerHeight);
        const top = rowBox.bottom + 4 + menu.offsetHeight <= bottom
          ? rowBox.bottom + 4 : rowBox.top - menu.offsetHeight - 4;
        // The transformed drawer is the fixed menu's containing block, not the viewport.
        const originX = drawer.left + elements.destinationSwitcher.clientLeft;
        const originY = drawer.top + elements.destinationSwitcher.clientTop;
        menu.style.left = `${Math.max(drawer.left + 8, 8, Math.min(anchor.right - menu.offsetWidth, drawer.right - menu.offsetWidth - 8, window.innerWidth - menu.offsetWidth - 8)) - originX}px`;
        menu.style.top = `${Math.max(bounds.top, 0, Math.min(top, bottom - menu.offsetHeight)) - originY}px`;
      });
      for (const [action, label] of [["rename", "Rename"], [task.archived ? "unarchive" : "archive", task.archived ? "Unarchive" : "Archive"], ["delete", "Delete"]]) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.disabled = !member.connected || (taskActionBusy && taskActionTarget?.machineId === member.id && taskActionTarget?.threadId === task.id) || (action !== "rename" && task.status?.startsWith("active"));
        button.addEventListener("click", () => {
          if (destinationSelection || taskActionBusy) return;
          const body = { machineId: member.id, threadId: task.id, archived: Boolean(task.archived), action };
          if (action === "rename" || action === "delete") openTaskDialog(body, task.name);
          else performTaskAction(body);
        });
        menu.append(button);
      }
      entry.append(actions);
      group.append(entry);
    }

    if (!tasks.length && !availability) {
      const empty = document.createElement("p");
      empty.className = "destination-group-empty";
      empty.textContent = query ? "No matching saved tasks" : "No saved tasks";
      group.append(empty);
    }
    elements.destinationList.append(group);
  }
  if (!displayMachines.length || !elements.destinationList.childElementCount) {
    const empty = document.createElement("p");
    empty.className = "destination-empty";
    empty.textContent = navigationErrors[slot] || (query ? "No matching tasks" : archived ? "No archived tasks" : "Task catalog unavailable");
    elements.destinationList.append(empty);
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

function invalidateNavigationCatalogs() {
  navigationEpoch += 1;
  navigationCatalogs.fill(null);
  navigationRequests.fill(null);
  navigationErrors.fill("");
}

// A confirmed mutation updates the cached lists immediately so the sidebar keeps rendering the row
// it already shows; the forced background refresh then makes both catalogs authoritative.
function applyTaskMutationToCatalogs({ action, machineId, threadId, name }) {
  if (!["rename", "archive", "unarchive", "delete"].includes(action)) return;
  for (const catalog of navigationCatalogs) {
    const machine = catalog?.machines?.find(candidate => candidate.id === machineId);
    if (!machine || !Array.isArray(machine.tasks)) continue;
    if (action === "rename") {
      const task = machine.tasks.find(candidate => candidate.id === threadId);
      if (task && name) task.name = name;
      continue;
    }
    if (action === "archive" && catalog !== navigationCatalogs[0]) continue;
    if (action === "unarchive" && catalog !== navigationCatalogs[1]) continue;
    machine.tasks = machine.tasks.filter(task => task.id !== threadId);
  }
}

function updateCatalogTaskStatus(catalog, { machineId, threadId, status, updatedAt }) {
  const tasks = catalog?.machines?.find(machine => machine.id === machineId)?.tasks;
  const task = tasks?.find(task => task.id === threadId);
  if (!task) return;
  if (Number.isFinite(updatedAt)) task.updatedAt = Math.max(task.updatedAt || 0, updatedAt);
  if (status) {
    task.status = status;
    task.phase = null;
    if (status.startsWith("active") || status === "idle") task.loaded = true;
    else if (status === "notLoaded") task.loaded = false;
  }
  tasks.sort(compareTaskOrder);
}

function updateLiveTaskCatalog(value) {
  for (const catalog of navigationCatalogs) updateCatalogTaskStatus(catalog, value);
  for (const request of navigationRequests) request?.taskStatuses.push(value);
  renderDestinationSwitcher();
}

async function refreshNavigationCatalog(archived = archivedTasks, force = false) {
  const slot = Number(archived);
  if (navigationRequests[slot]) return navigationRequests[slot];
  if (navigationCatalogs[slot] && !force) return;
  const epoch = navigationEpoch;
  const machineStateAtStart = machines;
  const request = (async () => {
    try {
      const response = await apiFetch(`/api/navigation?archived=${archived}`, { signal: AbortSignal.timeout(7_000) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || "Task catalog unavailable");
      if (epoch !== navigationEpoch) return;
      // A runtime event received during the read takes precedence over this catalog.
      if (machines === machineStateAtStart && Array.isArray(value.machines)) {
        machines = value.machines.map(machine => ({ ...machines.find(current => current.id === machine.id), ...machine }));
      }
      for (const status of request.taskStatuses) updateCatalogTaskStatus(value, status);
      for (const machine of value.machines || []) for (const task of machine.tasks || []) {
        if (task.status?.startsWith("active")) taskTerminalResults.delete(draftKey(machine.id, task.id));
      }
      navigationCatalogs[slot] = value;
      navigationErrors[slot] = "";
    } catch (error) {
      if (epoch === navigationEpoch) navigationErrors[slot] = error.message || "Task catalog unavailable";
    } finally {
      if (epoch === navigationEpoch) {
        navigationRequests[slot] = null;
        renderDestinationSwitcher();
        if (navigationCatalogs[slot] && !navigationCatalogs[1 - slot]) void refreshNavigationCatalog(!archived);
      }
    }
  })();
  request.taskStatuses = [];
  navigationRequests[slot] = request;
  renderDestinationSwitcher();
  return request;
}

// Menus are overlays; dismiss them before scrolling or interacting elsewhere.
function closeTaskMenus(except = null) {
  for (const actions of elements.destinationList.querySelectorAll(".task-actions[open]")) {
    if (actions !== except) actions.open = false;
  }
}
document.addEventListener("pointerdown", (event) => closeTaskMenus(event.target.closest(".task-actions")));
elements.destinationList.addEventListener("scroll", () => closeTaskMenus());
window.addEventListener("resize", () => closeTaskMenus());

function saveSidebarPreference(sidebar, open) {
  if (!matchMedia("(min-width: 1100px)").matches) return;
  try { localStorage.setItem(`codex-pocket-${sidebar}-open`, String(open)); } catch {}
}
function sidebarPreference(sidebar, fallback) {
  try { const value = localStorage.getItem(`codex-pocket-${sidebar}-open`); return value === null ? fallback : value === "true"; } catch { return fallback; }
}

const WIDE_LAYOUT_QUERY = matchMedia("(min-width: 1100px)");
function isWideLayout() { return WIDE_LAYOUT_QUERY.matches; }
function tasksSwitcherOpen() { return document.body.classList.contains("destination-open"); }
function inspectorOpen() { return elements.appShell.classList.contains("inspector-open"); }
function syncTasksControls() {
  const open = tasksSwitcherOpen();
  // Both the toggle icon and the (unboxed) machine/task text open or close Tasks on wide layouts.
  elements.destinationButton.setAttribute("aria-expanded", String(open));
  // The wide Tasks pane is navigation, not a dialog; only the narrow selector advertises a dialog.
  if (isWideLayout()) elements.destinationButton.removeAttribute("aria-haspopup");
  else elements.destinationButton.setAttribute("aria-haspopup", "dialog");
  elements.tasksToggle.setAttribute("aria-expanded", String(open));
  const label = open ? "Hide tasks" : "Show tasks";
  elements.tasksToggle.setAttribute("aria-label", label);
  elements.tasksToggle.title = label;
}

let destinationCloseTimer;
function concealDestinationSwitcher({ clearSearch = false } = {}) {
  closeTaskMenus();
  clearTimeout(destinationCloseTimer);
  elements.destinationSwitcher.inert = true;
  if (elements.destinationSwitcher.contains(document.activeElement)) {
    (isWideLayout() ? elements.tasksToggle : elements.destinationButton).focus();
  }
  // Let the 160 ms slide finish before removing the panels from layout.
  destinationCloseTimer = setTimeout(() => {
    elements.destinationSwitcher.hidden = true;
    elements.destinationBackdrop.hidden = true;
  }, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180);
  document.body.classList.remove("destination-open");
  if (clearSearch) elements.destinationSearch.value = "";
  destinationTaskError = null;
  syncTasksControls();
}

function closeDestinationSwitcher() {
  if (destinationSelection || taskActionBusy) return false;
  concealDestinationSwitcher({ clearSearch: true });
  saveSidebarPreference("tasks", false);
  return true;
}

function openDestinationSwitcher(animate = true) {
  elements.destinationSwitcher.setAttribute("role", isWideLayout() ? "navigation" : "dialog");
  // Only one narrow drawer: opening Tasks closes Details.
  if (!isWideLayout() && inspectorOpen()) closeInspector();
  clearSelectionForOverlay();
  clearTimeout(destinationCloseTimer);
  elements.destinationSwitcher.inert = false;
  // Restore the saved open position before revealing the drawer on startup.
  if (!animate) document.body.classList.add("destination-open");
  elements.destinationSwitcher.hidden = false;
  elements.destinationBackdrop.hidden = false;
  void elements.destinationSwitcher.offsetWidth; // Establish the closed position before transitioning.
  document.body.classList.add("destination-open");
  syncTasksControls();
  saveSidebarPreference("tasks", true);
  refreshNavigationCatalog(archivedTasks, true);
  renderDestinationSwitcher();
}

function currentCatalogModel(modelName = state?.model) {
  return (state?.models || []).find((candidate) => candidate.model === modelName);
}

function renderModelControls() {
  const models = state?.thread ? sortModelsForDisplay(state?.models || []) : [];
  const enabled = Boolean(state?.connected && state?.thread && models.length)
    && !updatingModel
    && !updatingAccess
    && !resolvingApproval
    && !submittingInputRequestId
    && !submittingInterrupt;
  elements.modelSelect = renderChoiceControl(elements.modelSlot, {
    entries: models.map((model) => ({ value: model.model, label: model.displayName || model.model })),
    selected: state?.model,
    ariaLabel: "Model",
    id: "model-select",
    disabled: !enabled,
    emptyLabel: state?.model && !/^not exposed$/i.test(state.model) ? state.model : "Unavailable",
    onChange: (value) => {
      const model = currentCatalogModel(value);
      const efforts = model?.supportedReasoningEfforts || [];
      const effort = efforts.some((option) => option.reasoningEffort === state?.reasoningEffort)
        ? state.reasoningEffort
        : model?.defaultReasoningEffort || efforts[0]?.reasoningEffort;
      if (model && effort) updateThreadSettings(model.model, effort);
    },
  });

  const selectedModel = currentCatalogModel(elements.modelSelect?.value || state?.model);
  const efforts = selectedModel?.supportedReasoningEfforts || [];
  elements.effortSelect.replaceChildren();
  for (const effort of efforts) {
    const option = document.createElement("option");
    option.value = effort.reasoningEffort;
    option.textContent = effortLabel(effort.reasoningEffort);
    option.selected = effort.reasoningEffort === state?.reasoningEffort;
    elements.effortSelect.append(option);
  }
  if (!efforts.length) {
    const option = document.createElement("option");
    option.textContent = effortLabel(state?.reasoningEffort);
    elements.effortSelect.append(option);
  }
  elements.effortSelect.disabled = !enabled || !efforts.length;
}

function renderAccessControl() {
  const access = state?.access;
  elements.accessSelect.replaceChildren();
  // Unavailable modes are omitted; a custom/unknown current mode is preserved on its own.
  const available = ACCESS_MODES.filter((mode) => access?.choices?.[mode.value]?.available === true);
  if (!available.some((mode) => mode.value === access?.mode) && (access?.mode || !available.length)) {
    const option = document.createElement("option");
    option.value = access?.mode || "unavailable";
    option.textContent = accessModeLabel(access?.mode);
    option.selected = true;
    option.disabled = true;
    if (access?.description || access?.profileId) option.title = access.description || access.profileId;
    elements.accessSelect.append(option);
  }
  for (const mode of available) {
    const choice = access?.choices?.[mode.value];
    const option = document.createElement("option");
    option.value = mode.value;
    option.textContent = mode.label;
    if (choice?.reason) option.title = choice.reason;
    option.selected = access?.mode === mode.value;
    elements.accessSelect.append(option);
  }
  elements.accessSelect.disabled = !state?.connected
    || !state?.thread
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

// Each Display option filters its own activity kind; the key matches the saved preference name.
const DISPLAY_ACTIVITY_KINDS = [
  ["reasoning", "reasoning"], ["command", "command"], ["tool", "tool"], ["search", "search"],
  ["files", "files"], ["collaboration", "collaboration"], ["images", "image"], ["review", "review"],
  ["compaction", "compaction"],
];
const DISPLAY_CONTROLS = {
  reasoning: elements.displayReasoning, command: elements.displayCommands, tool: elements.displayTool,
  search: elements.displaySearch, files: elements.displayFiles, collaboration: elements.displayCollaboration,
  images: elements.displayImages, review: elements.displayReview, compaction: elements.displayCompaction,
};

// Historical or live activity for a kind means its filter still matters, even if the runtime
// currently disables the feature that produced it.
function activityKindPresent(kind) {
  for (const activity of liveActivities.values()) if (activity.kind === kind) return true;
  for (const activity of historyActivities.values()) if (activity.kind === kind) return true;
  for (const activity of state?.activities || []) if (activity.kind === kind) return true;
  return false;
}

function renderDisplayControls() {
  const preferences = settingsDisplayDraft || displayPreferences;
  // A filter is hidden only when the runtime positively disables the feature AND the task has no
  // activity of that kind; unknown capability never hides a control.
  const capabilities = state?.capabilities || {};
  for (const [key, kind] of DISPLAY_ACTIVITY_KINDS) {
    const control = DISPLAY_CONTROLS[key];
    const supported = capabilities[kind] !== false || activityKindPresent(kind);
    if (control) control.closest("label").hidden = !supported;
  }
  elements.displayFiles.checked = preferences.files;
  elements.displayCommands.checked = preferences.command;
  elements.displayTool.checked = preferences.tool;
  elements.displaySearch.checked = preferences.search;
  elements.displayReview.checked = preferences.review;
  elements.displayReasoning.checked = preferences.reasoning;
  elements.displayCollaboration.checked = preferences.collaboration;
  elements.displayImages.checked = preferences.images;
  elements.displayCompaction.checked = preferences.compaction;
  // Show All / Hide All only act on the categories currently visible; disable the no-op one.
  const visibleCategories = DISPLAY_ACTIVITY_KINDS
    .map(([key]) => DISPLAY_CONTROLS[key])
    .filter((control) => control && !control.closest("label").hidden);
  const checkedCount = visibleCategories.filter((control) => control.checked).length;
  elements.displayShowAll.disabled = visibleCategories.length === 0 || checkedCount === visibleCategories.length;
  elements.displayHideAll.disabled = visibleCategories.length === 0 || checkedCount === 0;
}

function renderQueue() {
  const queued = state?.queuedMessage;
  if (queueDialog.open && !queueDialogMatches()) queueDialog.close();
  elements.queueBanner.hidden = !queued;
  renderImageThumbnails(elements.queueImages, queued?.images || []);
  renderFileChips(document.querySelector("#queue-files"), queued?.files || []);
  if (queued) {
    elements.queueText.textContent = queued.text || (queued.files?.length ? `${queued.files.length} file(s)` : `${queued.images?.length || 0} image(s)`);
    elements.queueText.title = queued.text;
    const turnActive = state?.turn?.status === "inProgress";
    elements.sendQueue.hidden = !turnActive && state?.message?.mode !== "start";
    elements.sendQueue.disabled = queued?.deliveryUnknown || queueDeliveryUnknown || !state?.message?.allowed || submittingMessage || sendingQueuedMessage || cancellingQueue || queueDialogBusy;
    elements.sendQueue.classList.toggle("icon-button", turnActive);
    elements.sendQueue.classList.toggle("text-button", !turnActive);
    const actionLabel = turnActive ? "Steer Now" : sendingQueuedMessage ? "Sending…" : "Send";
    elements.sendQueue.setAttribute("aria-label", actionLabel);
    elements.sendQueue.title = actionLabel;
    elements.sendQueue.innerHTML = turnActive
      ? '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 19v-7a5 5 0 0 1 5-5h9m-5-5 5 5-5 5"/></svg>'
      : actionLabel;
    elements.cancelQueue.disabled = submittingMessage || cancellingQueue || sendingQueuedMessage || queueDialogBusy;
    document.querySelector("#edit-queue").disabled = elements.cancelQueue.disabled || queueDeliveryUnknown;
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
  title.textContent = "Input Needed";
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
  submit.textContent = submittingInputRequestId === pending.id || pending.resolving ? "Sending…" : "Send Answer";
  submit.disabled = requestDisabled;
  actions.append(submit);
  form.append(actions);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitStructuredInput(pending);
  });
  elements.attentionBanner.append(form);
}

let attentionRenderKey = null;
function renderAttention() {
  const pending = state?.pending?.[0];
  const currentInputIds = new Set((state?.pending || []).filter((request) => request.kind === "input").map((request) => request.id));
  for (const requestId of inputDrafts.keys()) if (!currentInputIds.has(requestId)) inputDrafts.delete(requestId);
  const key = JSON.stringify([state?.machineId, state?.thread?.id, pending, submittingInputRequestId, resolvingApproval, state?.stoppingTurnId,
    (state?.pending || []).filter(request => request.kind === "permission").length]);
  if (key === attentionRenderKey) return;
  attentionRenderKey = key;
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
  title.textContent = "Approval Needed";
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

const goalStrip = document.querySelector("#goal-strip");
const goalToggle = document.querySelector("#goal-toggle");
const goalClear = document.querySelector("#goal-clear");
const goalClearDialog = document.querySelector("#goal-clear-dialog");
let goalClearTarget = null;
function goalClearTargetMatches() {
  return goalClearTarget && state?.goal && state.machineId === goalClearTarget.machineId && state.thread?.id === goalClearTarget.threadId;
}
let goalClock = null;
const goalTime = document.querySelector("#goal-time");
function renderGoalTime() {
  const elapsed = goalClock?.active ? Math.max(0, Date.now() - goalClock.receivedAt) : 0;
  goalTime.textContent = typeof goalClock?.seconds === "number" ? formatElapsed(goalClock.seconds * 1000 + elapsed) : "";
}
let goalActionBusy = null;
function renderGoal() {
  const goal = state?.goal;
  if (goalClearDialog.open && !goalClearTargetMatches()) goalClearDialog.close();
  goalStrip.hidden = !goal;
  if (!goal) { goalClock = null; return; }
  const clockKey = JSON.stringify([state.machineId, state.thread?.id, goal.objective, goal.status, goal.timeUsedSeconds]);
  if (goalClock?.key !== clockKey) goalClock = { key: clockKey, seconds: goal.timeUsedSeconds, active: goal.status === "active", receivedAt: Date.now() };
  renderGoalTime();
  const labels = { active: "Pursuing Goal", paused: "Goal Paused", blocked: "Goal Blocked", usageLimited: "Goal Usage Limited", budgetLimited: "Goal Budget Limited", complete: "Goal Complete" };
  document.querySelector("#goal-status").textContent = labels[goal.status] || `Goal ${goal.status}`;
  const objective = document.querySelector("#goal-objective");
  objective.textContent = goal.objective;
  objective.title = goal.objective;
  goalStrip.title = typeof goal.tokensUsed === "number" ? `${goal.tokensUsed.toLocaleString()} tokens used${typeof goal.tokenBudget === "number" ? ` / ${goal.tokenBudget.toLocaleString()} budget` : ""}` : "";
  const active = goal.status === "active";
  goalToggle.hidden = !active && goal.status !== "paused";
  goalToggle.dataset.action = active ? "pause" : "resume";
  goalToggle.title = active ? "Pause goal" : "Resume goal";
  goalToggle.setAttribute("aria-label", goalToggle.title);
  goalToggle.innerHTML = `<svg aria-hidden="true" viewBox="0 0 24 24"><path d="${active ? "M8 5v14M16 5v14" : "m8 5 11 7-11 7Z"}"/></svg>`;
  goalToggle.disabled = goalClear.disabled = Boolean(goalActionBusy) || !state.connected;
}
async function performGoalAction(body) {
  if (goalActionBusy) return;
  goalActionBusy = body;
  renderGoal();
  try {
    const response = await apiFetch("/api/goal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Goal action failed");
    if (state?.machineId === body.machineId && state?.thread?.id === body.threadId) mergeState({ goal: result.goal });
  } catch (error) {
    if (state?.machineId === body.machineId && state?.thread?.id === body.threadId) composerError = error.message;
  } finally { goalActionBusy = null; renderComposer(); }
}
goalToggle.addEventListener("click", () => performGoalAction({ machineId: state.machineId, threadId: state.thread.id, action: goalToggle.dataset.action }));
goalClear.addEventListener("click", () => {
  if (!state?.goal || !state.thread || goalActionBusy) return;
  const body = { machineId: state.machineId, threadId: state.thread.id, action: "clear", confirmed: true };
  if (state.goal.status === "complete") { void performGoalAction(body); return; }
  goalClearTarget = body;
  goalClearDialog.showModal();
  document.querySelector("#goal-clear-keep").focus();
});
goalClearDialog.addEventListener("keydown", event => { if (event.key === "Escape") event.stopPropagation(); });
goalClearDialog.addEventListener("close", () => { if (!goalClearDialog.open) goalClearTarget = null; });
document.querySelector("#goal-clear-keep").addEventListener("click", () => goalClearDialog.close());
document.querySelector("#goal-clear-form").addEventListener("submit", event => {
  event.preventDefault();
  if (!goalClearDialog.open || !goalClearTargetMatches()) { goalClearDialog.close(); return; }
  const body = goalClearTarget;
  goalClearDialog.close();
  void performGoalAction(body);
});

function renderComposer() {
  renderGoal();
  const capability = state?.message;
  const turnError = state?.phase === "failed" && state?.turn?.status !== "inProgress" ? state?.turn?.error : "";
  const turnActive = state?.turn?.status === "inProgress" && Boolean(state?.turn?.id);
  const stopping = submittingInterrupt || (turnActive && state?.stoppingTurnId === state?.turn?.id);
  const hasText = Boolean(elements.messageText.value.trim()) || (selectedImages.length > 0 || selectedFiles.length > 0);
  const allowed = Boolean(capability?.allowed)
    && !submittingMessage
    && !updatingAccess
    && !resolvingApproval
    && !submittingInputRequestId
    && !stopping
    && !readingAttachments
    && !attachmentDeliveryUnknown;
  elements.messageText.disabled = !state?.connected
    || !state?.thread
    || submittingMessage
    || stopping;
  elements.attachImage.disabled = elements.messageText.disabled || readingAttachments || Boolean(state?.queuedMessage) || attachmentDeliveryUnknown;
  if (turnActive && !hasText) {
    elements.sendMessage.dataset.action = "stop";
    elements.sendMessage.textContent = stopping ? "Stopping…" : "Stop";
    elements.sendMessage.classList.add("stop-action");
    elements.sendMessage.disabled = stopping;
  } else {
    elements.sendMessage.dataset.action = turnActive ? "queue" : "start";
    elements.sendMessage.textContent = "Send";
    elements.sendMessage.classList.remove("stop-action");
    elements.sendMessage.disabled = !allowed || !hasText || Boolean(state?.queuedMessage);
  }
  const capabilityError = !stopping && !resolvingApproval && !submittingInputRequestId
    && capability?.allowed === false && capability.reason !== "Stopping the active turn…" ? capability.reason : "";
  // With no task selected the conversation already says so; task-specific messages stay suppressed.
  const noTask = !state?.thread;
  const status = noTask ? "" : composerError || turnError || capabilityError || state?.taskNameWarning || "";
  const usageLimit = usageLimitMessage(status);
  elements.composerStatus.textContent = usageLimit || status;
  if (usageLimit) {
    const credits = Object.assign(document.createElement("a"), {
      className: "composer-credits", textContent: "Buy credits",
      href: "https://chatgpt.com/codex/settings/usage", target: "_blank", rel: "noopener noreferrer",
    });
    elements.composerStatus.append(" ", credits);
  }
  elements.composerStatus.hidden = !status;
  elements.composerStatus.classList.toggle("error-text", !noTask && Boolean(composerError || turnError));
  renderAttention();
  renderQueue();
  renderImageThumbnails(elements.composerImages, selectedImages, true);
  renderFileChips(document.querySelector("#composer-files"), selectedFiles, true);
}

function renderImageThumbnails(container, images, removable = false) {
  container.hidden = !images.length;
  container.replaceChildren();
  images.forEach((image, index) => {
    const thumb = document.createElement("span");
    thumb.className = "composer-thumbnail";
    const img = document.createElement("img");
    img.src = image.url;
    img.alt = `Image ${index + 1}`;
    enableImageViewer(img);
    thumb.append(img);
    if (removable) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "attachment-remove";
      remove.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 6 12 12M6 18 18 6"/></svg>';
      remove.setAttribute("aria-label", `Remove image ${index + 1}`);
      remove.disabled = submittingMessage || readingAttachments;
      remove.addEventListener("click", () => {
        selectedImages = selectedImages.filter((_, candidate) => candidate !== index);
        if (!selectedImages.length && !selectedFiles.length) attachmentDeliveryUnknown = false;
        renderComposer();
      });
      thumb.append(remove);
    }
    container.append(thumb);
  });
}

function renderFileChips(container, files, removable = false) {
  container.hidden = !files.length;
  container.replaceChildren();
  files.forEach((file, index) => {
    const chip = document.createElement("span");
    chip.className = "file-chip";
    const name = document.createElement("span");
    name.textContent = file.name;
    name.title = file.name;
    const size = document.createElement("small");
    size.textContent = file.size >= 1024 * 1024 ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(file.size / 1024)} KB`;
    chip.append(name, size);
    if (removable) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "attachment-remove";
      remove.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 6 12 12M6 18 18 6"/></svg>';
      remove.setAttribute("aria-label", `Remove file ${file.name}`);
      remove.disabled = submittingMessage || readingAttachments;
      remove.addEventListener("click", () => {
        selectedFiles = selectedFiles.filter((_, candidate) => candidate !== index);
        if (!selectedImages.length && !selectedFiles.length) attachmentDeliveryUnknown = false;
        renderComposer();
      });
      chip.append(remove);
    }
    container.append(chip);
  });
}

async function addFiles(files) {
  if (elements.attachImage.disabled || !files.length) return;
  if (unresolvedSubmission) unresolvedSubmission.restoreDraft = false;
  const taskKey = draftKey(state?.machineId, state?.thread?.id);
  const priorImages = [...selectedImages], priorFiles = [...selectedFiles];
  readingAttachments = true;
  composerError = "";
  renderComposer();
  try {
    const isImage = file => /^image\/(png|jpeg|gif|webp)$/.test(file.type);
    const imageFiles = files.filter(isImage), otherFiles = files.filter(file => !isImage(file));
    if (priorImages.length + imageFiles.length > MAX_INPUT_IMAGES) throw new Error("Choose up to 4 images");
    if (priorFiles.length + otherFiles.length > MAX_INPUT_FILES) throw new Error("Choose up to 4 files");
    if (otherFiles.some(file => file.size > MAX_INPUT_FILE_BYTES)) throw new Error("Each file must be 10 MB or smaller");
    if ([...priorFiles, ...otherFiles].reduce((sum, file) => sum + file.size, 0) > MAX_INPUT_FILES_BYTES) throw new Error("Files must be at most 20 MB together");
    const images = [], attachments = [];
    for (const file of files) {
      const image = isImage(file);
      if (image && file.size > MAX_INPUT_IMAGE_BYTES) throw new Error("Each image must be 4 MB or smaller");
      const url = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("Could not read this file"));
        reader.readAsDataURL(file);
      });
      if (image) images.push({ type: "image", url });
      else attachments.push({ name: file.name, size: file.size, data: url.slice(url.indexOf(",") + 1) });
    }
    const nextImages = imageInputs([...priorImages, ...images]);
    const nextFiles = fileInputs([...priorFiles, ...attachments]);
    if (taskKey !== draftKey(state?.machineId, state?.thread?.id)) {
      if (taskKey) rememberComposerDraft(composerDrafts, taskKey, { text: composerDrafts.get(taskKey)?.text || "", images: nextImages, files: nextFiles });
    } else { selectedImages = nextImages; selectedFiles = nextFiles; }
  } catch (error) {
    composerError = error.message;
  } finally {
    readingAttachments = false;
    elements.imagePicker.value = "";
    renderComposer();
  }
}

// One maximum is shared by CSS (--composer-max-height) and JS: the smaller of a fixed cap, ~40% of
// the usable visual viewport, and the space left after the action row and any visible extra rows.
const COMPOSER_MAX_HEIGHT = 320;
function composerSurroundingHeight() {
  let total = elements.composerActions.offsetHeight;
  for (const row of [elements.attentionBanner, elements.queueBanner, goalStrip, elements.composerImages, document.querySelector("#composer-files")]) {
    if (row && !row.hidden) total += row.getBoundingClientRect().height;
  }
  return total;
}
function composerMaxHeight() {
  const viewport = window.visualViewport?.height ?? window.innerHeight;
  const byViewport = Math.round(viewport * 0.4);
  const byFit = Math.round(viewport - composerSurroundingHeight() - 24);
  return Math.max(40, Math.min(COMPOSER_MAX_HEIGHT, byViewport, byFit));
}

function resizeComposer() {
  const textarea = elements.messageText;
  const scrollTop = textarea.scrollTop;
  elements.composerInput.classList.remove("can-expand");
  textarea.style.height = composerExpanded ? "100%" : "auto";
  const style = getComputedStyle(textarea);
  const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  const max = composerMaxHeight();
  elements.composerInput.style.setProperty("--composer-max-height", `${max}px`);
  // Show the normal-mode control only when its full hit target fits above the action row.
  const height = Math.max(40, Math.min(textarea.scrollHeight + border, max));
  const showExpand = composerExpanded || height >= 4 + 32 + 4 + elements.composerActions.offsetHeight;
  elements.composerInput.classList.toggle("can-expand", showExpand);
  elements.expandComposer.hidden = !showExpand;
  if (!composerExpanded) textarea.style.height = `${Math.max(height, Math.min(textarea.scrollHeight + border, max))}px`;
  textarea.scrollTop = scrollTop;
}

function renderState() {
  if (!state) return;
  const selectedMachine = machines.find((machine) => machine.id === state.machineId);
  if (selectedMachine) {
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
  // No task selected: hide the task-only header meters and swap details for one plain message.
  elements.appShell.classList.toggle("no-task", !state.thread);
  elements.inspector.classList.toggle("no-task", !state.thread);
  elements.inspectorEmpty.hidden = Boolean(state.thread);
  const phase = state.phase || "connecting";
  elements.phase.textContent = phaseLabels[phase] || phase;
  elements.phase.className = `phase-pill ${phase}`;
  const startedAt = state.turn?.startedAt;
  const completedAt = state.turn?.completedAt;
  elements.elapsed.textContent = startedAt ? formatElapsed((completedAt || Date.now()) - startedAt) : "—";
  // The provider is separate metadata next to the machine name, never part of the name.
  elements.machine.replaceChildren(state.machine || "—");
  const platform = platformLabel(state.platform);
  if (platform) elements.machine.append(` · ${platform}`);
  elements.provider.textContent = providerName(state.provider) || "—";
  if (cwdDialog.open && !cwdDialogMatches()) cwdDialog.close();
  document.querySelector("#edit-cwd").disabled = !state.connected || !state.thread || cwdBusy;
  elements.project.textContent = state.thread?.cwd || "—";
  elements.project.title = state.thread?.cwd || "";
  renderDestinationButton();
  renderDestinationSwitcher();
  renderModelControls();
  renderAccessControl();
  renderPlan();
  renderDisplayControls();
  renderQuota();
  const context = state.context;
  elements.contextPercent.textContent = context ? `${context.lastKnown ? "~" : ""}${context.usedPercent}%` : "—";
  elements.contextFill.style.width = `${context?.usedPercent ?? 0}%`;
  elements.context.title = context ? `${context.lastKnown ? "Last known · " : ""}${context.usedPercent}% context used · ${context.usedTokens.toLocaleString()} / ${context.contextWindow.toLocaleString()} tokens used` : "Context usage unavailable";
  elements.runtimeReason.textContent = ["local", "local:dsh"].includes(state.machineId) ? state.connectionError || "" : "";
  elements.runtimeReason.hidden = !elements.runtimeReason.textContent;
  renderComposer();
}

function messageNode(message, displayCreatedAt) {
  const article = document.createElement("article");
  article.className = `message ${message.role} ${message.complete ? "" : "streaming"}`;
  article.dataset.messageId = message.id;
  const meta = document.createElement("div");
  meta.className = "message-meta";
  const role = document.createElement("span");
  role.textContent = message.role === "assistant" ? "Codex" : "You";
  const time = document.createElement("time");
  if (displayCreatedAt) {
    time.dateTime = new Date(displayCreatedAt).toISOString();
    time.textContent = new Date(displayCreatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  meta.append(role, time);
  const body = document.createElement("div");
  body.className = "message-body";
  renderMarkdownInto(body, message.text, message);
  if (message.role === "user" && message.imageCount) {
    const images = document.createElement("div");
    images.className = "message-images";
    for (let index = 0; index < Math.min(message.imageCount, 10); index++) {
      const img = document.createElement("img");
      img.src = "/api/message/image?" + new URLSearchParams({ machineId: state.machineId, threadId: state.thread.id, messageId: message.id, index });
      img.alt = `Attached image ${index + 1}`;
      enableImageViewer(img);
      images.append(img);
    }
    body.append(images);
  }
  if (message.delivery === "async" && message.questions?.length) {
    suppressAsyncQuestionMarkdown(body, message.questions);
    for (const [index, question] of message.questions.entries()) body.append(asyncQuestionNode(message, question, index));
  }
  article.append(meta, body);
  return article;
}

// Match rendered blocks within this message only. Options belong to the immediately
// preceding matched question; identical words in unrelated lists are left alone.
function suppressAsyncQuestionMarkdown(body, questions) {
  const normalize = text => text.replace(/\s+/gu, " ").trim();
  const renderedText = value => {
    const node = document.createElement("div");
    renderMarkdownInto(node, value);
    return normalize(node.textContent);
  };
  const canonical = questions.map(question => ({ title: renderedText(question.title), options: new Set(question.options.map(renderedText)) }));
  const blocks = [];
  for (const node of body.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, table, hr")) {
    if (node.matches("blockquote, pre, table, hr")) { blocks.push({ text: null }); continue; }
    if (node.closest("blockquote, pre, table") || node.querySelector("p, ul, ol")) continue;
    const whole = normalize(node.textContent);
    if (canonical.some(question => question.title === whole || question.options.has(whole))) {
      const range = document.createRange();
      range.selectNodeContents(node);
      blocks.push({ range, text: whole });
      continue;
    }
    const breaks = [...node.querySelectorAll("br")];
    for (let index = 0; index <= breaks.length; index++) {
      const range = document.createRange();
      if (index) range.setStartAfter(breaks[index - 1]); else range.setStart(node, 0);
      if (index < breaks.length) range.setEndBefore(breaks[index]); else range.setEnd(node, node.childNodes.length);
      const text = normalize(range.toString());
      if (index < breaks.length) range.setEndAfter(breaks[index]);
      if (text) blocks.push({ range, text });
    }
  }
  let question = null;
  const remove = [];
  for (const block of blocks) {
    const match = canonical.find(candidate => candidate.title === block.text);
    if (match) { question = match; remove.push(block.range); }
    else if (question?.options.has(block.text)) remove.push(block.range);
    else question = null;
  }
  for (const range of remove.reverse()) range.deleteContents();
  for (const node of [...body.querySelectorAll("p, li, ul, ol, h1, h2, h3, h4, h5, h6")].reverse()) {
    if (!normalize(node.textContent) && !node.querySelector("img")) node.remove();
  }
}

function asyncQuestionNode(message, question, index) {
  const key = `${message.id}:${index}`;
  const draft = asyncDrafts.get(key) || { text: "", sending: false, error: "", uncertain: false };
  asyncDrafts.set(key, draft);
  const all = new Map([...historyMessages, ...liveMessages]);
  const answer = resolvedAsyncAnswer(message, index, [...all.values()], state?.asyncAnswers);
  const title = document.createElement("div");
  title.className = "async-title";
  renderMarkdownInto(title, question.title);
  if (answer !== null) {
    draft.error = "";
    draft.uncertain = false;
    return title;
  }
  const form = document.createElement("form");
  form.className = "async-answer";
  const fields = document.createElement("div");
  fields.className = "async-question";
  const disabled = draft.sending || draft.uncertain || !state?.message?.allowed;
  fields.append(title);
  const options = document.createElement("div");
  options.className = "async-options";
  for (const option of question.options) {
    const choice = document.createElement("button");
    choice.type = "button";
    choice.disabled = disabled;
    renderMarkdownInto(choice, option);
    choice.classList.toggle("selected", draft.text === option);
    choice.addEventListener("click", () => { draft.text = option; submitAsyncAnswer(message, index, draft); });
    options.append(choice);
  }
  const input = document.createElement("textarea");
  input.rows = 2;
  input.disabled = disabled;
  input.maxLength = 8000;
  input.placeholder = question.options.length ? "Or write your answer…" : "Write your answer…";
  input.setAttribute("aria-label", `Your answer: ${question.title}`);
  input.value = draft.text;
  let answerComposing = false;
  input.addEventListener("compositionstart", () => { answerComposing = true; });
  input.addEventListener("compositionend", () => { answerComposing = false; });
  input.addEventListener("keydown", event => {
    if (enterSubmits(event, enterSends, answerComposing) && input.value.trim() && !input.disabled) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  input.addEventListener("input", () => { draft.text = input.value; draft.error = ""; });
  const send = document.createElement("button");
  send.type = "submit";
  send.textContent = draft.sending ? "Sending…" : "Answer";
  send.disabled = disabled;
  const freeText = document.createElement("div");
  freeText.className = "async-free-text";
  freeText.hidden = question.options.length > 0 && !draft.otherOpen;
  freeText.append(input, send);
  fields.append(options);
  if (question.options.length) {
    const other = document.createElement("button");
    other.type = "button";
    other.className = "other-answer";
    other.textContent = "Other Answer…";
    other.disabled = disabled;
    other.setAttribute("aria-expanded", String(!freeText.hidden));
    other.addEventListener("click", () => {
      draft.otherOpen = !draft.otherOpen;
      freeText.hidden = !draft.otherOpen;
      other.setAttribute("aria-expanded", String(draft.otherOpen));
      if (draft.otherOpen) input.focus();
    });
    fields.append(other);
  }
  fields.append(freeText);
  const status = document.createElement("p");
  status.className = "form-status error-text";
  status.textContent = draft.error;
  form.append(fields, status);
  form.addEventListener("submit", (event) => { event.preventDefault(); submitAsyncAnswer(message, index, draft); });
  return form;
}

async function submitAsyncAnswer(message, index, draft) {
  if (destinationSelection || taskActionBusy) return;
  if (draft.sending || draft.uncertain || !draft.text.trim()) return;
  const machineId = state.machineId, threadId = state.thread.id;
  draft.sending = true;
  draft.error = "";
  document.activeElement?.blur();
  renderConversation({ restoreScrollTop: transcriptScroller().scrollTop });
  try {
    const result = await postMessageAction("/api/message", { machineId, question: { threadId, messageId: message.id, index, answer: draft.text } });
    if (machineId !== state?.machineId || threadId !== state?.thread?.id) return;
    if (!result.recovered) mergeState(result, true);
  } catch (error) {
    draft.error = error.message;
    draft.uncertain = Boolean(error.deliveryUnknown);
  } finally {
    draft.sending = false;
    renderConversation({ restoreScrollTop: transcriptScroller().scrollTop });
  }
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
  // File changes are always wrapped.
  wrapper.className = "detail-diff wrap";
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
    append(detailField("Working Directory", detail.cwd));
    append(detailField("Duration", detail.duration, "detail-note"));
    if (detail.exitCode !== null && detail.exitCode !== 0) append(detailField("Exit Code", detail.exitCode, "detail-note"));
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
    if (detail.type === "imageGeneration") append(detailField("Image", detail.name, "detail-note"));
    append(detailField("Revised Prompt", detail.revisedPrompt));
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
      enableImageViewer(image);
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
  const scrollTop = transcriptScroller().scrollTop;
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
  renderConversation({ restoreScrollTop: transcriptScroller().scrollTop });
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
        renderConversation({ restoreScrollTop: transcriptScroller().scrollTop });
      } else if (current?.detail || current?.error) {
        activityDetails.set(activity.id, { ...current, expanded: true });
        renderConversation({ restoreScrollTop: transcriptScroller().scrollTop });
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
    command: "Command", tool: "Tool", search: "Search", files: "File Changes",
    reasoning: "Reasoning", collaboration: "Subagents", image: "Image", compaction: "Context Compaction", review: "Review",
  };
  kind.textContent = labels[activity.kind] || "Activity";
  const activityStatus = document.createElement("span");
  activityStatus.className = "activity-status";
  activityStatus.textContent = activity.status === "interrupted" ? "Stopped" : `${activity.status.charAt(0).toUpperCase()}${activity.status.slice(1)}`;
  heading.append(kind, activityStatus);
  const label = document.createElement("div");
  label.className = "activity-label";
  label.textContent = activity.label;
  if (activity.expandable) {
    const chevron = document.createElement("span");
    chevron.className = "activity-chevron";
    chevron.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m9 5 7 7-7 7"/></svg>';
    label.append(chevron);
  }
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

function emptyConversationText() {
  return state?.thread ? "No conversation history yet." : "Select a task or create one.";
}

function renderConversation({ preserveScroll = null, forceBottom = false, restoreScrollTop = null } = {}) {
  observeTranscriptSelection();
  deferredTranscript = false;
  // Loading history can introduce activity kinds whose filters were hidden as unsupported.
  renderDisplayControls();
  const all = new Map(historyMessages);
  for (const [id, message] of liveMessages) all.set(id, message);
  const messages = reconcileConfirmedSteers([...all.values()]).sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0));
  const allActivities = new Map(historyActivities);
  for (const [id, activity] of liveActivities) allActivities.set(id, activity);
  const activities = [...allActivities.values()].filter(activityVisible);
  const timeline = orderTranscriptEntries([
    ...messages.map((value) => ({ type: "message", value })),
    ...activities.map((value) => ({ type: "activity", value })),
  ]);
  let displayCreatedAt = 0;
  for (const entry of timeline) {
    displayCreatedAt = Math.max(displayCreatedAt, entry.value.createdAt || 0);
    entry.displayCreatedAt = entry.value.createdAt ? displayCreatedAt : null;
  }
  const desired = timeline.length ? timeline : [{ type: "empty", value: { id: "empty" } }];
  const desiredKeys = new Set(desired.map(entry => `${entry.type}:${entry.value.id}`));
  // Keep selected entries (and an answer being edited) intact; update other entries normally.
  const protectedNode = node => heldTranscriptNodes.has(node)
    || node.contains(document.activeElement) && document.activeElement?.tagName === "TEXTAREA";
  // Include UI state that changes an entry without changing its protocol payload.
  const signature = entry => JSON.stringify([
    entry.value,
    entry.displayCreatedAt,
    entry.type === "activity" ? [activityDetails.get(entry.value.id)] : null,
    entry.type === "message" && entry.value.questions?.length ? [
      state?.message?.allowed,
      entry.value.questions.map((_, index) => [
        asyncDrafts.get(`${entry.value.id}:${index}`),
        resolvedAsyncAnswer(entry.value, index, messages, state?.asyncAnswers),
      ]),
    ] : null,
  ]);
  for (const [key, record] of transcriptNodes) {
    if (desiredKeys.has(key)) continue;
    if (protectedNode(record.node)) { deferredTranscript = true; continue; }
    record.node.remove();
    transcriptNodes.delete(key);
  }
  let cursor = elements.conversation.firstChild;
  for (const entry of desired) {
    const key = `${entry.type}:${entry.value.id}`;
    let record = transcriptNodes.get(key);
    const nextSignature = signature(entry);
    if (!record || record.signature !== nextSignature) {
      if (record && protectedNode(record.node)) {
        deferredTranscript = true;
      } else {
        const node = entry.type === "message" ? messageNode(entry.value, entry.displayCreatedAt)
          : entry.type === "activity" ? activityNode(entry.value)
          : Object.assign(document.createElement("p"), { className: "empty-state", textContent: emptyConversationText() });
        node.dataset.timelineKey = key;
        if (record) {
          if (cursor === record.node) cursor = node;
          record.node.replaceWith(node);
        }
        record = { node, signature: signature(entry) };
        transcriptNodes.set(key, record);
      }
    }
    if (record.node !== cursor) {
      if (protectedNode(record.node)) deferredTranscript = true;
      else elements.conversation.insertBefore(record.node, cursor);
    }
    cursor = record.node.nextSibling;
  }
  if (restoreScrollTop !== null) {
    transcriptScroller().scrollTop = restoreScrollTop;
  } else if (preserveScroll) {
    const addedHeight = transcriptScroller().scrollHeight - preserveScroll.scrollHeight;
    transcriptScroller().scrollTop = preserveScroll.scrollTop + addedHeight;
    shouldFollowConversation = false;
  } else if (!selectionHold.active && (forceBottom || shouldFollowConversation)) {
    transcriptScroller().scrollTop = transcriptScroller().scrollHeight;
    shouldFollowConversation = true;
  }
  rememberTranscriptScroll();
  updateJumpLatest();
}

function transcriptSelectionActive() {
  const selection = window.getSelection();
  return selection && !selection.isCollapsed && (elements.conversation.contains(selection.anchorNode) || elements.conversation.contains(selection.focusNode));
}

function observeTranscriptSelection() {
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed
    && elements.conversation.contains(selection.anchorNode) && !elements.conversation.contains(selection.focusNode)) {
    const bounds = document.createRange();
    bounds.selectNodeContents(elements.conversation);
    const above = bounds.comparePoint(selection.focusNode, selection.focusOffset) < 0;
    selection.extend(elements.conversation, above ? 0 : elements.conversation.childNodes.length);
  }
  const selected = transcriptSelectionActive();
  if (selected) markSendNavigationOverride();
  selectionHold.observe(selected);
  elements.appShell.classList.toggle("transcript-selection-held", selectionHold.active);
  if (!selected) return;
  for (const node of elements.conversation.children) {
    for (let index = 0; index < selection.rangeCount; index++) {
      if (selection.getRangeAt(index).intersectsNode(node)) heldTranscriptNodes.add(node);
    }
  }
}

function clearSelectionForOverlay() {
  window.getSelection()?.removeAllRanges();
  selectionHold.reset();
  elements.appShell.classList.remove("transcript-selection-held");
  heldTranscriptNodes.clear();
  flushDeferredTranscript();
}

function flushDeferredTranscript() {
  if (deferredTranscript && !selectionHold.active && !transcriptSelectionActive()) renderConversation({ restoreScrollTop: transcriptScroller().scrollTop });
}

function transcriptScroller() {
  return matchMedia("(max-width: 860px)").matches ? document.scrollingElement : elements.conversation;
}

function rememberTranscriptScroll() {
  transcriptScrollElement = transcriptScroller();
  transcriptScrollTop = transcriptScrollElement.scrollTop;
  transcriptScrollBottomGap = transcriptScrollElement.scrollHeight - transcriptScrollElement.scrollTop - transcriptScrollElement.clientHeight;
}

// A deliberate transcript navigation after pressing Send (an upward scroll or a text selection)
// overrides the pending automatic jump, scoped to the task that owns the in-flight submission.
function markSendNavigationOverride() {
  const pending = pendingSendNavigation;
  if (pending && !pending.overridden
    && pending.machineId === state?.machineId && pending.threadId === state?.thread?.id) pending.overridden = true;
}

// Jump to Latest is an explicit request to follow again, so it drops any pending override.
function clearSendNavigationOverride() {
  if (pendingSendNavigation) pendingSendNavigation.overridden = false;
}

// Retire the guard once its submission reaches a final outcome; an unconfirmed send keeps it for recovery.
function settleSendNavigation(pending) {
  if (pending && pendingSendNavigation === pending) pendingSendNavigation = null;
}

function updateJumpLatest() {
  const distance = transcriptScroller().scrollHeight - transcriptScroller().scrollTop - transcriptScroller().clientHeight;
  elements.jumpLatest.hidden = distance < NEAR_BOTTOM_PX;
}

function jumpToLatest(instant = false) {
  shouldFollowConversation = true;
  transcriptScroller().scrollTo({
    top: transcriptScroller().scrollHeight,
    behavior: instant || matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
  });
  updateJumpLatest();
}

function mergeState(next, renderMessages = Array.isArray(next.liveMessages) || Array.isArray(next.activities)) {
  if (Object.hasOwn(next, "queuedMessage") && !next.queuedMessage && !unresolvedSubmission) queueDeliveryUnknown = false;
  const terminalTransitions = [];
  if (Array.isArray(next.activities)) {
    next = { ...next, activities: mergeActivities([...liveActivities.values()], next.activities) };
    for (const activity of next.activities) {
      const previous = liveActivities.get(activity.id) || state?.activities?.find((candidate) => candidate.id === activity.id);
      if (previous?.status === "running" && ["completed", "failed", "interrupted"].includes(activity.status)) {
        terminalTransitions.push([previous, activity]);
      }
    }
  }
  if (Array.isArray(next.machines)) {
    machines = next.machines;
    for (const machine of machines) restoreTaskTerminalResults(machine.id, machine.terminalResults);
  }
  if (next.taskTerminalResults) restoreTaskTerminalResults(next.machineId || state?.machineId, next.taskTerminalResults);
  if (!Array.isArray(next.machines) && Object.hasOwn(next, "connected") && (next.machineId || state?.machineId)) {
    const id = next.machineId || state.machineId;
    machines = machines.map(machine => machine.id === id ? { ...machine, connected: next.connected } : machine);
  }
  state = { ...(state || {}), ...next };
  if (newTaskLeaveWarning?.machineId === state.machineId
    && newTaskLeaveWarning?.threadId === state.thread?.id
    && next.turn?.id && ["inProgress", "completed", "failed", "interrupted"].includes(next.turn.status)) {
    newTaskLeaveWarning = null;
    renderDestinationSwitcher(true);
  }
  if (Array.isArray(next.liveMessages)) {
    for (const message of next.liveMessages) {
      const existing = liveMessages.get(message.id) || historyMessages.get(message.id);
      liveMessages.set(message.id, preserveMessageCreatedAt(existing, message));
    }
  }
  if (Array.isArray(next.activities)) {
    for (const activity of next.activities) liveActivities.set(activity.id, activity);
  }
  renderState();
  if (renderMessages) renderConversation();
  for (const [previous, activity] of terminalTransitions) refreshExpandedDetailOnTerminal(previous, activity);
}

function resetConversationState() {
  unresolvedSubmission = null;
  selectionHold.reset();
  elements.appShell.classList.remove("transcript-selection-held");
  heldTranscriptNodes.clear();
  transcriptNodes.clear();
  deferredTranscript = false;
  // A destination change intentionally replaces the previous transcript.
  elements.conversation.replaceChildren();
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
  transcriptUpwardScroll = 0;
  submittingInputRequestId = null;
  submittingInterrupt = false;
  sendingQueuedMessage = false;
  inputDrafts.clear();
  asyncDrafts.clear();
  queueDeliveryUnknown = false;
  setHistoryStatus();
}

function applySnapshot(next, loadChangedHistory = true) {
  const previousMachineId = state?.machineId;
  const previousThreadId = state?.thread?.id;
  const nextMachineId = next?.machineId;
  const nextThreadId = next?.thread?.id;
  if (next?.threadStatus?.startsWith("active") || next?.turn?.status === "inProgress") taskTerminalResults.delete(draftKey(nextMachineId, nextThreadId));
  const taskChanged = previousMachineId !== nextMachineId || previousThreadId !== nextThreadId;
  if (newTaskLeaveWarning && next?.connected && nextThreadId
    && (newTaskLeaveWarning.machineId !== nextMachineId || newTaskLeaveWarning.threadId !== nextThreadId)) {
    newTaskLeaveWarning = null;
    renderDestinationSwitcher(true);
  }
  if (taskChanged) {
    const oldKey = draftKey(previousMachineId, previousThreadId);
    if (oldKey) rememberComposerDraft(composerDrafts, oldKey, { text: elements.messageText.value, images: [...selectedImages], files: [...selectedFiles] });
    resetConversationState();
    const draft = rememberComposerDraft(composerDrafts, draftKey(nextMachineId, nextThreadId));
    elements.messageText.value = draft?.text || "";
    selectedImages = [...(draft?.images || [])];
    selectedFiles = [...(draft?.files || [])];
    unresolvedSubmission = unresolvedSubmissions.get(draftKey(nextMachineId, nextThreadId)) || null;
    attachmentDeliveryUnknown = Boolean(unresolvedSubmission && (unresolvedSubmission.requested.images?.length || unresolvedSubmission.requested.files?.length));
    queueDeliveryUnknown = Boolean(unresolvedSubmission?.queued && (!unresolvedSubmission.requested.queueId
      || unresolvedSubmission.requested.queueId === (next.queuedMessage?.id ?? String(next.queuedMessage?.createdAt))));
    composerError = unresolvedSubmission?.warning || "";
    resizeComposer();
  }
  mergeState(next, true);
  if (taskChanged && unresolvedSubmission) void recoverUnresolvedSubmission();
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
    const preserveScroll = cursor ? { scrollHeight: transcriptScroller().scrollHeight, scrollTop: transcriptScroller().scrollTop } : null;
    for (const turn of page.turns || []) {
      for (const message of turn.messages || []) {
        const existing = liveMessages.get(message.id) || historyMessages.get(message.id);
        historyMessages.set(message.id, preserveMessageCreatedAt(existing, message));
      }
      for (const activity of turn.activities || []) historyActivities.set(activity.id, activity);
    }
    nextCursor = page.nextCursor;
    setHistoryStatus();
    renderConversation({ preserveScroll, forceBottom });
    void recoverUnresolvedSubmission();
    const transcriptFits = transcriptScroller().scrollHeight <= transcriptScroller().clientHeight + 1;
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

// Runtime-backed terminal results, mirrored for Tasks rendering.
const taskTerminalResults = new Map();
function restoreTaskTerminalResults(machineId, results) {
  if (!results) return;
  for (const key of taskTerminalResults.keys()) if (JSON.parse(key)[0] === machineId) taskTerminalResults.delete(key);
  for (const [threadId, result] of Object.entries(results)) taskTerminalResults.set(draftKey(machineId, threadId), result);
}
const newTaskDialog = document.querySelector("#new-task-dialog");
const newTaskForm = document.querySelector("#new-task-form");
const newTaskName = document.querySelector("#new-task-name");
const newTaskCwd = document.querySelector("#new-task-cwd");
const newTaskError = document.querySelector("#new-task-error");
const newTaskCreate = document.querySelector("#new-task-create");
const newTaskProviderField = document.querySelector("#new-task-provider-field");
const newTaskProviderSlot = document.querySelector("#new-task-provider-slot");
const newTaskModelSlot = document.querySelector("#new-task-model-slot");
const newTaskSettings = document.querySelector(".new-task-settings");
const newTaskEffort = document.querySelector("#new-task-effort");
const newTaskAccess = document.querySelector("#new-task-access");
let newTaskModel = null;
let newTaskModelValue = "";
let newTaskModels = [];
let newTaskOptionsRequest = 0;
let newTaskOptionsReady = false;
let newTaskOptionsLoad = Promise.resolve();
const newTaskPreferenceKey = machineId => `codex-pocket-new-task-settings:${machineId}`;
function newTaskEfforts(preferred) {
  newTaskEffort.replaceChildren();
  const model = newTaskModels.find(model => model.model === newTaskModelValue);
  const efforts = (model?.supportedReasoningEfforts || []).map(effort => effort.reasoningEffort);
  for (const effort of efforts) newTaskEffort.add(new Option(effortLabel(effort), effort));
  const resolved = resolveModelEffort(efforts, preferred, model?.defaultReasoningEffort);
  if (resolved) newTaskEffort.value = resolved;
  newTaskEffort.disabled = !newTaskEffort.options.length;
}
function renderNewTaskAccess(access) {
  newTaskAccess.replaceChildren();
  for (const mode of ACCESS_MODES) if (access?.[mode.value]) newTaskAccess.add(new Option(mode.label, mode.value));
}
async function loadNewTaskOptions() {
  if (!newTaskDialog.open) return;
  const request = ++newTaskOptionsRequest;
  newTaskOptionsReady = false;
  // Keep Create available for the existing choice while a reload is in flight.
  newTaskCreate.disabled = !newTaskModelValue;
  try {
    const query = new URLSearchParams({ machineId: newTaskMachine.id, cwd: newTaskCwd.value.trim() });
    const response = await apiFetch(`/api/tasks/options?${query}`);
    const value = await response.json();
    if (request !== newTaskOptionsRequest || !newTaskDialog.open) return;
    if (!response.ok) throw new Error(value.error || "Starting settings unavailable");
    let remembered;
    try { remembered = JSON.parse(localStorage.getItem(newTaskPreferenceKey(newTaskMachine.id))); } catch {}
    const chosen = newTaskModelValue
      ? { model: newTaskModelValue, effort: newTaskEffort.value, access: newTaskAccess.value }
      : remembered || value.current || {};
    const catalogModels = (value.models || []).filter(model => model.model && model.supportedReasoningEfforts?.length);
    // Resolve the default from the catalog order before sorting so presentation cannot change it.
    const preferredModel = catalogModels.some(model => model.model === chosen.model) ? chosen.model
      : catalogModels.some(model => model.model === value.current?.model) ? value.current.model
        : catalogModels[0]?.model;
    newTaskModels = sortModelsForDisplay(catalogModels);
    newTaskModel = renderChoiceControl(newTaskModelSlot, {
      entries: newTaskModels.map(model => ({ value: model.model, label: model.displayName || model.model })),
      selected: preferredModel,
      ariaLabel: "Model",
      id: "new-task-model",
      emptyLabel: "No model available",
      // A model switch keeps the current effort (and Access) in place; it never reloads the
      // runtime's remembered preset.
      onChange: (value) => { const effort = newTaskEffort.value; newTaskModelValue = value; newTaskEfforts(effort); },
    });
    newTaskModelValue = newTaskModel ? newTaskModel.value : newTaskModels[0]?.model || "";
    renderNewTaskAccess(value.access);
    newTaskEfforts(chosen.effort);
    if ([...newTaskAccess.options].some(option => option.value === chosen.access)) newTaskAccess.value = chosen.access;
    else if ([...newTaskAccess.options].some(option => option.value === value.current?.access)) newTaskAccess.value = value.current.access;
    if (!newTaskModelValue || !newTaskEffort.value || !newTaskAccess.value) throw new Error("No available starting settings");
    newTaskOptionsReady = true;
    newTaskCreate.disabled = false;
    if (newTaskError.textContent.startsWith("Starting settings unavailable.")) newTaskError.textContent = "";
  } catch {
    if (request === newTaskOptionsRequest && newTaskDialog.open) {
      newTaskCreate.disabled = true;
      newTaskError.textContent = "Starting settings unavailable. Check the Project Folder and try again.";
    }
  }
}
newTaskCwd.addEventListener("change", () => { newTaskOptionsLoad = loadNewTaskOptions(); });
let newTaskMachine = null;
let newTaskGroup = null;

// One dialog per physical machine; the Provider field appears only when it has several runtimes.
function renderNewTaskProvider() {
  const providers = newTaskGroup.members.filter(member => providerName(member.provider));
  newTaskProviderSlot.replaceChildren();
  // Keep the field out of the layout entirely for single-provider machines.
  if (providers.length < 2) { newTaskProviderField.remove(); return; }
  newTaskSettings.insertBefore(newTaskProviderField, newTaskSettings.firstElementChild);
  newTaskProviderField.hidden = false;
  const select = document.createElement("select");
  select.id = "new-task-provider";
  select.setAttribute("aria-label", "Provider");
  for (const member of providers) select.add(new Option(providerName(member.provider), member.id));
  select.value = newTaskMachine.id;
  select.addEventListener("change", () => {
    const next = newTaskGroup.members.find(member => member.id === select.value);
    if (!next || next === newTaskMachine) return;
    newTaskMachine = next;
    // Switching providers restores that runtime's own remembered values; never carry the old ones.
    newTaskModelValue = "";
    // Model, Effort and Access come from the chosen runtime's own new-task options.
    newTaskOptionsLoad = loadNewTaskOptions();
  });
  newTaskProviderSlot.append(select);
}

function newTask(visual) {
  if (destinationSelection || taskActionBusy) return;
  newTaskGroup = visual;
  // Prefer the selected task's provider on this machine, otherwise the machine's default one.
  newTaskMachine = visual.members.find(member => member.id === state?.machineId) || visual.members[0];
  document.querySelector("#new-task-title").textContent = `New Task on ${visual.name}`;
  renderNewTaskProvider();
  newTaskName.value = "";
  newTaskCwd.value = (newTaskMachine.id === state?.machineId ? state?.thread?.cwd : "")
    || newTaskMachine.tasks?.find(task => task.selected && task.cwd?.trim())?.cwd
    || "";
  newTaskError.textContent = "";
  newTaskModelSlot.replaceChildren();
  newTaskModel = null;
  newTaskModelValue = "";
  newTaskAccess.replaceChildren();
  newTaskModels = [];
  newTaskEfforts();
  newTaskDialog.showModal();
  newTaskOptionsLoad = loadNewTaskOptions();
  newTaskName.focus();
}
newTaskDialog.addEventListener("keydown", event => { if (event.key === "Escape") event.stopPropagation(); });
newTaskDialog.addEventListener("cancel", event => { if (taskActionBusy) event.preventDefault(); });
document.querySelector("#new-task-cancel").addEventListener("click", () => newTaskDialog.close());
newTaskForm.addEventListener("submit", async event => {
  event.preventDefault();
  const name = newTaskName.value.trim(), cwd = newTaskCwd.value.trim();
  if (!name || name.length > 180) { newTaskError.textContent = "Enter a task name"; newTaskName.focus(); return; }
  if (cwd && (cwd.length > 4096 || /[\r\n\0]/.test(cwd) || !/^(?:\/|[a-z]:[\\/]|\\\\)/i.test(cwd))) {
    newTaskError.textContent = "Enter an absolute project folder on this machine"; newTaskCwd.focus(); return;
  }
  newTaskError.textContent = "";
  const optionsRequest = newTaskOptionsRequest;
  if (!newTaskOptionsReady) await newTaskOptionsLoad;
  if (!newTaskDialog.open || taskActionBusy || optionsRequest !== newTaskOptionsRequest
    || newTaskCwd.value.trim() !== cwd || newTaskName.value.trim() !== name) return;
  if (!newTaskOptionsReady || !newTaskModelValue || !newTaskEffort.value || !newTaskAccess.value) { newTaskError.textContent = "Choose available starting settings before creating the task"; return; }
  const machineId = newTaskMachine.id;
  const startingSettings = { model: newTaskModelValue, effort: newTaskEffort.value, access: newTaskAccess.value };
  ++newTaskOptionsRequest;
  for (const control of newTaskForm.elements) control.disabled = true;
  newTaskCreate.textContent = "Creating…";
  try {
    const result = await performTaskAction({ machineId: newTaskMachine.id, action: "create", name, cwd, ...startingSettings });
    if (result?.succeeded) {
      if (!result.warning) { try { localStorage.setItem(newTaskPreferenceKey(machineId), JSON.stringify(startingSettings)); } catch {} }
      newTaskDialog.close();
      if (matchMedia("(min-width: 1100px)").matches) elements.messageText.focus({ preventScroll: true });
    }
    else newTaskError.textContent = result?.failure || "Task creation is unavailable right now";
  } finally {
    newTaskCreate.textContent = "Create";
    for (const control of newTaskForm.elements) control.disabled = false;
  }
});

const taskDialog = document.querySelector("#task-dialog");
const taskDialogForm = document.querySelector("#task-dialog-form");
const taskDialogName = document.querySelector("#task-dialog-name");
const taskDialogError = document.querySelector("#task-dialog-error");
let taskDialogAction = null;
let taskDialogOriginalName = "";
function openTaskDialog(body, name) {
  taskDialogAction = body;
  taskDialogOriginalName = name;
  const deleting = body.action === "delete";
  document.querySelector("#task-dialog-title").textContent = deleting ? "Delete Task" : "Rename Task";
  document.querySelector("#task-dialog-name-field").hidden = deleting;
  document.querySelector("#task-dialog-delete-copy").hidden = !deleting;
  document.querySelector("#task-dialog-task-name").textContent = name;
  const submit = document.querySelector("#task-dialog-submit");
  submit.textContent = deleting ? "Delete" : "Rename";
  submit.className = deleting ? "danger-button" : "primary-button";
  taskDialogName.value = name;
  taskDialogError.textContent = "";
  taskDialog.showModal();
  if (deleting) document.querySelector("#task-dialog-cancel").focus();
  else { taskDialogName.focus(); taskDialogName.select(); }
}
taskDialog.addEventListener("keydown", event => { if (event.key === "Escape") event.stopPropagation(); });
taskDialog.addEventListener("close", () => { if (!taskDialog.open) taskDialogAction = null; });
document.querySelector("#task-dialog-cancel").addEventListener("click", () => taskDialog.close());
taskDialogForm.addEventListener("submit", event => {
  event.preventDefault();
  if (!taskDialogAction) return;
  const body = { ...taskDialogAction };
  if (body.action === "rename") {
    body.name = taskDialogName.value.trim();
    if (!body.name || body.name.length > 180) { taskDialogError.textContent = "Enter a task name"; taskDialogName.focus(); return; }
    if (body.name === taskDialogOriginalName) { taskDialog.close(); return; }
  } else body.confirmed = true;
  taskDialog.close();
  void performTaskAction(body);
});

async function performTaskAction(body) {
  if (taskActionBusy || destinationSelection || submittingMessage || readingAttachments) return;
  taskActionBusy = true;
  const target = { machineId: body.machineId, threadId: body.threadId, action: body.action, events: [] };
  if (body.action === "delete") {
    target.archived = Boolean(body.archived);
    const tasks = navigationCatalogs[Number(target.archived)]?.machines
      ?.find(machine => machine.id === body.machineId)?.tasks;
    target.task = tasks?.find(task => task.id === body.threadId);
  }
  taskActionTarget = target;
  destinationTaskError = null;
  renderDestinationSwitcher();
  let succeeded = false;
  let snapshot = null;
  let failure = "";
  try {
    const response = await apiFetch("/api/tasks", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, expectedMachineId: state?.machineId || "", expectedThreadId: state?.thread?.id || "" }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Task action failed");
    snapshot = result;
    succeeded = true;
  } catch (error) {
    // Never repeat task creation or deletion after a lost response.
    failure = error instanceof TypeError ? "Could not confirm the task action. Check the refreshed list before trying again." : error.message;
    try { const response = await apiFetch("/api/state"); if (response.ok) snapshot = await response.json(); } catch {}
  }
  if (succeeded) applyTaskMutationToCatalogs(body);
  taskActionBusy = false;
  taskActionTarget = null;
  const changed = snapshot && (snapshot.machineId !== state?.machineId || snapshot.thread?.id !== state?.thread?.id);
  if (snapshot && (succeeded || changed)) {
    applySnapshot(snapshot, false);
    const lastSnapshot = target.events.findLastIndex(entry => entry.snapshot?.machineId === snapshot.machineId && entry.snapshot?.thread?.id === snapshot.thread?.id);
    for (const entry of target.events.slice(lastSnapshot < 0 ? target.events.length : lastSnapshot + 1)) entry.deliver();
  } else for (const entry of target.events) entry.deliver();
  if (succeeded && body.action === "delete") composerDrafts.delete(draftKey(body.machineId, body.threadId));
  if (failure && body.action !== "create") destinationTaskError = { machineId: body.machineId, threadId: body.threadId, message: taskFailureMessage(failure) };
  // Keep the visible lists rendered while both catalogs refresh in the background; the Refresh
  // control's disabled/spinning state is the only loading indicator for a cached list.
  navigationEpoch += 1;
  navigationRequests.fill(null);
  navigationErrors.fill("");
  renderDestinationSwitcher();
  void Promise.allSettled([refreshNavigationCatalog(false, true), refreshNavigationCatalog(true, true)]);
  await Promise.allSettled([refreshMachines(), refreshLoadedThreads()]);
  renderDestinationSwitcher();
  if (succeeded && body.action === "create") {
    if (!matchMedia("(min-width: 1100px)").matches) closeDestinationSwitcher();
  }
  if (succeeded && snapshot?.warning) { composerError = snapshot.warning.replace(/^Task created\. /, ""); renderComposer(); }
  if (changed && state?.thread) await loadHistory(null, historyEpoch, true);
  return { succeeded, failure, warning: snapshot?.warning };
}

function taskFailureMessage(message) {
  return /another Codex runtime|active writer/i.test(message) ? "Open elsewhere. Close it and retry." : message;
}

async function selectDestination(machineId, threadId) {
  if (!machineId || !threadId || destinationSelection || taskActionBusy || submittingMessage || sendingQueuedMessage || submittingInterrupt || updatingModel || updatingAccess || readingAttachments) return;
  destinationTaskError = null;
  if (machineId === state?.machineId && threadId === state?.thread?.id) {
    if (!matchMedia("(min-width: 1100px)").matches) closeDestinationSwitcher();
    return;
  }
  const expectedMachineId = state?.machineId || "";
  const expectedThreadId = state?.thread?.id || "";
  const token = { machineId, threadId, events: [] };
  destinationSelection = token;
  renderDestinationSwitcher();
  let accepted = null;
  let rejected = false;
  let message = "Could not switch tasks";
  try {
    const response = await apiFetch("/api/navigation/select", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ machineId, threadId, expectedMachineId, expectedThreadId }),
    });
    const snapshot = await response.json();
    if (!response.ok) {
      // A structured rejection is definitive unless another client changed selection.
      rejected = response.status === 409 && !/selected task changed/i.test(snapshot.error || "");
      throw new Error(snapshot.error || message);
    }
    if (snapshot.machineId !== machineId || snapshot.thread?.id !== threadId) throw new Error("Task selection response did not match the requested destination");
    accepted = snapshot;
  } catch (error) {
    message = error.message || message;
    if (!rejected) {
      // Recover lost/malformed responses without repeating the selection request.
      try {
        const response = await apiFetch("/api/state");
        if (response.ok) {
          const snapshot = await response.json();
          if (snapshot.machineId !== expectedMachineId || snapshot.thread?.id !== expectedThreadId) accepted = snapshot;
        }
      } catch { /* Keep the current conversation intact if recovery is unavailable. */ }
    }
  }
  destinationSelection = null;
  if (accepted) {
    loadedThreads = [];
    threadsRequest = null;
    applySnapshot(accepted, false);
    // The response covers events through the final selection snapshot. Preserve later deltas.
    const lastSnapshot = token.events.findLastIndex(entry => entry.snapshot?.machineId === accepted.machineId && entry.snapshot?.thread?.id === accepted.thread?.id);
    for (const entry of token.events.slice(lastSnapshot < 0 ? token.events.length : lastSnapshot + 1)) entry.deliver();
    if (!matchMedia("(min-width: 1100px)").matches) closeDestinationSwitcher();
    else elements.messageText.focus({ preventScroll: true });
    await loadHistory(null, historyEpoch, true);
    await Promise.allSettled([refreshMachines(), refreshLoadedThreads()]);
  } else {
    // Retain live updates received for the original task while the request was pending.
    for (const entry of token.events) entry.deliver();
    const sourceError = rejected && message === "Send the first message before leaving this new task.";
    if (sourceError) newTaskLeaveWarning = { machineId: expectedMachineId, threadId: expectedThreadId, message };
    else destinationTaskError = { machineId, threadId, message: taskFailureMessage(message) };
    renderDestinationSwitcher();
  }
}

async function submitMessage(action) {
  if (destinationSelection || taskActionBusy) return;
  const sentDraftKey = draftKey(state?.machineId, state?.thread?.id);
  const requestedEpoch = historyEpoch;
  const previousTurn = state?.turn;
  const current = () => sentDraftKey === draftKey(state?.machineId, state?.thread?.id) && requestedEpoch === historyEpoch;
  const text = elements.messageText.value;
  const images = selectedImages;
  const files = selectedFiles;
  if ((!text.trim() && !images.length && !files.length) || readingAttachments || attachmentDeliveryUnknown || submittingMessage || state?.queuedMessage) return;
  submittingMessage = true;
  composerError = "";
  const optimisticQueue = action === "queue" ? { threadId: state?.thread?.id, text, images, files: files.map(({name,size}) => ({name,size})), createdAt: Date.now() } : null;
  if (optimisticQueue) {
    elements.messageText.value = "";
    resizeComposer();
    mergeState({ queuedMessage: optimisticQueue });
  }
  renderState();
  try {
    const result = await postMessageAction("/api/message", { machineId: state?.machineId, threadId: state?.thread?.id, text, action, images, files });
    const savedDraft = composerDrafts.get(sentDraftKey);
    if (savedDraft?.text === text && JSON.stringify(savedDraft.images || []) === JSON.stringify(images)
      && JSON.stringify(savedDraft.files || []) === JSON.stringify(files)) composerDrafts.delete(sentDraftKey);
    if (!current()) return;
    selectedImages = [];
    selectedFiles = [];
    attachmentDeliveryUnknown = false;
    elements.messageText.value = "";
    resizeComposer();
    mergeState({
      ...(state?.turn === previousTurn && result.turn ? { turn: result.turn } : {}),
      ...(state?.turn === previousTurn && result.phase ? { phase: result.phase } : {}),
      ...(state?.turn === previousTurn && result.message ? { message: result.message } : {}),
      // A queue SSE update can arrive before this response, including an automatic send.
      ...(Object.hasOwn(result, "queuedMessage") && (!optimisticQueue || state?.queuedMessage === optimisticQueue)
        ? { queuedMessage: result.queuedMessage } : {}),
    });
  } catch (error) {
    if (!current()) return;
    if (error.deliveryUnknown) {
      attachmentDeliveryUnknown = images.length > 0 || files.length > 0;
      elements.messageText.value = images.length || files.length ? text : "";
      if (!images.length && !files.length && unresolvedSubmission) unresolvedSubmission.restoreDraft = true;
      queueDeliveryUnknown = action === "queue";
      resizeComposer();
    } else if (optimisticQueue) {
      if (state?.queuedMessage === optimisticQueue) mergeState({ queuedMessage: null });
      elements.messageText.value = text;
      resizeComposer();
    }
    composerError = error.message;
  } finally {
    submittingMessage = false;
    renderState();
  }
}

const cwdDialog = document.querySelector("#cwd-dialog");
const cwdInput = document.querySelector("#cwd-input");
const cwdError = document.querySelector("#cwd-error");
let cwdTarget = null;
let cwdBusy = false;
function cwdDialogMatches() {
  return cwdTarget && state?.machineId === cwdTarget.machineId && state.thread?.id === cwdTarget.threadId;
}
document.querySelector("#edit-cwd").addEventListener("click", () => {
  if (!state?.thread || cwdBusy || destinationSelection || taskActionBusy) return;
  cwdTarget = { machineId: state.machineId, threadId: state.thread.id };
  cwdInput.value = state.thread.cwd || "";
  cwdError.textContent = "";
  cwdDialog.showModal();
  cwdInput.focus();
  cwdInput.select();
});
cwdDialog.addEventListener("keydown", event => { if (event.key === "Escape") event.stopPropagation(); });
cwdDialog.addEventListener("close", () => { if (!cwdDialog.open) cwdTarget = null; });
document.querySelector("#cwd-cancel").addEventListener("click", () => cwdDialog.close());
document.querySelector("#cwd-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (cwdBusy || !cwdDialogMatches()) return;
  const cwd = cwdInput.value.trim();
  if (!cwd || cwd.length > 4096 || /[\r\n\0]/.test(cwd) || !/^(?:\/|[a-z]:[\\/]|\\\\)/i.test(cwd)) {
    cwdError.textContent = "Enter an absolute project folder on this machine";
    return;
  }
  if (cwd === state.thread.cwd) { cwdDialog.close(); return; }
  const target = cwdTarget;
  cwdBusy = true;
  cwdError.textContent = "";
  document.querySelector("#cwd-save").disabled = cwdInput.disabled = true;
  try {
    const response = await apiFetch("/api/thread/cwd", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...target, cwd }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not update project folder");
    if (cwdTarget === target && cwdDialogMatches()) {
      mergeState({ thread: result.thread });
      cwdDialog.close();
    }
  } catch (error) {
    if (cwdTarget === target && cwdDialogMatches()) cwdError.textContent = error.message;
  } finally {
    cwdBusy = false;
    document.querySelector("#cwd-save").disabled = cwdInput.disabled = false;
    renderState();
  }
});

const queueDialog = document.querySelector("#queue-dialog");
const queueDialogText = document.querySelector("#queue-dialog-text");
const queueDialogError = document.querySelector("#queue-dialog-error");
const queueDialogSubmit = document.querySelector("#queue-dialog-submit");
const queueDialogCancel = document.querySelector("#queue-dialog-cancel");
let queueDialogTarget = null;
let queueDialogBusy = false;
function queueDialogMatches() {
  return queueDialogTarget && state?.queuedMessage
    && state.machineId === queueDialogTarget.machineId && state.thread?.id === queueDialogTarget.threadId
    && state.queuedMessage.threadId === queueDialogTarget.threadId && (state.queuedMessage.id ?? String(state.queuedMessage.createdAt)) === queueDialogTarget.queueId;
}
function openQueueDialog(mode) {
  if (!state?.queuedMessage || queueDialogBusy || submittingMessage || sendingQueuedMessage || cancellingQueue || destinationSelection || taskActionBusy) return;
  queueDialogTarget = { machineId: state.machineId, threadId: state.thread.id, createdAt: state.queuedMessage.createdAt, queueId: state.queuedMessage.id ?? String(state.queuedMessage.createdAt), mode };
  const editing = mode === "edit";
  document.querySelector("#queue-dialog-title").textContent = editing ? "Edit queued message" : "Cancel queued message?";
  document.querySelector("#queue-dialog-copy").hidden = editing;
  queueDialogText.hidden = !editing;
  queueDialogText.value = editing ? state.queuedMessage.text : "";
  queueDialogError.textContent = "";
  queueDialogCancel.textContent = editing ? "Cancel" : "Keep";
  queueDialogSubmit.textContent = editing ? "Save" : "Discard";
  queueDialogSubmit.className = editing ? "primary-button" : "danger-button";
  queueDialog.showModal();
  (editing ? queueDialogText : queueDialogCancel).focus();
}
queueDialog.addEventListener("keydown", event => { if (event.key === "Escape") event.stopPropagation(); });
queueDialog.addEventListener("cancel", event => { if (queueDialogBusy) event.preventDefault(); });
queueDialog.addEventListener("close", () => { if (!queueDialog.open) queueDialogTarget = null; });
queueDialogCancel.addEventListener("click", () => queueDialog.close());
document.querySelector("#queue-dialog-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (queueDialogBusy || !queueDialogMatches()) return;
  if (queueDialogTarget.mode === "cancel") {
    queueDialog.close();
    void cancelQueuedMessage();
    return;
  }
  const target = queueDialogTarget;
  const text = queueDialogText.value;
  if (!text.trim() && !state.queuedMessage.images?.length && !state.queuedMessage.files?.length) {
    queueDialogError.textContent = "Enter a message or attach files";
    return;
  }
  queueDialogBusy = true;
  queueDialogError.textContent = "";
  queueDialogSubmit.disabled = queueDialogCancel.disabled = queueDialogText.disabled = true;
  renderQueue();
  try {
    const response = await apiFetch("/api/message/queue", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ machineId: target.machineId, threadId: target.threadId, queueId: target.queueId, text }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not edit queued message");
    if (queueDialogTarget === target && queueDialogMatches()) {
      mergeState({ queuedMessage: result.queuedMessage });
      queueDialog.close();
    }
  } catch (error) {
    if (queueDialogTarget === target && queueDialogMatches()) queueDialogError.textContent = error.message;
  } finally {
    queueDialogBusy = false;
    queueDialogSubmit.disabled = queueDialogCancel.disabled = queueDialogText.disabled = false;
    renderQueue();
  }
});

async function cancelQueuedMessage() {
  if (destinationSelection || taskActionBusy) return;
  if (submittingMessage || sendingQueuedMessage || cancellingQueue) return;
  const machineId = state?.machineId, threadId = state?.thread?.id;
  const queueId = state?.queuedMessage?.id ?? String(state?.queuedMessage?.createdAt);
  const current = () => machineId === state?.machineId && threadId === state?.thread?.id
    && queueId === (state?.queuedMessage?.id ?? String(state?.queuedMessage?.createdAt));
  cancellingQueue = true;
  renderQueue();
  try {
    const url = new URL("/api/message/queue", location.origin);
    url.searchParams.set("machineId", machineId || "");
    url.searchParams.set("threadId", threadId || "");
    url.searchParams.set("queueId", queueId);
    const response = await apiFetch(url, { method: "DELETE" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not cancel queued message");
    if (current() && result.cancelled === true) {
      mergeState({ queuedMessage: null });
    }
  } catch (error) {
    if (current()) composerError = error.message;
  } finally {
    cancellingQueue = false;
    renderComposer();
  }
}

async function sendQueuedMessage() {
  if (destinationSelection || taskActionBusy) return;
  if (submittingMessage || cancellingQueue || sendingQueuedMessage || !state?.queuedMessage) return;
  const machineId = state.machineId, threadId = state.thread.id, requestedEpoch = historyEpoch;
  const queueId = state.queuedMessage.id ?? String(state.queuedMessage.createdAt);
  const current = () => machineId === state?.machineId && threadId === state?.thread?.id
    && queueId === (state?.queuedMessage?.id ?? String(state?.queuedMessage?.createdAt));
  const action = state?.turn?.status === "inProgress" ? "steer" : "start";
  sendingQueuedMessage = true;
  composerError = "";
  renderState();
  try {
    const result = await postMessageAction("/api/message/queue", { machineId, threadId, queueId, action });
    if (current() && !result.recovered) mergeState({ queuedMessage: null });
  } catch (error) {
    if (!current()) return;
    queueDeliveryUnknown = Boolean(error.deliveryUnknown);
    if (current()) composerError = error.message;
  } finally {
    if (requestedEpoch === historyEpoch) sendingQueuedMessage = false;
    renderState();
  }
}

async function interruptTurn() {
  if (destinationSelection || taskActionBusy) return;
  if (submittingInterrupt || state?.turn?.status !== "inProgress") return;
  const machineId = state?.machineId;
  const expectedThreadId = state?.thread?.id;
  const expectedTurnId = state?.turn?.id;
  if (!machineId || !expectedThreadId || !expectedTurnId) return;
  submittingInterrupt = true;
  composerError = "";
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
    if (machineId === state?.machineId && expectedThreadId === state?.thread?.id) composerError = error.message;
  } finally {
    submittingInterrupt = false;
    renderState();
  }
}

async function updateThreadSettings(model, effort) {
  if (destinationSelection || taskActionBusy) return;
  if (updatingModel || !state?.thread) return;
  updatingModel = true;
  const machineId = state.machineId, threadId = state.thread.id, requestedEpoch = historyEpoch;
  const current = () => machineId === state?.machineId && threadId === state?.thread?.id && requestedEpoch === historyEpoch;
  composerError = "";
  renderState();
  try {
    const response = await apiFetch("/api/thread/settings", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ machineId, threadId, model, effort }),
    });
    const result = await response.json();
    if (!response.ok || !result.updated) throw new Error(result.error || "Could not update model settings");
    if (!current()) return;
    mergeState({ model: result.model, reasoningEffort: result.reasoningEffort });
  } catch (error) {
    if (current()) composerError = error.message;
  } finally {
    updatingModel = false;
    renderState();
  }
}

async function updateAccess(mode) {
  if (destinationSelection || taskActionBusy) return;
  if (updatingAccess || !state?.thread) return;
  updatingAccess = true;
  const machineId = state.machineId, threadId = state.thread.id, requestedEpoch = historyEpoch;
  const current = () => machineId === state?.machineId && threadId === state?.thread?.id && requestedEpoch === historyEpoch;
  composerError = "";
  renderState();
  try {
    const response = await apiFetch("/api/thread/access", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ machineId, threadId, mode }),
    });
    const result = await response.json();
    if (!response.ok || !result.updated) throw new Error(result.error || "Could not update access");
    if (!current()) return;
    mergeState({ access: result.access });
  } catch (error) {
    if (current()) composerError = error.message;
  } finally {
    updatingAccess = false;
    renderState();
  }
}

async function resolveApproval(requestId, decision) {
  if (destinationSelection || taskActionBusy) return;
  if (resolvingApproval || !requestId) return;
  resolvingApproval = true;
  const machineId = state?.machineId, threadId = state?.thread?.id, requestedEpoch = historyEpoch;
  const current = () => machineId === state?.machineId && threadId === state?.thread?.id && requestedEpoch === historyEpoch;
  composerError = "";
  const pending = (state?.pending || []).map((request) => request.id === requestId ? { ...request, resolving: true } : request);
  mergeState({ pending });
  try {
    const response = await apiFetch("/api/approval", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ machineId: state?.machineId, requestId, decision }),
    });
    const result = await response.json();
    if (!response.ok || !result.accepted) throw new Error(result.error || "Codex did not accept the approval response");
  } catch (error) {
    if (!current()) return;
    composerError = error.message;
    try {
      const response = await apiFetch("/api/state");
      if (response.ok) {
        const snapshot = await response.json();
        if (current() && snapshot.machineId === machineId && snapshot.thread?.id === threadId) applySnapshot(snapshot, false);
      }
    } catch {
      // SSE/reconnect will restore the authoritative pending state.
    }
  } finally {
    resolvingApproval = false;
    renderState();
  }
}

async function submitStructuredInput(pending) {
  if (destinationSelection || taskActionBusy) return;
  if (!pending?.id || submittingInputRequestId) return;
  const requestDraft = inputDrafts.get(pending.id) || new Map();
  const answers = [];
  for (const question of pending.questions || []) {
    const value = requestDraft.get(question.id);
    if (!value) {
      composerError = `Answer ${question.header || "every question"} before sending`;
      renderComposer();
      return;
    }
    if (Array.isArray(question.options)) {
      if (value.type === "option" && Number.isInteger(value.optionIndex)) {
        answers.push({ questionId: question.id, type: "option", optionIndex: value.optionIndex });
      } else if (value.type === "other" && question.isOther && String(value.value || "").trim()) {
        answers.push({ questionId: question.id, type: "other", value: value.value });
      } else {
        composerError = `Choose an answer for ${question.header || "every question"}`;
        renderComposer();
        return;
      }
    } else if (value.type === "text" && String(value.value || "").trim()) {
      answers.push({ questionId: question.id, type: "text", value: value.value });
    } else {
      composerError = `Answer ${question.header || "every question"} before sending`;
      renderComposer();
      return;
    }
  }

  submittingInputRequestId = pending.id;
  const machineId = state?.machineId, threadId = state?.thread?.id, requestedEpoch = historyEpoch;
  const current = () => machineId === state?.machineId && threadId === state?.thread?.id && requestedEpoch === historyEpoch;
  composerError = "";
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
  } catch (error) {
    if (!current()) return;
    composerError = error.message;
    try {
      const response = await apiFetch("/api/state");
      if (response.ok) {
        const snapshot = await response.json();
        if (current() && snapshot.machineId === machineId && snapshot.thread?.id === threadId) applySnapshot(snapshot, false);
      }
    } catch {
      // SSE/reconnect restores the authoritative pending request.
    }
  } finally {
    if (current() && submittingInputRequestId === pending.id) submittingInputRequestId = null;
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
  const on = (type, handler) => source.addEventListener(type, event => {
    const pending = destinationSelection || taskActionTarget;
    if (pending && type !== "open" && type !== "error" && type !== "task-status") {
      pending.events.push({ snapshot: type === "snapshot" ? parseEvent(event) : null, deliver: () => handler(event) });
    } else handler(event);
  });
  on("open", () => { setConnection(true); void recoverUnresolvedSubmission(); });
  on("error", handleEventError);
  on("snapshot", (event) => { applySnapshot(parseEvent(event)); });
  on("task-status", event => {
    const value = parseEvent(event);
    const key = draftKey(value.machineId, value.threadId);
    if (Object.hasOwn(value, "terminalResult")) {
      if (value.terminalResult) taskTerminalResults.set(key, value.terminalResult);
      else taskTerminalResults.delete(key);
    }
    if (value.status?.startsWith("active")) taskTerminalResults.delete(key);
    updateLiveTaskCatalog(value);
  });
  on("status", (event) => { mergeState(parseEvent(event)); });
  on("thread", (event) => {
    const thread = parseEvent(event);
    const previousId = state?.thread?.id;
    mergeState({ thread });
    // A DSH Project Folder change swaps the internal runtime id for the same
    // visible task; refresh the task catalog so no stale id stays clickable.
    if (thread?.id && previousId && thread.id !== previousId) void refreshNavigationCatalog(archivedTasks, true);
  });
  on("task-name", event => {
    const value = parseEvent(event);
    if (value.threadId === state?.thread?.id) mergeState({ taskNameWarning: value.taskNameWarning });
  });
  on("settings", (event) => { mergeState(parseEvent(event)); });
  on("queue", (event) => {
    mergeState(parseEvent(event));
    if (!state?.queuedMessage && unresolvedSubmission?.requested.queueId) void recoverUnresolvedSubmission();
  });
  on("control", (event) => { mergeState(parseEvent(event)); });
  on("goal", event => {
    const value = parseEvent(event);
    if (value.machineId === state?.machineId && value.threadId === state?.thread?.id) mergeState({ goal: value.goal });
  });
  on("context", (event) => { mergeState(parseEvent(event)); });
  on("answers", (event) => { mergeState(parseEvent(event), true); });
  on("machines", (event) => { mergeState(parseEvent(event), false); });
  on("quota", (event) => mergeState({ quota: parseEvent(event) }, false));
  on("turn", (event) => {
    const value = parseEvent(event);
    const key = draftKey(state?.machineId, state?.thread?.id);
    const status = value.turn?.status;
    if (["inProgress", "completed", "failed", "interrupted"].includes(status)) taskTerminalResults.delete(key);
    updateLiveTaskCatalog({
      machineId: state?.machineId, threadId: state?.thread?.id, status: status === "inProgress" ? "active" : "idle",
    });
    mergeState(value);
  });
  on("plan", (event) => { mergeState({ plan: parseEvent(event) }); });
  on("request", (event) => { mergeState(parseEvent(event)); });
  on("activity", (event) => {
    const activity = parseEvent(event);
    const activities = [...(state.activities || [])];
    const index = activities.findIndex((candidate) => candidate.id === activity.id);
    if (index >= 0) activities[index] = activity;
    else activities.push(activity);
    mergeState({ activities: activities.slice(-50) });
  });
  on("message", (event) => {
    const message = parseEvent(event);
    const existing = liveMessages.get(message.id) || historyMessages.get(message.id);
    liveMessages.set(message.id, preserveMessageCreatedAt(existing, message));
    renderConversation();
  });
  on("assistant_delta", (event) => {
    const value = parseEvent(event);
    const known = liveMessages.get(value.id) || historyMessages.get(value.id);
    const message = known
      ? { ...known }
      : { id: value.id, role: "assistant", text: "", createdAt: Date.now(), complete: false };
    message.text += value.delta;
    message.complete = false;
    liveMessages.set(value.id, message);
    renderConversation();
  });
}

function isMobileInspector() { return !isWideLayout(); }
function updateInspectorButtonState() {
  const open = inspectorOpen();
  elements.inspectorButton.setAttribute("aria-expanded", String(open));
  elements.inspectorButton.classList.toggle("active", open);
  const label = open ? "Hide task details" : "Show task details";
  elements.inspectorButton.setAttribute("aria-label", label);
  elements.inspectorButton.title = label;
}
function openInspector({ save = true } = {}) {
  // Only one narrow drawer: opening Details closes Tasks.
  if (isMobileInspector() && tasksSwitcherOpen()) closeDestinationSwitcher();
  if (save) saveSidebarPreference("details", true);
  elements.appShell.classList.remove("inspector-closed");
  elements.appShell.classList.add("inspector-open");
  if (isMobileInspector()) {
    elements.inspectorBackdrop.hidden = false;
  } else {
    elements.inspectorBackdrop.hidden = true;
  }
  elements.inspector.inert = false;
  updateInspectorButtonState();
}
function closeInspector({ save = true } = {}) {
  if (save) saveSidebarPreference("details", false);
  elements.appShell.classList.remove("inspector-open");
  elements.appShell.classList.add("inspector-closed");
  elements.inspectorBackdrop.hidden = true;
  elements.inspector.inert = true;
  updateInspectorButtonState();
}
function toggleInspector() {
  const open = inspectorOpen();
  if (open) closeInspector(); else openInspector();
}

// Crossing the sidebar breakpoint closes both drawers (narrow) or restores saved desktop
// preferences (wide) without changing the selected task, drafts, or reading position.
function applySidebarLayout({ instant = false } = {}) {
  if (isWideLayout()) {
    if (sidebarPreference("details", true)) openInspector({ save: false }); else closeInspector({ save: false });
    // A narrow -> wide crossing restores both drawers with the same visible slide-in.
    if (sidebarPreference("tasks", true)) openDestinationSwitcher(!instant); else concealDestinationSwitcher();
    return;
  }
  // Narrow always starts with both drawers closed; this also makes the hidden inspector inert.
  closeInspector({ save: false });
  concealDestinationSwitcher();
}
WIDE_LAYOUT_QUERY.addEventListener("change", () => applySidebarLayout());

// Settings owns network/security plus browser-local appearance. Machine management lives in the
// Tasks sidebar (see the machine dialog below), so these payloads never carry machines or localName.
function serverSettingsValue() {
  return {
    lanEnabled: elements.settingsLanEnabled.checked,
    host: elements.settingsHost.value.trim(),
    port: Number(elements.settingsPort.value),
    pin: elements.settingsPin.value,
  };
}

function localSettingsValue() {
  return {
    theme: elements.settingsTheme.value,
    translucent: translucentUI.checked,
    enterSends: elements.enterSends.checked,
    context: elements.showContext.checked,
    quota: elements.showQuota.checked,
    projects: showProjects.checked,
    machineControls: showMachineControls.checked,
    display: { ...(settingsDisplayDraft || displayPreferences) },
  };
}

function restoreLocalSettingsControls() {
  elements.settingsTheme.value = selectedTheme;
  translucentUI.checked = document.documentElement.dataset.translucent !== "false";
  elements.enterSends.checked = enterSends;
  elements.showContext.checked = !elements.context.hidden;
  elements.showQuota.checked = !elements.quota.hidden;
  showProjects.checked = projectsVisible;
  showMachineControls.checked = machineControlsVisible;
  renderDisplayControls();
}

function commitLocalSettings(value) {
  selectedTheme = value.theme;
  enterSends = value.enterSends;
  projectsVisible = value.projects;
  machineControlsVisible = value.machineControls;
  document.documentElement.dataset.translucent = String(value.translucent);
  elements.context.hidden = !value.context;
  elements.quota.hidden = !value.quota;
  Object.assign(displayPreferences, value.display);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, selectedTheme);
    for (const [key, setting] of [["translucent-ui", value.translucent], ["enter-sends", enterSends],
      ["show-context", value.context], ["show-quota", value.quota], ["show-projects", projectsVisible],
      ["show-machine-controls", machineControlsVisible]]) {
      localStorage.setItem("codex-pocket-" + key, String(setting));
    }
  } catch {}
  saveDisplayPreferences();
  applyTheme();
  renderDestinationSwitcher();
  renderConversation();
}

function updateSettingsSave() {
  elements.settingsSave.disabled = savingSettings || settingsBaseline === null
    || (JSON.stringify(serverSettingsValue()) === settingsBaseline.server
      && JSON.stringify(localSettingsValue()) === settingsBaseline.local);
}

function closeSettings() {
  elements.settingsScreen.hidden = true;
  document.body.classList.remove("settings-open");
  settingsDisplayDraft = null;
  // Any previewed theme is discarded; the saved theme applies again.
  applyTheme(selectedTheme);
  restoreLocalSettingsControls();
  if (settingsValue) renderSettings(settingsValue);
  settingsBaseline = null;
  updateSettingsSave();
}

// ---- Machine configuration (owned by the Tasks sidebar) ----
// The saved machine configuration plus whether it differs from the running connections; the sidebar
// merges this with the live runtime summaries so newly saved machines stay visible before they start.
let machineConfig = { saved: [], restartRequired: false, headless: false, hostName: "", localName: "" };
let machineDialogTarget = null;
let machineDialogBusy = false;
let machineReorderMode = false;
let machineReorderBusy = false;
let machineReorderDraft = null;

const WAKE_MAC_PATTERN = /^(?:[\da-f]{12}|[\da-f]{2}([:-])(?:[\da-f]{2}\1){4}[\da-f]{2})$/i;
// Mirrors the gateway's machine rules so the dialog can reveal the first failure before submitting.
function machineFieldError(machine, index = 0, machines = []) {
  if (!machine.name.trim()) return { field: "name", message: "Enter a display name for this machine" };
  const ssh = machine.ssh.trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(ssh) || ssh.length > 128) return { field: "ssh", message: "Enter a simple SSH alias (letters, digits, dot, dash or underscore)" };
  // Duplicates are detected against every other entry, whether it sits before or after this one.
  if (machines.some((other, otherIndex) => otherIndex !== index && other.ssh.trim().toLowerCase() === ssh.toLowerCase())) {
    return { field: "ssh", message: `Duplicate SSH alias: ${ssh}` };
  }
  const wakeMac = (machine.wakeMac || "").trim();
  if (wakeMac && !WAKE_MAC_PATTERN.test(wakeMac)) return { field: "wakeMac", message: "Enter a valid Wake-on-LAN MAC address" };
  return null;
}

function savedMachines() {
  return Array.isArray(machineConfig.saved) ? machineConfig.saved : [];
}

// Navigation entries identify SSH runtimes by their `ssh:<alias>` id (the catalog omits the raw
// alias), so the grouping helper derives it from the id/group when the field is absent.
function sidebarMachineCatalog(catalogMachines) {
  return sidebarMachineCatalogFor(catalogMachines, savedMachines(), machineConfig.localName || machineConfig.hostName || "");
}

function applyMachineSettings(settings, restartRequired) {
  const value = settings || {};
  machineConfig = {
    saved: (Array.isArray(value.machines) ? value.machines : []).map((machine) => ({ name: machine.name || "", ssh: machine.ssh || "", wakeMac: machine.wakeMac || "", ...(machine.dshPath ? { dshPath: machine.dshPath } : {}) })),
    restartRequired: Boolean(restartRequired),
    headless: Boolean(value.headless),
    hostName: value.hostName || "",
    localName: value.localName || "",
  };
  renderDestinationSwitcher();
}

async function refreshMachineConfig() {
  try {
    const response = await apiFetch("/api/settings");
    const value = await response.json();
    if (!response.ok) return;
    applyMachineSettings(value.settings, value.restartRequired);
  } catch { /* keep the last known configuration */ }
}

// Focused machine/name saves; the server keeps every unrelated settings field from its latest config.
async function saveMachineConfig(payload) {
  const response = await apiFetch("/api/settings", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok || !result.saved) throw new Error(result.error || "Could not save machine settings");
  // Apply the authoritative save response so newly saved machines appear even if a refresh fails.
  if (result.settings) applyMachineSettings(result.settings, result.restartRequired);
  else await refreshMachineConfig();
  await Promise.allSettled([refreshMachines(), refreshNavigationCatalog(archivedTasks, true)]);
  return result;
}

function machineDialogDraft() {
  const name = elements.machineDialogName.value.trim();
  const ssh = elements.machineDialogSsh.value.trim();
  const wakeMac = elements.machineDialogMac.value.trim();
  return { name, ssh, ...(wakeMac ? { wakeMac } : {}) };
}

function machineDialogValidation() {
  // An empty host name is valid: it falls back to the real hostname ("Use hostname").
  if (machineDialogTarget?.mode === "host") return null;
  const index = machineDialogTarget?.mode === "edit" && machineDialogTarget.index >= 0 ? machineDialogTarget.index : savedMachines().length;
  return machineFieldError(machineDialogDraft(), index, savedMachines());
}

// Remove Machine is the only footer action, and only while editing a saved SSH machine.
function updateMachineDialogActions() {
  const target = machineDialogTarget;
  const editing = target?.mode === "edit" && target.index >= 0;
  elements.machineDialogRemove.hidden = !editing;
  elements.machineDialogRemove.disabled = !editing || machineDialogBusy;
}

function openMachineDialog(target) {
  machineDialogTarget = target;
  const host = target.mode === "host";
  const draft = host
    ? { name: machineConfig.localName, ssh: "", wakeMac: "" }
    : target.mode === "edit" && target.index >= 0 ? savedMachines()[target.index]
      : target.draft || { name: "", ssh: "", wakeMac: "" };
  elements.machineDialogTitle.textContent = target.mode === "add" ? "Add Machine" : "Machine Details";
  elements.machineDialogHost.hidden = !host;
  elements.machineDialogName.value = draft.name || "";
  elements.machineDialogName.placeholder = host ? "Use hostname" : "Name";
  elements.machineDialogSsh.value = host ? "" : draft.ssh || "";
  elements.machineDialogMac.value = host ? "" : draft.wakeMac || "";
  elements.machineDialogSshField.hidden = host;
  elements.machineDialogSshHelp.hidden = host;
  elements.machineDialogMacField.hidden = host;
  elements.machineDialogMacHelp.hidden = host;
  elements.machineDialogSubmit.textContent = target.mode === "add" ? "Add" : "Save";
  elements.machineDialogError.textContent = "";
  for (const field of [elements.machineDialogName, elements.machineDialogSsh, elements.machineDialogMac]) field.setCustomValidity("");
  updateMachineDialogActions();
  // Only Add Machine declares a text-input autofocus target; existing details focus the dialog so
  // the modal can open without touching a text field (and without summoning the mobile keyboard).
  elements.machineDialogName.toggleAttribute("autofocus", target.mode === "add");
  elements.machineDialog.toggleAttribute("autofocus", target.mode !== "add");
  elements.machineDialog.showModal();
  if (target.mode === "add") elements.machineDialogName.focus();
  else elements.machineDialog.focus({ preventScroll: true });
}

function openMachineDetails(machine, opener) {
  if (machine.local) return openMachineDialog({ mode: "host", opener });
  const alias = machineCatalogAlias(machine);
  const index = alias ? savedMachines().findIndex((saved) => saved.ssh.trim().toLowerCase() === alias.toLowerCase()) : -1;
  if (index >= 0) return openMachineDialog({ mode: "edit", index, opener });
  return openMachineDialog({ mode: "add", draft: { name: machine.name || "", ssh: alias, wakeMac: machine.wakeMac || "" }, opener });
}

async function runMachineDialogAction(action) {
  if (machineDialogBusy) return;
  machineDialogBusy = true;
  elements.machineDialogSubmit.disabled = true;
  elements.machineDialogError.classList.remove("error-text");
  elements.machineDialogError.textContent = "Saving…";
  updateMachineDialogActions();
  try {
    await action();
    elements.machineDialog.close();
  } catch (error) {
    // Keep the draft so the user can correct it and retry.
    elements.machineDialogError.textContent = error instanceof Error ? error.message : String(error);
    elements.machineDialogError.classList.add("error-text");
  } finally {
    machineDialogBusy = false;
    elements.machineDialogSubmit.disabled = false;
    updateMachineDialogActions();
  }
}

elements.machineDialogForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (machineDialogBusy || !machineDialogTarget) return;
  const error = machineDialogValidation();
  if (error) {
    const field = error.field === "name" ? elements.machineDialogName : error.field === "ssh" ? elements.machineDialogSsh : elements.machineDialogMac;
    field.setCustomValidity(error.message);
    field.focus();
    field.reportValidity();
    elements.machineDialogError.textContent = error.message;
    elements.machineDialogError.classList.add("error-text");
    return;
  }
  for (const field of [elements.machineDialogName, elements.machineDialogSsh, elements.machineDialogMac]) field.setCustomValidity("");
  const target = machineDialogTarget;
  void runMachineDialogAction(() => {
    if (target.mode === "host") return saveMachineConfig({ localName: elements.machineDialogName.value.trim() });
    if (target.mode === "add") return saveMachineConfig({ machines: [...savedMachines(), machineDialogDraft()] });
    return saveMachineConfig({ machines: savedMachines().map((machine, index) => index === target.index ? { ...machine, ...machineDialogDraft(), wakeMac: machineDialogDraft().wakeMac || "" } : machine) });
  });
});
elements.machineDialogRemove.addEventListener("click", async () => {
  const target = machineDialogTarget;
  if (machineDialogBusy || !target || target.mode !== "edit") return;
  const machine = savedMachines()[target.index];
  const label = machine?.name || machine?.ssh || "this machine";
  const confirmed = await pocketConfirm({
    title: `Remove ${label} from Pocket?`,
    message: "This removes its Pocket connection configuration. Conversations and project files are not deleted.",
    confirmLabel: "Remove", danger: true,
  });
  if (!confirmed) return;
  void runMachineDialogAction(() => saveMachineConfig({ machines: savedMachines().filter((_, index) => index !== target.index) }));
});
elements.machineDialogCancel.addEventListener("click", () => elements.machineDialog.close());
for (const field of [elements.machineDialogName, elements.machineDialogSsh, elements.machineDialogMac]) {
  field.addEventListener("input", () => {
    field.setCustomValidity("");
    elements.machineDialogError.textContent = "";
    elements.machineDialogError.classList.remove("error-text");
  });
}
elements.machineDialog.addEventListener("close", () => {
  const opener = machineDialogTarget?.opener;
  machineDialogTarget = null;
  machineDialogBusy = false;
  elements.machineDialogSubmit.disabled = false;
  if (opener?.isConnected) opener.focus({ preventScroll: true });
});
elements.machineDialog.addEventListener("keydown", (event) => { if (event.key === "Escape") event.stopPropagation(); });
elements.machineAdd.addEventListener("click", (event) => openMachineDialog({ mode: "add", opener: event.currentTarget }));

// Reorder mode replaces dragging: Up/Down move one saved machine one saved slot at a time. The
// host and running-but-unsaved entries are shown but never move, and each move saves immediately.
function reorderVisualGroups(catalogMachines) {
  const groups = [];
  const byKey = new Map();
  for (const entry of sidebarMachineCatalog(catalogMachines)) {
    const key = entry.group || entry.id;
    let visual = byKey.get(key);
    if (!visual) {
      visual = { key, name: entry.name || "Machine", local: entry.local === true, members: [] };
      byKey.set(key, visual);
      groups.push(visual);
    }
    visual.members.push(entry);
    if (entry.local === true) visual.local = true;
  }
  return groups;
}

function focusReorderMachine(key, direction) {
  const row = elements.destinationList.querySelector(`.reorder-row[data-machine-key="${CSS.escape(key)}"]`);
  if (!row) return;
  const preferred = row.querySelector(`.icon-button[data-direction="${direction < 0 ? "up" : "down"}"]`);
  const target = preferred && !preferred.disabled ? preferred : row.querySelector(".icon-button");
  target?.focus();
}

// The draft differs from the saved order only when the sequence (or its contents) differs.
function reorderDraftChanged() {
  if (!machineReorderMode || !machineReorderDraft) return false;
  return JSON.stringify(machineReorderDraft) !== JSON.stringify(savedMachines());
}

function syncMachineReorderUi() {
  elements.destinationSwitcher.classList.toggle("reordering", machineReorderMode);
  elements.machinesFooter.classList.toggle("reordering", machineReorderMode);
  syncMachineFooterVisibility();
  elements.machineReorderSave.disabled = machineReorderBusy || !reorderDraftChanged();
  elements.machineReorderCancel.disabled = machineReorderBusy;
  elements.machineReorder.disabled = machineReorderBusy;
}

// Hide the whole footer only when it has nothing left: no controls, no restart hint, no error.
function syncMachineFooterVisibility() {
  const setupHidden = !machineControlsVisible || archivedTasks;
  elements.machinesFooterActions.hidden = machineReorderMode || setupHidden;
  elements.machineReorderActions.hidden = !machineReorderMode;
  elements.machinesFooter.hidden = !machineReorderMode && setupHidden
    && elements.machinesRestart.hidden && elements.machinesError.hidden;
}

// Reorder mode lists the host, then the local draft order, then unsaved running machines.
function renderMachineReorderList(catalogMachines) {
  const groups = reorderVisualGroups(catalogMachines);
  const draft = machineReorderDraft || [];
  const draftKeys = new Set(draft.map((machine) => `ssh:${machine.ssh}`.toLowerCase()));
  const rows = [
    ...groups.filter((machine) => machine.local).map((machine) => ({ key: machine.key, name: machine.name, index: -1 })),
    ...draft.map((machine, index) => ({ key: `ssh:${machine.ssh}`, name: machine.name || machine.ssh, index })),
    ...groups.filter((machine) => !machine.local && !draftKeys.has(machine.key.toLowerCase())).map((machine) => ({ key: machine.key, name: machine.name, index: -1 })),
  ];
  for (const { key, name: machineName, index } of rows) {
    const row = document.createElement("div");
    row.className = `reorder-row${index < 0 ? " fixed" : ""}`;
    row.dataset.machineKey = key;
    row.tabIndex = -1;
    const name = document.createElement("span");
    name.className = "reorder-name";
    name.textContent = machineName;
    row.append(name);
    // Only saved SSH machines move; the host and unsaved running entries stay fixed.
    if (index >= 0) {
      const actions = document.createElement("div");
      actions.className = "reorder-actions";
      for (const direction of [-1, 1]) {
        const up = direction < 0;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "icon-button";
        button.dataset.direction = up ? "up" : "down";
        const label = `Move ${name.textContent} ${up ? "up" : "down"}`;
        button.setAttribute("aria-label", label);
        button.title = label;
        button.innerHTML = `<svg aria-hidden="true" viewBox="0 0 24 24"><path d="${up ? "M12 19V5m-6 6 6-6 6 6" : "M12 5v14m-6-6 6 6 6-6"}"/></svg>`;
        button.disabled = machineReorderBusy || (up ? index === 0 : index === draft.length - 1);
        button.addEventListener("click", () => moveReorderDraft(index, direction, key));
        actions.append(button);
      }
      row.append(actions);
    }
    elements.destinationList.append(row);
  }
  if (!rows.length) elements.destinationList.append(Object.assign(document.createElement("p"), { className: "destination-empty", textContent: "No machines" }));
}

// Arrow presses only change the local draft: nothing is saved and navigation is not refreshed.
function moveReorderDraft(from, direction, key) {
  if (!machineReorderMode || machineReorderBusy || !machineReorderDraft) return;
  const to = from + direction;
  if (from < 0 || to < 0 || to >= machineReorderDraft.length) return;
  const [moved] = machineReorderDraft.splice(from, 1);
  machineReorderDraft.splice(to, 0, moved);
  syncMachineReorderUi();
  renderDestinationSwitcher(true);
  focusReorderMachine(key, direction);
}

async function saveMachineReorder() {
  if (!machineReorderMode || machineReorderBusy || !reorderDraftChanged()) return;
  machineReorderBusy = true;
  elements.machinesError.hidden = true;
  elements.machinesError.textContent = "";
  syncMachineReorderUi();
  try {
    // saveMachineConfig only commits a confirmed save, so a failure keeps the draft for retry.
    await saveMachineConfig({ machines: machineReorderDraft.map((machine) => ({ ...machine })) });
    machineReorderBusy = false;
    setMachineReorderMode(false);
  } catch (error) {
    machineReorderBusy = false;
    elements.machinesError.textContent = error instanceof Error ? error.message : String(error);
    elements.machinesError.hidden = false;
    syncMachineReorderUi();
  }
}

function setMachineReorderMode(active) {
  const next = Boolean(active);
  if (machineReorderBusy && next !== machineReorderMode) return;
  machineReorderMode = next;
  machineReorderDraft = next ? savedMachines().map((machine) => ({ ...machine })) : null;
  elements.machinesError.hidden = true;
  elements.machinesError.textContent = "";
  syncMachineReorderUi();
  renderDestinationSwitcher(true);
  if (next) elements.destinationList.querySelector(".reorder-row")?.focus();
  else if (tasksSwitcherOpen()) elements.machineReorder.focus();
}
elements.machineReorder.addEventListener("click", () => setMachineReorderMode(true));
elements.machineReorderCancel.addEventListener("click", () => setMachineReorderMode(false));
elements.machineReorderSave.addEventListener("click", () => void saveMachineReorder());
function renderSettings(value) {
  settingsValue = value;
  for (const field of [elements.settingsLanEnabled, elements.settingsHost, elements.settingsPort]) field.disabled = Boolean(value.headless);
  document.querySelector("#settings-network-help").textContent = value.headless
    ? "Network binding is managed by the container/host."
    : "Use 0.0.0.0 for all local-network interfaces.";
  elements.quitPocket.disabled = Boolean(value.headless);
  // Host lifecycle control is unavailable in a container; Restart stays available everywhere.
  elements.quitPocket.hidden = Boolean(value.headless);
  elements.restartPocket.hidden = false;
  document.querySelector("#container-lifecycle").hidden = !value.headless;
  // DeepSeek needs no toggle; only a broken host credential is worth surfacing here.
  elements.settingsDeepseekSection.hidden = !value.deepseekError;
  elements.settingsDeepseekError.textContent = value.deepseekError || "";
  elements.settingsLanEnabled.checked = Boolean(value.lanEnabled);
  elements.settingsHost.value = value.host || "127.0.0.1";
  elements.settingsPort.value = String(value.port || 4173);
  elements.settingsPin.value = "";
  elements.settingsPin.placeholder = value.pinConfigured ? "Leave blank to keep current PIN" : "Enter 4 digits";
  elements.settingsPinState.textContent = value.pinConfigured ? "PIN configured." : "No PIN configured.";
  elements.phoneUrlList.replaceChildren();
  const urls = value.headless ? [location.origin] : Array.isArray(value.phoneUrls) ? value.phoneUrls : [];
  for (const url of urls) {
    const link = document.createElement("a");
    link.href = url;
    link.textContent = url;
    elements.phoneUrlList.append(link);
  }
  elements.phoneUrls.hidden = urls.length === 0;
  settingsBaseline = { server: JSON.stringify(serverSettingsValue()), local: JSON.stringify(localSettingsValue()) };
  updateSettingsSave();
}

async function openSettings() {
  settingsBaseline = null;
  settingsDisplayDraft = { ...displayPreferences };
  restoreLocalSettingsControls();
  const localBaseline = JSON.stringify(localSettingsValue());
  updateSettingsSave();
  clearSelectionForOverlay();
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
    settingsBaseline.local = localBaseline;
    updateSettingsSave();
    elements.settingsRestart.hidden = !result.restartRequired;
    elements.settingsStatus.textContent = "";
    (settingsValue?.headless ? elements.settingsPin : elements.settingsLanEnabled).focus();
  } catch (error) {
    elements.settingsStatus.textContent = error.message;
    elements.settingsStatus.classList.add("error-text");
  }
}

elements.destinationButton.addEventListener("click", () => {
  if (elements.destinationButton.getAttribute("aria-expanded") !== "true") openDestinationSwitcher();
  else closeDestinationSwitcher();
});
elements.tasksToggle.addEventListener("click", () => {
  if (tasksSwitcherOpen()) closeDestinationSwitcher(); else openDestinationSwitcher();
});
elements.destinationRefresh.addEventListener("click", () => refreshNavigationCatalog(archivedTasks, true));
elements.destinationClose.addEventListener("click", closeDestinationSwitcher);
elements.destinationBackdrop.addEventListener("click", closeDestinationSwitcher);
elements.destinationSearch.addEventListener("input", () => renderDestinationSwitcher());
elements.showArchived.addEventListener("change", () => {
  archivedTasks = elements.showArchived.checked;
  renderDestinationSwitcher();
  void refreshNavigationCatalog();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.defaultPrevented || document.querySelector("dialog[open]")) return;
  if (!elements.settingsScreen.hidden) { closeSettings(); return; }
  if (composerExpanded) { event.preventDefault(); toggleComposer(); return; }
  if (!isWideLayout()) {
    if (inspectorOpen()) closeInspector();
    else if (tasksSwitcherOpen()) closeDestinationSwitcher();
  }
});
elements.attachImage.addEventListener("click", () => elements.imagePicker.click());
elements.imagePicker.addEventListener("change", () => addFiles([...elements.imagePicker.files]));
elements.messageText.addEventListener("paste", (event) => {
  const files = [...(event.clipboardData?.items || [])].filter((item) => item.kind === "file" && item.type.startsWith("image/")).map((item) => item.getAsFile()).filter(Boolean);
  if (files.length) { event.preventDefault(); addFiles(files); }
});
elements.expandComposer.addEventListener("click", toggleComposer);
elements.expandComposer.addEventListener("pointerdown", (event) => event.preventDefault());
elements.messageText.addEventListener("focus", () => {
  if (matchMedia("(max-width: 860px)").matches) jumpToLatest(true);
});
let previousViewportHeight = window.visualViewport?.height ?? innerHeight;
let viewportReconcileFrame;
let keyboardClosedHeight = previousViewportHeight;
let composerKeyboardOpen = false;
function cancelViewportReconciliation() { cancelAnimationFrame(viewportReconcileFrame); }
function viewportReconciliationBlocked() {
  const focused = document.activeElement;
  const editing = focused?.matches("textarea, input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]), [contenteditable]:not([contenteditable=false])");
  return transcriptScroller() !== document.scrollingElement || composerExpanded || editing || selectionHold.active || transcriptSelectionActive();
}
window.visualViewport?.addEventListener("resize", () => {
  const height = window.visualViewport.height;
  const decrease = previousViewportHeight - height;
  previousViewportHeight = height;
  cancelViewportReconciliation();
  const mobileComposer = document.activeElement === elements.messageText && matchMedia("(max-width: 860px)").matches;
  keyboardClosedHeight = Math.max(keyboardClosedHeight, height);
  const keyboardOpen = mobileComposer && keyboardClosedHeight - height > 150;
  const openingKeyboard = keyboardOpen && !composerKeyboardOpen;
  const closingKeyboard = !keyboardOpen && composerKeyboardOpen;
  composerKeyboardOpen = keyboardOpen;
  if (!matchMedia("(max-width: 860px)").matches) keyboardClosedHeight = height;
  if (closingKeyboard) return;
  if (openingKeyboard) jumpToLatest(true);
  if (document.activeElement === elements.messageText && matchMedia("(max-width: 860px)").matches && shouldFollowConversation) {
    jumpToLatest(true);
    viewportReconcileFrame = requestAnimationFrame(() => {
      if (document.activeElement === elements.messageText && shouldFollowConversation) jumpToLatest(true);
    });
    return;
  }
  if (decrease <= 0 || viewportReconciliationBlocked()) return;
  const scroller = document.scrollingElement;
  const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  if (distance > decrease + 80) return;
  viewportReconcileFrame = requestAnimationFrame(() => {
    if (viewportReconciliationBlocked()) return;
    scroller.scrollTop = scroller.scrollHeight;
    shouldFollowConversation = true;
    rememberTranscriptScroll();
    updateJumpLatest();
  });
});
for (const type of ["touchstart", "wheel", "keydown"]) document.addEventListener(type, cancelViewportReconciliation, { passive: true });
window.visualViewport?.addEventListener("resize", fitExpandedComposer);
window.visualViewport?.addEventListener("scroll", fitExpandedComposer);
window.visualViewport?.addEventListener("resize", () => resizeComposer());
let composerWidth = 0;
new ResizeObserver(([entry]) => {
  if (entry.contentRect.width === composerWidth) return;
  composerWidth = entry.contentRect.width;
  resizeComposer();
}).observe(elements.composerInput);
let composerZoneHeight = 0;
let composerResizeFrame = null;
let composerResizeScrollTop = 0;
new ResizeObserver(([entry]) => {
  if (entry.contentRect.height === composerZoneHeight) return;
  composerZoneHeight = entry.contentRect.height;
  if (composerExpanded || !shouldFollowConversation || selectionHold.active || transcriptSelectionActive() || historyRequest || composerResizeFrame !== null) return;
  composerResizeScrollTop = transcriptScroller().scrollTop;
  composerResizeFrame = requestAnimationFrame(() => {
    composerResizeFrame = null;
    if (composerExpanded || !shouldFollowConversation || selectionHold.active || transcriptSelectionActive() || historyRequest) return;
    const scroller = transcriptScroller();
    scroller.scrollTop = scroller.scrollHeight;
    shouldFollowConversation = true;
    rememberTranscriptScroll();
    updateJumpLatest();
  });
}).observe(elements.composerZone);
// User scrolling takes priority over a pending composer resize reconciliation.
for (const type of ["pointerdown", "touchstart", "wheel", "keydown"]) document.addEventListener(type, () => {
  cancelAnimationFrame(composerResizeFrame);
  composerResizeFrame = null;
}, { passive: true });
document.addEventListener("selectionchange", observeTranscriptSelection);
elements.conversation.addEventListener("pointerdown", event => {
  if (event.isPrimary && event.button === 0 && !matchMedia("(max-width: 860px)").matches) {
    elements.composerZone.inert = true;
  }
});
const clearTranscriptDrag = () => { elements.composerZone.inert = false; };
for (const type of ["pointerup", "pointercancel", "mouseup"]) window.addEventListener(type, clearTranscriptDrag, true);
window.addEventListener("blur", clearTranscriptDrag);
elements.conversation.addEventListener("focusout", (event) => {
  if (!event.relatedTarget?.closest(".async-answer")) queueMicrotask(flushDeferredTranscript);
});
elements.messageText.addEventListener("compositionstart", () => { composing = true; });
elements.messageText.addEventListener("compositionend", () => { composing = false; });
elements.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const action = elements.sendMessage.dataset.action;
  if (action === "stop") interruptTurn();
  else submitMessage(action === "queue" ? "queue" : "start");
});
elements.sendQueue.addEventListener("click", sendQueuedMessage);
elements.cancelQueue.addEventListener("click", () => openQueueDialog("cancel"));
document.querySelector("#edit-queue").addEventListener("click", () => openQueueDialog("edit"));
elements.messageText.addEventListener("input", () => {
  if (unresolvedSubmission) unresolvedSubmission.restoreDraft = false;
  composerError = "";
  resizeComposer();
  renderComposer();
});
elements.messageText.addEventListener("keydown", (event) => {
  if (enterSubmits(event, enterSends, composing) && (elements.messageText.value.trim() || selectedImages.length || selectedFiles.length)) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});
elements.effortSelect.addEventListener("change", () => updateThreadSettings(elements.modelSelect?.value || state?.model, elements.effortSelect.value));
elements.accessSelect.addEventListener("change", () => updateAccess(elements.accessSelect.value));
function handleTranscriptScroll() {
  const scroller = transcriptScroller();
  const top = scroller.scrollTop;
  // Deliberate scrolling away moves the position up *and* increases the distance from the bottom.
  // A layout clamp (the composer shrinking after a send) drops scrollTop but keeps the same
  // distance, and a taller transcript viewport only changes the distance, so neither counts.
  const gap = scroller.scrollHeight - top - scroller.clientHeight;
  const sameScroller = scroller === transcriptScrollElement;
  const movedUp = sameScroller ? Math.max(0, transcriptScrollTop - top) : 0;
  const grewFromBottom = sameScroller ? gap - transcriptScrollBottomGap : 0;
  // A wheel gesture can arrive as many sub-threshold steps, so accumulate the part of each step
  // that genuinely moved the content rather than a layout clamp. Anything that moves back down
  // (or clamps by keeping the same distance) clears the accumulation, so a round trip never counts.
  if (movedUp > 0.5 && grewFromBottom > 0.5) transcriptUpwardScroll += Math.min(movedUp, grewFromBottom);
  else transcriptUpwardScroll = 0;
  const upward = transcriptUpwardScroll > 1;
  // Preserve known layout reconciliation; input cancels its pending frame above.
  if (composerResizeFrame === null || top < composerResizeScrollTop) {
    if (upward) {
      shouldFollowConversation = false;
      markSendNavigationOverride();
    } else if (gap <= 2) shouldFollowConversation = true;
  }
  rememberTranscriptScroll();
  updateJumpLatest();
  if (transcriptScroller().scrollTop < 140 && nextCursor && !historyRequest) loadHistory(nextCursor, historyEpoch, false);
}
elements.conversation.addEventListener("scroll", handleTranscriptScroll);
document.addEventListener("scroll", () => {
  if (transcriptScroller() === document.scrollingElement) handleTranscriptScroll();
});
elements.jumpLatest.addEventListener("click", () => { clearSendNavigationOverride(); jumpToLatest(); });
elements.inspectorButton.addEventListener("click", toggleInspector);
elements.inspectorClose.addEventListener("click", closeInspector);
elements.inspectorBackdrop.addEventListener("click", closeInspector);
window.addEventListener("resize", () => {
  updateInspectorButtonState();
  elements.destinationSwitcher.setAttribute("role", isWideLayout() ? "navigation" : "dialog");
  resizeComposer();
});
for (const [element, key] of [
  [elements.displayFiles, "files"],
  [elements.displayCommands, "command"],
  [elements.displayTool, "tool"],
  [elements.displaySearch, "search"],
  [elements.displayReview, "review"],
  [elements.displayReasoning, "reasoning"],
  [elements.displayCollaboration, "collaboration"],
  [elements.displayImages, "images"],
  [elements.displayCompaction, "compaction"],
]) {
  element.addEventListener("change", () => {
    if (settingsDisplayDraft) { settingsDisplayDraft[key] = element.checked; renderDisplayControls(); updateSettingsSave(); return; }
    displayPreferences[key] = element.checked;
    saveDisplayPreferences();
    renderDisplayControls();
    renderConversation();
  });
}

for (const [id, visible] of [["display-show-all", true], ["display-hide-all", false]]) {
  const button = id === "display-show-all" ? elements.displayShowAll : elements.displayHideAll;
  button.addEventListener("click", () => {
    const preferences = settingsDisplayDraft || displayPreferences;
    // Hidden categories keep whatever the user saved for them.
    for (const [key, control] of Object.entries(DISPLAY_CONTROLS)) {
      if (control?.closest("label")?.hidden) continue;
      preferences[key] = visible;
    }
    if (settingsDisplayDraft) { renderDisplayControls(); updateSettingsSave(); return; }
    saveDisplayPreferences();
    renderDisplayControls();
    renderConversation();
  });
}

setInterval(() => {
  if (goalClock?.active) renderGoalTime();
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
// Keep focus (and the mobile keyboard) on the PIN field while toggling the revealed type.
elements.loginPinReveal.addEventListener("pointerdown", (event) => event.preventDefault());
elements.loginPinReveal.addEventListener("click", () => {
  const pin = elements.loginPin;
  const { selectionStart, selectionEnd, selectionDirection } = pin;
  const revealed = pin.type === "text";
  pin.type = revealed ? "password" : "text";
  try { pin.setSelectionRange(selectionStart, selectionEnd, selectionDirection); } catch { /* unsupported type */ }
  const label = revealed ? "Show PIN" : "Hide PIN";
  elements.loginPinReveal.setAttribute("aria-label", label);
  elements.loginPinReveal.title = label;
  elements.loginPinReveal.setAttribute("aria-pressed", String(!revealed));
  if (document.activeElement !== pin) pin.focus({ preventScroll: true });
});

elements.settingsButton.addEventListener("click", openSettings);
elements.settingsClose.addEventListener("click", closeSettings);
elements.settingsCancel.addEventListener("click", closeSettings);
elements.settingsScreen.addEventListener("click", (event) => { if (event.target === elements.settingsScreen) closeSettings(); });
elements.settingsLanEnabled.addEventListener("change", () => {
  if (elements.settingsLanEnabled.checked && elements.settingsHost.value === "127.0.0.1") elements.settingsHost.value = "0.0.0.0";
});
// Preview only: selectedTheme/localStorage stay untouched until Save.
elements.settingsTheme.addEventListener("change", () => applyTheme(elements.settingsTheme.value));
elements.settingsPin.addEventListener("input", () => {
  elements.settingsPin.value = elements.settingsPin.value.replace(/\D/g, "").slice(0, 4);
  elements.settingsStatus.textContent = "";
  elements.settingsStatus.classList.remove("error-text");
});
elements.settingsForm.addEventListener("input", updateSettingsSave);
elements.settingsForm.addEventListener("change", updateSettingsSave);
elements.settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (savingSettings || elements.settingsSave.disabled) return;
  const local = localSettingsValue();
  const serverChanged = JSON.stringify(serverSettingsValue()) !== settingsBaseline.server;
  const pin = elements.settingsPin.value;
  if (serverChanged && elements.settingsLanEnabled.checked && !settingsValue?.pinConfigured && !/^\d{4}$/.test(pin)) {
    elements.settingsStatus.textContent = "Set a four-digit PIN before enabling LAN access";
    elements.settingsStatus.classList.add("error-text");
    elements.settingsPin.focus();
    return;
  }
  savingSettings = true;
  elements.settingsSave.disabled = true;
  elements.settingsStatus.textContent = "Saving…";
  elements.settingsStatus.classList.remove("error-text");
  try {
    let result = { settings: settingsValue, restartRequired: !elements.settingsRestart.hidden };
    if (serverChanged) {
      const response = await apiFetch("/api/settings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(serverSettingsValue()),
      });
      result = await response.json();
      if (!response.ok || !result.saved) throw new Error(result.error || "Could not save settings");
      invalidateNavigationCatalogs();
    }
    commitLocalSettings(local);
    settingsDisplayDraft = { ...displayPreferences };
    restoreLocalSettingsControls();
    renderSettings(result.settings);
    elements.settingsRestart.hidden = !result.restartRequired;
    // Keep the Tasks-sidebar restart hint aligned with the latest saved config.
    void refreshMachineConfig();
    elements.settingsStatus.textContent = "";
    if (result.restartRequired) {
      elements.settingsRestart.scrollIntoView({ block: "center" });
      elements.restartPocket.focus({ preventScroll: true });
    } else closeSettings();
  } catch (error) {
    elements.settingsStatus.textContent = error.message;
    elements.settingsStatus.classList.add("error-text");
  } finally {
    savingSettings = false;
    updateSettingsSave();
  }
});
elements.restartPocket.addEventListener("click", async () => {
  if (restartingPocket) return;
  const hostName = settingsValue?.hostName || state?.hostName || "this Mac";
  // Restart uses the configuration already saved on the host; unsaved Settings edits are not committed.
  const confirmed = await pocketConfirm({
    title: `Restart Pocket on ${hostName}?`,
    message: "Active Pocket work may be interrupted while the gateway restarts.",
    confirmLabel: "Restart",
  });
  if (!confirmed) return;
  restartingPocket = true;
  elements.restartPocket.disabled = true;
  elements.restartPocket.textContent = "Restarting…";
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
    elements.restartPocket.textContent = "Restart Pocket";
    elements.settingsStatus.textContent = error.message;
    elements.settingsStatus.classList.add("error-text");
  }
});
elements.quitPocket.addEventListener("click", async () => {
  if (quittingPocket) return;
  const hostName = settingsValue?.hostName || state?.hostName || "this Mac";
  const confirmed = await pocketConfirm({
    title: `Quit Pocket on ${hostName}?`,
    message: "Pocket will stop and you won't be able to reconnect until Codex Pocket.app is launched again on that Mac.",
    confirmLabel: "Quit", danger: true,
  });
  if (!confirmed) return;
  quittingPocket = true;
  elements.quitPocket.disabled = true;
  elements.quitPocket.textContent = "Quitting…";
  elements.settingsStatus.textContent = "Quitting…";
  elements.settingsStatus.classList.remove("error-text");
  try {
    const response = await apiFetch("/api/shutdown", { method: "POST" });
    const result = await response.json();
    if (!response.ok || !result.shuttingDown) throw new Error(result.error || "Could not quit Pocket");
    showStopped();
  } catch (error) {
    quittingPocket = false;
    elements.quitPocket.disabled = false;
    elements.quitPocket.textContent = "Quit Pocket";
    elements.settingsStatus.textContent = error.message;
    elements.settingsStatus.classList.add("error-text");
  }
});

async function startApp() {
  elements.loginScreen.hidden = true;
  elements.stoppedScreen.hidden = true;
  elements.appShell.hidden = false;
  // First wide-layout launch opens both sidebars instantly; saved desktop preferences always win.
  applySidebarLayout({ instant: true });
  try {
    const response = await apiFetch("/api/state");
    applySnapshot(await response.json(), false);
    refreshNavigationCatalog();
    await Promise.all([refreshMachineConfig(), refreshMachines(), refreshLoadedThreads()]);
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

// Viewer transforms are independent of the browser's page zoom.
function setupImageViewer(dialog, image, close) {
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    dialog.close();
  });
  let opener;
  let scale = 1, x = 0, y = 0;
  let lastTap = null;
  let gesture = null;
  let ignoreClick = false;
  const pointers = new Map();
  const points = () => [...pointers.values()];
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const midpoint = (a, b) => ({ x: (a.x + b.x) / 2 - dialog.clientWidth / 2, y: (a.y + b.y) / 2 - dialog.clientHeight / 2 });
  function paint() {
    const limitX = Math.max(0, (image.offsetWidth * scale - dialog.clientWidth) / 2);
    const limitY = Math.max(0, (image.offsetHeight * scale - dialog.clientHeight) / 2);
    x = Math.max(-limitX, Math.min(limitX, x));
    y = Math.max(-limitY, Math.min(limitY, y));
    image.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px) scale(${scale})`;
    image.style.cursor = scale > 1 ? 'grab' : 'default';
  }
  function begin(multi = false) {
    if (multi) lastTap = null;
    const [a, b] = points();
    gesture = a ? { a, distance: b ? distance(a, b) : 0, center: b ? midpoint(a, b) : null, scale, x, y, moved: multi, multi } : null;
  }
  dialog.addEventListener('pointerdown', event => {
    if (event.target.closest('button') || event.button !== 0) return;
    event.preventDefault();
    if (!pointers.size) ignoreClick = false;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.target.setPointerCapture(event.pointerId);
    begin(pointers.size > 1);
  });
  dialog.addEventListener('pointermove', event => {
    if (!pointers.has(event.pointerId) || !gesture) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const [a, b] = points();
    if (b && gesture.center) {
      scale = Math.max(1, Math.min(6, gesture.scale * distance(a, b) / Math.max(1, gesture.distance)));
      const center = midpoint(a, b);
      x = center.x - (gesture.center.x - gesture.x) * scale / gesture.scale;
      y = center.y - (gesture.center.y - gesture.y) * scale / gesture.scale;
    } else {
      const dx = a.x - gesture.a.x, dy = a.y - gesture.a.y;
      if (Math.hypot(dx, dy) > 8) gesture.moved = true;
      if (scale > 1) { x = gesture.x + dx; y = gesture.y + dy; }
    }
    paint();
  });
  function finish(event) {
    if (!pointers.has(event.pointerId)) return;
    const last = pointers.size === 1;
    ignoreClick = gesture.moved || gesture.multi || event.type === 'pointercancel';
    const tap = event.type === 'pointerup' && event.pointerType === 'touch' && last && !ignoreClick && event.target === image;
    const previousTap = lastTap;
    pointers.delete(event.pointerId);
    if (event.target.hasPointerCapture(event.pointerId)) event.target.releasePointerCapture(event.pointerId);
    begin(true); // A pinch becoming one finger must never become a dismiss gesture.
    if (tap) {
      const now = performance.now();
      if (previousTap && now - previousTap.time < 300 && Math.hypot(event.clientX - previousTap.x, event.clientY - previousTap.y) < 24) {
        if (scale > 1) { scale = 1; x = 0; y = 0; }
        else {
          scale = 2.5;
          x = (event.clientX - dialog.clientWidth / 2) * (1 - scale);
          y = (event.clientY - dialog.clientHeight / 2) * (1 - scale);
        }
        lastTap = null;
      } else lastTap = { time: now, x: event.clientX, y: event.clientY };
    }
    paint();
  }
  dialog.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    if (event.target === dialog && !ignoreClick) dialog.close();
  });
  dialog.addEventListener('pointerup', finish);
  dialog.addEventListener('pointercancel', finish);
  dialog.addEventListener('wheel', event => {
    lastTap = null;
    event.preventDefault();
    const previous = scale;
    scale = Math.max(1, Math.min(6, scale * Math.exp(-event.deltaY * .002)));
    const px = event.clientX - dialog.clientWidth / 2, py = event.clientY - dialog.clientHeight / 2;
    x = px - (px - x) * scale / previous;
    y = py - (py - y) * scale / previous;
    paint();
  }, { passive: false });
  image.addEventListener('load', paint);
  window.addEventListener('resize', () => { if (dialog.open) paint(); });
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    // A queued close event can arrive after the same image has reopened.
    if (dialog.open) return;
    pointers.clear();
    gesture = null;
    image.removeAttribute('src');
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  });
  function open(source) {
    opener = source;
    scale = 1; x = 0; y = 0; lastTap = null;
    pointers.clear(); gesture = null;
    image.src = source.src;
    image.alt = source.alt;
    dialog.showModal();
    paint();
    close.focus();
  }
  return { open };
}
