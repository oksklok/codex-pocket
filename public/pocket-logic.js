// Display-only copy for Codex's known credits/usage-limit error.
export function usageLimitMessage(error, currentYear = new Date().getFullYear()) {
  const match = /^You've hit your usage limit\. Visit https:\/\/chatgpt\.com\/codex\/settings\/usage to purchase more credits or try again at (.+)\.$/.exec(error);
  if (!match) return null;
  const date = /^(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?) (\d{1,2})(?:st|nd|rd|th)?, (\d{4}) (\d{1,2}:\d{2} [AP]M)$/.exec(match[1]);
  const retry = date ? `${date[1].slice(0, 3)} ${date[2]}${Number(date[3]) === currentYear ? "" : `, ${date[3]}`} at ${date[4]}` : match[1];
  return `Usage limit reached. Try again ${retry}.`;
}

export function enterSubmits(event, enterSends, composing = false) {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing && !composing && event.keyCode !== 229
    && (enterSends || event.ctrlKey || event.metaKey);
}

export function destinationTaskStatus(machine, task, currentState, terminalResult = "") {
  const selected = machine.id === currentState?.machineId && task.id === currentState?.thread?.id;
  const phase = selected ? currentState?.phase : task.phase;
  const status = selected ? currentState?.threadStatus : task.status;
  if (status?.startsWith("active:") && /waitingOnApproval|waitingOnUserInput/.test(status)) return "Waiting";
  if (phase === "waiting_permission" || phase === "waiting_input") return "Waiting";
  if (phase === "working" || status?.startsWith("active")) return "Working";
  return terminalResult;
}

export function preserveMessageCreatedAt(existing, incoming) {
  if (!existing || !Number.isFinite(existing.createdAt)) return { ...incoming };
  return { ...incoming, createdAt: existing.createdAt };
}

export function contextSnapshot(usage) {
  const used = usage?.last?.totalTokens, window = usage?.modelContextWindow;
  if (!Number.isFinite(used) || used < 0 || !Number.isFinite(window) || window <= 0) return null;
  return { usedTokens: used, contextWindow: window, usedPercent: Math.round(100 * Math.min(used, window) / window) };
}

export const MAX_INPUT_IMAGES = 4;
export const MAX_INPUT_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_INPUT_IMAGES_BYTES = 8 * 1024 * 1024;

export function imageInputs(images = []) {
  if (!Array.isArray(images) || images.length > MAX_INPUT_IMAGES) throw new Error("Choose up to 4 images");
  let total = 0;
  return images.map((image) => {
    const url = image?.url;
    if (typeof url !== "string" || url.length > Math.ceil(MAX_INPUT_IMAGE_BYTES * 4 / 3) + 40) throw new Error("Each image must be 4 MB or smaller");
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
    if (!match || match[2].length % 4) throw new Error("Use PNG, JPEG, GIF, or WebP images");
    const bytes = match[2].length * 3 / 4 - (match[2].endsWith("==") ? 2 : match[2].endsWith("=") ? 1 : 0);
    total += bytes;
    if (bytes > MAX_INPUT_IMAGE_BYTES || total > MAX_INPUT_IMAGES_BYTES) throw new Error("Images must be at most 4 MB each and 8 MB together");
    const header = atob(match[2].slice(0, 32));
    const valid = match[1] === "image/png" ? header.startsWith("\x89PNG\r\n\x1a\n")
      : match[1] === "image/jpeg" ? header.startsWith("\xff\xd8\xff")
      : match[1] === "image/gif" ? /^GIF8[79]a/.test(header)
      : header.startsWith("RIFF") && header.slice(8, 12) === "WEBP";
    if (!valid) throw new Error("Image content does not match its type");
    return { type: "image", url };
  });
}

export const MAX_INPUT_FILES = 4;
export const MAX_INPUT_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_INPUT_FILES_BYTES = 20 * 1024 * 1024;

export function fileInputs(files = []) {
  if (!Array.isArray(files) || files.length > MAX_INPUT_FILES) throw new Error("Choose up to 4 files");
  let total = 0;
  return files.map(file => {
    if (!file || typeof file.name !== "string" || !file.name.trim() || file.name.length > 255
      || /[\\/\x00-\x1f\x7f]/.test(file.name) || file.name === "." || file.name === ".." || Object.hasOwn(file, "path")) throw new Error("Invalid file name");
    const data = file.data;
    if (typeof data !== "string" || data.length > Math.ceil(MAX_INPUT_FILE_BYTES / 3) * 4) throw new Error("Each file must be 10 MB or smaller");
    if (data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error("Invalid file base64");
    // Canonical padding bits, without decoding the entire payload in the browser.
    if (data.endsWith("=") && btoa(atob(data.slice(-4))) !== data.slice(-4)) throw new Error("Invalid file base64");
    const size = data.length * 3 / 4 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
    total += size;
    if (size > MAX_INPUT_FILE_BYTES || total > MAX_INPUT_FILES_BYTES) throw new Error("Files must be at most 10 MB each and 20 MB together");
    if (file.size !== undefined && file.size !== size) throw new Error("File size does not match its content");
    const name = file.name.replace(/[<>:"|?*]/g, "_").replace(/^[. ]+|[. ]+$/g, "").slice(0, 120) || "file";
    return { name, data, size };
  });
}

export function messageInputs(text, images = []) {
  const input = imageInputs(images);
  if (typeof text !== "string" || text.length > 12000) throw new Error("Message text must be at most 12,000 characters");
  if (text.trim()) input.unshift({ type: "text", text: text.replace(/\r\n/g, "\n"), text_elements: [] });
  if (!input.length) throw new Error("Enter a message or choose an image");
  return input;
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

// Use the existing protocol reply envelope so history retains the exact question/index.
export function asyncAnswerInput(messageId, index, title, answer) {
  return `<send_user_message_question_reply>${JSON.stringify([{
    questionItemId: JSON.stringify(["request_user_input_async", messageId, index]),
    question: title,
    answer,
  }])}</send_user_message_question_reply>`;
}

function asyncReplyMatches(value, messageId, index) {
  if (value === messageId) return true;
  if (typeof value !== "string") return false;
  try {
    // Desktop serializes the tuple with escaped quotes inside questionItemId.
    const id = JSON.parse(value.replace(/\\"/g, '"'));
    return Array.isArray(id) && id.length === 3 && id[0] === "request_user_input_async"
      && id[1] === messageId && Number.isInteger(id[2]) && id[2] === index;
  } catch { return false; }
}

// Confirmed text Steers live in the existing message map until their Codex echo arrives.
export function reconcileConfirmedSteers(messages) {
  const confirmed = messages.filter(message => message.confirmedSteer);
  const authoritative = messages.filter(message => !message.confirmedSteer);
  const used = new Set(confirmed.map(message => message.confirmedSteer.matchedId).filter(Boolean));
  return messages.filter(message => {
    const receipt = message.confirmedSteer;
    if (!receipt) return true;
    if (receipt.matchedId) return false;
    const echo = authoritative.find(candidate => candidate.role === "user" && !candidate.imageCount
      && candidate.turnId === message.turnId && candidate.text === message.text
      && !receipt.previousMessageIds.includes(candidate.id) && !used.has(candidate.id));
    if (!echo) return true;
    receipt.matchedId = echo.id;
    used.add(echo.id);
    return false;
  });
}

export function resolvedAsyncAnswer(message, index, messages, answers = {}) {
  const recorded = answers[message.id]?.[index];
  if (recorded !== undefined) return recorded;
  for (const candidate of messages) {
    if (candidate.role !== "user" || !Array.isArray(candidate.questionReplies)) continue;
    const reply = candidate.questionReplies.find(reply => asyncReplyMatches(reply.questionItemId, message.id, index)
      && (reply.question === message.questions[index].title || (reply.question === undefined && message.questions.length === 1)));
    if (reply && typeof reply.answer === "string") return reply.answer;
  }
  // Retain recognition of replies sent by older Pocket clients. Their display
  // text stays intact because those messages have no durable reply identity.
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
  // The gateway must retire a delivered queue before clients consider recovery complete.
  if (requested.queueId) return "unknown";
  if (!requested.threadId || snapshot.machineId !== requested.machineId || snapshot.thread?.id !== requested.threadId) return "unknown";
  if (requested.question) {
    const question = requested.question;
    return snapshot.asyncAnswers?.[question.messageId]?.[question.index] === question.answer.trim() ? "accepted" : "unknown";
  }
  const text = requested.text?.replace(/\r\n/g, "\n");
  const images = requested.images || [];
  // Staged paths cannot prove the original bytes landed; use the submission receipt.
  if (requested.files?.length) return "unknown";
  if (!text && !images.length) return "unknown";
  if (requested.action === "queue" && snapshot.queuedMessage?.threadId === requested.threadId && snapshot.queuedMessage.text === text
    && JSON.stringify((snapshot.queuedMessage.images || []).map((image) => image.url)) === JSON.stringify(images.map((image) => image.url))) return "accepted";
  // Text alone cannot prove that an image submission landed. Use the receipt or exact queue.
  if (images.length) return "unknown";
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
  return /(?:method[^\n]*not found|unsupported[^\n]*method|-32601|is not supported yet)/i.test(String(message || ""));
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

// Android can briefly collapse a range while a native selection handle moves.
export function createSelectionHold(onRelease, timers = globalThis) {
  let active = false;
  let release = null;
  return {
    get active() { return active; },
    observe(selected) {
      if (selected) {
        active = true;
        timers.clearTimeout(release);
        release = null;
      } else if (active && release === null) {
        release = timers.setTimeout(() => {
          release = null;
          active = false;
          onRelease();
        }, 500);
      }
    },
    reset() {
      timers.clearTimeout(release);
      release = null;
      active = false;
    },
  };
}

// Map insertion order keeps the eight most recently saved or restored non-empty drafts.
export function rememberComposerDraft(drafts, key, draft = drafts.get(key)) {
  drafts.delete(key);
  if (!key || !draft || (!draft.text && !draft.images.length && !draft.files?.length)) return undefined;
  drafts.set(key, draft);
  while (drafts.size > 8) drafts.delete(drafts.keys().next().value);
  return draft;
}

// Keep fetched catalogs and live browser updates in the same order.
export function compareTaskOrder(left, right) {
  const priority = task => task.status?.startsWith("active") ? 1 : 0;
  return priority(right) - priority(left) || (right.updatedAt || 0) - (left.updatedAt || 0)
    || String(left.id).localeCompare(String(right.id));
}

// The two known DSH catalog entries, which advertise the compact names
// "DeepSeek-V41-Flash" and "DeepSeek-V4-Pro". Pocket applies its newer-generation-first display
// policy and normalized names to exactly these known ids; an unknown future model keeps its catalog
// name and the deterministic fallback order instead of having a version guessed for it.
const DEEPSEEK_MODEL_DISPLAY = new Map([
  ["deepseek-flash", { name: "DeepSeek V4.1 Flash", version: [4, 1] }],
  ["deepseek-v4-pro", { name: "DeepSeek V4 Pro", version: [4] }],
]);
const deepseekModelKey = (model) => String(model?.model ?? model?.id ?? "").trim().toLowerCase();

// Display-only name for the known DeepSeek entries; every other model keeps its catalog name.
export function modelDisplayName(model) {
  return DEEPSEEK_MODEL_DISPLAY.get(deepseekModelKey(model))?.name
    || model?.displayName || model?.model || model?.id || "";
}

// Recognizable GPT versions sort newest first; anything else keeps a deterministic name/id order
// instead of guessing a quality or release ranking that the catalog does not state.
export function modelVersionParts(model) {
  if (!model) return null;
  const known = DEEPSEEK_MODEL_DISPLAY.get(deepseekModelKey(model));
  if (known) return [...known.version];
  for (const text of [model.model, model.displayName]) {
    if (typeof text !== "string") continue;
    const match = /(?:^|[^a-z0-9])gpt[-\s]?(\d+(?:\.\d+)*)/i.exec(text)
      || /^(\d+(?:\.\d+)*)$/.exec(text.trim());
    if (match) return match[1].split(".").map(Number);
  }
  return null;
}

// Pocket's display policy for the recognized GPT-5.6 tiers; not a benchmark ranking. Only applies
// when the entry is a recognizable 5.6 model and its id or name carries one of the tier words, so
// unknown families and other generations keep the deterministic fallback.
const GPT_56_TIERS = ["sol", "terra", "luna"];
export function modelGpt56Tier(model) {
  const version = modelVersionParts(model);
  if (!version || version[0] !== 5 || version[1] !== 6 || version.length !== 2) return null;
  for (const text of [model?.model, model?.displayName]) {
    if (typeof text !== "string") continue;
    const match = /(?:^|[^a-z])(sol|terra|luna)(?![a-z])/i.exec(text);
    if (match) return GPT_56_TIERS.indexOf(match[1].toLowerCase());
  }
  return null;
}

export function compareModelDisplayOrder(left, right) {
  const leftVersion = modelVersionParts(left);
  const rightVersion = modelVersionParts(right);
  if (leftVersion && rightVersion) {
    for (let index = 0; index < Math.max(leftVersion.length, rightVersion.length); index += 1) {
      const difference = (rightVersion[index] ?? 0) - (leftVersion[index] ?? 0);
      if (difference) return difference;
    }
  } else if (leftVersion) return -1;
  else if (rightVersion) return 1;
  const leftTier = modelGpt56Tier(left);
  const rightTier = modelGpt56Tier(right);
  if (leftTier !== null || rightTier !== null) {
    if (leftTier === null) return 1;
    if (rightTier === null) return -1;
    if (leftTier !== rightTier) return leftTier - rightTier;
  }
  const leftName = String(left?.displayName || left?.model || "");
  const rightName = String(right?.displayName || right?.model || "");
  return leftName.localeCompare(rightName) || String(left?.model || "").localeCompare(String(right?.model || ""));
}

// Presentation-only copy: callers keep their own catalog order for ids, capabilities and defaults.
export function sortModelsForDisplay(models = []) {
  return [...models].sort(compareModelDisplayOrder);
}

// New Task keeps the caller's current effort when the selected model supports it; otherwise it uses
// that model's catalog default and finally the first supported effort. Never per-model memory.
export function resolveModelEffort(supported, current, fallback) {
  const efforts = Array.isArray(supported) ? supported : [];
  if (current && efforts.includes(current)) return current;
  if (fallback && efforts.includes(fallback)) return fallback;
  return efforts[0] || "";
}

// Navigation entries identify SSH runtimes by their `ssh:<alias>` id (the catalog omits the raw
// alias), so derive the alias from the id/group when the field is absent.
export function machineCatalogAlias(machine) {
  if (machine.ssh) return String(machine.ssh);
  const key = String(machine.group || machine.id || "");
  return key.startsWith("ssh:") ? key.slice(4) : "";
}

// One list for the sidebar: the host first, then the saved SSH machines in saved order, then any
// still-running machine the saved config no longer contains (reachable until the next restart).
// One physical machine can expose several runtimes (OpenAI and DeepSeek) under the same SSH alias;
// every runtime for an alias is kept, and the visual grouping stays the caller's job.
export function sidebarMachineCatalog(catalogMachines, savedMachines = [], savedHostName = "") {
  const byAlias = new Map();
  for (const machine of catalogMachines) {
    const alias = machineCatalogAlias(machine);
    if (!alias) continue;
    const key = alias.toLowerCase();
    const runtimes = byAlias.get(key);
    if (runtimes) runtimes.push(machine);
    else byAlias.set(key, [machine]);
  }
  // The desired saved host name is the custom localName when set, otherwise the real hostname.
  const ordered = catalogMachines.filter((machine) => machine.local === true || !machineCatalogAlias(machine)).map((machine) => ({
    ...machine,
    name: savedHostName || machine.name,
    hostPending: Boolean(savedHostName) && savedHostName !== machine.name,
  }));
  const consumed = new Set();
  const savedAliases = new Set(savedMachines.map((machine) => machine.ssh.trim().toLowerCase()));
  savedMachines.forEach((savedMachine, index) => {
    const running = byAlias.get(savedMachine.ssh.trim().toLowerCase()) || [];
    if (running.length) {
      for (const machine of running) {
        consumed.add(machine.id);
        ordered.push({
          ...machine,
          name: savedMachine.name || machine.name,
          savedIndex: index,
          pendingConfig: (machine.name || "") !== (savedMachine.name || ""),
        });
      }
    } else {
      ordered.push({
        id: `ssh:${savedMachine.ssh}`, name: savedMachine.name || savedMachine.ssh, provider: "openai",
        group: `ssh:${savedMachine.ssh}`, platform: "", local: false, connected: false, catalogAvailable: false,
        connectionError: null, canWake: false, tasks: [], ssh: savedMachine.ssh, wakeMac: savedMachine.wakeMac || null,
        pending: true, pendingConfig: false, savedIndex: index,
      });
    }
  });
  for (const machine of catalogMachines) {
    const alias = machineCatalogAlias(machine);
    if (!alias || consumed.has(machine.id) || savedAliases.has(alias.toLowerCase())) continue;
    ordered.push({ ...machine, savedIndex: -1, pendingRemoval: true });
  }
  return ordered;
}

// Whether a Project Folder response belongs to the operation the dialog started.
// A DSH relocation replaces the task's internal id, so the confirmed response
// (which carries `relocatedFrom`) is accepted once the browser has adopted the
// replacement id for the same visible task; an unrelated task change is not.
export function cwdResponseApplies(target, current, result) {
  if (!target || !current || current.machineId !== target.machineId) return false;
  if (current.thread?.id === target.threadId) return true;
  return result?.relocatedFrom === target.threadId
    && typeof result?.thread?.id === "string"
    && result.thread.id === current.thread?.id;
}
