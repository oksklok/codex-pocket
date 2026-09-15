import test from "node:test";
import assert from "node:assert/strict";

import {
  compareTaskOrder,
  createSelectionHold,
  usageLimitMessage,
  enterSubmits,
  destinationTaskStatus,
  historyTurnTimestamp,
  isUnsupportedMethodError,
  mergeActivities,
  orderTranscriptEntries,
  pocketPhase,
  preserveMessageCreatedAt,
  asyncAnswerText,
  contextSnapshot,
  imageInputs,
  messageInputs,
  normalizeAsyncQuestions,
  reconcileSubmission,
  reconcileConfirmedSteers,
  resolvedAsyncAnswer,
  rememberComposerDraft,
} from "../public/pocket-logic.js";
import { MachineRuntime, MessageSubmissions, PocketGateway, RpcClient, parseArgs, RESTART_HELPER, restartUrlForRequest } from "../gateway.ts";

const machine = { id: "local" };
const task = { id: "thread-1", status: "failed" };

test("selected task status trusts fresh live phase over stale catalog status", () => {
  assert.equal(destinationTaskStatus(machine, task, {
    machineId: "local",
    thread: { id: "thread-1" },
    phase: "working",
  }), "Working");
  assert.equal(destinationTaskStatus(machine, task, {
    machineId: "local",
    thread: { id: "thread-1" },
    phase: "done",
  }), "");
});

test("phase precedence favors blocking requests and a newer active turn", () => {
  const base = { connected: true, connectionError: null, pending: [], threadStatus: "idle" };
  assert.equal(pocketPhase({ ...base, turn: { status: "failed", error: "old failure" } }), "failed");
  assert.equal(pocketPhase({ ...base, threadStatus: "active", turn: { status: "failed", error: "old failure" } }), "working");
  assert.equal(pocketPhase({ ...base, turn: { status: "inProgress", error: "old failure" } }), "working");
  assert.equal(pocketPhase({
    ...base,
    threadStatus: "active",
    turn: { status: "inProgress", error: null },
    pending: [{ kind: "permission" }],
  }), "waiting_permission");
});

test("message updates retain their first-seen timestamp by message ID", () => {
  const existing = { id: "message-1", text: "partial", createdAt: 100, complete: false };
  const completed = preserveMessageCreatedAt(existing, {
    id: "message-1",
    text: "complete",
    createdAt: 900,
    complete: true,
  });
  assert.deepEqual(completed, { id: "message-1", text: "complete", createdAt: 100, complete: true });
});

test("history messages fall back to turn start instead of turn completion", () => {
  assert.equal(historyTurnTimestamp({ startedAt: 100 }, 900), 100);
  assert.equal(historyTurnTimestamp({}, 900), 900);
});

test("a final answer closes only its own turn after late activity completion", () => {
  const entries = [
    { type: "message", value: { id: "user-1", turnId: "turn-1", role: "user", phase: null, createdAt: 100 } },
    { type: "message", value: { id: "commentary-1", turnId: "turn-1", role: "assistant", phase: "commentary", createdAt: 200 } },
    { type: "activity", value: { id: "reasoning-1", turnId: "turn-1", status: "running", createdAt: 300 } },
    { type: "message", value: { id: "final-1", turnId: "turn-1", role: "assistant", phase: "final_answer", createdAt: 400 } },
    { type: "message", value: { id: "user-2", turnId: "turn-2", role: "user", phase: null, createdAt: 500 } },
  ];
  assert.deepEqual(orderTranscriptEntries(entries).map((entry) => entry.value.id), [
    "user-1", "commentary-1", "reasoning-1", "final-1", "user-2",
  ]);

  const afterLateCompletion = entries.map((entry) => entry.value.id === "reasoning-1"
    ? { type: "activity", value: { ...entry.value, status: "completed" } }
    : entry);
  const ordered = orderTranscriptEntries(afterLateCompletion);
  assert.deepEqual(ordered.map((entry) => entry.value.id), [
    "user-1", "commentary-1", "reasoning-1", "final-1", "user-2",
  ]);
  assert.equal(ordered.filter((entry) => entry.value.id === "reasoning-1").length, 1);
});

test("interleaved timestamps are not regrouped across turns", () => {
  const ordered = orderTranscriptEntries([
    { type: "message", value: { id: "final-1", turnId: "turn-1", role: "assistant", phase: "final_answer", createdAt: 400 } },
    { type: "message", value: { id: "user-2", turnId: "turn-2", role: "user", phase: null, createdAt: 500 } },
    { type: "activity", value: { id: "late-1", turnId: "turn-1", status: "completed", createdAt: 600 } },
  ]);
  assert.deepEqual(ordered.map((entry) => entry.value.id), ["final-1", "user-2", "late-1"]);
});

test("legacy item history fallback recognizes only unsupported-method errors", () => {
  assert.equal(isUnsupportedMethodError("Method not found (-32601)"), true);
  assert.equal(isUnsupportedMethodError("unsupported app-server method"), true);
  assert.equal(isUnsupportedMethodError("thread/items/list timed out"), false);
  assert.equal(isUnsupportedMethodError("connection closed"), false);
});

function activeRuntime() {
  const runtime = new MachineRuntime({}, { id: "local", name: "Local", ssh: null }, () => {});
  runtime.rpc = { request: async () => ({}) };
  runtime.canAcceptDirectInput = true;
  Object.assign(runtime.state, {
    connected: true,
    thread: { id: "thread-1" },
    threadStatus: "active",
  });
  runtime.handleNotification({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } } });
  return runtime;
}

test("retryable turn errors preserve Working and input until authoritative completion", async () => {
  const runtime = activeRuntime();
  runtime.handleNotification({ method: "error", params: {
    threadId: "thread-1", turnId: "turn-1", error: { message: "Stream disconnected; retrying" }, willRetry: true,
  } });
  assert.equal(runtime.snapshot().phase, "working");
  assert.equal(runtime.state.connectionError, null);
  assert.equal(runtime.state.turn.error, null);
  assert.equal(runtime.state.turn.status, "inProgress");
  assert.deepEqual(runtime.snapshot().message, { allowed: true, mode: "steer", reason: null });
  runtime.handleNotification({ method: "item/completed", params: {
    threadId: "thread-1", turnId: "turn-1", item: { id: "commentary", type: "agentMessage", text: "Continuing work", phase: "commentary" },
  } });
  assert.equal(runtime.state.liveMessages.at(-1).text, "Continuing work");
  assert.equal((await runtime.sendMessage("Follow up", "queue")).accepted, true);
  runtime.cancelQueuedMessage();
  runtime.handleNotification({ method: "turn/completed", params: {
    threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null },
  } });
  assert.equal(runtime.snapshot().phase, "done");
  assert.equal(runtime.snapshot().message.mode, "start");

  const failed = activeRuntime();
  failed.handleNotification({ method: "turn/completed", params: {
    threadId: "thread-1", turn: { id: "turn-1", status: "failed", error: { message: "Terminal failure" } },
  } });
  failed.handleNotification({ method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: "late" } });
  assert.equal(failed.snapshot().phase, "failed");
  assert.deepEqual(failed.snapshot().message, { allowed: true, mode: "start", reason: null });
  assert.equal(failed.state.turn.error, "Terminal failure");
  failed.rpc = { request: async () => { throw new Error("Still exhausted"); } };
  await assert.rejects(failed.sendMessage("Try again", "start"), /Still exhausted/);
  assert.equal(failed.state.turn.error, "Terminal failure");
  assert.equal(failed.state.turn.status, "failed");
  const calls = [];
  failed.rpc = { request: async method => { calls.push(method); return { turn: { id: "turn-2", status: "inProgress" } }; } };
  assert.equal((await failed.sendMessage("Try again", "start")).accepted, true);
  assert.deepEqual(calls, ["turn/start"]);
  assert.equal(failed.state.turn.status, "inProgress");
  assert.equal(failed.state.connectionError, null);
  failed.handleNotification({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-2", status: "inProgress" } } });
  assert.equal(failed.snapshot().phase, "working");
  assert.equal(failed.state.turn.error, null);
});

test("activity IDs survive final answers, thin completion snapshots, and history hydration", async () => {
  const runtime = activeRuntime();
  const items = [
    { id: "reasoning", type: "reasoning", summary: ["Checking the implementation"] },
    { id: "command", type: "commandExecution", command: "npm test", aggregatedOutput: "Tests passed" },
    { id: "tool", type: "mcpToolCall", server: "local", tool: "inspect" },
  ];
  for (const item of items) runtime.handleNotification({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item } });
  let visible = mergeActivities([], runtime.snapshot().activities);
  const ids = visible.map((activity) => activity.id);
  runtime.handleNotification({ method: "item/completed", params: {
    threadId: "thread-1", turnId: "turn-1", item: { id: "final", type: "agentMessage", text: "All done", phase: "final_answer" },
  } });
  runtime.handleNotification({ method: "turn/completed", params: {
    threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [{ id: "command", type: "commandExecution", status: "completed" }] },
  } });
  visible = mergeActivities(visible, runtime.snapshot().activities);
  visible = mergeActivities(visible, []);
  visible = mergeActivities(visible, [{ ...items[0], kind: "reasoning", status: "running", detail: "", createdAt: 9999999999999 }]);
  assert.deepEqual(visible.map((activity) => activity.id), ids);
  assert.ok(visible.every((activity) => activity.status === "completed"));
  assert.equal(visible[0].detail, "Checking the implementation");
  assert.equal(visible[1].label, "npm test");
  assert.equal(runtime.itemCache.get("command").item.aggregatedOutput, "Tests passed");
  assert.deepEqual(orderTranscriptEntries([
    ...runtime.state.liveMessages.map((value) => ({ type: "message", value })),
    ...visible.map((value) => ({ type: "activity", value })),
  ]).map((entry) => entry.value.id), [...ids, "final"]);

  runtime.handleNotification({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-2", status: "inProgress" } } });
  assert.deepEqual(runtime.snapshot().activities.map((activity) => activity.id), ids);
  runtime.rpc = { request: async (method) => method === "thread/turns/list"
    ? { data: [{ id: "turn-1", status: "completed", items }] }
    : { data: [{ turnId: "turn-1", item: { ...items[1], status: "completed" } }] } };
  const history = await runtime.history(null, 2);
  assert.deepEqual(history.turns[0].activities.map((activity) => activity.id), ids);
  assert.deepEqual(mergeActivities(history.turns[0].activities, visible).map((activity) => activity.id), ids);
});

test("lost message/queue/steer responses reconcile once without repeating an action", async () => {
  const receipts = new MessageSubmissions();
  const runtime = activeRuntime();
  let starts = 0, steers = 0;
  runtime.rpc = { request: async (method) => {
    if (method === "turn/steer") steers++;
    if (method === "turn/start") starts++;
    return { turn: { id: "next-turn", status: "inProgress" } };
  } };
  const queueId = `${receipts.epoch}-queue`;
  await receipts.run(queueId, () => runtime.sendMessage("Exactly once", "queue"));
  const queued = runtime.state.queuedMessage;
  const recover = async (id) => ({ ...runtime.snapshot(), submission: await receipts.recover(id) });
  assert.equal(reconcileSubmission(queueId, await recover(queueId)), "accepted");
  assert.equal(runtime.state.queuedMessage, queued);
  assert.equal((await receipts.run(queueId, () => runtime.sendMessage("Duplicate", "queue"))).accepted, true);
  assert.equal(runtime.state.queuedMessage, queued);
  const steerId = `${receipts.epoch}-steer`;
  await receipts.run(steerId, () => runtime.sendQueuedMessage("steer"));
  assert.equal(reconcileSubmission(steerId, await recover(steerId)), "accepted");
  assert.equal(runtime.state.queuedMessage, null);
  assert.equal(steers, 1);
  runtime.handleNotification({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
  const startId = `${receipts.epoch}-start`;
  await receipts.run(startId, () => runtime.sendMessage("New turn", "start"));
  assert.equal(reconcileSubmission(startId, await recover(startId)), "accepted");
  assert.equal(starts, 1);
  assert.equal((await receipts.recover(startId)).turnId, runtime.state.turn.id);

  const missingId = `${receipts.epoch}-missing`;
  assert.equal(reconcileSubmission(missingId, await recover(missingId)), "rejected");
  await assert.rejects(receipts.run(missingId, () => runtime.sendMessage("Delayed POST", "start")), /did not reach/);
  assert.equal(starts, 1);
  assert.equal(reconcileSubmission(startId, { submission: await new MessageSubmissions().recover(startId) }), "unknown");
  assert.equal(reconcileSubmission(startId, {}), "unknown");
  const requested = { machineId: "local", threadId: "thread-1", turnId: "turn-1", action: "queue", text: "Exactly once", previousMessageIds: ["old-user"] };
  const state = { machineId: "local", thread: { id: "thread-1" }, turn: { id: "next-turn" } };
  assert.equal(reconcileSubmission(queueId, { ...state, queuedMessage: queued }, requested), "accepted");
  const user = { id: "new-user", role: "user", turnId: "next-turn", text: "Exactly once" };
  assert.equal(reconcileSubmission(startId, { ...state, liveMessages: [user] }, { ...requested, action: "start" }), "accepted");
  assert.equal(reconcileSubmission(startId, { ...state, liveMessages: [{ ...user, id: "old-user" }] }, requested), "unknown");
  assert.equal(reconcileSubmission(startId, { ...state, machineId: "another-machine", liveMessages: [user] }, requested), "unknown");
});

test("one recovery waits for an in-flight submission and preserves uncertain failures", async () => {
  const receipts = new MessageSubmissions();
  const id = `${receipts.epoch}-pending`;
  let finish;
  const operation = receipts.run(id, () => new Promise((resolve) => { finish = resolve; }));
  const recovery = receipts.recover(id);
  finish({ accepted: true });
  await operation;
  assert.equal((await recovery).status, "accepted");
  const failedId = `${receipts.epoch}-failed`;
  await assert.rejects(receipts.run(failedId, async () => { throw new Error("App-server connection closed"); }));
  assert.equal((await receipts.recover(failedId)).status, "unknown");
  const rejectedId = `${receipts.epoch}-rejected`;
  await assert.rejects(receipts.run(rejectedId, async () => { throw new Error("Queue is occupied"); }));
  assert.equal((await receipts.recover(rejectedId)).status, "rejected");
});

test("async final_answer questions stay mid-turn through live/history normalization", async () => {
  const runtime = activeRuntime();
  const items = [
    { id: "commentary", type: "agentMessage", phase: "commentary", text: "Working", createdAt: 100 },
    { id: "question", type: "agentMessage", phase: "final_answer", delivery: "async", text: "Scope?\n- Keep\n- Expand", questions: [{ title: "Scope?", options: ["Keep", "Expand"] }], createdAt: 200 },
    { id: "later", type: "commandExecution", command: "npm test", createdAt: 300 },
    { id: "final", type: "agentMessage", phase: "final_answer", text: "Done", createdAt: 400 },
  ];
  for (const item of items) runtime.handleNotification({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item } });
  const question = runtime.state.liveMessages.find((message) => message.id === "question");
  assert.equal(question.delivery, "async");
  assert.deepEqual(question.questions, items[1].questions);
  const order = (messages, activities) => orderTranscriptEntries([
    ...messages.map((value) => ({ type: "message", value })),
    ...activities.map((value) => ({ type: "activity", value })),
  ]).map((entry) => entry.value.id);
  assert.deepEqual(order(runtime.state.liveMessages, runtime.state.activities), ["commentary", "question", "later", "final"]);
  runtime.rpc = { request: async (method) => method === "thread/turns/list"
    ? { data: [{ id: "turn-1", status: "completed", items: [] }] }
    : { data: items.map((item) => ({ turnId: "turn-1", item })) } };
  const history = (await runtime.history(null, 2)).turns[0];
  assert.deepEqual(history.messages.find((message) => message.id === "question").questions, items[1].questions);
  assert.deepEqual(order(history.messages, history.activities), ["commentary", "question", "later", "final"]);
  const bounded = normalizeAsyncQuestions(Array(12).fill({ title: "x".repeat(3000), options: Array(22).fill("y".repeat(600)) }));
  assert.equal(bounded.length, 10);
  assert.equal(bounded[0].title.length, 2000);
  assert.equal(bounded[0].options.length, 20);
  assert.equal(bounded[0].options[0].length, 500);
  assert.deepEqual(normalizeAsyncQuestions([{ title: "Free text", options: null }]), [{ title: "Free text", options: [] }]);
});

test("async answers steer the original active turn, retain failure state, and start after completion", async () => {
  const runtime = activeRuntime();
  const item = { id: "question", type: "agentMessage", phase: "final_answer", delivery: "async", text: "", questions: [{ title: "Scope?", options: ["Keep"] }, { title: "Anything else?", options: null }] };
  runtime.handleNotification({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item } });
  const message = runtime.state.liveMessages[0];
  assert.ok(message);
  const question = { threadId: "thread-1", messageId: "question", index: 0, answer: "Keep" };
  const calls = [];
  let fail = true;
  runtime.rpc = { request: async (method, params) => {
    calls.push({ method, params });
    if (fail) throw new Error("Answer rejected");
    return { turn: { id: "turn-2", status: "inProgress" } };
  } };
  await assert.rejects(runtime.answerAsyncQuestion(question), /Answer rejected/);
  assert.deepEqual(runtime.snapshot().asyncAnswers, {});
  fail = false;
  await runtime.answerAsyncQuestion(question);
  assert.equal(calls.at(-1).method, "turn/steer");
  assert.equal(calls.at(-1).params.input[0].text, asyncAnswerText("Scope?", "Keep"));
  assert.equal(runtime.state.queuedMessage, null);
  assert.equal(resolvedAsyncAnswer(message, 0, [], runtime.snapshot().asyncAnswers), "Keep");
  await assert.rejects(runtime.answerAsyncQuestion(question), /already answered/);
  assert.equal(resolvedAsyncAnswer(message, 0, [{ role: "user", createdAt: message.createdAt + 1, text: asyncAnswerText("Scope?", "Keep") }]), "Keep");
  runtime.handleNotification({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
  await runtime.answerAsyncQuestion({ ...question, index: 1, answer: "Please check mobile" });
  assert.equal(calls.at(-1).method, "turn/start");
  assert.equal(calls.at(-1).params.input[0].text, asyncAnswerText("Anything else?", "Please check mobile"));
});

test("bounded resume leaves context unavailable until replay or a later authoritative update", async () => {
  const usage = { total: { totalTokens: 900000 }, last: { totalTokens: 27000 }, modelContextWindow: 100000 };
  assert.deepEqual(contextSnapshot(usage), { usedTokens: 27000, contextWindow: 100000, usedPercent: 27 });
  assert.equal(contextSnapshot({ ...usage, modelContextWindow: null }), null);
  assert.equal(contextSnapshot({ ...usage, last: { totalTokens: -1 } }), null);
  assert.equal(contextSnapshot({ ...usage, last: { totalTokens: 200000 } }).usedPercent, 100);
  const runtime = activeRuntime();
  const update = (threadId) => runtime.handleNotification({ method: "thread/tokenUsage/updated", params: { threadId, tokenUsage: usage } });
  update("unrelated"); assert.equal(runtime.snapshot().context, null);
  update("thread-1"); assert.equal(runtime.snapshot().context.usedPercent, 27);
  runtime.loadedThreads = [{ id: "thread-2", name: "Other", cwd: "/tmp", status: "idle" }];
  const resumes = [];
  runtime.rpc = { request: async (method, params) => {
    if (method === "thread/resume") {
      resumes.push(params);
      return { thread: { id: "thread-2", status: "idle" } };
    }
    return { data: [] };
  } };
  await runtime.attachLoadedThread("thread-2", false);
  assert.deepEqual(resumes, [{ threadId: "thread-2", excludeTurns: true }]);
  assert.equal(runtime.snapshot().context, null);
  update("thread-1"); assert.equal(runtime.snapshot().context, null);
  update("thread-2");
  assert.deepEqual(runtime.snapshot().context, contextSnapshot(usage));
  runtime.loadedThreads.push({ id: "thread-3", name: "Replay", cwd: "/tmp", status: "idle" });
  runtime.rpc = { request: async (method, params) => {
    if (method === "thread/resume") {
      resumes.push(params);
      assert.deepEqual(runtime.snapshot().context, contextSnapshot(usage));
      update("thread-3");
      return { thread: { id: "thread-3", status: "idle" } };
    }
    return { data: [] };
  } };
  await runtime.attachLoadedThread("thread-3", false);
  assert.deepEqual(resumes, [
    { threadId: "thread-2", excludeTurns: true },
    { threadId: "thread-3", excludeTurns: true },
  ]);
  assert.deepEqual(runtime.snapshot().context, contextSnapshot(usage));
});

const png = { type: "image", url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==" };

test("bounded native image input supports image-only, queue, steer, and automatic next turn", async () => {
  assert.deepEqual(messageInputs("", [png]), [png]);
  assert.equal(messageInputs("Look", [png])[0].text, "Look");
  assert.throws(() => imageInputs(Array(5).fill(png)), /up to 4/);
  assert.throws(() => imageInputs([{ url: "file:///etc/passwd" }]), /PNG/);
  assert.throws(() => imageInputs([{ url: "data:image/png;base64,bm90YW5pbWFnZQ==" }]), /content/);
  assert.throws(() => imageInputs([{ url: "data:image/png;base64," + "A".repeat(5600000) }]), /4 MB/);
  const runtime = activeRuntime();
  const calls = [];
  let fail = true;
  runtime.rpc = { request: async (method, params) => {
    calls.push({ method, params });
    if (fail) throw new Error("Rejected image turn");
    return { turn: { id: "turn-2", status: "inProgress" } };
  } };
  await runtime.sendMessage("", "queue", [png]);
  const queued = runtime.state.queuedMessage;
  assert.deepEqual(queued.images, [png]);
  await assert.rejects(runtime.sendQueuedMessage("steer"), /Rejected/);
  assert.equal(runtime.state.queuedMessage, queued);
  fail = false;
  await runtime.sendQueuedMessage("steer");
  assert.deepEqual(calls.at(-1).params.input, [png]);
  assert.equal(runtime.state.queuedMessage, null);
  await runtime.sendMessage("Describe this", "queue", [png]);
  await runtime.startQueuedMessage("thread-1");
  assert.equal(calls.at(-1).method, "turn/start");
  assert.deepEqual(calls.at(-1).params.input, messageInputs("Describe this", [png]));
});

test("image submission recovery matches exact images and never repeats accepted input", async () => {
  const receipts = new MessageSubmissions();
  const id = `${receipts.epoch}-image`;
  let sends = 0;
  const operation = async () => { sends++; return { accepted: true }; };
  await receipts.run(id, operation);
  assert.equal(reconcileSubmission(id, { submission: await receipts.recover(id) }), "accepted");
  await receipts.run(id, operation);
  assert.equal(sends, 1);
  const requested = { machineId: "local", threadId: "thread-1", turnId: "turn-1", action: "queue", text: "", images: [png] };
  const snapshot = { machineId: "local", thread: { id: "thread-1" }, queuedMessage: { threadId: "thread-1", text: "", images: [png] } };
  assert.equal(reconcileSubmission(id, snapshot, requested), "accepted");
  assert.equal(reconcileSubmission(id, { ...snapshot, queuedMessage: { ...snapshot.queuedMessage, images: [] } }, requested), "unknown");
  assert.equal(reconcileSubmission(id, { ...snapshot, queuedMessage: null, liveMessages: [{ id: "new", turnId: "turn-2", role: "user", text: "Look" }], turn: { id: "turn-2" } }, { ...requested, text: "Look", action: "start" }), "unknown");
});

test("primary messages and coalesced deltas retain content beyond 12k", async () => {
  const runtime = activeRuntime();
  const text = "Beginning\n" + "汉字 and code\n".repeat(1800) + "Final tail";
  const events = [];
  runtime.broadcast = (event, value) => events.push({ event, value });
  runtime.handleNotification({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", id: "long", text } } });
  assert.equal(runtime.snapshot().liveMessages.find(m => m.id === "long").text, text);
  runtime.queueAssistantDelta("stream", "turn-1", text.slice(0, 11990));
  runtime.flushAssistantDelta("stream");
  runtime.queueAssistantDelta("stream", "turn-1", text.slice(11990));
  runtime.flushAssistantDelta("stream");
  assert.equal(runtime.snapshot().liveMessages.find(m => m.id === "stream").text, text);
  assert.equal(events.filter(e => e.event === "assistant_delta").map(e => e.value.delta).join(""), text);
  runtime.rpc = { request: async (method) => method === "thread/turns/list"
    ? { data: [{ id: "turn-1", status: "completed" }] }
    : { data: [{ turnId: "turn-1", item: { id: "history-agent", type: "agentMessage", text } }, { turnId: "turn-1", item: { id: "history-user", type: "userMessage", content: [{ type: "text", text }] } }] } };
  const history = await runtime.history(null, 1);
  assert.deepEqual(history.turns[0].messages.map(m => m.text), [text, text]);
  assert.throws(() => messageInputs(text), /12,000/);
});

test("user image endpoint resolves native live and history items without exposing blobs in messages", async () => {
  const runtime = activeRuntime();
  const item = { type: "userMessage", id: "image-user", content: [png] };
  runtime.handleNotification({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item } });
  assert.equal(runtime.snapshot().liveMessages[0].imageCount, 1);
  assert.equal(runtime.snapshot().liveMessages[0].text, "");
  assert.ok(!JSON.stringify(runtime.snapshot().liveMessages).includes("base64"));
  const result = await runtime.messageImage("thread-1", "image-user", 0);
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.data.toString("base64"), png.url.split(",")[1]);
  await assert.rejects(runtime.messageImage("other-thread", "image-user", 0), /selected task changed/);
  await assert.rejects(runtime.messageImage("thread-1", "image-user", 1), /unavailable/);
  runtime.itemCache.clear();
  runtime.rpc = { request: async (method) => { assert.equal(method, "thread/items/list"); return { data: [{ turnId: "turn-1", item }] }; } };
  assert.deepEqual(await runtime.messageImage("thread-1", "image-user", 0), result);
});

test("empty task creation selects returned ID without fake input; lifecycle and same-name replacement use official APIs", async () => {
  const runtime = activeRuntime();
  const tasks = new Map();
  const calls = [];
  let serial = 0;
  const materialized = new Set();
  runtime.rpc = { request: async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/start") { const thread = { id: `new-${++serial}`, cwd: params.cwd, status: "idle", canAcceptDirectInput: true }; tasks.set(thread.id, thread); return { thread }; }
    if (method === "thread/name/set") { assert(materialized.has(params.threadId)); tasks.get(params.threadId).name = params.name; return {}; }
    if (method === "thread/list") return { data: [...tasks.values()].filter(t => t.archived === true && params.archived === true) }; // Empty live tasks are absent from persisted listing.
    if (method === "thread/loaded/list") return { data: [...tasks.values()].filter(t => !t.archived).map(t => t.id) };
    if (method === "thread/read") { assert.equal(params.includeTurns, false); return { thread: tasks.get(params.threadId) }; }
    if (method === "thread/archive") { tasks.get(params.threadId).archived = true; return {}; }
    if (method === "thread/unarchive") { tasks.get(params.threadId).archived = false; return {}; }
    if (method === "thread/delete") { tasks.delete(params.threadId); return {}; }
    if (method === "turn/start") { materialized.add(params.threadId); return { turn: { id: "first", status: "inProgress" } }; }
    if (method === "thread/resume") {
      assert(materialized.has(params.threadId), "missing source rollout");
      return { thread: tasks.get(params.threadId) };
    }
    if (method === "thread/turns/list") { assert(materialized.has(params.threadId), "missing source rollout"); return { data: [] }; }
    return { data: [] };
  } };
  const create = () => runtime.taskAction({ action: "create", name: "Same name", cwd: "/tmp/pocket-test" });
  const first = await create();
  assert.equal(first.thread.id, "new-1");
  assert.equal(first.message.mode, "start");
  assert.equal(first.thread.name, "Same name");
  assert.ok((await runtime.listLoadedThreads()).some(t => t.id === first.thread.id));
  assert.ok(!calls.some(c => c.method === "turn/start"));
  assert(!calls.some(c => ["thread/resume", "thread/name/set"].includes(c.method)));
  await runtime.sendMessage("Real first message", "start");
  runtime.handleNotification({ method: "turn/completed", params: { threadId: first.thread.id, turn: { id: "first", status: "completed" } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(tasks.get(first.thread.id).name, "Same name");
  await runtime.taskAction({ action: "create", name: "Other task", cwd: "/tmp/other-project" });
  await runtime.sendMessage("Other real first message", "start");
  await runtime.selectThread(first.thread.id);
  assert.equal(runtime.state.thread.id, first.thread.id);
  assert.deepEqual((await runtime.history(null, 20)).turns, []);
  await assert.rejects(runtime.taskAction({ action: "delete", threadId: "new-1" }), /Confirm/);
  await runtime.taskAction({ action: "archive", threadId: "new-1" });
  assert.equal(runtime.state.thread, null);
  assert.equal((await runtime.listArchivedThreads())[0].id, "new-1");
  await runtime.taskAction({ action: "unarchive", threadId: "new-1", archived: true });
  await runtime.selectThread("new-1");
  assert.deepEqual((await runtime.history(null, 20)).turns, []);
  await runtime.taskAction({ action: "delete", threadId: "new-1", confirmed: true });
  assert.equal(runtime.state.thread, null);
  const next = await create();
  assert.equal(next.thread.name, "Same name");
  assert.notEqual(first.thread.id, next.thread.id);
});

test("ownership conflict stays friendly and a normal subsequent attachment can succeed", async () => {
  const runtime = activeRuntime();
  const thread = { id: "owned", name: "Owned task", cwd: "/tmp", status: "idle", canAcceptDirectInput: true };
  let conflict = true;
  runtime.rpc = { request: async (method, params) => {
    if (method === "thread/list") return { data: [thread] };
    if (method === "thread/resume") {
      assert.deepEqual(params, { threadId: "owned", excludeTurns: true });
      if (conflict) throw new Error("thread owned already has an active writer (error -32600)");
      return { thread };
    }
    return { data: [] };
  } };
  await assert.rejects(runtime.selectThread("owned"), /Close it there, then retry/);
  assert.equal(runtime.state.thread.id, "thread-1");
  assert.equal(runtime.state.connectionError, null);
  conflict = false;
  assert.equal((await runtime.selectThread("owned")).thread.id, "owned");
});

test("selection hold survives transient collapse and flushes once after 500ms clear", () => {
  let pending = null, flushes = 0, id = 0;
  const hold = createSelectionHold(() => flushes++, {
    setTimeout(callback, delay) { assert.equal(delay, 500); pending = callback; return ++id; },
    clearTimeout() { pending = null; },
  });
  hold.observe(true);
  hold.observe(false);
  const first = pending;
  hold.observe(false);
  assert.equal(pending, first);
  hold.observe(true);
  assert.equal(pending, null);
  assert.equal(hold.active, true);
  hold.observe(false);
  pending(); pending = null;
  assert.equal(hold.active, false);
  assert.equal(flushes, 1);
  hold.observe(false);
  assert.equal(pending, null);
  hold.observe(true); hold.observe(false); hold.reset();
  assert.equal(hold.active, false);
  assert.equal(pending, null);
  assert.equal(flushes, 1);
});

test("headless gateway exposes only SSH runtimes and selects the first", () => {
  const options = { host: "127.0.0.1", port: 4173, localName: "Local", machines: [{ name: "Remote", ssh: "remote" }] };
  const gateway = new PocketGateway(options, true);
  assert.deepEqual(gateway.listMachines().map(machine => machine.id), ["ssh:remote"]);
  assert.equal(gateway.state.machineId, "ssh:remote");
  assert.deepEqual(new PocketGateway(options, false).listMachines().map(machine => machine.id), ["local", "ssh:remote"]);
  assert.throws(() => new PocketGateway({ ...options, machines: [] }, true), /at least one configured SSH/);
});

test("SSH auto-attach writer conflict preserves connection and saved-task catalog", async (t) => {
  const thread = { id: "owned", name: "Owned task", cwd: "/project", status: { type: "active" } };
  t.mock.method(RpcClient.prototype, "connect", async () => {});
  t.mock.method(RpcClient.prototype, "notify", () => {});
  t.mock.method(RpcClient.prototype, "close", () => {});
  t.mock.method(RpcClient.prototype, "request", async (method) => {
    if (method === "thread/list") return { data: [thread] };
    if (method === "thread/loaded/list") return { data: [thread.id] };
    if (method === "thread/resume") throw new Error("thread already has an active writer (-32600)");
    return { data: [] };
  });
  const runtime = new MachineRuntime({ machines: [] }, { id: "ssh:remote", name: "Remote", ssh: "remote" }, () => {});
  try {
    await runtime.start();
    assert.equal(runtime.state.connected, true);
    assert.equal(runtime.state.thread, null);
    assert.notEqual(runtime.state.phase, "unavailable");
    assert.deepEqual((await runtime.listLoadedThreads()).map(task => task.id), ["owned"]);
  } finally { await runtime.stop(); }
});

function notify(runtime, method, params) {
  runtime.handleNotification({ method, params: { threadId: "thread-1", turnId: "turn-1", ...params } });
}

test("terminal turns flush deltas and reconcile incomplete messages once from authoritative items", async () => {
  for (const status of ["completed", "interrupted", "failed"]) {
    const runtime = activeRuntime();
    const events = [];
    runtime.broadcast = (event, value) => events.push({ event, value });
    let finish;
    const calls = [];
    runtime.rpc = { request: (method, params) => {
      calls.push({ method, params });
      return new Promise(resolve => { finish = resolve; });
    } };
    notify(runtime, "item/agentMessage/delta", { itemId: "partial", delta: "Visible partial" });
    notify(runtime, "turn/completed", { turn: { id: "turn-1", status } });
    assert.equal(runtime.assistantFlushes.size, 0);
    assert.ok(events.some(event => event.event === "assistant_delta"));
    assert.deepEqual(calls, [{ method: "thread/items/list", params: {
      threadId: "thread-1", turnId: "turn-1", cursor: null, limit: 100, sortDirection: "desc",
    } }]);
    notify(runtime, "turn/completed", { turn: { id: "turn-1", status } });
    assert.equal(calls.length, 1);
    notify(runtime, "item/agentMessage/delta", { itemId: "partial", delta: " last buffered text" });
    finish({ data: [{ turnId: "turn-1", item: { id: "partial", type: "agentMessage", text: "Authoritative final text" } }], nextCursor: "not-followed" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 1);
    assert.equal(runtime.assistantFlushes.size, 0);
    assert.equal(runtime.state.liveMessages[0].text, "Authoritative final text");
    assert.equal(runtime.state.liveMessages[0].complete, true);
    assert.ok(events.some(event => event.event === "message" && event.value.complete));
  }
});

test("terminal snapshots with a completed message need no item lookup", () => {
  const runtime = activeRuntime();
  runtime.rpc = { request: () => { assert.fail("No remote lookup needed"); } };
  notify(runtime, "item/agentMessage/delta", { itemId: "final", delta: "Partial" });
  notify(runtime, "turn/completed", { turn: { id: "turn-1", status: "completed", items: [
    { id: "final", type: "agentMessage", text: "Complete final" },
  ] } });
  assert.equal(runtime.assistantFlushes.size, 0);
  assert.equal(runtime.state.liveMessages[0].text, "Complete final");
  assert.equal(runtime.state.liveMessages[0].complete, true);
});

test("terminal reconciliation preserves final events and cannot leak across task resets", async () => {
  for (const reset of [false, true]) {
    const runtime = activeRuntime();
    let finish;
    runtime.rpc = { request: () => new Promise(resolve => { finish = resolve; }) };
    notify(runtime, "item/agentMessage/delta", { itemId: "partial", delta: "Partial" });
    notify(runtime, "turn/completed", { turn: { id: "turn-1", status: "interrupted" } });
    if (reset) runtime.resetThreadState();
    else notify(runtime, "item/completed", { item: { id: "partial", type: "agentMessage", text: "Newer final" } });
    finish({ data: [{ item: { id: "partial", type: "agentMessage", text: "Stale final" } }] });
    await new Promise(resolve => setImmediate(resolve));
    if (reset) assert.equal(runtime.state.liveMessages.length, 0);
    else assert.equal(runtime.state.liveMessages[0].text, "Newer final");
  }
  const runtime = activeRuntime();
  let calls = 0;
  runtime.rpc = { request: async () => { calls++; throw new Error("Offline"); } };
  notify(runtime, "item/agentMessage/delta", { itemId: "partial", delta: "Keep this text" });
  notify(runtime, "turn/completed", { turn: { id: "turn-1", status: "failed" } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(runtime.state.liveMessages[0].text, "Keep this text");
  assert.equal(runtime.state.liveMessages[0].complete, true);
});

test("async answers use trusted live or cached questions without remote lookup", async () => {
  for (const source of ["live", "cache", "remote"]) {
    const runtime = activeRuntime();
    const item = { id: "question", type: "agentMessage", delivery: "async", text: "Choose", questions: [{ title: "Scope?", options: ["Keep", "Expand"] }] };
    notify(runtime, "item/completed", { item });
    if (source !== "cache") runtime.itemCache.clear();
    if (source !== "live") runtime.state.liveMessages = [];
    const calls = [];
    runtime.rpc = { request: async (method, params) => {
      calls.push({ method, params });
      if (method === "thread/items/list") return { data: [{ turnId: "turn-1", item }] };
      return { turnId: "turn-1" };
    } };
    const question = { threadId: "thread-1", messageId: "question", index: 0, answer: "Keep" };
    await assert.rejects(runtime.answerAsyncQuestion({ ...question, threadId: "other" }), /changed/);
    assert.equal(calls.length, 0);
    if (source !== "remote") {
      await assert.rejects(runtime.answerAsyncQuestion({ ...question, index: 9 }), /unavailable/);
      await assert.rejects(runtime.answerAsyncQuestion({ ...question, answer: " " }), /Enter an answer/);
      runtime.state.turn.id = "another-turn";
      await assert.rejects(runtime.answerAsyncQuestion(question), /Another turn/);
      runtime.state.turn.id = "turn-1";
      assert.equal(calls.length, 0);
    }
    await runtime.answerAsyncQuestion(question);
    assert.deepEqual(calls.map(call => call.method), source === "remote" ? ["thread/items/list", "turn/steer"] : ["turn/steer"]);
    assert.equal(calls.at(-1).params.input[0].text, asyncAnswerText("Scope?", "Keep"));
    await assert.rejects(runtime.answerAsyncQuestion(question), /already answered/);
  }
});

test("GPT-6 async reply envelopes show only human answers in live messages and history", async () => {
  const runtime = activeRuntime();
  const wrap = payload => `<send_user_message_question_reply>\n${payload}\n</send_user_message_question_reply>`;
  const payload = JSON.stringify([
    { questionItemId: "internal-id", question: "Which?", answer: "Use the first option." },
    { questionItemId: "another-id", answer: "Then continue." },
  ]);
  const cases = [
    [wrap(payload), "Use the first option.\n\nThen continue."],
    [wrap(JSON.stringify([{ answer: "Yes" }])), "Yes"],
    [wrap("broken JSON"), "Question answered."],
    [wrap('{"answer":"wrong shape"}'), "Question answered."],
    [wrap('[{"answer":42}]'), "Question answered."],
    ["Ordinary <tags> and JSON {}", "Ordinary <tags> and JSON {}"],
    [`Example: ${wrap(payload)}`, `Example: ${wrap(payload)}`],
  ];
  const items = cases.map(([text], index) => ({ type: "userMessage", id: `reply-${index}`, content: [{ type: "text", text }] }));
  items.push({ type: "agentMessage", id: "assistant-example", text: wrap(payload) });
  for (const item of items) runtime.handleNotification({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item } });
  const expected = [...cases.map(([, visible]) => visible), wrap(payload)];
  assert.deepEqual(runtime.snapshot().liveMessages.map(message => message.text), expected);
  runtime.rpc = { request: async method => method === "thread/turns/list"
    ? { data: [{ id: "turn-1", status: "completed" }] }
    : { data: items.map(item => ({ turnId: "turn-1", item })) } };
  const history = await runtime.history(null, 1);
  assert.deepEqual(history.turns[0].messages.map(message => message.text), expected);
});

test("same-machine rejected selection preserves authoritative task, subscription, and live state", async () => {
  const runtime = activeRuntime();
  const gateway = new PocketGateway({ machines: [] });
  gateway.runtimes.set("local", runtime);
  const owned = { id: "owned", name: "Owned", status: "idle", cwd: "/tmp" };
  runtime.state.queuedMessage = { threadId: "thread-1", text: "Keep queued", images: [] };
  runtime.pendingServerRequests.set("approval", { method: "test" });
  runtime.itemCache.set("cached", { item: { id: "cached" } });
  runtime.asyncAnswers = { question: "Keep answer" };
  const before = structuredClone(runtime.state);
  const calls = [], events = [];
  let reject = true;
  runtime.broadcast = (type, value) => events.push({ type, value: structuredClone(value) });
  runtime.rpc = { request: async (method) => {
    calls.push(method);
    if (method === "thread/list") return { data: [owned] };
    if (method === "thread/resume") {
      assert.equal(runtime.state.thread.id, "thread-1");
      assert.equal(calls.includes("thread/unsubscribe"), false);
      if (reject) {
        runtime.handleNotification({ method: "item/completed", params: { threadId: "owned", item: { id: "target-only", type: "agentMessage", text: "Must not leak" } } });
        assert.deepEqual(runtime.state, before);
        throw new Error("already has an active writer");
      }
      return { thread: owned };
    }
    return { data: [] };
  } };
  await assert.rejects(gateway.selectDestination("local", "owned", "local", "thread-1"), /another Codex runtime/);
  assert.deepEqual(runtime.state, before);
  assert.equal(gateway.snapshot().thread.id, "thread-1");
  assert.equal(calls.includes("thread/unsubscribe"), false);
  assert.deepEqual(events, []);
  assert(runtime.pendingServerRequests.has("approval"));
  assert(runtime.itemCache.has("cached"));
  assert.deepEqual(runtime.asyncAnswers, { question: "Keep answer" });
  runtime.handleNotification({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "still-live", type: "agentMessage", text: "Still receiving" } } });
  assert.equal(runtime.state.liveMessages.at(-1).text, "Still receiving");
  reject = false;
  const accepted = await gateway.selectDestination("local", "owned", "local", "thread-1");
  assert.equal(accepted.thread.id, "owned");
  assert(calls.lastIndexOf("thread/unsubscribe") > calls.lastIndexOf("thread/resume"));
  assert.deepEqual(events.filter(e => e.type === "snapshot").map(e => e.value.thread?.id), ["owned"]);
});

test("browser mutations enforce origin and JSON while preserving authenticated and loopback shutdown", async () => {
  const { createServer, request } = await import("node:http");
  const { handleRequest } = await import("../gateway.ts");
  const gateway = new PocketGateway({ machines: [] });
  const auth = { required: false, pin: null, sessionId: "session", attempts: new Map() };
  let quits = 0;
  const options = { host: "127.0.0.1" };
  const server = createServer((req, res) => {
    handleRequest(req, res, gateway, auth, {}, options, async () => ({ localUrl: "/" }), () => quits++, () => false)
      .catch(() => { res.writeHead(500); res.end(); });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const raw = (path, headers = {}, method = "GET", body) => new Promise((resolve, reject) => {
    const req = request(origin + path, { method, headers }, res => {
      let text = ""; res.on("data", chunk => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, json: async () => JSON.parse(text) }));
    });
    req.on("error", reject); req.end(body);
  });
  const post = (path, headers = {}, body) => raw(path, headers, "POST", body);
  try {
    assert.equal((await post("/api/machines/wake", { Origin: "https://attacker.example", "Content-Type": "application/json" }, '{"machineId":"local"}')).status, 403);
    assert.equal((await post("/api/machines/wake", { Origin: origin }, '{}')).status, 415);
    const wake = await post("/api/machines/wake", { Origin: origin, "Content-Type": "application/json" }, '{"machineId":"local","wakeMac":"AA:BB:CC:DD:EE:FF","address":"127.0.0.1","port":1234}');
    assert.equal(wake.status, 400);
    assert.match((await wake.json()).error, /not configured/);
    assert.equal((await post("/api/login", { Origin: origin, "Content-Type": "application/json; charset=utf-8", "Sec-Fetch-Site": "same-origin" }, "{}")).status, 200);
    assert.equal((await post("/api/login", { Origin: origin.replace("http:","https:"), "Content-Type": "application/json" }, "{}")).status, 200);
    assert.equal((await post("/api/shutdown", { Origin: "https://attacker.example" })).status, 403);
    assert.equal((await post("/api/shutdown", { "Sec-Fetch-Site": "cross-site" })).status, 403);
    assert.equal((await post("/api/shutdown", { Origin: "null" })).status, 403);
    assert.equal((await post("/api/login", { Origin: origin, "Content-Type": "text/plain" }, "{}")).status, 415);
    assert.equal((await post("/api/login", { Origin: origin })).status, 415);
    const runtime = gateway.runtimes.get("local");
    runtime.state.thread = { id: "queued-task" };
    runtime.state.queuedMessage = { id: "queue-test", threadId: "queued-task", text: "Keep until cancelled" };
    const cancel = headers => fetch(origin + "/api/message/queue?machineId=local&threadId=queued-task&queueId=queue-test", { method: "DELETE", headers });
    assert.equal((await cancel({ Origin: "https://attacker.example" })).status, 403);
    assert.equal((await cancel({ "Sec-Fetch-Site": "cross-site" })).status, 403);
    assert.equal(runtime.state.queuedMessage.text, "Keep until cancelled");
    assert.equal((await post("/api/message/queue", { Origin: origin })).status, 415);
    const cancelled = await cancel({ Origin: origin, "Sec-Fetch-Site": "same-origin" });
    assert.equal(cancelled.status, 200);
    assert.deepEqual(await cancelled.json(), { cancelled: true, queuedMessage: null });
    assert.equal(runtime.state.queuedMessage, null);
    const evilHost = `evil.example:${server.address().port}`;
    assert.equal((await post("/api/shutdown", { Host: evilHost, Origin: `http://${evilHost}`, "Sec-Fetch-Site": "same-origin" })).status, 403);
    assert.equal((await raw("/api/auth", { Host: evilHost })).status, 403);
    assert.equal((await raw("/", { Host: evilHost })).status, 403);
    assert.equal((await raw("/api/auth", { Host: `localhost:${server.address().port}` })).status, 200);
    assert.equal(quits, 0);
    assert.equal((await post("/api/shutdown", { Origin: origin })).status, 202);
    assert.equal((await post("/api/shutdown")).status, 202);
    auth.required = true;
    assert.equal((await post("/api/shutdown", { Origin: origin })).status, 401);
    assert.equal((await post("/api/shutdown", { Origin: origin, Cookie: "codex_pocket_session=session" })).status, 202);
    assert.equal(quits, 3);
    options.host = "0.0.0.0";
    for (const address of ["100.64.0.0", "100.127.255.255", "100.63.255.255", "100.128.0.0"]) {
      const host = `${address}:8080`;
      const allowed = address === "100.64.0.0" || address === "100.127.255.255";
      options.host = "127.0.0.1";
      assert.equal((await raw("/api/auth", { Host: host })).status, 403);
      options.host = "0.0.0.0";
      assert.equal((await raw("/api/auth", { Host: host })).status, allowed ? 200 : 403);
      if (allowed) {
        assert.equal((await post("/api/message/queue", { Host: host, Origin: `http://${host}`, "Content-Type": "application/json" }, "{}")).status, 401);
        assert.equal((await post("/api/message/queue", { Host: host, Origin: "http://evil.example", "Content-Type": "application/json", Cookie: "codex_pocket_session=session" }, "{}")).status, 403);
      }
    }
    const publishedHost = "192.168.1.100:8080";
    assert.equal((await post("/api/shutdown", { Host: publishedHost, Origin: `http://${publishedHost}`, Cookie: "codex_pocket_session=session" })).status, 202);
    assert.equal((await post("/api/shutdown", { Host: evilHost, Origin: `http://${evilHost}`, Cookie: "codex_pocket_session=session" })).status, 403);
    assert.equal(quits, 4);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test("headless settings preserve deployment network and reject empty machines; macOS remains editable", async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { saveLocalSettings } = await import("../gateway.ts");
  const dir = mkdtempSync(join(tmpdir(), "pocket-settings-"));
  const settings = { path: join(dir, "config.json"), loaded: true, config: {
    lanEnabled: true, host: "0.0.0.0", port: 4173, pin: "1234", localName: "", machines: [{ name: "Remote", ssh: "remote" }],
  } };
  const changes = { lanEnabled: false, host: "127.0.0.1", port: 5000, pin: "5678", machines: [{ name: "Renamed", ssh: "new-alias" }] };
  try {
    const saved = saveLocalSettings(settings, changes, null, true);
    assert.deepEqual([saved.lanEnabled, saved.host, saved.port], [true, "0.0.0.0", 4173]);
    assert.equal(saved.pin, "5678");
    assert.deepEqual(saved.machines, changes.machines);
    const disk = readFileSync(settings.path, "utf8");
    assert.throws(() => saveLocalSettings(settings, { ...changes, machines: [] }, null, true), /at least one SSH machine/);
    assert.equal(readFileSync(settings.path, "utf8"), disk);
    const native = saveLocalSettings(settings, { ...changes, machines: [] }, null, false);
    assert.deepEqual([native.lanEnabled, native.host, native.port, native.machines], [false, "127.0.0.1", 5000, []]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("assistant local images require thread-local protocol provenance, including hydrated history", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "pocket-images-"));
  const path = join(dir, "trusted.png"), arbitrary = join(dir, "arbitrary.png");
  const bytes = Buffer.from(png.url.split(",")[1], "base64");
  writeFileSync(path, bytes); writeFileSync(arbitrary, bytes);
  const runtime = activeRuntime();
  const emit = item => runtime.handleNotification({ method: "item/completed", params: { threadId: runtime.state.thread.id, turnId: "turn-1", item } });
  const markdown = (id, path) => ({ id, type: "agentMessage", text: `![](${path})` });
  try {
    emit(markdown("arbitrary", arbitrary));
    await assert.rejects(runtime.messageImage("thread-1", "arbitrary", 0), /Image unavailable/);
    emit({ id: "view", type: "imageView", path });
    emit(markdown("trusted", path));
    assert.deepEqual((await runtime.messageImage("thread-1", "trusted", 0)).data, bytes);
    assert.deepEqual((await runtime.activityImage("thread-1", "view")).data, bytes);
    runtime.resetThreadState(); runtime.state.thread = { id: "thread-2" };
    emit(markdown("new-thread", path));
    await assert.rejects(runtime.messageImage("thread-2", "new-thread", 0), /Image unavailable/);
    const items = [{ id: "history-view", type: "imageGeneration", savedPath: path }, markdown("history-text", path)];
    runtime.rpc = { request: async method => method === "thread/turns/list" ? { data: [{ id: "turn-2", status: "completed", items }] } : { data: items.map(item => ({ turnId: "turn-2", item })) } };
    await runtime.history(null, 1);
    assert.deepEqual((await runtime.messageImage("thread-2", "history-text", 0)).data, bytes);
    runtime.resetThreadState();runtime.state.thread={id:"thread-3"};
    emit({ id:"local",type:"userMessage",content:[{type:"localImage",path}] });
    assert.deepEqual((await runtime.messageImage("thread-3","local",0)).data,bytes);
    let release;
    runtime.rpc = { request: () => new Promise(resolve => { release = resolve; }) };
    const history = runtime.history(null, 1);
    runtime.resetThreadState(); runtime.state.thread = { id: "thread-4" };
    release({ data: [{ id: "old-turn", items: [{ id: "stale-view", type: "imageView", path }] }] });
    await assert.rejects(history, /selected task changed/);
    emit(markdown("stale-path", path));
    await assert.rejects(runtime.messageImage("thread-4", "stale-path", 0), /Image unavailable/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fresh history resolves async answers from exact question IDs without exposing wrapper text", async () => {
  const runtime = activeRuntime();
  const question = { id: "question-id", type: "agentMessage", delivery: "async", text: "Choose", questions: [{ title: "First?", options: [] }, { title: "Second?", options: [] }], createdAt: 100 };
  const reply = { id: "reply-id", type: "userMessage", createdAt: 200, content: [{ type: "text", text: `<send_user_message_question_reply>${JSON.stringify([
    { questionItemId: "question-id", question: "Second?", answer: "Two" },
    { questionItemId: "question-id", question: "First?", answer: "One" },
  ])}</send_user_message_question_reply>` }] };
  runtime.rpc = { request: async method => method === "thread/turns/list" ? { data: [{ id: "turn-1", status: "completed" }] } : { data: [question, reply].map(item => ({ turnId: "turn-1", item })) } };
  const messages = (await runtime.history(null, 1)).turns[0].messages;
  assert.deepEqual(runtime.snapshot().asyncAnswers, {});
  const normalizedQuestion = messages.find(m => m.id === question.id);
  const normalizedReply = messages.find(m => m.id === reply.id);
  assert.equal(normalizedReply.text, "Two\n\nOne");
  assert.equal(resolvedAsyncAnswer(normalizedQuestion, 0, messages, {}), "One");
  assert.equal(resolvedAsyncAnswer(normalizedQuestion, 1, messages, {}), "Two");
  assert.equal(resolvedAsyncAnswer({ ...normalizedQuestion, id: "different-question" }, 0, messages, {}), null);
  assert.equal(resolvedAsyncAnswer(normalizedQuestion, 0, messages, { "question-id": { 0: "Fast path" } }), "Fast path");
});

test("cross-machine selection releases only the previous task after target acceptance", async () => {
  const gateway = new PocketGateway({ machines: [{ name: "B", ssh: "b" }] });
  const a = gateway.runtimes.get("local"), b = gateway.runtimes.get("ssh:b");
  const calls = [];
  let rejectB = true, rejectA = false;
  for (const [label, runtime] of [["A", a], ["B", b]]) {
    Object.assign(runtime.state, { connected: true, thread: label === "A" ? { id: "a" } : null, threadStatus: "idle" });
    runtime.rpc = { request: async (method, params) => {
      calls.push(`${label}:${method}:${params?.threadId || ""}`);
      if (method === "thread/list") return { data: [{ id: label.toLowerCase(), name: label, cwd: "/tmp", status: "idle" }] };
      if (method === "thread/resume") {
        if ((label === "B" && rejectB) || (label === "A" && rejectA)) throw new Error("already has an active writer");
        return { thread: { id: label.toLowerCase(), name: label, cwd: "/tmp", status: "idle" } };
      }
      return { data: [] };
    } };
  }
  a.state.queuedMessage = { threadId: "a", text: "Must not send in background" };
  a.pendingServerRequests.set("approval", {});
  a.itemCache.set("item", {});
  const before = structuredClone(a.state);
  await assert.rejects(gateway.selectDestination("ssh:b", "b", "local", "a"), /another Codex runtime/);
  assert.deepEqual(a.state, before);
  assert(!calls.includes("A:thread/unsubscribe:a"));
  rejectB = false;
  calls.length = 0;
  await gateway.selectDestination("ssh:b", "b", "local", "a");
  assert(calls.indexOf("A:thread/unsubscribe:a") > calls.indexOf("B:thread/resume:b"));
  assert.equal(a.state.connected, true);
  assert.equal(a.state.thread, null);
  assert.equal(a.state.queuedMessage, null);
  assert.equal(a.pendingServerRequests.size, 0);
  assert.equal(a.itemCache.size, 0);
  assert.equal((await a.listLoadedThreads())[0].id, "a");
  rejectA = true;
  const previousB = structuredClone(b.state);
  await assert.rejects(gateway.selectDestination("local", "a", "ssh:b", "b"), /another Codex runtime/);
  assert.deepEqual(b.state, previousB);
  assert(!calls.includes("B:thread/unsubscribe:b"));
  rejectA = false;
  await gateway.selectDestination("local", "a", "ssh:b", "b");
  assert.equal(gateway.state.thread.id, "a");
  assert.equal(b.state.thread, null);
  assert.equal(b.state.connected, true);
});

test("startup and background reconnect attach only the selected runtime while catalogs stay live", async (t) => {
  const resumes = [];
  t.mock.method(RpcClient.prototype, "connect", async function (_ws, alias) { this.testMachine = alias || "local"; });
  t.mock.method(RpcClient.prototype, "notify", () => {});
  t.mock.method(RpcClient.prototype, "close", () => {});
  t.mock.method(RpcClient.prototype, "request", async function (method) {
    const thread = { id: this.testMachine, name: this.testMachine, cwd: "/tmp", status: "idle" };
    if (method === "thread/list") return { data: [thread] };
    if (method === "thread/loaded/list") return { data: [thread.id] };
    if (method === "thread/read") return { thread };
    if (method === "thread/resume") { resumes.push(thread.id); return { thread }; }
    return { data: [] };
  });
  const gateway = new PocketGateway({ machines: [{ name: "B", ssh: "b" }] });
  try {
    await gateway.start();
    assert.deepEqual(resumes, ["local"]);
    const b = gateway.runtimes.get("ssh:b");
    assert.equal(b.state.connected, true);
    assert.equal(b.state.thread, null);
    assert.deepEqual((await b.listLoadedThreads()).map(t => t.id), ["b"]);
    await b.connect();
    assert.deepEqual(resumes, ["local"]);
    await gateway.selectDestination("ssh:b", "b", "local", "local");
    const a = gateway.runtimes.get("local");
    assert.equal(a.autoAttach, false);
    await a.connect();
    assert.deepEqual(resumes, ["local", "b"]);
    const catalog = await gateway.navigationCatalog();
    assert(catalog.machines.every(m => m.connected && m.catalogAvailable && m.tasks.length));
    let quotaRefreshes = 0;
    a.scheduleQuotaRefresh = () => quotaRefreshes++;
    a.handleNotification({ method: "account/rateLimits/updated", params: {} });
    assert.equal(quotaRefreshes, 1);
  } finally { await gateway.stop(); }
});

test("release preserves a waiting queue and clears attached state after existing operations settle", async () => {
  const runtime = activeRuntime();
  runtime.state.queuedMessage = { threadId: "thread-1", text: "Cancel on leave" };
  let finish;
  runtime.selectionQueue = new Promise(resolve => { finish = resolve; }).then(() => {
    runtime.state.liveMessages = [{ id: "late", role: "assistant", text: "Late operation result" }];
  });
  const released = runtime.releaseTask();
  assert.equal(runtime.state.queuedMessage.text, "Cancel on leave");
  finish();
  await released;
  assert.equal(runtime.state.thread, null);
  assert.equal(runtime.taskQueues.get("thread-1").text, "Cancel on leave");
  assert.deepEqual(runtime.state.liveMessages, []);
  assert.equal(runtime.state.connected, true);
});

test("reconnect delay progresses, caps, resets on catalog-only success, and cancels on stop", async (t) => {
  const timers = [];
  t.mock.method(globalThis, "setTimeout", (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; });
  t.mock.method(globalThis, "clearTimeout", timer => { if (timer) timer.cancelled = true; });
  let succeed = false, resumes = 0;
  t.mock.method(RpcClient.prototype, "connect", async () => { if (!succeed) throw new Error("Offline fixture"); });
  t.mock.method(RpcClient.prototype, "close", () => {});
  t.mock.method(RpcClient.prototype, "notify", () => {});
  t.mock.method(RpcClient.prototype, "request", async method => {
    if (method === "thread/list") return { data: [{ id: "available", name: "Available", status: "idle" }] };
    if (method === "thread/resume") resumes++;
    return { data: [] };
  });
  const runtime = new MachineRuntime({}, { id: "ssh:test", name: "Test", ssh: "test" }, () => {});
  await runtime.start(false);
  for (const expected of [5000, 10000, 20000, 30000, 60000, 60000]) {
    const timer = timers.at(-1);
    assert.equal(timer.delay, expected);
    timer.fn();
    await new Promise(setImmediate);
  }
  succeed = true;
  timers.at(-1).fn();await new Promise(setImmediate);
  assert(runtime.state.connected);
  assert.equal(runtime.state.thread, null);
  assert.equal(resumes, 0);
  assert.equal(runtime.autoAttach, false);
  runtime.handleClose(new Error("Later disconnect"));
  assert.equal(timers.at(-1).delay, 5000);
  const pending = timers.at(-1);
  await runtime.stop();
  assert(pending.cancelled);
});

test("proxy handshake is bounded and timeout enters normal reconnect; success and abort clear timer", async (t) => {
  const childProcess = (await import("node:child_process")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const { createHash } = await import("node:crypto");
  const children = [], timers = [];
  const spawnMock = t.mock.method(childProcess, "spawn", () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; };
    children.push(child); return child;
  });
  syncBuiltinESMExports();
  t.after(() => { spawnMock.mock.restore(); syncBuiltinESMExports(); });
  t.mock.method(globalThis, "setTimeout", (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; });
  t.mock.method(globalThis, "clearTimeout", timer => { if (timer) timer.cancelled = true; });
  const runtime = new MachineRuntime({}, { id: "local", name: "Test", ssh: null }, () => {});
  const starting = runtime.start(false);
  children.at(-1).emit("spawn");
  const timeout = timers.at(-1);
  assert.equal(timeout.delay, 15000);
  timeout.fn();await starting;
  assert(children[0].killed);
  assert.equal(runtime.state.connected, false);
  assert.equal(timers.at(-1).delay, 5000);
  assert.match(runtime.state.connectionError, /handshake timed out/);
  await runtime.stop();
  const client = new RpcClient();
  const connecting = client.connect();
  const child = children.at(-1), successTimer = timers.at(-1);
  child.emit("spawn");
  const request = child.stdin.read().toString();
  const key = /Sec-WebSocket-Key: (.+)\r/.exec(request)[1];
  const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  child.stdout.write(`HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  await connecting;assert(successTimer.cancelled);client.close();
  const aborted = new RpcClient();const pending = aborted.connect();const abortTimer = timers.at(-1);
  aborted.close();await assert.rejects(pending, /aborted/);assert(abortTimer.cancelled);
  for (const event of ["error", "exit"]) {
    const failed = new RpcClient();const attempt = failed.connect();const timer = timers.at(-1);
    if (event === "error") children.at(-1).emit("error", new Error("spawn failed"));
    else children.at(-1).emit("exit", 1, null);
    await assert.rejects(attempt);assert(timer.cancelled);failed.close();
  }
  let socket;
  t.mock.method(globalThis, "WebSocket", function () {
    socket = new EventTarget();socket.close = () => { socket.closed = true; };return socket;
  });
  const direct = new RpcClient();const stalled = direct.connect("ws://127.0.0.1:1234");
  assert.equal(timers.at(-1).delay, 15000);timers.at(-1).fn();
  await assert.rejects(stalled, /handshake timed out/);assert(socket.closed);direct.close();
  const established = new RpcClient();const opening = established.connect("ws://127.0.0.1:1234");const directTimer = timers.at(-1);
  socket.dispatchEvent(new Event("open"));await opening;assert(directTimer.cancelled);established.close();
});

test("remote proxy closes exactly once and configures bounded SSH keepalives", async (t) => {
  const childProcess = (await import("node:child_process")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const { createHash } = await import("node:crypto");
  const children = [];
  const spawnMock = t.mock.method(childProcess, "spawn", (command, args) => {
    const child = new EventEmitter();
    child.command = command; child.args = args;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => true;
    children.push(child); return child;
  });
  syncBuiltinESMExports();
  t.after(() => { spawnMock.mock.restore(); syncBuiltinESMExports(); });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.mock.method(RpcClient.prototype, "request", async method => method === "account/rateLimits/read"
    ? { rateLimits: { primary: { usedPercent: 0, windowDurationMins: 300 } } } : { data: [] });

  for (const cause of ["close-frame", "error", "exit", "keepalive", "intentional-close"]) {
    const runtime = new MachineRuntime({}, { id: "ssh:test", name: "Test", ssh: "test" }, () => {});
    const closeSpy = t.mock.method(runtime, "handleClose");
    const starting = runtime.start(false);
    const child = children.at(-1);
    assert.equal(child.command, process.env.SSH_BIN || "ssh");
    assert.deepEqual(child.args, ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5",
      "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "test", "codex", "app-server", "proxy"]);
    child.emit("spawn");
    const key = /Sec-WebSocket-Key: (.+)\r/.exec(child.stdin.read().toString())[1];
    const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    child.stdout.write(`HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    await starting;
    assert.equal(runtime.state.connected, true);
    const client = runtime.rpc;
    if (cause === "close-frame") child.stdout.write(Buffer.from([0x88, 0]));
    else if (cause === "error") child.emit("error", new Error("SSH connection error"));
    else if (cause === "exit") child.emit("exit", 255, null);
    else if (cause === "intentional-close") await runtime.stop();
    else {
      // Model OpenSSH exhausting the configured probes; Pocket relies on its process exit.
      const option = name => Number(child.args.find(value => value.startsWith(name + "=")).split("=")[1]);
      const windowMs = option("ServerAliveInterval") * option("ServerAliveCountMax") * 1000;
      assert.equal(windowMs, 45_000);
      setTimeout(() => child.emit("exit", 255, null), windowMs);
      t.mock.timers.tick(windowMs - 1);
      assert.equal(runtime.state.connected, true);
      t.mock.timers.tick(1);
    }
    const expected = cause === "intentional-close" ? 0 : 1;
    assert.equal(closeSpy.mock.callCount(), expected);
    const reconnect = runtime.reconnectTimer;
    if (expected) {
      assert.equal(runtime.state.connected, false);
      assert(reconnect);
      assert.equal(runtime.reconnectDelayIndex, 1);
    }
    // A frame, process error and exit can arrive for the same failed transport.
    child.stdout.write(Buffer.from([0x88, 0]));
    if (cause !== "error") child.emit("error", new Error("Late transport error"));
    child.emit("exit", 255, null);
    client.close(); // Cleanup after a peer close must not write to ended stdin.
    await new Promise(setImmediate);
    assert.equal(closeSpy.mock.callCount(), expected);
    assert.equal(runtime.reconnectTimer, reconnect);
    await runtime.stop();
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  }
});

test("complete task catalogs page active, archived and loaded IDs without changing ordering", async () => {
  const runtime = activeRuntime();
  const make = (prefix, count) => Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, name: `${prefix} ${i}`, cwd: '/tmp', status: 'idle', updatedAt: 1000 - i, canAcceptDirectInput: true }));
  const active = make('active', 103), archived = make('archived', 53), empty = make('empty', 105);
  const calls = [];
  runtime.rpc = { request: async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/list' || method === 'thread/loaded/list') {
      const all = method === 'thread/loaded/list' ? empty.map(t => t.id) : params.archived ? archived : active;
      const offset = Number(params.cursor || 0), end = offset + params.limit;
      return { data: all.slice(offset, end), nextCursor: end < all.length ? String(end) : null };
    }
    if (method === 'thread/read' || method === 'thread/resume') return { thread: [...active, ...empty].find(t => t.id === params.threadId) };
    return { data: [] };
  } };
  const catalog = await runtime.listLoadedThreads();
  assert.equal(catalog.length, 208);
  assert.deepEqual(catalog.filter(t => t.id.startsWith('active')).map(t => t.id), active.map(t => t.id));
  assert.deepEqual(catalog.filter(t => t.id.startsWith('empty')).map(t => t.id), empty.map(t => t.id));
  assert.deepEqual((await runtime.listArchivedThreads()).map(t => t.id), archived.map(t => t.id));
  await runtime.selectThread('active-102');
  assert.equal(runtime.state.thread.id, 'active-102');
  assert(calls.some(c => c.method === 'thread/resume' && c.params.threadId === 'active-102'));
  await runtime.taskAction({ action: 'rename', threadId: 'archived-52', archived: true, name: 'Archived rename' });
  assert(calls.some(c => c.method === 'thread/name/set' && c.params.threadId === 'archived-52'));
  assert.equal(runtime.state.thread.id, 'active-102');
});

test("rename uses official API for running selected tasks and preserves task state on failure", async () => {
  const runtime = activeRuntime();
  const task = { id: 'thread-1', name: 'Original', cwd: '/tmp', status: 'active' };
  runtime.state.thread.name = task.name;
  const calls = []; let fail = false;
  runtime.rpc = { request: async (method, params) => {
    if (method === 'thread/list') return { data: [task] };
    if (method === 'thread/name/set') {
      calls.push(params);
      if (fail) throw new Error('Rename failed');
      task.name = params.name;
    }
    return { data: [] };
  } };
  const turn = runtime.state.turn, messages = runtime.state.messages;
  await runtime.taskAction({ action: 'rename', threadId: task.id, name: ' Renamed ' });
  assert.deepEqual(calls, [{ threadId: task.id, name: 'Renamed' }]);
  assert.equal(runtime.state.thread.name, 'Renamed');
  assert.equal(runtime.state.turn, turn);
  assert.equal(runtime.state.messages, messages);
  const before = runtime.snapshot(); fail = true;
  await assert.rejects(runtime.taskAction({ action: 'rename', threadId: task.id, name: 'Other' }), /Rename failed/);
  assert.deepEqual(runtime.snapshot(), before);
  for (const name of ['', ' '.repeat(3), 'x'.repeat(181)]) await assert.rejects(runtime.taskAction({ action: 'rename', threadId: task.id, name }), /180/);
  await assert.rejects(runtime.taskAction({ action: 'rename', threadId: 'missing', name: 'Other' }), /no longer/);
  assert.equal(calls.length, 2);
});


test("draft memory restores A/B, touches recency, drops empty entries and evicts the ninth oldest", () => {
  const drafts = new Map();
  const a = { text: "Draft A", images: [{ url: "data:image/png;base64,large" }] };
  const b = { text: "Draft B", images: [] };
  rememberComposerDraft(drafts, "A", a);
  rememberComposerDraft(drafts, "B", b);
  assert.deepEqual(rememberComposerDraft(drafts, "A"), a);
  assert.deepEqual(rememberComposerDraft(drafts, "B"), b);
  rememberComposerDraft(drafts, "empty", { text: "", images: [] });
  assert.equal(drafts.size, 2);
  for (let i = 0; i < 7; i++) rememberComposerDraft(drafts, `task-${i}`, { text: String(i), images: [] });
  assert.equal(drafts.size, 8);
  assert.equal(rememberComposerDraft(drafts, "A"), undefined);
  assert.deepEqual(rememberComposerDraft(drafts, "B"), b);
  rememberComposerDraft(drafts, "task-7", { text: "7", images: [] });
  assert.equal(drafts.has("B"), true);
  assert.equal(drafts.has("task-0"), false);
  rememberComposerDraft(drafts, "B", { text: "", images: [] });
  assert.equal(drafts.has("B"), false);
});

test("phone URLs discover only local private or CGNAT IPv4 interfaces", async (t) => {
  const os = (await import("node:os")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const addresses = ["100.64.0.0", "100.127.255.255", "100.63.255.255", "100.128.0.0", "192.168.1.100"];
  const mock = t.mock.method(os, "networkInterfaces", () => ({ test: addresses.map(address => ({ address, family: "IPv4", internal: false })) }));
  syncBuiltinESMExports();
  try {
    const gateway = new PocketGateway({ machines: [] });
    assert.deepEqual(gateway.hostStatus({ host: "0.0.0.0", port: 4173 }).phoneUrls, ["http://100.127.255.255:4173", "http://100.64.0.0:4173", "http://192.168.1.100:4173"]);
    assert.deepEqual(gateway.hostStatus({ host: "127.0.0.1", port: 4173 }).phoneUrls, []);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

test("only an exact local missing socket starts the daemon once before reconnecting", async (t) => {
  const childProcess = (await import('node:child_process')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const missing = 'failed to connect to socket: No such file or directory';
  let starts = [], connects = 0, scenario;
  const starter = t.mock.method(childProcess, 'execFile', (command, args, options, callback) => {
    starts.push({ command, args, options });
    queueMicrotask(() => callback(scenario.startFails ? new Error('unsupported daemon start') : null));
    return { kill() {} };
  });
  syncBuiltinESMExports();
  t.mock.method(RpcClient.prototype, 'connect', async () => {
    connects++;
    if (connects === 1 || scenario.retryFails) throw new Error(scenario.error);
  });
  t.mock.method(RpcClient.prototype, 'request', async () => ({ data: [] }));
  t.mock.method(RpcClient.prototype, 'notify', () => {});
  t.mock.method(RpcClient.prototype, 'close', () => {});
  try {
    for (scenario of [
      { error: missing, recovered: true },
      { error: missing, retryFails: true },
      { error: missing, startFails: true },
      { error: missing, ssh: 'remote' },
      { error: missing, ws: 'ws://127.0.0.1:7777' },
      { error: 'failed to connect to socket: Permission denied' },
      { error: 'spawn codex ENOENT' },
    ]) {
      starts = []; connects = 0;
      const runtime = new MachineRuntime({ ws: scenario.ws }, { id: scenario.ssh ? 'ssh:remote' : 'local', name: 'Test', ssh: scenario.ssh || null }, () => {});
      try {
        await runtime.start(false);
        const recovery = scenario.error === missing && !scenario.ssh && !scenario.ws;
        assert.equal(starts.length, recovery ? 1 : 0);
        assert.equal(connects, recovery && !scenario.startFails ? 2 : 1);
        if (recovery) {
          assert.deepEqual(starts[0].args, ['app-server', 'daemon', 'start']);
          assert.equal(starts[0].options.timeout, 15000);
        }
        assert.equal(runtime.state.connected, Boolean(scenario.recovered));
        assert.equal(runtime.state.thread, null);
        if (!scenario.recovered) {
          assert.equal(runtime.reconnectTimer._idleTimeout, 5000);
          assert.equal(runtime.reconnectDelayIndex, 1);
        }
      } finally { await runtime.stop(); }
    }
  } finally { starter.mock.restore(); syncBuiltinESMExports(); }
});

test("task context survives release as last known, refreshes authoritatively, and stays bounded", async () => {
  const runtime = activeRuntime();
  const usage = tokens => ({ last: { totalTokens: tokens }, modelContextWindow: 100000 });
  const update = (id, value) => runtime.handleNotification({ method: 'thread/tokenUsage/updated', params: { threadId: id, tokenUsage: value } });
  update('thread-1', usage(41000));
  runtime.loadedThreads = [{ id: 'thread-1', name: 'A', cwd: '/tmp', status: 'idle' }];
  runtime.rpc = { request: async (method, params) => method === 'thread/resume' ? { thread: { id: params.threadId, status: 'idle' } } : { data: [] } };
  await runtime.releaseTask();
  assert.equal(runtime.state.context, null);
  await runtime.attachLoadedThread('thread-1', false);
  assert.deepEqual(runtime.state.context, { usedTokens: 41000, contextWindow: 100000, usedPercent: 41, lastKnown: true });
  update('other', usage(99000));
  update('thread-1', { last: { totalTokens: -1 }, modelContextWindow: 100000 });
  assert.equal(runtime.state.context.usedPercent, 41);
  assert.equal(runtime.state.context.lastKnown, true);
  update('thread-1', usage(42000));
  assert.equal(runtime.state.context.usedPercent, 42);
  assert.equal(runtime.state.context.lastKnown, undefined);
  for (let i = 0; i < 32; i++) {
    runtime.state.thread = { id: `cached-${i}` };
    update(`cached-${i}`, usage(i));
  }
  assert.equal(runtime.contextByThread.size, 32);
  assert.equal(runtime.contextByThread.has('thread-1'), false);
  await runtime.attachLoadedThread('thread-1', false);
  assert.equal(runtime.state.context, null);
});

test('New Task hands off ownership before deferred naming; naming failure cannot fail an accepted message', async () => {
  const gateway = new PocketGateway({ machines: [{ name: 'B', ssh: 'b' }] });
  const a = gateway.runtimes.get('local'), b = gateway.runtimes.get('ssh:b');
  const calls = [];
  const created = { id: 'new-b', cwd: '/project', status: 'idle', canAcceptDirectInput: true };
  for (const [label, runtime] of [['A', a], ['B', b]]) {
    Object.assign(runtime.state, { connected: true, thread: label === 'A' ? { id: 'a' } : null, threadStatus: 'idle' });
    runtime.rpc = { request: async (method, params) => {
      calls.push(`${label}:${method}`);
      if (method === 'thread/start' || method === 'thread/resume') return { thread: created };
      if (method === 'thread/name/set') throw new Error('Name save failed');
      if (method === 'turn/start') return { turn: { id: 'real', status: 'inProgress' } };
      if (method === 'thread/loaded/list') return { data: ['new-b'] };
      if (method === 'thread/read') return { thread: created };
      return { data: [] };
    } };
  }
  const result = await gateway.taskAction({ action: 'create', machineId: 'ssh:b', expectedMachineId: 'local', expectedThreadId: 'a', name: 'New name', cwd: '/project' });
  assert.equal(result.machineId, 'ssh:b');
  assert.equal(result.thread.id, 'new-b');
  assert.equal(result.thread.name, 'New name');
  assert(!calls.includes('B:thread/name/set'));
  const sent = await b.sendMessage('Real input', 'start');
  assert.equal(sent.accepted, true);
  assert(!calls.includes('B:thread/name/set'));
  b.handleNotification({ method: 'turn/started', params: { threadId: 'new-b', turn: { id: 'real', status: 'inProgress' } } });
  assert(!calls.includes('B:thread/name/set'));
  b.handleNotification({ method: 'turn/completed', params: { threadId: 'new-b', turn: { id: 'real', status: 'completed' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await b.listLoadedThreads()).find(t => t.id === 'new-b').name, 'New name');
  assert.equal(b.pendingTaskNames.get('new-b').name, 'New name');
  await b.attachLoadedThread('new-b', false, { thread: { ...created, preview: 'Generated preview' } });
  assert.equal(b.state.thread.name, 'New name');
  const namingCalls = calls.filter(c => c === 'B:thread/name/set').length;
  assert.match(b.snapshot().taskNameWarning, /name could not be saved/);
  b.handleNotification({ method: 'turn/completed', params: { threadId: 'new-b', turn: { id: 'real', status: 'completed' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(c => c === 'B:thread/name/set').length, namingCalls);
  b.rpc.request = async (method, params) => {
    if (method === 'thread/name/set') { created.name = params.name; return {}; }
    if (method === 'thread/loaded/list') return { data: ['new-b'] };
    if (method === 'thread/read') return { thread: created };
    return { data: [] };
  };
  b.handleNotification({ method: 'turn/completed', params: { threadId: 'new-b', turn: { id: 'next', status: 'completed' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.pendingTaskNames.has('new-b'), false);
  assert.equal(b.snapshot().taskNameWarning, null);
  assert.equal(created.name, 'New name');
  assert.equal((await b.refreshLoadedThreads()).find(t => t.id === 'new-b').name, 'New name');
  await b.taskAction({ action: 'rename', threadId: 'new-b', name: 'Renamed explicitly' });
  assert.equal(b.pendingTaskNames.has('new-b'), false);
  assert.equal(b.state.thread.name, 'Renamed explicitly');
  assert.equal(gateway.selectedMachineId, 'ssh:b');
  assert.equal(a.state.thread, null);
  assert.equal(a.state.connected, true);
  assert.equal(a.autoAttach, false);
  assert.equal(b.autoAttach, true);
  assert(calls.indexOf('B:thread/start') < calls.indexOf('A:thread/unsubscribe'));
  assert.deepEqual([...gateway.runtimes.values()].filter(r => r.state.thread).map(r => r.definition.id), ['ssh:b']);
});

test('Cancel cannot clear a queued message while automatic turn/start is in flight', async () => {
  const runtime = activeRuntime();
  await runtime.sendMessage('Queued text', 'queue');
  const queued = runtime.state.queuedMessage;
  let resolveStart,started;const ready=new Promise(resolve=>started=resolve);
  runtime.rpc = { request: method => {
    assert.equal(method, 'turn/start');started();
    return new Promise(resolve => { resolveStart = resolve; });
  } };
  const delivery = runtime.startQueuedMessage('thread-1');
  assert.equal(runtime.startingQueuedMessage, true);
  assert.deepEqual(runtime.cancelQueuedMessage(), { cancelled: false });
  assert.equal(runtime.state.queuedMessage, queued);
  await ready;resolveStart({ turn: { id: 'delivered', status: 'inProgress' } });
  assert.equal(await delivery, true);
  assert.equal(runtime.state.queuedMessage, null);
  assert.equal(runtime.state.turn.id, 'delivered');
  assert.equal(runtime.startingQueuedMessage, false);
});

test('model and permission profile pagination reject repeated cursors without partial state', async () => {
  for (const [method, load, field] of [['model/list', 'loadModels', 'models'], ['permissionProfile/list', 'loadPermissionProfiles', 'permissionProfiles']]) {
    const runtime = activeRuntime();
    const previous = [{ id: 'previous' }];
    if (field === 'models') runtime.state.models = previous; else runtime.permissionProfiles = previous;
    const cursors = [];
    runtime.rpc = { request: async (name, params) => {
      assert.equal(name, method); cursors.push(params.cursor);
      assert(cursors.length <= 2, 'pagination must stop at the first repeated cursor');
      return { data: [{ id: 'new', model: 'new' }], nextCursor: 'repeat' };
    } };
    await assert.rejects(runtime[load]('/project'), /returned a repeated cursor/);
    assert.deepEqual(cursors, [null, 'repeat']);
    assert.equal(field === 'models' ? runtime.state.models : runtime.permissionProfiles, previous);
  }
});

test('New Task catalog refresh failure after attachment cannot abort ownership handoff', async () => {
  const gateway = new PocketGateway({ machines: [{ name: 'B', ssh: 'b' }] });
  const a = gateway.runtimes.get('local'), b = gateway.runtimes.get('ssh:b');
  const calls = [];
  for (const [label, runtime] of [['A', a], ['B', b]]) {
    Object.assign(runtime.state, { connected: true, thread: label === 'A' ? { id: 'a' } : null, threadStatus: 'idle' });
    runtime.rpc = { request: async method => {
      calls.push(`${label}:${method}`);
      if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'new-b', cwd: '/project', status: 'idle', canAcceptDirectInput: true } };
      return { data: [] };
    } };
  }
  b.refreshLoadedThreads = async () => {
    assert.equal(b.state.thread.id, 'new-b');
    assert.equal(a.state.thread.id, 'a');
    calls.push('B:refresh-failed');
    throw new Error('Task catalog request timed out');
  };
  const result = await gateway.taskAction({ action: 'create', machineId: 'ssh:b', expectedMachineId: 'local', expectedThreadId: 'a', name: 'New name', cwd: '/project' });
  assert.equal(result.machineId, 'ssh:b');
  assert.equal(result.thread.id, 'new-b');
  assert.equal(result.thread.name, 'New name');
  assert.equal(gateway.selectedMachineId, 'ssh:b');
  assert.equal(a.state.thread, null);
  assert.equal(a.state.connected, true);
  assert.equal(a.autoAttach, false);
  assert.equal(b.autoAttach, true);
  assert.equal(calls.filter(call => call === 'B:refresh-failed').length, 1);
  assert(calls.indexOf('B:refresh-failed') < calls.indexOf('A:thread/unsubscribe'));
  assert.deepEqual([...gateway.runtimes.values()].filter(r => r.state.thread).map(r => r.definition.id), ['ssh:b']);
});


test('restart preserves explicit launch overrides without freezing saved settings or putting PINs in argv', async () => {
  const { runInNewContext } = await import('node:vm');
  const saved = { host: '127.0.0.1', port: 4999, localName: '', machines: [] };
  const overrides = ['--host', '0.0.0.0', '--port', '4888', '--ws', 'ws://localhost:1234', '--thread', 'task-id'];
  for (const args of [[], overrides]) for (const pin of [undefined, '', '1234']) {
    const env = { CODEX_BIN: '/custom/codex' };
    if (pin !== undefined) env.CODEX_POCKET_PIN = pin;
    let launch;
    runInNewContext(RESTART_HELPER, {
      process: { argv: ['node', '123', '/node', '/gateway.ts', '/project', '/log', ...args], env, kill: () => { throw new Error('old process exited'); } },
      require: name => name === 'node:fs' ? { openSync: () => 9 } : { spawn: (file, argv, options) => { launch = { file, argv, options }; return { unref() {} }; } },
    });
    assert.equal(launch.file, '/node');
    assert.deepEqual(Array.from(launch.argv), ['--experimental-strip-types', '/gateway.ts', ...args]);
    assert.deepEqual({ ...launch.options.env }, env);
    const next = parseArgs(Array.from(launch.argv).slice(2), saved);
    assert.equal(next.host, args.length ? '0.0.0.0' : saved.host);
    assert.equal(next.port, args.length ? 4888 : saved.port);
    assert.equal(next.ws, args.length ? 'ws://localhost:1234' : undefined);
    assert.equal(next.thread, args.length ? 'task-id' : undefined);
  }
  const request = { headers: { host: '192.168.1.100:4173' } };
  assert.equal(restartUrlForRequest(request, true, 'http://127.0.0.1:4888'), 'http://192.168.1.100:4888');
  assert.equal(restartUrlForRequest(request, false, 'http://127.0.0.1:4999'), 'http://127.0.0.1:4999');
  request.headers.origin='https://192.168.1.100:4173';
  assert.equal(restartUrlForRequest(request,true,'http://127.0.0.1:4888'),request.headers.origin);
  request.headers.origin='https://attacker.example';
  assert.equal(restartUrlForRequest(request,true,'http://127.0.0.1:4888'),'http://192.168.1.100:4888');
});

test('PWA manifest and branded PNG icons are served as public static assets', async () => {
  const { createServer } = await import('node:http');
  const { handleRequest } = await import('../gateway.ts');
  const gateway = new PocketGateway({ machines: [] });
  const server = createServer((req, res) => {
    handleRequest(req, res, gateway, { required: true, pin: '1234', sessionId: 'test', attempts: new Map() }, {}, { host: '127.0.0.1' }, async () => ({ localUrl: '/' }), () => {}, () => false)
      .catch(() => { res.writeHead(500); res.end(); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const html = await (await fetch(origin)).text();
    assert.match(html, /rel="manifest" href="\/manifest.webmanifest"/);
    const response = await fetch(`${origin}/manifest.webmanifest`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/manifest+json');
    const manifest = await response.json();
    assert.equal(manifest.name, 'Codex Pocket');
    assert.equal(manifest.short_name, 'Codex Pocket');
    assert.equal(manifest.start_url, '/');
    assert.equal(manifest.scope, '/');
    assert.equal(manifest.display, 'standalone');
    for (const icon of manifest.icons) {
      const response = await fetch(origin + icon.src);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'image/png');
      const png = Buffer.from(await response.arrayBuffer());
      assert.equal(png.subarray(1, 4).toString(), 'PNG');
      assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, icon.sizes);
    }
    assert.deepEqual(manifest.icons.map(icon => icon.sizes), ['192x192', '512x512']);
    const js = await (await fetch(`${origin}/app.js?viewportDebug=1`)).text();
    assert(!js.includes('viewportDebug'));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});


test("navigation catalog timeouts are bounded and do not mark connected runtimes Offline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const gateway = new PocketGateway({ machines: [{ name: "Remote", ssh: "remote" }] });
  const local = gateway.runtimes.get("local");
  const remote = gateway.runtimes.get("ssh:remote");
  local.state.connected = true;
  const client = new RpcClient();
  client.wire = { send() {}, close() {} };
  local.rpc = client;
  for (const archived of [false, true]) {
    let done = false;
    const pending = gateway.navigationCatalog(archived).then(value => { done = true; return value; });
    await Promise.resolve();
    t.mock.timers.tick(4_999); await Promise.resolve();
    assert.equal(done, false);
    t.mock.timers.tick(1);
    const result = await pending;
    assert.equal(result.machines[0].connected, true);
    assert.equal(result.machines[0].catalogAvailable, false);
    assert.equal(result.machines[1].connected, false);
    assert.equal(remote.state.thread, null);
    assert.equal(client.pending.size, 0);
  }
  // Pagination shares the deadline rather than granting each page another five seconds.
  const budgets = [];
  local.rpc = { request: async (method, params, timeout) => {
    budgets.push(timeout);
    if (!params.cursor) { t.mock.timers.tick(3_000); return { data: [], nextCursor: "next" }; }
    return { data: [], nextCursor: null };
  } };
  await local.listArchivedThreads();
  assert.deepEqual(budgets, [5_000, 2_000]);
});


test("successful core catalogs survive optional loaded metadata failures and deadlines", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const runtime = activeRuntime();
  const core = { id: "core", name: "Core task", cwd: "/project", updatedAt: 100 };
  const extra = { ...core, id: "extra", name: "Loaded empty task" };
  runtime.rpc = { request: async method => method === "thread/list" ? { data: [core] }
    : method === "thread/loaded/list" ? { data: ["core", "extra"] } : { thread: extra } };
  const initial = await runtime.listLoadedThreads();
  assert.equal(initial.length, 2);
  for (const failure of ["read", "timeout", "loaded-list"]) {
    runtime.rpc = { request: async method => {
      if (method === "thread/list") return { data: [core] };
      if (method === "thread/loaded/list" && failure !== "loaded-list") return { data: ["core", "extra"] };
      if (failure === "timeout") t.mock.timers.tick(5_000);
      throw new Error("Optional metadata failed");
    } };
    const catalog = await runtime.listLoadedThreads();
    assert.equal(catalog.find(t => t.id === "core").name, "Core task");
    assert.deepEqual(catalog.find(t => t.id === "extra"), initial.find(t => t.id === "extra"));
    assert.equal(runtime.state.connected, true);
    const gateway = new PocketGateway({ machines: [] });
    gateway.runtimes.set("local", runtime);
    const result = (await gateway.navigationCatalog()).machines[0];
    assert.equal(result.catalogAvailable, true);
    assert(result.tasks.some(task => task.id === "core"));
  }
});

test("machine disconnection publishes current state independently of a failed catalog", async () => {
  const gateway = new PocketGateway({ machines: [{ name: "Remote", ssh: "remote" }] });
  const remote = gateway.runtimes.get("ssh:remote");
  remote.state.connected = true;
  remote.listLoadedThreads = async () => { throw new Error("Catalog failure"); };
  assert.equal((await gateway.navigationCatalog()).machines[1].catalogAvailable, false);
  const events = [];
  gateway.subscribers.add({ write: payload => events.push(payload) });
  remote.shuttingDown = false;
  remote.scheduleReconnect = () => {};
  remote.handleClose();
  const event = events.find(event => event.startsWith("event: machines"));
  assert.equal(JSON.parse(event.split("data: ")[1]).machines[1].connected, false);
  assert.equal(gateway.snapshot().machines[1].connected, false);
});

test("confirmed Steers reconcile only to distinct new authoritative user items in their turn", () => {
  const old = { id: "old", role: "user", turnId: "turn", text: "Continue" };
  const confirmed = id => ({ ...old, id, confirmedSteer: { previousMessageIds: ["old"] } });
  const a = confirmed("confirmed-a"), b = confirmed("confirmed-b");
  const echo = { ...old, id: "echo" };
  assert.deepEqual(reconcileConfirmedSteers([old, a]), [old, a]);
  assert.deepEqual(reconcileConfirmedSteers([old, a, b, echo]), [old, b, echo]);
  const second = { ...echo, id: "second" };
  assert.deepEqual(reconcileConfirmedSteers([old, a, b, echo, second]), [old, echo, second]);
  assert.deepEqual(reconcileConfirmedSteers([old, a, b, echo, second]), [old, echo, second]);
  const wrongTurn = { ...echo, id: "wrong", turnId: "other" };
  const c = confirmed("confirmed-c");
  assert.deepEqual(reconcileConfirmedSteers([c, wrongTurn]), [c, wrongTurn]);
});

test("Desktop composite async reply IDs resolve the exact question index live and after history reload", async () => {
  const runtime = activeRuntime();
  const question = { id: "call_desktop", type: "agentMessage", delivery: "async", text: "Confirm", questions: [{ title: "Same?" }, { title: "Same?" }] };
  for (const escaped of [false, true]) {
    let id = JSON.stringify(["request_user_input_async", question.id, 1]);
    if (escaped) id = id.replaceAll('"', '\\"');
    const reply = { id: "desktop-reply", type: "userMessage", content: [{ type: "text", text: `<send_user_message_question_reply>${JSON.stringify([{ questionItemId: id, question: "Same?", answer: "All good." }])}</send_user_message_question_reply>` }] };
    runtime.handleNotification({ method: "item/completed", params: { threadId: runtime.state.thread.id, turnId: "turn-1", item: question } });
    runtime.handleNotification({ method: "item/completed", params: { threadId: runtime.state.thread.id, turnId: "turn-1", item: reply } });
    runtime.rpc = { request: async method => method === "thread/turns/list" ? { data: [{ id: "turn-1", status: "completed" }] } : { data: [question, reply].map(item => ({ turnId: "turn-1", item })) } };
    for (const messages of [runtime.snapshot().liveMessages, (await runtime.history(null, 1)).turns[0].messages]) {
      const q = messages.find(m => m.id === question.id);
      assert.equal(resolvedAsyncAnswer(q, 0, messages), null);
      assert.equal(resolvedAsyncAnswer(q, 1, messages), "All good.");
      assert.equal(messages.filter(m => m.text === "All good.").length, 1);
      assert.equal(resolvedAsyncAnswer({ ...q, id: "other" }, 1, messages), null);
    }
  }
});


test('New live tasks never resume or name zero-turn threads on either machine', async () => {
  for (const machineId of ['local', 'ssh:b']) for (const cwd of ['', '/project']) {
    const gateway = new PocketGateway({ machines: [{ name: 'B', ssh: 'b' }] });
    const a = gateway.runtimes.get('local'), target = gateway.runtimes.get(machineId);
    Object.assign(a.state, { connected: true, thread: { id: 'a' }, threadStatus: 'idle' });
    target.state.connected = true;
    const calls = [];
    let rejectTurn = true, materialized = false;
    const thread = { id: 'new', cwd: '/project', status: 'idle', canAcceptDirectInput: true };
    a.rpc = { request: async () => ({ data: [] }) };
    target.rpc = { request: async (method, params) => {
      calls.push(method);
      if (method === 'thread/name/set') assert(materialized, 'name save must wait for materialized turn completion');
      if (method === 'command/exec') return { exitCode: 0, stdout: '/home/target', stderr: '' };
      if (method === 'thread/start') { assert.deepEqual(params, { cwd: cwd || '/home/target' }); return { thread: { ...thread } }; }
      if (method === 'thread/resume') throw new Error('no rollout found for thread id new (-32600)');
      if (method === 'thread/loaded/list') return { data: ['new'] };
      if (method === 'thread/read') throw new Error('no rollout found');
      if (method === 'turn/start') { if (rejectTurn) throw new Error('Turn rejected'); return { turn: { id: 'first', status: 'inProgress' } }; }
      return { data: [] };
    } };
    const created = await gateway.taskAction({ action: 'create', machineId, expectedMachineId: 'local', expectedThreadId: 'a', name: 'Requested name', cwd });
    assert.equal(created.thread.name, 'Requested name');
    assert.equal(created.thread.cwd, '/project');
    assert.equal(gateway.selectedMachineId, machineId);
    assert.equal((await target.listLoadedThreads()).find(t => t.id === 'new').name, 'Requested name');
    assert(!calls.includes('thread/resume'));
    assert(!calls.includes('thread/name/set'));
    assert(!calls.includes('turn/start'));
    if (machineId !== 'local') assert.equal(a.state.thread, null);
    await assert.rejects(target.sendMessage('First real input', 'start'), /Turn rejected/);
    assert(!calls.includes('thread/name/set'));
    assert.equal(target.pendingTaskNames.get('new').name, 'Requested name');
    rejectTurn = false;
    const sent = await target.sendMessage('First real input', 'start');
    assert.equal(sent.accepted, true);
    assert(!calls.includes('thread/name/set'));
    materialized = true;
    target.handleNotification({ method: 'turn/completed', params: { threadId: 'new', turn: { id: 'first', status: 'completed' } } });
    assert(calls.indexOf('thread/name/set') > calls.indexOf('turn/start'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(target.pendingTaskNames.size, 0);
  }
});

test('Tasks labels require observed terminal results and active status takes priority', () => {
  const idle = { id: 'a', status: 'idle' };
  const selected = { machineId: 'local', thread: idle, phase: 'done', threadStatus: 'idle' };
  assert.equal(destinationTaskStatus(machine, idle, selected), '');
  for (const result of ['Done', 'Failed', 'Stopped']) {
    assert.equal(destinationTaskStatus(machine, idle, selected, result), result);
    assert.equal(destinationTaskStatus(machine, idle, {}, result), result);
    assert.equal(destinationTaskStatus(machine, { ...idle, status: 'active' }, {}, result), 'Working');
  }
});


test('Enter submission rule shares preference, modifiers, and composition protection', () => {
  for (const preference of [true, false]) {
    const event = { key: 'Enter' };
    assert.equal(Boolean(enterSubmits(event, preference)), preference);
    for (const modifier of ['ctrlKey', 'metaKey']) assert(enterSubmits({ ...event, [modifier]: true }, preference));
    for (const guard of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }]) {
      assert(!enterSubmits({ ...event, ctrlKey: true, ...guard }, preference));
    }
    assert(!enterSubmits({ ...event, metaKey: true }, preference, true));
  }
});

test('Non-selected task status broadcasts reach browsers without changing attachment or turn state', () => {
  const gateway = new PocketGateway({ machines: [{ name: 'Remote', ssh: 'remote' }] });
  const a = gateway.runtimes.get('local'), b = gateway.runtimes.get('ssh:remote');
  a.state.thread = { id: 'selected' };
  const before = a.snapshot();
  const messages = [];
  gateway.subscribers.add({ write: message => messages.push(message) });
  a.loadedThreads = [{ id: 'other', status: 'idle' }];
  a.handleNotification({ method: 'thread/status/changed', params: { threadId: 'other', status: { type: 'active', activeFlags: [] } } });
  b.handleNotification({ method: 'thread/status/changed', params: { threadId: 'remote-task', status: { type: 'active', activeFlags: ['waitingOnUserInput'] } } });
  assert.equal(a.loadedThreads[0].status, 'active');
  assert.equal(messages.length, 2);
  assert(messages.every(message => message.startsWith('event: task-status')));
  assert(messages[1].includes('active:waitingOnUserInput'));
  assert.deepEqual(a.snapshot(), before);
  assert.equal(b.state.thread, null);
  a.handleNotification({ method: 'turn/started', params: { threadId: 'other', turn: { id: 'foreign', status: 'inProgress' } } });
  assert.deepEqual(a.snapshot(), before);
  assert.equal(destinationTaskStatus({ id: 'remote' }, { id: 'other', status: 'active:waitingOnApproval' }, {}, 'Done'), 'Waiting');
});


test('Non-selected terminal transitions reconcile one unhydrated latest turn and survive snapshots', async () => {
  const gateway = new PocketGateway({ machines: [] });
  const runtime = gateway.runtimes.get('local');
  Object.assign(runtime.state, { connected: true, thread: { id: 'selected' } });
  const before = runtime.snapshot().thread;
  const calls = [];
  let outcome;
  runtime.rpc = { request: async (method, params, timeout) => {
    calls.push(method);
    assert.equal(method, 'thread/turns/list');
    assert.deepEqual(params, { threadId: 'other', cursor: null, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
    assert.equal(timeout, 5000);
    if (outcome === 'unreadable') throw new Error('Read failed');
    return { data: outcome ? [{ status: outcome }] : [] };
  } };
  const notify = status => runtime.handleNotification({ method: 'thread/status/changed', params: { threadId: 'other', status: { type: status } } });
  notify('idle');assert.equal(calls.length, 0);
  for (const [status, label] of [['completed','Done'],['failed','Failed'],['interrupted','Stopped'],['inProgress',undefined],[null,undefined],['unreadable',undefined]]) {
    outcome = status;
    notify('active');assert.equal(runtime.snapshot().taskTerminalResults.other, undefined);
    const beforeCount = calls.length;
    notify('idle');notify('notLoaded');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, beforeCount + 1);
    assert.equal(runtime.snapshot().taskTerminalResults.other, label);
    assert.equal(gateway.snapshot().machines[0].terminalResults.other, label);
    assert.deepEqual(runtime.state.thread, before);
  }
});

test('New activity invalidates pending terminal reads; tasks retain independent results', async () => {
  const runtime = activeRuntime();
  const pending = new Map();
  runtime.rpc = { request: (method, params) => { assert.equal(method, 'thread/turns/list'); return new Promise(resolve => pending.set(params.threadId, resolve)); } };
  const notify = (threadId, type) => runtime.handleNotification({ method: 'thread/status/changed', params: { threadId, status: { type } } });
  for (const id of ['a','b']) { notify(id,'active'); notify(id,'idle'); }
  notify('a','active');pending.get('a')({data:[{status:'completed'}]});pending.get('b')({data:[{status:'failed'}]});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(runtime.snapshot().taskTerminalResults, { b: 'Failed' });
  notify('a','notLoaded');pending.get('a')({data:[{status:'interrupted'}]});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(runtime.snapshot().taskTerminalResults, { a: 'Stopped', b: 'Failed' });
  // Selected turn events retain their existing path, without a reconciliation read.
  runtime.finalizeTerminalMessages = async () => {};
  runtime.handleNotification({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'selected-turn',status:'completed'}}});
  assert.equal(runtime.snapshot().taskTerminalResults['thread-1'], undefined);
  notify('thread-1','idle');assert.equal(pending.has('thread-1'), false);
});


test('Catalog refresh respects newer live status observations and reconciled terminal results', async () => {
  for (const [terminal, label] of [['completed','Done'],['failed','Failed'],['interrupted','Stopped']]) {
    const runtime = activeRuntime();
    let release;
    const catalog = new Promise(resolve => { release = resolve; });
    runtime.rpc = { request: async method => {
      if (method === 'thread/list') return catalog;
      if (method === 'thread/loaded/list') return { data: [] };
      assert.equal(method, 'thread/turns/list');
      return { data: [{ status: terminal }] };
    } };
    const notify = type => runtime.handleNotification({ method: 'thread/status/changed', params: { threadId: 'other', status: { type } } });
    notify('active');
    const refresh = runtime.refreshLoadedThreads();
    notify('idle');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(runtime.snapshot().taskTerminalResults.other, label);
    release({data:[{id:'other',cwd:'/project',source:'cli',status:{type:'active',activeFlags:[]}}]});
    const tasks = await refresh;
    assert.equal(tasks[0].status, 'idle');
    assert.equal(runtime.taskStatuses.get('other'), 'idle');
    assert.equal(runtime.snapshot().taskTerminalResults.other, label);
    assert.equal(runtime.machineSummary().terminalResults.other, label);
  }
});

test('Live active wins over stale idle catalogs, while uncontested catalog active clears stale labels', async () => {
  const runtime = activeRuntime();
  let release;
  let catalog = new Promise(resolve => { release = resolve; });
  runtime.rpc = { request: async method => method === 'thread/list' ? catalog : {data:[]} };
  const notify = type => runtime.handleNotification({ method:'thread/status/changed',params:{threadId:'other',status:{type}} });
  notify('active');
  const refresh = runtime.refreshLoadedThreads();
  // Same status value as at read start must still count as a newer observation.
  notify('active');
  release({data:[{id:'other',cwd:'/project',source:'cli',status:{type:'idle'}}]});
  assert.equal((await refresh)[0].status,'active');
  runtime.terminalResults.other = 'Done';
  catalog = Promise.resolve({data:[{id:'other',cwd:'/project',source:'cli',status:{type:'active',activeFlags:[]}}]});
  assert.equal((await runtime.refreshLoadedThreads())[0].status,'active');
  assert.equal(runtime.snapshot().taskTerminalResults.other,undefined);
});


test('Successful deliberate task entry acknowledges only its terminal marker and invalidates older reads', async () => {
  for (const crossMachine of [false, true]) for (const label of ['Done', 'Failed', 'Stopped']) {
    const gateway = new PocketGateway({ machines: [{ name: 'B', ssh: 'b' }] });
    const a = gateway.runtimes.get('local');
    const targetId = crossMachine ? 'ssh:b' : 'local';
    const target = gateway.runtimes.get(targetId);
    Object.assign(a.state, { connected: true, thread: { id: 'a' }, threadStatus: 'idle' });
    target.state.connected = true;
    a.terminalResults.a = 'Stopped';
    target.terminalResults.b = label;
    target.terminalResults.other = 'Failed';
    let reject = true, finishRead;
    target.rpc = { request: async (method) => {
      if (method === 'thread/list') return { data: [{ id: 'b', name: 'B', cwd: '/tmp', status: 'idle' }] };
      if (method === 'thread/resume') {
        if (reject) throw new Error('already has an active writer');
        return { thread: { id: 'b', name: 'B', cwd: '/tmp', status: 'idle' } };
      }
      if (method === 'thread/turns/list') return new Promise(resolve => { finishRead = resolve; });
      return { data: [] };
    } };
    if (crossMachine) a.rpc = { request: async () => ({ data: [] }) };
    await assert.rejects(gateway.selectDestination(targetId, 'b', 'local', 'a'), /another Codex runtime/);
    assert.equal(target.snapshot().taskTerminalResults.b, label);
    const pending = target.reconcileTaskTerminal('b');
    target.terminalResults.b = label;
    reject = false;
    const accepted = await gateway.selectDestination(targetId, 'b', 'local', 'a');
    assert.equal(accepted.thread.id, 'b');
    assert.equal(accepted.taskTerminalResults.b, undefined);
    assert.equal(a.terminalResults.a, 'Stopped');
    assert.equal(target.terminalResults.other, 'Failed');
    finishRead({ data: [{ status: 'completed' }] });
    await pending;
    assert.equal(target.terminalResults.b, undefined);
    target.finalizeTerminalMessages = async () => {};
    target.handleNotification({ method: 'turn/completed', params: { threadId: 'b', turn: { id: 'later', status: 'completed' } } });
    assert.equal(gateway.snapshot().taskTerminalResults.b, undefined);
    // Reload/snapshot and a redundant selection of the current task are not acknowledgment.
    assert.equal(gateway.snapshot().taskTerminalResults.b, undefined);
    await gateway.selectDestination(targetId, 'b', targetId, 'b');
    assert.equal(gateway.snapshot().taskTerminalResults.b, undefined);
  }
});

test('Fresh task history only suppresses the specific unmaterialized condition before first use', async () => {
  const runtime = activeRuntime();
  runtime.state.turn = null;
  runtime.pendingTaskNames.set('thread-1', { name: 'Fresh', firstMessageAccepted: false });
  let error = 'thread thread-1 is not materialized yet; history unavailable before first user message';
  runtime.rpc = { request: async () => { throw new Error(error); } };
  assert.deepEqual((await runtime.history(null, 20)).turns, []);
  error = 'Permission denied';
  await assert.rejects(runtime.history(null, 20), /Permission denied/);
  error = 'thread thread-1 is not materialized yet; history unavailable before first user message';
  runtime.pendingTaskNames.get('thread-1').firstMessageAccepted = true;
  await assert.rejects(runtime.history(null, 20), /not materialized/);
});

test('New Task starting settings use the target runtime and optional failures keep ownership handoff', async () => {
  for (const settings of [{}, { model: 'target-model', effort: 'high', access: 'auto' }, { model: 'missing', access: 'full' }]) {
    const gateway = new PocketGateway({ machines: [{ name: 'B', ssh: 'b' }] });
    const a = gateway.runtimes.get('local'), b = gateway.runtimes.get('ssh:b');
    Object.assign(a.state, { connected: true, thread: { id: 'a' }, threadStatus: 'idle' });
    b.state.connected = true;
    b.state.models = [{ model: 'target-model', displayName: 'Target model', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }];
    const calls = [];
    a.rpc = { request: async method => { assert.equal(method, 'thread/unsubscribe'); return {}; } };
    b.waitForSettingsUpdate = async () => true;
    b.rpc = { request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'command/exec') return { exitCode: 0, stdout: '/home/target', stderr: '' };
      if (method === 'thread/start') return { thread: { id: 'new', cwd: '/resolved', status: 'idle', canAcceptDirectInput: true }, model: 'target-model', reasoningEffort: 'high', activePermissionProfile: { id: ':workspace' }, approvalsReviewer: 'user' };
      if (method === 'permissionProfile/list') return { data: [{ id: ':workspace', allowed: true }, { id: ':full-access', allowed: true }] };
      if (method === 'thread/loaded/list') return { data: ['new'] };
      if (method === 'thread/read') throw new Error('no rollout found');
      if (method === 'thread/resume') throw new Error('Must not resume zero-turn task');
      if (method === 'turn/start') return { turn: { id: 'real', status: 'inProgress' } };
      return { data: [] };
    } };
    const options = await gateway.newTaskOptions('ssh:b', '/resolved');
    assert.equal(options.models[0].model, 'target-model');
    assert.deepEqual(options.current,{model:b.state.model,effort:b.state.reasoningEffort,access:b.state.access?.mode});
    assert.deepEqual(options.access, { ask: true, auto: true, full: true });
    assert.equal(b.permissionProfiles.length, 0); // Read-only options do not replace attached-task settings.
    const result = await gateway.taskAction({ action: 'create', machineId: 'ssh:b', expectedMachineId: 'local', expectedThreadId: 'a', name: 'Fresh', ...settings });
    assert.equal(result.machineId, 'ssh:b');assert.equal(a.state.thread, null);
    assert.equal(result.thread.id, 'new');
    assert(!calls.some(c => ['thread/resume', 'thread/name/set', 'turn/start'].includes(c.method)));
    const updates = calls.filter(c => c.method === 'thread/settings/update').map(c => c.params);
    if (!settings.model) assert.deepEqual(updates, []);
    else if (settings.model === 'target-model') {
      assert.deepEqual(updates, [{ threadId: 'new', model: 'target-model', effort: 'high' }, { threadId: 'new', approvalsReviewer: 'auto_review', approvalPolicy: 'on-request' }]);
      assert.equal(result.warning, undefined);
    } else { assert.match(result.warning, /Task created.*Model\/effort/);assert.equal(updates[0].permissions, ':full-access'); }
    assert.equal((await b.sendMessage('Real first message', 'start')).accepted, true);
    assert(calls.findIndex(c => c.method === 'turn/start') > calls.findLastIndex(c => c.method === 'thread/settings/update'));
  }
});

test('Unconfirmed fresh-task access never falls back to resuming the zero-turn thread', async () => {
  const runtime = activeRuntime();
  runtime.pendingTaskNames.set('thread-1', { name: 'Fresh', firstMessageAccepted: false });
  runtime.state.access = { mode: 'ask', choices: { auto: { available: true } } };
  runtime.waitForSettingsUpdate = async () => false;
  const calls = [];
  runtime.rpc = { request: async method => { calls.push(method); return {}; } };
  await assert.rejects(runtime.updateAccessNow('auto'), /could not be confirmed/);
  assert.deepEqual(calls, ['thread/settings/update']);
});

test('Task queues survive same-machine and cross-machine entry without background delivery', async () => {
  for (const cross of [false, true]) {
    const gateway = new PocketGateway({ machines: [{ name: 'B', ssh: 'b' }] });
    const a = gateway.runtimes.get('local'), b = gateway.runtimes.get(cross ? 'ssh:b' : 'local');
    const bId = cross ? 'ssh:b' : 'local';
    const calls = [];
    for (const runtime of new Set([a,b])) {
      runtime.state.connected = true;
      runtime.canAcceptDirectInput = true;
      runtime.rpc = { request: async (method, params) => {
        calls.push({ method, params });
        if (method === 'thread/list') return { data: ['a','b'].map(id=>({id,name:id,cwd:'/project',status:'idle'})) };
        if (method === 'thread/resume') return { thread: {id:params.threadId,name:params.threadId,cwd:'/project',status:'idle',canAcceptDirectInput:true} };
        if (method === 'turn/start') return { turn: { id: 'sent', status: 'inProgress' } };
        return { data: [] };
      } };
      runtime.finalizeTerminalMessages = async () => {};
    }
    Object.assign(a.state,{thread:{id:'a'},threadStatus:'active',turn:{id:'a-turn',status:'inProgress'},phase:'working'});
    await a.sendMessage('Queue A','queue',[png]);
    const queueA = structuredClone(a.state.queuedMessage);
    await gateway.selectDestination(bId,'b','local','a');
    assert.equal(gateway.snapshot().queuedMessage,null);
    assert.deepEqual(a.taskQueues.get('a'),queueA);
    a.handleNotification({method:'turn/completed',params:{threadId:'a',turn:{id:'a-turn',status:'completed'}}});
    await a.selectionQueue;
    assert(!calls.some(c=>c.method==='turn/start'));
    Object.assign(b.state,{threadStatus:'active',turn:{id:'b-turn',status:'inProgress'},phase:'working'});
    await b.sendMessage('Queue B','queue');
    await gateway.selectDestination('local','a',bId,'b');
    assert.deepEqual(gateway.snapshot().queuedMessage,queueA); // A reload receives the restored images too.
    assert.equal(b.taskQueues.get('b').text,'Queue B');
    a.handleNotification({method:'turn/completed',params:{threadId:'a',turn:{id:'a-turn',status:'completed'}}});
    await a.selectionQueue;
    assert(!calls.some(c=>c.method==='turn/start'));
    assert.equal(a.cancelQueuedMessage().cancelled,true);
    assert.equal(a.state.queuedMessage,null);assert(!a.taskQueues.has('a'));
    assert.equal(b.taskQueues.get('b').text,'Queue B');
    Object.assign(a.state,{threadStatus:'active',turn:{id:'next',status:'inProgress'},phase:'working'});
    await a.sendMessage('Send this','queue',[png]);
    a.state.turn = null;a.state.threadStatus='idle';
    await a.sendQueuedMessage('start');
    assert.equal(a.state.queuedMessage,null);assert(!a.taskQueues.has('a'));
    assert(calls.find(c=>c.method==='turn/start').params.input.some(item=>item.type==='image'));
    await gateway.selectDestination(bId,'b','local','a');
    assert.equal(b.state.queuedMessage.text,'Queue B');
    await gateway.selectDestination('local','a',bId,'b');
    await b.taskAction({action:'delete',threadId:'b',confirmed:true});
    assert(!b.taskQueues.has('b'));
  }
});

test('A delayed completion callback cannot send a restored queue after leaving and returning', async () => {
  const runtime = activeRuntime();
  await runtime.sendMessage('Wait for my return', 'queue');
  const calls = [];
  let finish;
  runtime.selectionQueue = new Promise(resolve => { finish = resolve; });
  runtime.finalizeTerminalMessages = async () => {};
  runtime.rpc = { request: async method => { calls.push(method); return method === 'turn/start' ? { turn: { id: 'sent', status: 'inProgress' } } : { data: [] }; } };
  runtime.loadedThreads = ['thread-1','b'].map(id=>({id,name:id,cwd:'/project',status:'idle'}));
  runtime.handleNotification({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});
  for (const id of ['b','thread-1']) await runtime.attachLoadedThread(id,false,{thread:{id,cwd:'/project',status:'idle',canAcceptDirectInput:true}});
  finish();await runtime.selectionQueue;
  assert.equal(runtime.state.queuedMessage.text,'Wait for my return');
  assert(!calls.includes('turn/start'));
  runtime.handleNotification({method:'turn/started',params:{threadId:'thread-1',turn:{id:'new-turn',status:'inProgress'}}});
  runtime.handleNotification({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'new-turn',status:'completed'}}});
  await runtime.selectionQueue;
  assert.equal(calls.filter(method=>method==='turn/start').length,1);
  assert.equal(runtime.state.queuedMessage,null);
});

test('Only successful active completion automatically sends a queued message', async () => {
  for (const status of ['completed','failed','interrupted',undefined]) {
    const runtime=activeRuntime();await runtime.sendMessage('Follow up','queue',[png]);
    let starts=0;runtime.finalizeTerminalMessages=async()=>{};
    runtime.rpc={request:async method=>{if(method==='turn/start'){starts++;return {turn:{id:'next',status:'inProgress'}};}return {data:[]};}};
    runtime.handleNotification({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status}}});
    await runtime.selectionQueue;
    assert.equal(starts,status==='completed'?1:0);
    assert.equal(Boolean(runtime.state.queuedMessage),status!=='completed');
  }
});

test('Unexpected disconnect and failed reconnect preserve image queue without sending', async (t) => {
  const runtime=activeRuntime();await runtime.sendMessage('Keep this','queue',[png]);
  const queued=structuredClone(runtime.state.queuedMessage);
  runtime.scheduleReconnect=()=>{};
  runtime.handleClose(new Error('Connection lost'));
  assert.deepEqual(runtime.taskQueues.get('thread-1'),queued);
  let fail=true;const calls=[];
  t.mock.method(RpcClient.prototype,'connect',async()=>{if(fail)throw new Error('Transport unavailable');});
  t.mock.method(RpcClient.prototype,'close',()=>{});
  t.mock.method(RpcClient.prototype,'notify',()=>{});
  t.mock.method(RpcClient.prototype,'request',async method=>{
    calls.push(method);
    const thread={id:'thread-1',name:'Task',cwd:'/project',status:'idle',canAcceptDirectInput:true};
    if(method==='thread/list')return {data:[thread]};
    if(method==='thread/read'||method==='thread/resume')return {thread};
    return {data:[]};
  });
  await runtime.connect();
  assert.deepEqual(runtime.taskQueues.get('thread-1'),queued);
  fail=false;await runtime.connect();
  assert.deepEqual(runtime.snapshot().queuedMessage,queued);
  assert(calls.includes('thread/resume'));
  assert(!calls.includes('turn/start'));
});

test('Confirmed deletion removes all per-task runtime bookkeeping', async () => {
  const runtime=activeRuntime();runtime.state.turn=null;runtime.state.threadStatus='idle';
  const id='thread-1';
  for(const key of ['taskQueues','pendingTaskNames','contextByThread','taskStatuses','taskStatusObservations','terminalReads'])runtime[key].set(id,{});
  runtime.terminalResults[id]='Done';
  runtime.refreshLoadedThreads=async()=>[{id,name:'Task',status:'idle'}];
  await runtime.taskAction({action:'delete',threadId:id,confirmed:true});
  for(const key of ['taskQueues','pendingTaskNames','contextByThread','taskStatuses','taskStatusObservations','terminalReads'])assert(!runtime[key].has(id),key);
  assert.equal(runtime.terminalResults[id],undefined);
});

test('Settings preserve saved PIN without copying an environment override', async () => {
  const {mkdtempSync,readFileSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {saveLocalSettings,settingsNeedRestart}=await import('../gateway.ts');
  const dir=mkdtempSync(join(tmpdir(),'pocket-pin-settings-'));
  const previousPin=process.env.CODEX_POCKET_PIN;
  process.env.CODEX_POCKET_PIN='9876';
  const settings={path:join(dir,'config.json'),config:{lanEnabled:true,host:'0.0.0.0',port:4173,pin:null,localName:'',machines:[]}};
  try {
    saveLocalSettings(settings,{...settings.config,pin:'',localName:'Host'},undefined,false);
    assert.equal(settings.config.pin,null);
    assert.equal(JSON.parse(readFileSync(settings.path,'utf8')).pin,null);
    assert(!readFileSync(settings.path,'utf8').includes('9876'));
    assert.throws(()=>saveLocalSettings(settings,{...settings.config,pin:''},null,false),/LAN access requires/);
    saveLocalSettings(settings,{...settings.config,pin:'1234'},'9876',false);
    saveLocalSettings(settings,{...settings.config,pin:''},'9876',false);
    assert.equal(settings.config.pin,'1234');
    const options=parseArgs([],{...settings.config});
    assert.equal(settingsNeedRestart(settings,options,{pin:'9876'},[],'9876'),false);
    assert.equal(settingsNeedRestart(settings,options,{pin:'1234'},[],'9876'),true);
  } finally {
    if(previousPin===undefined)delete process.env.CODEX_POCKET_PIN;else process.env.CODEX_POCKET_PIN=previousPin;
    rmSync(dir,{recursive:true,force:true});
  }
});

test('Restart-required compares effective launch overrides and unmasked settings', async () => {
  const {settingsNeedRestart}=await import('../gateway.ts');
  const settings={config:{lanEnabled:true,host:'0.0.0.0',port:4173,pin:'1234',localName:'Host',machines:[]}};
  const args=['--host','127.0.0.1','--port','4888'];
  const options=parseArgs(args,settings.config);
  const auth={pin:'9876'};
  assert.equal(settingsNeedRestart(settings,options,auth,args,'9876'),false);
  settings.config.host='192.168.1.10';settings.config.port=5000;settings.config.pin='5678';
  assert.equal(settingsNeedRestart(settings,options,auth,args,'9876'),false);
  settings.config.localName='New host';
  assert.equal(settingsNeedRestart(settings,options,auth,args,'9876'),true);
  settings.config.localName='Host';settings.config.machines=[{name:'Remote',ssh:'remote'}];
  assert.equal(settingsNeedRestart(settings,options,auth,args,'9876'),true);
  settings.config.machines=[];
  assert.equal(settingsNeedRestart(settings,options,auth,[],'9876'),true);
});

test('Compaction alone survives release and is authoritatively reconciled on reattach', async () => {
  for (const outcome of ['running','completed-away','different-turn','finished','unreadable','racing-completion','incomplete','older-completion','second-completed-away']) {
    const runtime=activeRuntime();const item={id:'a750986f-933a-41cc-a30f-fec514d17671',type:'contextCompaction'};
    const older={id:'item-3',type:'contextCompaction'};
    runtime.rpc={request:async()=>({data:['older-completion','second-completed-away'].includes(outcome)?[{item:older}]:[]})};
    runtime.handleNotification({method:'item/started',params:{threadId:'thread-1',turnId:'turn-1',item}});
    assert.equal(runtime.state.activities[0].label,'Compacting context');
    await runtime.releaseTask();assert.equal(runtime.state.activities.length,0);
    const calls=[];
    runtime.rpc={request:async(method,params,timeout)=>{
      calls.push({method,params,timeout});
      if(method==='thread/turns/list')return {data:outcome==='finished'?[]:[{id:outcome==='different-turn'?'turn-2':'turn-1',status:'inProgress'}]};
      if(method==='thread/items/list'){
        if(outcome==='unreadable')throw new Error('Unavailable');
        if(outcome==='incomplete')return {data:[],nextCursor:'repeated'};
        if(outcome==='racing-completion')runtime.handleNotification({method:'item/completed',params:{threadId:'thread-1',turnId:'turn-1',item}});
        return {data:outcome==='second-completed-away'?[{turnId:'turn-1',item:older},{turnId:'turn-1',item:{...item,id:'item-7'}}]:outcome==='completed-away'?[{turnId:'turn-1',item:{...item,id:'item-7'}}]:outcome==='older-completion'?[{turnId:'turn-1',item:older}]:[]};
      }
      return {data:[]};
    }};
    runtime.loadedThreads=[{id:'thread-1',name:'Task',cwd:'/project',status:outcome==='finished'?'idle':'active'}];
    await runtime.attachLoadedThread('thread-1',false,{thread:{id:'thread-1',cwd:'/project',status:outcome==='finished'?'idle':'active',canAcceptDirectInput:true}});
    const activities=runtime.state.activities;
    if(outcome==='running'||outcome==='older-completion'){
      assert.equal(activities[0].label,'Compacting context');
      runtime.handleNotification({method:'item/completed',params:{threadId:'thread-1',turnId:'turn-1',item}});
      assert.equal(runtime.state.activities.length,1);assert.equal(runtime.state.activities[0].label,'Context compacted');
      assert(!runtime.compactionHints.has('thread-1'));
    } else if(['completed-away','second-completed-away','racing-completion'].includes(outcome)) {
      assert.equal(activities.length,1);assert.equal(activities[0].status,'completed');
    } else assert.equal(activities.length,0);
    const reads=calls.filter(c=>c.method==='thread/items/list');
    assert.equal(reads.length,['different-turn','finished'].includes(outcome)?0:outcome==='incomplete'?2:1);
    if(reads.length){assert.equal(reads[0].params.turnId,'turn-1');assert(reads[0].timeout<=5000);}
  }
});

test('Reattachment awaits the original compaction baseline after an immediate switch', async () => {
  for (const invalidate of [false,true]) {
    const runtime=activeRuntime();let releaseBaseline, enteredRestore;
    const baseline=new Promise(resolve=>{releaseBaseline=resolve;});
    const restoring=new Promise(resolve=>{enteredRestore=resolve;});
    let baselineReads=0,reconcileReads=0;
    runtime.rpc={request:async method=>{if(method==='thread/items/list'){baselineReads++;return baseline;}return {data:[]};}};
    runtime.handleNotification({method:'item/started',params:{threadId:'thread-1',turnId:'turn-1',item:{id:'live-uuid',type:'contextCompaction'}}});
    const hint=runtime.compactionHints.get('thread-1');
    await runtime.releaseTask();
    assert.equal(hint.occurrence,undefined);
    runtime.rpc={request:async method=>{
      if(method==='thread/turns/list')return {data:[{id:'turn-1',status:'inProgress'}]};
      if(method==='thread/items/list'){reconcileReads++;return {data:[]};}
      return {data:[]};
    }};
    runtime.loadedThreads=[{id:'thread-1',name:'Task',cwd:'/project',status:'active'}];
    const restore=runtime.restoreCompactionHint.bind(runtime);
    runtime.restoreCompactionHint=()=>{enteredRestore();return restore();};
    const attaching=runtime.attachLoadedThread('thread-1',false,{thread:{id:'thread-1',cwd:'/project',status:'active',canAcceptDirectInput:true}});
    await restoring;
    assert.equal(reconcileReads,0);
    if(invalidate)runtime.handleNotification({method:'turn/started',params:{threadId:'thread-1',turn:{id:'new-turn',status:'inProgress'}}});
    releaseBaseline({data:[]});
    await attaching;
    assert.equal(baselineReads,1);
    assert.equal(reconcileReads,invalidate?0:1);
    assert.equal(runtime.state.activities.length,invalidate?0:1);
    if(!invalidate)assert.equal(runtime.state.activities[0].label,'Compacting context');
    else assert.equal(hint.occurrence,undefined);
  }
});

test('Selected terminal events clear attention markers for every terminal status', () => {
  for(const status of ['completed','failed','interrupted']) {
    const runtime=activeRuntime();runtime.terminalResults['thread-1']='Done';runtime.finalizeTerminalMessages=async()=>{};
    runtime.handleNotification({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status}}});
    assert.equal(runtime.snapshot().taskTerminalResults['thread-1'],undefined);
    assert.equal(runtime.state.turn.status,status);
  }
});


test("Known usage-limit copy is concise without rewriting unrelated errors", () => {
  const raw = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 17th, 2026 1:07 PM.";
  assert.equal(usageLimitMessage(raw, 2026), "Usage limit reached. Try again Sep 17 at 1:07 PM.");
  assert.equal(usageLimitMessage(raw, 2025), "Usage limit reached. Try again Sep 17, 2026 at 1:07 PM.");
  const unrelated = "Upstream capacity reached. Try again later.";
  assert.equal(usageLimitMessage(unrelated) || unrelated, unrelated);
});

function freshTaskGateway() {
  const gateway = new PocketGateway({ machines: [{ name: 'B', ssh: 'b' }] });
  const calls = [];
  for (const [machineId, runtime] of gateway.runtimes) {
    const tasks = [{ id: 'fresh', name: 'Fresh', cwd: '/project', status: 'idle', canAcceptDirectInput: true },
      { id: 'other', name: 'Other', cwd: '/project', status: 'idle', canAcceptDirectInput: true }];
    Object.assign(runtime.state, { connected: true, thread: machineId === 'local' ? { ...tasks[0] } : null, turn: null, threadStatus: 'idle', phase: 'idle' });
    runtime.canAcceptDirectInput = true;
    runtime.rpc = { request: async (method, params) => {
      calls.push({ machineId, method, params });
      if (method === 'thread/list') return { data: tasks };
      if (method === 'thread/loaded/list') return { data: tasks.map(t => t.id) };
      if (method === 'thread/read' || method === 'thread/resume') {
        if (method === 'thread/resume') { assert.equal(params.excludeTurns, true); assert.notEqual(params.threadId, 'fresh'); }
        return { thread: tasks.find(t => t.id === params.threadId) };
      }
      if (method === 'turn/start') {
        if (runtime.rejectStart) throw new Error('First send failed');
        return { turn: { id: 'accepted', status: 'inProgress' } };
      }
      if (method === 'thread/delete') tasks.splice(tasks.findIndex(t => t.id === params.threadId), 1);
      assert.notEqual(method, 'thread/start', 'must reject before creating another thread');
      return { data: [] };
    } };
  }
  const runtime = gateway.runtimes.get('local');
  runtime.pendingTaskNames.set('fresh', { name: 'Fresh', firstMessageAccepted: false });
  return { gateway, runtime, calls };
}
const freshTaskError = { message: 'Send the first message before leaving this new task.' };

test('fresh task blocks both same-machine selection routes and preserves current state', async () => {
  const { gateway, runtime, calls } = freshTaskGateway();
  const before = gateway.snapshot();
  await assert.rejects(gateway.selectThread('local', 'other'), freshTaskError);
  await assert.rejects(gateway.selectDestination('local', 'other', 'local', 'fresh'), freshTaskError);
  assert.deepEqual(gateway.snapshot(), before);
  assert.deepEqual(calls, []);
  await gateway.selectDestination('local', 'fresh', 'local', 'fresh');
  assert.equal(runtime.state.thread.id, 'fresh');
  assert(!calls.some(c => ['thread/resume', 'thread/unsubscribe'].includes(c.method)));
});

test('fresh task blocks cross-machine selection before any destination attach or release', async () => {
  const { gateway, calls } = freshTaskGateway();
  const before = gateway.snapshot();
  await assert.rejects(gateway.selectDestination('ssh:b', 'other', 'local', 'fresh'), freshTaskError);
  assert.deepEqual(gateway.snapshot(), before);
  assert.equal(gateway.runtimes.get('ssh:b').state.thread, null);
  assert.deepEqual(calls, []);
});

test('fresh task blocks New Task on either machine before thread/start', async () => {
  const { gateway, runtime, calls } = freshTaskGateway();
  for (const machineId of ['local', 'ssh:b']) {
    await assert.rejects(gateway.taskAction({ action: 'create', machineId, expectedMachineId: 'local', expectedThreadId: 'fresh', name: 'Next' }), freshTaskError);
  }
  await assert.rejects(runtime.taskAction({ action: 'create', name: 'Next' }), freshTaskError);
  assert.equal(runtime.state.thread.id, 'fresh');
  assert.deepEqual(calls, []);
});

test('fresh task Rename remains in memory, Archive is blocked, and Delete discards it', async () => {
  const { gateway, runtime, calls } = freshTaskGateway();
  const action = (action, extra = {}) => gateway.taskAction({ action, machineId: 'local', expectedMachineId: 'local', expectedThreadId: 'fresh', threadId: 'fresh', ...extra });
  await action('rename', { name: 'Renamed' });
  assert.deepEqual(runtime.pendingTaskNames.get('fresh'), { name: 'Renamed', firstMessageAccepted: false });
  assert.equal(runtime.state.thread.name, 'Renamed');
  assert(!calls.some(c => ['thread/name/set', 'thread/resume', 'turn/start'].includes(c.method)));
  calls.length = 0;
  await assert.rejects(action('archive'), freshTaskError);
  assert.deepEqual(calls, []);
  await action('delete', { confirmed: true });
  assert.equal(runtime.state.thread, null);
  assert.equal(runtime.pendingTaskNames.has('fresh'), false);
  assert(calls.some(c => c.method === 'thread/delete'));
});

test('failed first Start keeps the guard; accepted Start restores destination-before-authority switching', async () => {
  for (const destination of ['local', 'ssh:b']) {
    const { gateway, runtime, calls } = freshTaskGateway();
    runtime.rejectStart = true;
    await assert.rejects(gateway.sendMessage('local', 'Real input', 'start', [], [], undefined, 'fresh'), /First send failed/);
    assert.equal(runtime.pendingTaskNames.get('fresh').firstMessageAccepted, false);
    assert.equal(runtime.state.turn, null);
    await assert.rejects(gateway.selectDestination(destination, 'other', 'local', 'fresh'), freshTaskError);
    assert(!calls.some(c => ['thread/resume', 'thread/name/set'].includes(c.method)));
    runtime.rejectStart = false;
    assert.equal((await gateway.sendMessage('local', 'Real input', 'start', [], [], undefined, 'fresh')).accepted, true);
    await gateway.selectDestination(destination, 'other', 'local', 'fresh');
    assert.equal(gateway.state.thread.id, 'other');
    assert.equal(gateway.selectedMachineId, destination);
    const attach = calls.findIndex(c => c.method === 'thread/resume');
    const release = calls.findIndex(c => c.method === 'thread/unsubscribe');
    assert(attach >= 0 && release > attach);
    assert(calls.filter(c => c.method === 'thread/resume').every(c => c.params.excludeTurns === true));
  }
});

test('Stop awaits active goal pause before interrupting the exact turn', async () => {
  const runtime = activeRuntime(), calls = [];
  let finishPause;
  runtime.rpc = { request: async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/goal/get') return { goal: { threadId: 'thread-1', status: 'active' } };
    if (method === 'thread/goal/set') return new Promise(resolve => { finishPause = () => resolve({ goal: { threadId: 'thread-1', status: 'paused' } }); });
    return {};
  } };
  const stopping = runtime.interruptTurn('thread-1', 'turn-1');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runtime.state.stoppingTurnId, 'turn-1');
  assert.deepEqual(calls, [
    { method: 'thread/goal/get', params: { threadId: 'thread-1' } },
    { method: 'thread/goal/set', params: { threadId: 'thread-1', status: 'paused' } },
  ]);
  finishPause();
  assert.deepEqual(await stopping, { accepted: true });
  assert.equal(runtime.state.goal.status, 'paused');
  assert.deepEqual(calls[2], { method: 'turn/interrupt', params: { threadId: 'thread-1', turnId: 'turn-1' } });
  assert.equal(calls.length, 3);
  await assert.rejects(runtime.interruptTurn('thread-1', 'turn-1'), /already stopping/);
  assert.equal(calls.length, 3);
});

test('Stop only interrupts ordinary turns and never rewrites a non-active goal', async () => {
  for (const status of [null, 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']) {
    const runtime = activeRuntime(), calls = [];
    runtime.rpc = { request: async (method, params) => {
      calls.push({ method, params });
      return method === 'thread/goal/get' ? { goal: status === null ? null : { status } } : {};
    } };
    assert.deepEqual(await runtime.interruptTurn('thread-1', 'turn-1'), { accepted: true });
    assert.deepEqual(calls, [
      { method: 'thread/goal/get', params: { threadId: 'thread-1' } },
      { method: 'turn/interrupt', params: { threadId: 'thread-1', turnId: 'turn-1' } },
    ]);
  }
});

test('Stop rejects stale thread/turn and inactive turns before any goal RPC', async () => {
  for (const [threadId, turnId, completed, error] of [
    ['wrong', 'turn-1', false, /selected task changed/],
    ['thread-1', 'wrong', false, /active turn changed/],
    ['thread-1', 'turn-1', true, /no active turn/],
  ]) {
    const runtime = activeRuntime(), calls = [];
    if (completed) runtime.state.turn.status = 'completed';
    runtime.rpc = { request: async method => { calls.push(method); return {}; } };
    await assert.rejects(runtime.interruptTurn(threadId, turnId), error);
    assert.deepEqual(calls, []);
    assert.equal(runtime.state.stoppingTurnId, null);
  }
});

test('goal read or pause failure rejects Stop, clears its guard, and permits retry', async () => {
  for (const failure of ['thread/goal/get', 'thread/goal/set', 'turn/interrupt']) {
    const runtime = activeRuntime(), calls = [];
    let fail = true;
    runtime.rpc = { request: async method => {
      calls.push(method);
      if (fail && method === failure) throw new Error('Stop RPC failed');
      return method === 'thread/goal/get' ? { goal: { status: 'active' } } : {};
    } };
    await assert.rejects(runtime.interruptTurn('thread-1', 'turn-1'), /Stop RPC failed/);
    assert.equal(runtime.state.stoppingTurnId, null);
    assert.equal(runtime.state.turn.status, 'inProgress');
    const order = ['thread/goal/get', 'thread/goal/set', 'turn/interrupt'];
    assert.deepEqual(calls, order.slice(0, order.indexOf(failure) + 1));
    calls.length = 0; fail = false;
    assert.deepEqual(await runtime.interruptTurn('thread-1', 'turn-1'), { accepted: true });
    assert.deepEqual(calls, order);
  }
});

test('Wake MAC normalization, config round-trip, and exact magic packet', async () => {
  const { normalizeWakeMac, wakeMagicPacket, saveLocalSettings } = await import('../gateway.ts');
  for (const mac of ['aa:bb:cc:dd:ee:ff','AA-BB-CC-DD-EE-FF','aabbccddeeff',' AA:BB:CC:DD:EE:FF ']) assert.equal(normalizeWakeMac(mac),'AA:BB:CC:DD:EE:FF');
  for (const mac of ['',null,42,'AA:BB:CC:DD:EE','AA:BB:CC:DD:EE:GG','AA:BB-CC:DD:EE:FF','aabbccddeeff00']) assert.throws(()=>normalizeWakeMac(mac),/valid Wake-on-LAN MAC/);
  const packet=wakeMagicPacket('AA:BB:CC:DD:EE:FF');
  assert.equal(packet.length,102);
  assert.equal(packet.toString('hex'),'ff'.repeat(6)+'aabbccddeeff'.repeat(16));
  const {mkdtempSync,readFileSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');
  const dir=mkdtempSync(`${tmpdir()}/pocket-wake-`);
  const settings={path:`${dir}/config.json`,config:{lanEnabled:false,host:'127.0.0.1',port:4173,pin:'1234',localName:'',machines:[]}};
  try {
    const machines=[{name:'Legacy',ssh:'legacy'},{name:'PC',ssh:'pc',wakeMac:'aa-bb-cc-dd-ee-ff'}];
    saveLocalSettings(settings,{...settings.config,machines},null,false);
    assert.deepEqual(settings.config.machines,[machines[0],{...machines[1],wakeMac:'AA:BB:CC:DD:EE:FF'}]);
    const disk=readFileSync(settings.path,'utf8');
    assert.throws(()=>saveLocalSettings(settings,{...settings.config,machines:[{...machines[1],wakeMac:'invalid'}]},null,false),/valid Wake/);
    assert.equal(readFileSync(settings.path,'utf8'),disk);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('Wake resolves configured SSH MAC, preserves selection, and nudges existing reconnect only after UDP success', async t => {
  const dgram=(await import('node:dgram')).default;
  const {syncBuiltinESMExports}=await import('node:module');
  const {EventEmitter}=await import('node:events');
  const calls=[];let sendError=null, closed=0;
  t.mock.method(dgram,'createSocket',type=>{
    assert.equal(type,'udp4');
    const socket=new EventEmitter();
    socket.bind=(port,callback)=>{assert.equal(port,0);queueMicrotask(callback);};
    socket.setBroadcast=enabled=>assert.equal(enabled,true);
    socket.send=(packet,port,address,callback)=>{calls.push({packet,port,address});callback(sendError);};
    socket.close=()=>closed++;
    return socket;
  });
  syncBuiltinESMExports();
  const gateway=new PocketGateway({machines:[{name:'PC',ssh:'pc',wakeMac:'AA:BB:CC:DD:EE:FF'},{name:'Legacy',ssh:'legacy'}]});
  const local=gateway.runtimes.get('local'),pc=gateway.runtimes.get('ssh:pc');
  local.state.thread={id:'selected'};
  const before=gateway.snapshot();
  pc.reconnectDelayIndex=4;pc.scheduleReconnect();const originalTimer=pc.reconnectTimer;
  try {
    for(const id of ['missing','local','ssh:legacy',{machineId:'ssh:pc',mac:'11:22:33:44:55:66'}])await assert.rejects(gateway.wakeMachine(id),/not configured/);
    assert.equal(calls.length,0);
    const catalog=await gateway.navigationCatalog();
    assert.deepEqual(catalog.machines.map(m=>m.canWake),[false,true,false]);
    assert(!JSON.stringify(catalog).includes('AA:BB'));
    pc.state.connected=true;
    assert.equal(pc.machineSummary().canWake,false);
    await assert.rejects(gateway.wakeMachine('ssh:pc'),/already connected/);
    pc.state.connected=false;
    sendError=new Error('send EACCES');
    await assert.rejects(gateway.wakeMachine('ssh:pc'),/send EACCES/);
    assert.equal(pc.reconnectTimer,originalTimer);assert.equal(pc.reconnectDelayIndex,4);
    sendError=null;
    assert.deepEqual(await gateway.wakeMachine('ssh:pc'),{sent:true});
    assert.notEqual(pc.reconnectTimer,originalTimer);
    assert.equal(pc.reconnectTimer._idleTimeout,5000);assert.equal(pc.reconnectDelayIndex,1);
    assert.equal(originalTimer._destroyed,true);
    assert.equal(calls[1].port,9);assert.equal(calls[1].address,'255.255.255.255');
    assert.equal(calls[1].packet.toString('hex'),'ff'.repeat(6)+'aabbccddeeff'.repeat(16));
    assert.equal(closed,2);
    assert.deepEqual(gateway.snapshot(),before);
    // A connection already in flight is left alone; its next failure starts at the short delay.
    clearTimeout(pc.reconnectTimer);pc.reconnectTimer=null;pc.rpc={};pc.reconnectDelayIndex=4;
    await gateway.wakeMachine('ssh:pc');
    assert.equal(pc.reconnectTimer,null);assert.equal(pc.reconnectDelayIndex,0);
  } finally {if(pc.reconnectTimer)clearTimeout(pc.reconnectTimer);t.mock.restoreAll();syncBuiltinESMExports();}
});

test('Goal notifications expose only useful fields for the selected task and reset on release', async () => {
  const runtime=activeRuntime();
  const goal={objective:'Finish the task',status:'active',timeUsedSeconds:123,tokensUsed:42,tokenBudget:500,threadId:'thread-1',createdAt:1,updatedAt:2,extra:'omit'};
  runtime.handleNotification({method:'thread/goal/updated',params:{threadId:'other',goal}});
  assert.equal(runtime.state.goal,null);
  runtime.handleNotification({method:'thread/goal/updated',params:{threadId:'thread-1',goal}});
  assert.deepEqual(runtime.snapshot().goal,{objective:goal.objective,status:'active',timeUsedSeconds:123,tokensUsed:42,tokenBudget:500});
  runtime.handleNotification({method:'thread/goal/cleared',params:{threadId:'other'}});
  assert.equal(runtime.state.goal.status,'active');
  runtime.handleNotification({method:'thread/goal/cleared',params:{threadId:'thread-1'}});
  assert.equal(runtime.state.goal,null);
  runtime.handleNotification({method:'thread/goal/updated',params:{threadId:'thread-1',goal}});
  await runtime.releaseTask();assert.equal(runtime.state.goal,null);
});

test('Goal attachment reads current state and replays a newer notification over the read', async () => {
  for(const notified of [false,true]){
    const runtime=activeRuntime();
    runtime.loadedThreads=[{id:'next',name:'Next',cwd:'/tmp',status:'idle'}];
    const calls=[];
    runtime.rpc={request:async(method,params)=>{
      calls.push({method,params});
      if(method==='thread/resume')return {thread:{id:'next',cwd:'/tmp',status:'idle'}};
      if(method==='thread/goal/get'){
        if(notified)runtime.handleNotification({method:'thread/goal/updated',params:{threadId:'next',goal:{objective:'New state',status:'paused'}}});
        return {goal:{objective:'Initial',status:'active',timeUsedSeconds:5}};
      }
      return {data:[]};
    }};
    await runtime.attachLoadedThread('next',false);
    assert.equal(runtime.state.goal.status,notified?'paused':'active');
    assert.deepEqual(calls.find(c=>c.method==='thread/goal/get').params,{threadId:'next'});
    assert(calls.findIndex(c=>c.method==='thread/goal/get')<calls.findIndex(c=>c.method==='thread/unsubscribe'));
  }
});

test('Goal actions use exact status values, require Clear confirmation, and reject stale selection', async () => {
  const gateway=new PocketGateway({machines:[]}),runtime=gateway.runtimes.get('local'),calls=[];
  Object.assign(runtime.state,{connected:true,thread:{id:'selected'},goal:{objective:'Goal',status:'active'}});
  runtime.rpc={request:async(method,params)=>{
    calls.push({method,params});
    return method==='thread/goal/clear'?{cleared:true}:{goal:{objective:'Goal',status:params.status,timeUsedSeconds:10}};
  }};
  const act=(action,extra={})=>gateway.goalAction({machineId:'local',threadId:'selected',action,...extra});
  await assert.rejects(act('pause',{threadId:'old'}),/Selected task changed/);
  await assert.rejects(act('clear'),/Confirm/);assert.equal(calls.length,0);
  assert.equal((await act('pause')).goal.status,'paused');
  assert.equal((await act('resume')).goal.status,'active');
  assert.deepEqual(calls,[{method:'thread/goal/set',params:{threadId:'selected',status:'paused'}},{method:'thread/goal/set',params:{threadId:'selected',status:'active'}}]);
  runtime.state.goal.status='blocked';await assert.rejects(act('resume'),/status changed/);
  runtime.rpc.request=async()=>{throw new Error('Goal update failed');};
  await assert.rejects(act('clear',{confirmed:true}),/Goal update failed/);assert.equal(runtime.state.goal.status,'blocked');
  runtime.rpc.request=async(method,params)=>{calls.push({method,params});return {cleared:true};};
  assert.equal((await act('clear',{confirmed:true})).goal,null);
  assert.deepEqual(calls.at(-1),{method:'thread/goal/clear',params:{threadId:'selected'}});
});

test('file validation bounds decoded bytes and rejects traversal, forged sizes, and malformed base64', async () => {
  const {fileInputs,MAX_INPUT_FILE_BYTES}=await import('../public/pocket-logic.js');
  const file={name:'report: draft?.pdf',data:Buffer.from([0,255,13,10]).toString('base64'),size:4};
  assert.deepEqual(fileInputs([file]),[{...file,name:'report_ draft_.pdf'}]);
  for(const name of ['测试报告.pdf','日本語 résumé 版本2.xlsx','한국어.txt'])assert.equal(fileInputs([{...file,name}])[0].name,name);
  assert.equal(fileInputs([{...file,name:'测试<>:"|?*报告.pdf'}])[0].name,'测试_______报告.pdf');
  assert.equal(fileInputs([{...file,name:' . 测试报告.pdf. '}])[0].name,'测试报告.pdf');
  assert.equal(fileInputs([{...file,name:'测'.repeat(130)}])[0].name,'测'.repeat(120));
  for(const name of ['../x','..','.', '/tmp/x','C:\\temp\\x','a/b','a\0b','a\nb','测\tb','测\x1fb','测\x7fb',''])assert.throws(()=>fileInputs([{...file,name}]),/name/);
  assert.throws(()=>fileInputs([{...file,path:'/tmp/chosen'}]),/name/);
  for(const data of ['data:application/pdf;base64,AA==','A===','AAAA\n','AB==','A','!!!!'])assert.throws(()=>fileInputs([{...file,data}]),/base64/);
  assert.throws(()=>fileInputs([{...file,size:1}]),/size/);
  assert.throws(()=>fileInputs(Array(5).fill(file)),/up to 4/);
  const large={name:'large.bin',data:Buffer.alloc(MAX_INPUT_FILE_BYTES).toString('base64')};
  assert.equal(fileInputs([large,large]).reduce((sum,f)=>sum+f.size,0),20*1024*1024);
  assert.throws(()=>fileInputs([large,large,file]),/20 MB/);
  assert.throws(()=>fileInputs([{name:'too-large',data:Buffer.alloc(MAX_INPUT_FILE_BYTES+1).toString('base64')}]),/10 MB/);
});

test('local files stage exact bytes in submission-scoped temp paths with server-chosen names', async () => {
  const {stageMessageFiles}=await import('../gateway.ts');
  const {readFile,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {randomUUID}=await import('node:crypto');
  const id=randomUUID(),bytes=Buffer.from(Array.from({length:256},(_,i)=>i));
  const files=[{name:'CON',data:bytes.toString('base64')},{name:'CON',data:''},{name:'测试报告.pdf',data:bytes.toString('base64')}];
  try{
    const staged=await stageMessageFiles(files,id);
    assert.deepEqual(staged,[{name:'CON',path:join(tmpdir(),'codex-pocket',id,'1-CON'),size:256},{name:'CON',path:join(tmpdir(),'codex-pocket',id,'2-CON'),size:0},{name:'测试报告.pdf',path:join(tmpdir(),'codex-pocket',id,'3-测试报告.pdf'),size:256}]);
    assert.deepEqual(await readFile(staged[2].path),bytes);
    assert.deepEqual(await readFile(staged[0].path),bytes);
    assert.deepEqual(await stageMessageFiles(files,id),staged);
    assert.equal('data' in staged[0],false);
    await assert.rejects(stageMessageFiles(files,'../escape'),/submission/);
  }finally{await rm(join(tmpdir(),'codex-pocket',id),{recursive:true,force:true});}
});

test('SSH file staging streams exact binary bytes through the configured alias for POSIX and Windows', async t => {
  const {stageMessageFiles}=await import('../gateway.ts');
  const cp=(await import('node:child_process')).default;const {syncBuiltinESMExports}=await import('node:module');
  const {PassThrough}=await import('node:stream');const {EventEmitter}=await import('node:events');
  const {mkdtemp,readFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const temp=await mkdtemp(join(tmpdir(),'pocket-upload-test-')),spawn=cp.spawn,bytes=Buffer.from([0,255,128,13,10,26,34,39]);
  let windows=false,uploaded,script;
  t.mock.method(cp,'spawn',(command,args,options)=>{
    assert.equal(command,process.env.SSH_BIN||'ssh');assert.equal(args.at(-2),'configured-alias');assert.deepEqual(args.slice(0,-2),['-T','-o','BatchMode=yes','-o','ConnectTimeout=5']);
    if(!windows)return spawn('/bin/sh',['-c',args.at(-1)],{...options,env:{...process.env,TMPDIR:temp}});
    script=Buffer.from(args.at(-1).split(' ').at(-1),'base64').toString('utf16le');
    const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
    const chunks=[];child.stdin.on('data',chunk=>chunks.push(chunk));child.stdin.on('finish',()=>{uploaded=Buffer.concat(chunks);child.stdout.end('C:\\Temp\\codex-pocket\\test-submission\\1-日本語 résumé 版本2.xlsx');child.emit('close',0);});
    return child;
  });syncBuiltinESMExports();
  try{
    const file={name:'日本語 résumé 版本2.xlsx',data:bytes.toString('base64')};
    const [posix]=await stageMessageFiles([file],'test-submission','configured-alias');
    assert.equal(posix.path,join(temp,'codex-pocket','test-submission','1-日本語 résumé 版本2.xlsx'));assert.deepEqual(await readFile(posix.path),bytes);
    windows=true;const [win]=await stageMessageFiles([file],'test-submission','configured-alias',true);
    assert.equal(win.path,'C:\\Temp\\codex-pocket\\test-submission\\1-日本語 résumé 版本2.xlsx');assert.deepEqual(uploaded,bytes);
    assert.match(script,/GetTempPath/);assert.match(script,/codex-pocket\\test-submission/);assert.match(script,/'1-日本語 résumé 版本2.xlsx'/);assert.match(script,/OpenStandardInput\(\)\.CopyTo\(\$f\)/);
  }finally{t.mock.restoreAll();syncBuiltinESMExports();await rm(temp,{recursive:true,force:true});}
});

test('file-only Start, mixed Steer, and queued Start/Steer use staged text inputs and retain no payload', async () => {
  const {rm,readFile}=await import('node:fs/promises');const {join}=await import('node:path');const {tmpdir}=await import('node:os');const {randomUUID}=await import('node:crypto');
  const runtime=activeRuntime(),calls=[],ids=[];
  const files=[{name:'data.zip',data:Buffer.from('exact\0bytes').toString('base64')}];
  const id=()=>{const value=randomUUID();ids.push(value);return value;};
  runtime.rpc={request:async(method,params)=>{calls.push({method,params});return {turn:{id:'next',status:'inProgress'},turnId:'turn-1'};}};
  try{
    runtime.state.turn=null;runtime.state.threadStatus='idle';
    await runtime.sendMessage('','start',[],files,id());
    assert.equal(calls[0].method,'turn/start');assert.equal(calls[0].params.input.length,1);assert.equal(calls[0].params.input[0].type,'text');
    const path=calls[0].params.input[0].text.split('\n- ')[1];assert.deepEqual(await readFile(path),Buffer.from('exact\0bytes'));
    runtime.state.turn={id:'turn-1',status:'inProgress'};runtime.state.threadStatus='active';
    await runtime.sendMessage('Use these','steer',[png],files,id());
    assert.deepEqual(calls.at(-1).params.input.slice(0,2),messageInputs('Use these',[png]));assert.match(calls.at(-1).params.input[2].text,/Attached files available on this machine:/);
    for(const action of ['start','steer']){
      const queuedId=id();await runtime.sendMessage('','queue',[],files,queuedId);
      const queued=runtime.state.queuedMessage;assert.equal('data' in queued.files[0],false);assert.equal('files' in queued,true);
      assert.deepEqual(await readFile(queued.files[0].path),Buffer.from('exact\0bytes'));
      if(action==='start')runtime.state.turn.status='completed';
      await runtime.sendQueuedMessage(action);
      assert.equal(calls.at(-1).method,`turn/${action}`);assert(calls.at(-1).params.input[0].text.includes(queued.files[0].path));assert.equal(runtime.state.queuedMessage,null);
    }
  }finally{for(const value of ids)await rm(join(tmpdir(),'codex-pocket',value),{recursive:true,force:true});}
});

test('file submissions use receipts for recovery and reject a stale task before staging', async () => {
  const {rm}=await import('node:fs/promises');const {join}=await import('node:path');const {tmpdir}=await import('node:os');
  const gateway=new PocketGateway({machines:[]}),runtime=gateway.runtimes.get('local'),calls=[];
  Object.assign(runtime.state,{connected:true,thread:{id:'selected'},threadStatus:'idle'});runtime.canAcceptDirectInput=true;
  runtime.rpc={request:async(method)=>{calls.push(method);return {turn:{id:'accepted',status:'inProgress'}};}};
  const files=[{name:'report.pdf',data:'AA=='}],id=`${gateway.submissions.epoch}-files`;
  await assert.rejects(gateway.sendMessage('local','','start',[],files,id,'old'),/Selected task changed/);assert.equal(calls.length,0);
  try{
    const send=()=>gateway.sendMessage('local','','start',[],files,id,'selected');
    await gateway.submissions.run(id,send);await gateway.submissions.run(id,send);assert.deepEqual(calls,['turn/start']);
    assert.equal(reconcileSubmission(id,{submission:await gateway.submissions.recover(id)},{files}),'accepted');
    assert.equal(reconcileSubmission(id,{machineId:'local',thread:{id:'selected'},queuedMessage:{threadId:'selected',text:'',files:[{name:'report.pdf',path:'irrelevant',size:1}]}},{machineId:'local',threadId:'selected',text:'',action:'queue',files}),'unknown');
    const drafts=new Map();rememberComposerDraft(drafts,'task',{text:'',images:[],files});assert.deepEqual(rememberComposerDraft(drafts,'task').files,files);
  }finally{await rm(join(tmpdir(),'codex-pocket',id),{recursive:true,force:true});}
});

test('upload failure sends no turn or queue; completion during upload starts the staged queue once', async t => {
  const cp=(await import('node:child_process')).default;const {syncBuiltinESMExports}=await import('node:module');
  const {PassThrough}=await import('node:stream');const {EventEmitter}=await import('node:events');
  const runtime=activeRuntime(),calls=[];runtime.definition.ssh='configured-alias';runtime.autoAttach=true;
  runtime.rpc={request:async(method,params)=>{calls.push({method,params});return {turn:{id:'next',status:'inProgress'}};}};
  let fail=true;
  t.mock.method(cp,'spawn',()=>{
    const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
    child.stdin.resume();child.stdin.on('finish',()=>{
      if(fail){child.stderr.end('Remote disk full');child.emit('close',1);}
      else {runtime.state.turn.status='completed';child.stdout.end('/tmp/codex-pocket/test-upload/1-data.bin');child.emit('close',0);}
    });return child;
  });syncBuiltinESMExports();
  const files=[{name:'data.bin',data:'AA=='}];
  try{
    for(const action of ['steer','queue']){
      await assert.rejects(runtime.sendMessage('',action,[],files,'test-upload'),/Remote disk full/);
      assert.equal(runtime.state.queuedMessage,null);assert.equal(calls.length,0);
    }
    fail=false;await runtime.sendMessage('','queue',[],files,'test-upload');
    assert.equal(calls.length,1);assert.equal(calls[0].method,'turn/start');assert.equal(runtime.state.queuedMessage,null);
    assert.match(calls[0].params.input[0].text,/test-upload\/1-data.bin/);
  }finally{t.mock.restoreAll();syncBuiltinESMExports();}
});

const objectiveUuid='b1ed4737-775d-4385-9a95-888a9fac8c68';
const goalReference=path=>`Read the Codex goal objective file at ${path} before continuing.`;
const goalTick=()=>new Promise(resolve=>setImmediate(resolve));

test('initialize retains codexHome privately and the initial Goal read resolves its trusted objective', async t => {
  const home='/tmp/runtime-codex',path=`${home}/attachments/${objectiveUuid}/goal-objective.md`,calls=[];
  t.mock.method(RpcClient.prototype,'connect',async()=>{});
  t.mock.method(RpcClient.prototype,'notify',()=>{});
  t.mock.method(RpcClient.prototype,'close',()=>{});
  t.mock.method(RpcClient.prototype,'request',async(method,params)=>{
    calls.push({method,params});
    if(method==='initialize')return {codexHome:home,platformOs:'linux'};
    if(method==='thread/resume')return {thread:{id:'next',cwd:'/tmp',status:'idle'}};
    if(method==='thread/goal/get')return {goal:{objective:goalReference(path),status:'active'}};
    if(method==='fs/readFile')return {dataBase64:Buffer.from('实际 objective\nSecond line').toString('base64')};
    return {data:[]};
  });
  const runtime=new MachineRuntime({}, {id:'local',name:'Test',ssh:null},()=>{});
  try{
    await runtime.start(false);assert.equal(runtime.codexHome,home);assert.equal('codexHome' in runtime.snapshot(),false);
    runtime.loadedThreads=[{id:'next',cwd:'/tmp',name:'Next'}];await runtime.attachLoadedThread('next',false);await goalTick();
    assert.equal(runtime.state.goal.objective,'实际 objective\nSecond line');
    assert.equal(runtime.upstreamGoal.objective,goalReference(path));assert.equal('upstreamGoal' in runtime.snapshot(),false);
    assert.deepEqual(calls.filter(c=>c.method==='fs/readFile'),[{method:'fs/readFile',params:{path}}]);
  }finally{await runtime.stop();}
});

test('Goal updates resolve exact POSIX and Windows objective paths without changing inline objectives', async () => {
  for(const [home,path,platform] of [
    ['/home/user/.codex',`/home/user/.codex/attachments/${objectiveUuid}/goal-objective.md`,'linux'],
    ['C:\\Users\\测试\\.codex',`C:\\Users\\测试\\.codex\\attachments\\${objectiveUuid}\\goal-objective.md`,'windows'],
  ]){
    const runtime=activeRuntime(),calls=[];runtime.codexHome=home;runtime.state.platform=platform;
    runtime.rpc={request:async(method,params)=>{calls.push({method,params});return {dataBase64:Buffer.from('Build the actual thing.').toString('base64')};}};
    const update=objective=>runtime.handleNotification({method:'thread/goal/updated',params:{threadId:'thread-1',goal:{objective,status:'active'}}});
    update('Normal inline objective');await goalTick();assert.equal(runtime.state.goal.objective,'Normal inline objective');assert.equal(calls.length,0);
    update(goalReference(path));assert.equal(runtime.state.goal.objective,'Goal objective unavailable');await goalTick();
    assert.equal(runtime.state.goal.objective,'Build the actual thing.');assert.deepEqual(calls,[{method:'fs/readFile',params:{path}}]);
    update(goalReference(path));assert.equal(runtime.state.goal.objective,'Build the actual thing.');await goalTick();assert.equal(calls.length,1);
  }
});

test('literal Windows oversized Goal wrapper resolves through updateGoal', async () => {
  const runtime=activeRuntime(),calls=[];
  runtime.codexHome=String.raw`C:\Users\KyouKyou\.codex`;runtime.state.platform='windows';
  const path=String.raw`C:\Users\KyouKyou\.codex\attachments\b1ed4737-775d-4385-9a95-888a9fac8c68\goal-objective.md`;
  const objective=String.raw`Read the Codex goal objective file at C:\Users\KyouKyou\.codex\attachments\b1ed4737-775d-4385-9a95-888a9fac8c68\goal-objective.md before continuing.`;
  runtime.rpc={request:async(method,params)=>{calls.push({method,params});return {dataBase64:Buffer.from('The actual Windows objective').toString('base64')};}};
  runtime.updateGoal('thread-1',{objective,status:'active'});await goalTick();
  assert.deepEqual(calls,[{method:'fs/readFile',params:{path}}]);
  assert.equal(runtime.state.goal.objective,'The actual Windows objective');
  assert.equal(runtime.upstreamGoal.objective,objective);
});

test('Goal reference validation never reads paths outside the exact attachment shape', async () => {
  const runtime=activeRuntime();runtime.codexHome='/home/user/.codex';runtime.state.platform='linux';
  let reads=0;runtime.rpc={request:async()=>{reads++;throw new Error('Should not read');}};
  const root=runtime.codexHome;
  for(const path of [
    `/other/attachments/${objectiveUuid}/goal-objective.md`,`${root}-other/attachments/${objectiveUuid}/goal-objective.md`,
    `${root}/attachments/not-a-uuid/goal-objective.md`,`${root}/attachments/${objectiveUuid}/other.md`,
    `${root}/attachments/${objectiveUuid}/GOAL-OBJECTIVE.md`,`${root}/attachments/${objectiveUuid}/../goal-objective.md`,
    `${root}/attachments/../${objectiveUuid}/goal-objective.md`,`${root}/attachments/${objectiveUuid}/goal-objective.md/extra`,
    `relative/attachments/${objectiveUuid}/goal-objective.md`,`${root}/attachments/${objectiveUuid}/goal-objective.md\n`,
  ]){
    runtime.updateGoal('thread-1',{objective:goalReference(path),status:'active'});await goalTick();
    assert.equal(runtime.state.goal.objective,'Goal objective unavailable');
  }
  runtime.codexHome=null;runtime.updateGoal('thread-1',{objective:goalReference(`${root}/attachments/${objectiveUuid}/goal-objective.md`),status:'active'});await goalTick();
  assert.equal(runtime.state.goal.objective,'Goal objective unavailable');assert.equal(reads,0);
});

test('failed, malformed base64, and invalid UTF-8 objective reads use a neutral fallback', async () => {
  const runtime=activeRuntime();runtime.codexHome='/codex';
  const objective=goalReference(`/codex/attachments/${objectiveUuid}/goal-objective.md`);
  for(const response of [new Error('ENOENT'),{}, {dataBase64:'!!!'}, {dataBase64:Buffer.from([0xc3,0x28]).toString('base64')}]){
    runtime.rpc={request:async()=>{if(response instanceof Error)throw response;return response;}};
    runtime.updateGoal('thread-1',{objective,status:'paused'});await goalTick();
    assert.equal(runtime.state.goal.objective,'Goal objective unavailable');assert.equal(runtime.upstreamGoal.objective,objective);
  }
});

test('stale Goal objective reads cannot overwrite a new goal, cleared goal, task, or connection', async () => {
  for(const change of ['goal','clear','task','connection']){
    const runtime=activeRuntime();runtime.codexHome='/codex';let finish;
    runtime.rpc={request:()=>new Promise(resolve=>finish=resolve)};
    runtime.updateGoal('thread-1',{objective:goalReference(`/codex/attachments/${objectiveUuid}/goal-objective.md`),status:'active'});
    if(change==='clear')runtime.updateGoal('thread-1',null);
    else if(change==='goal')runtime.updateGoal('thread-1',{objective:'New objective',status:'paused'});
    else if(change==='task'){runtime.resetThreadState();runtime.state.thread={id:'new-task'};runtime.updateGoal('new-task',{objective:'Other task objective',status:'active'});}
    else runtime.rpc={request:async()=>({})};
    const expected=structuredClone(runtime.state.goal);finish({dataBase64:Buffer.from('Stale objective').toString('base64')});await goalTick();
    assert.deepEqual(runtime.state.goal,expected);
  }
});


test('queued text edits validate identity/content and preserve all attachment metadata', async () => {
  const runtime=activeRuntime(),events=[];
  runtime.broadcast=(type,value)=>events.push({type,value});
  const original={threadId:'thread-1',text:'Original',createdAt:123,images:[{url:'data:image/png;base64,AA=='}],files:[{path:'C:\\temp\\report.pdf',name:'report.pdf',size:1}],error:'Retained metadata'};
  runtime.state.queuedMessage=original;
  const result=runtime.editQueuedMessage('thread-1','Updated\r\ntext');
  assert.deepEqual(result.queuedMessage,{...original,text:'Updated\ntext'});
  assert.equal(original.text,'Original');assert.equal(result.queuedMessage.images,original.images);assert.equal(result.queuedMessage.files,original.files);
  assert.equal(events.at(-1).type,'queue');assert.equal(events.at(-1).value.queuedMessage,result.queuedMessage);
  runtime.editQueuedMessage('thread-1','');assert.equal(runtime.state.queuedMessage.text,'');
  for(const [threadId,text] of [['wrong','text'],['thread-1',null],['thread-1','x'.repeat(12001)]]){
    const before=runtime.state.queuedMessage;assert.throws(()=>runtime.editQueuedMessage(threadId,text));assert.equal(runtime.state.queuedMessage,before);
  }
  runtime.startingQueuedMessage=true;assert.throws(()=>runtime.editQueuedMessage('thread-1','text'),/already being sent/);runtime.startingQueuedMessage=false;
  runtime.state.queuedMessage={threadId:'thread-1',text:'Text only',createdAt:456};
  assert.throws(()=>runtime.editQueuedMessage('thread-1','  '),/Enter a message/);
  runtime.editQueuedMessage('thread-1','x'.repeat(12000));assert.equal(runtime.state.queuedMessage.text.length,12000);
  runtime.state.queuedMessage=null;assert.throws(()=>runtime.editQueuedMessage('thread-1','text'),/no longer/);
});

test('queue PATCH enforces selected machine/thread and JSON before updating text', async () => {
  const {handleRequest}=await import('../gateway.ts');const {createServer}=await import('node:http');
  const gateway=new PocketGateway({machines:[]}),runtime=activeRuntime();gateway.runtimes.set('local',runtime);
  runtime.state.queuedMessage={threadId:'thread-1',text:'Before',images:[],files:[],createdAt:12};
  const server=createServer((req,res)=>{handleRequest(req,res,gateway,{required:false},{},{host:'127.0.0.1'},async()=>({localUrl:'/'}),()=>{},()=>false).catch(error=>{res.statusCode=500;res.end(error.message);});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const url=`http://127.0.0.1:${server.address().port}/api/message/queue`;
    const patch=(body,type='application/json')=>fetch(url,{method:'PATCH',headers:{'Content-Type':type},body:JSON.stringify(body)});
    assert.equal((await patch({machineId:'other',threadId:'thread-1',text:'Wrong'})).status,409);
    assert.equal((await patch({machineId:'local',threadId:'wrong',text:'Wrong'})).status,409);
    assert.equal((await patch({machineId:'local',threadId:'thread-1',text:'Wrong'},'text/plain')).status,415);
    assert.equal(runtime.state.queuedMessage.text,'Before');
    const response=await patch({machineId:'local',threadId:'thread-1',queueId:'12',text:'After'});assert.equal(response.status,200);
    assert.deepEqual((await response.json()).queuedMessage,{threadId:'thread-1',text:'After',images:[],files:[],createdAt:12});
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test("Working Path validates selected task and absolute paths before settings RPC", async () => {
  const runtime = activeRuntime();
  runtime.state.thread.cwd = "/old";
  const calls = [];
  runtime.rpc.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/settings/update") runtime.handleNotification({ method: "thread/settings/updated", params: { threadId: params.threadId, threadSettings: { cwd: params.cwd } } });
    return { data: [] };
  };
  for (const cwd of ["", "relative", "C:relative", "/bad\npath", "/bad\rpath", "/bad\0path", "/".repeat(4097)]) {
    await assert.rejects(runtime.updateWorkingPath("thread-1", cwd), /absolute project folder/);
  }
  await assert.rejects(runtime.updateWorkingPath("stale", "/new"), /selected task changed/);
  assert.deepEqual(calls, []);
  for (const cwd of ["C:\\Projects\\测试", "/home/remote/project", "\\\\server\\share\\project"]) {
    const result = await runtime.updateWorkingPath("thread-1", `  ${cwd}  `);
    assert.equal(result.thread.cwd, cwd);
    assert.deepEqual(calls.findLast(call => call.method === "thread/settings/update").params, { threadId: "thread-1", cwd });
  }
  const count = calls.length;
  await runtime.updateWorkingPath("thread-1", runtime.state.thread.cwd);
  assert.equal(calls.length, count);
  assert(!calls.some(call => call.method === "thread/resume"));
});

test("Working Path stays authoritative on failure and refreshes cwd permission profiles after confirmation", async () => {
  const runtime = activeRuntime();
  runtime.state.thread.cwd = "/old";
  runtime.rpc.request = async () => { throw new Error("Folder unavailable"); };
  await assert.rejects(runtime.updateWorkingPath("thread-1", "/new"), /Folder unavailable/);
  assert.equal(runtime.state.thread.cwd, "/old");
  const calls = [], events = [];
  runtime.broadcast = (type, data) => events.push({ type, data });
  let notify;
  runtime.rpc.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/settings/update") notify = () => {
      runtime.handleNotification({ method: "thread/settings/updated", params: { threadId: "thread-1", threadSettings: { cwd: params.cwd, model: "model-new", effort: "high" } } });
    };
    return { data: [] };
  };
  const pending = runtime.updateWorkingPath("thread-1", "/new");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runtime.state.thread.cwd, "/old");
  let settled = false;
  pending.then(() => { settled = true; });
  runtime.handleNotification({ method: "thread/settings/updated", params: { threadId: "thread-1", threadSettings: { cwd: "/old", model: "unrelated" } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  notify(); await pending;
  assert.equal(runtime.state.thread.cwd, "/new");
  assert(events.some(event => event.type === "thread" && event.data.cwd === "/new"));
  assert(calls.some(call => call.method === "permissionProfile/list" && call.params.cwd === "/new"));
  runtime.handleNotification({ method: "thread/settings/updated", params: { threadId: "stale", threadSettings: { cwd: "/stale" } } });
  assert.equal(runtime.state.thread.cwd, "/new");
  runtime.rpc.request = async () => ({});
  runtime.waitForSettingsUpdate = async () => false;
  await assert.rejects(runtime.updateWorkingPath("thread-1", "/unconfirmed"), /could not be confirmed/);
  assert.equal(runtime.state.thread.cwd, "/new");
});

test("Working Path serializes behind runtime selection and revalidates the task", async () => {
  const gateway = new PocketGateway({ machines: [] });
  const runtime = activeRuntime();
  gateway.runtimes.set("local", runtime);
  await assert.rejects(gateway.updateWorkingPath({ machineId: "ssh:other", threadId: "thread-1", cwd: "/new" }), /selected machine|machine changed|Unknown machine/i);
  let release;
  runtime.selectionQueue = new Promise(resolve => { release = resolve; });
  const calls = [];
  runtime.rpc.request = async method => { calls.push(method); return {}; };
  const update = gateway.updateWorkingPath({ machineId: "local", threadId: "thread-1", cwd: "/ssh/project" });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, []);
  runtime.state.thread = { id: "new-thread", cwd: "/old" };
  release();
  await assert.rejects(update, /selected task changed/);
  assert.deepEqual(calls, []);
});

test("Working Path POST enforces JSON and selected machine/thread before RPC", async () => {
  const { handleRequest } = await import('../gateway.ts');
  const { createServer } = await import('node:http');
  const gateway = new PocketGateway({ machines: [] }), runtime = activeRuntime();
  gateway.runtimes.set('local', runtime);
  const calls = [];
  runtime.rpc.request = async (method, params) => {
    calls.push(method);
    if (method === 'thread/settings/update') runtime.handleNotification({ method: 'thread/settings/updated', params: { threadId: params.threadId, threadSettings: { cwd: params.cwd } } });
    return { data: [] };
  };
  const server = createServer((req, res) => { handleRequest(req, res, gateway, { required: false }, {}, { host: '127.0.0.1' }, async () => ({ localUrl: '/' }), () => {}, () => false).catch(error => { res.statusCode = 500; res.end(error.message); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const post = (body, type = 'application/json') => fetch(`http://127.0.0.1:${server.address().port}/api/thread/cwd`, { method: 'POST', headers: { 'Content-Type': type }, body: JSON.stringify(body) });
    const body = { machineId: 'local', threadId: 'thread-1', cwd: '/new' };
    assert.equal((await post({ ...body, machineId: 'other' })).status, 409);
    assert.equal((await post({ ...body, threadId: 'stale' })).status, 409);
    assert.equal((await post({ ...body, cwd: 'relative' })).status, 409);
    assert.equal((await post(body, 'text/plain')).status, 415);
    assert.deepEqual(calls, []);
    const response = await post(body);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).thread.cwd, '/new');
    assert(!calls.includes('thread/resume'));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});


test('deferred naming deduplicates completions and explicit Rename wins an in-flight save', async () => {
  const runtime = activeRuntime();
  runtime.pendingTaskNames.set('thread-1', { name: 'Requested', firstMessageAccepted: true });
  const calls = [];
  let finish;
  runtime.refreshLoadedThreads = async () => [{ id: 'thread-1', name: 'Requested', status: 'idle' }];
  runtime.rpc = { request: async (method, params) => {
    if (method === 'thread/name/set') {
      calls.push(params.name);
      if (params.name === 'Requested') await new Promise(resolve => { finish = resolve; });
    }
    return { data: [] };
  } };
  const complete = threadId => runtime.handleNotification({ method: 'turn/completed', params: { threadId, turn: { id: 'first', status: 'completed' } } });
  complete('unrelated');assert.deepEqual(calls, []);
  complete('thread-1');complete('thread-1');
  const rename = runtime.taskAction({ action: 'rename', threadId: 'thread-1', name: 'Explicit' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['Requested']);
  finish();await rename;
  assert.deepEqual(calls, ['Requested', 'Explicit']);
  assert.equal(runtime.state.thread.name, 'Explicit');
  assert.equal(runtime.pendingTaskNames.size, 0);
});

test('failed deferred name survives reconnect without retrying until another completion', async () => {
  const runtime = activeRuntime();
  runtime.scheduleReconnect = () => {};
  runtime.pendingTaskNames.set('thread-1', { name: 'Requested', firstMessageAccepted: true });
  let saves = 0;
  runtime.rpc = { request: async () => { saves++;throw new Error('Disconnected'); } };
  await runtime.savePendingTaskName('thread-1', 'first');
  runtime.handleClose(new Error('Disconnected'));
  assert.equal(runtime.pendingTaskNames.get('thread-1').name, 'Requested');
  runtime.rpc = { request: async () => { saves++;return {}; } };
  runtime.handleNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'second', status: 'completed' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(saves, 2);
  assert.equal(runtime.pendingTaskNames.size, 0);
});


test('an away task persists its pending name from authoritative terminal reconciliation', async () => {
  const runtime = activeRuntime();
  runtime.pendingTaskNames.set('away', { name: 'Away name', firstMessageAccepted: true });
  runtime.taskStatuses.set('away', 'active');
  const calls = [];
  runtime.rpc = { request: async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/turns/list') return { data: [{ id: 'away-first', status: 'completed' }] };
    return {};
  } };
  runtime.handleNotification({ method: 'thread/status/changed', params: { threadId: 'away', status: 'idle' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runtime.state.thread.id, 'thread-1');
  assert.equal(runtime.pendingTaskNames.size, 0);
  assert.deepEqual(calls.map(c => c.method), ['thread/turns/list', 'thread/name/set']);
  assert.deepEqual(calls[1].params, { threadId: 'away', name: 'Away name' });
});

test('blank New Task folder resolves the selected runtime user home before creating a zero-turn task', async () => {
  for (const [platform, home] of [['unix / macos','/Users/Target User'],['unix / linux','/home/target'],['windows / windows','C:\\Users\\Target User']]) {
    for (const ssh of [null, 'remote-target']) {
      const runtime = new MachineRuntime({}, { id: ssh || 'local', name: 'Target', ssh }, () => {}, () => {});
      Object.assign(runtime.state, { connected: true, platform });
      const calls = [];
      runtime.rpc = { request: async (method, params) => {
        calls.push({ method, params });
        if (method === 'command/exec') {
          assert.deepEqual(params.sandboxPolicy, platform.startsWith('windows') ? { type: 'dangerFullAccess' } : { type: 'readOnly', networkAccess: false });
          if (platform.startsWith('windows')) assert.match(Buffer.from(params.command.at(-1),'base64').toString('utf16le'), /GetFolderPath\('UserProfile'\)/);
          else assert.deepEqual(params.command, ['sh','-c',`printf '%s' "$HOME"`]);
          return { exitCode: 0, stdout: home, stderr: '' };
        }
        if (method === 'thread/start') return { thread: { id: 'fresh', cwd: params.cwd, status: 'idle', canAcceptDirectInput: true } };
        return { data: [] };
      } };
      await runtime.newTaskOptions('   ');
      assert.equal(calls.find(c => c.method === 'permissionProfile/list').params.cwd, home);
      calls.length = 0;
      const result = await runtime.taskAction({ action: 'create', name: 'Home task', cwd: '   ' });
      assert.equal(result.thread.cwd, home);
      assert.deepEqual(calls.slice(0,2).map(c => c.method), ['command/exec','thread/start']);
      assert.deepEqual(calls[1].params, { cwd: home });
      assert(!calls.some(c => ['thread/resume','thread/name/set','turn/start'].includes(c.method)));
    }
  }
});

test('failed home resolution creates no task and never falls back to process cwd', async () => {
  for (const response of [{exitCode:1,stdout:'/home/target'}, {exitCode:0,stdout:''}, {exitCode:0,stdout:'relative'}, {exitCode:0,stdout:'/home/a\n/home/b'}]) {
    const runtime = activeRuntime(), calls = [];
    runtime.rpc = { request: async method => {calls.push(method);return response;} };
    await assert.rejects(runtime.newTaskOptions(''), /Enter a Project Folder/);
    assert.deepEqual(calls,['command/exec']);calls.length=0;
    await assert.rejects(runtime.taskAction({action:'create', name:'Home task'}), /Enter a Project Folder/);
    assert.deepEqual(calls,['command/exec']);
  }
});

test('task ordering uses active, genuine recency, then deterministic id ties', () => {
  const tasks = [{id:'unloaded',status:'notLoaded',updatedAt:900}, {id:'older',loaded:true,status:'idle',updatedAt:1},
    {id:'newer',loaded:true,status:'idle',updatedAt:2}, {id:'b',loaded:true,status:'active',updatedAt:1}, {id:'a',loaded:true,status:'active',updatedAt:1}];
  assert.deepEqual(tasks.sort(compareTaskOrder).map(t=>t.id),['a','b','unloaded','newer','older']);
  tasks.find(t=>t.id==='older').updatedAt=3;
  assert.deepEqual(tasks.sort(compareTaskOrder).map(t=>t.id),['a','b','unloaded','older','newer']);
});

test('review: task mutations require thread identity at execution and queue replacement is fenced', async () => {
  for (const action of ['message','model','access']) {
    const gateway=new PocketGateway({machines:[]}),runtime=activeRuntime();gateway.runtimes.set('local',runtime);
    let release;runtime.selectionQueue=new Promise(r=>release=r);
    const writes=[];runtime.rpc={request:async(...args)=>{writes.push(args);return {};}};
    const invoke=threadId=>action==='message'?gateway.sendMessage('local','Hello','start',[],[],undefined,threadId)
      :action==='model'?gateway.updateThreadSettings('local','test','high',threadId):gateway.updateAccess('local','full',threadId);
    await assert.rejects(invoke(undefined),/Selected task changed/);
    const pending=invoke('thread-1');await new Promise(setImmediate);
    runtime.state.thread={id:'other'};release();
    await assert.rejects(pending,/Selected task changed/);assert.equal(writes.length,0);
  }
  for (const action of ['edit','cancel','send']) {
    const gateway=new PocketGateway({machines:[]}),runtime=activeRuntime();gateway.runtimes.set('local',runtime);
    const before={id:'old',threadId:'thread-1',text:'Old',createdAt:1};
    runtime.state.queuedMessage=before;
    let release;gateway.operationQueue=new Promise(r=>release=r);
    const pending=action==='edit'?gateway.editQueuedMessage({machineId:'local',threadId:'thread-1',queueId:'old',text:'Stale'})
      :action==='cancel'?gateway.cancelQueuedMessage('local','thread-1','old'):gateway.sendQueuedMessage('local','steer','thread-1','old');
    const replacement={...before,id:'new',text:'Replacement'};runtime.state.queuedMessage=replacement;release();
    await assert.rejects(pending,/no longer has/);assert.equal(runtime.state.queuedMessage,replacement);
    await assert.rejects(gateway.cancelQueuedMessage('local','thread-1',undefined),/no longer has/);
  }
});

test('review: late normal and queued starts preserve terminal notifications and newer tasks', async () => {
  for(const queued of [false,true])for(const status of ['completed','failed','interrupted','changed']){
    const runtime=activeRuntime();runtime.state.turn=null;runtime.state.threadStatus='idle';
    if(queued)runtime.state.queuedMessage={id:'queue',threadId:'thread-1',text:'Queued',createdAt:1};
    let expected;
    runtime.rpc={request:async method=>{
      assert.equal(method,'turn/start');
      if(status==='changed'){
        runtime.state.thread={id:'other'};runtime.rpc={};runtime.state.turn={id:'newer',status:'inProgress'};runtime.state.phase='working';
      }else runtime.handleNotification({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'started',status,error:status==='failed'?{message:'Failed'}:null}}});
      expected=runtime.state.turn;
      return {turn:{id:'started',status:'inProgress'}};
    }};
    if(queued)await runtime.sendQueuedMessage('start');
    else await runtime.sendMessage('Hello','start');
    assert.equal(runtime.state.turn,expected);
    if(status!=='changed')assert.equal(runtime.state.phase,status==='failed'?'failed':status==='interrupted'?'stopped':'done');
  }
});

test('review: late model/access acknowledgments cannot update another task', async () => {
  for(const mode of ['model','access']){
    const runtime=activeRuntime();runtime.state.models=[{model:'test',supportedReasoningEfforts:[{reasoningEffort:'high'}]}];
    runtime.state.access={mode:'ask',choices:{full:{available:true}}};runtime.permissionProfiles=[{id:':full-access',allowed:true}];
    let resolve,started;const ready=new Promise(r=>started=r);
    runtime.rpc={request:()=>{started();return new Promise(r=>resolve=r);}};
    const pending=mode==='model'?runtime.updateThreadSettings('test','high'):runtime.updateAccess('full');
    await ready;runtime.state.thread={id:'other'};runtime.state.model='new-model';runtime.state.access={mode:'ask'};
    resolve({});await assert.rejects(pending,/Selected task changed/);
    assert.equal(runtime.state.model,'new-model');assert.equal(runtime.state.access.mode,'ask');
  }
});

test('review: peer disconnect drains RPCs, prevents writes, and contains malformed frames and stdin errors',async t=>{
  const cp=(await import('node:child_process')).default,{syncBuiltinESMExports}=await import('node:module');
  const {EventEmitter}=await import('node:events'),{PassThrough}=await import('node:stream'),{createHash}=await import('node:crypto');
  let child;t.mock.method(cp,'spawn',()=>{child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>true;return child;});
  syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  for(const cause of ['frame','parser','stdin','intentional']){
    const rpc=new RpcClient();let closes=0;rpc.onClose=()=>closes++;
    const opening=rpc.connect(undefined,'fixture');const c=child;c.emit('spawn');
    const key=/Sec-WebSocket-Key: (.+)\r/.exec(c.stdin.read().toString())[1];
    const accept=createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    c.stdout.write('HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');await opening;
    const one=rpc.request('one'),two=rpc.request('two');const pending=[...rpc.pending.values()];
    const rejected=Promise.all([assert.rejects(one),assert.rejects(two)]);
    if(cause==='frame')c.stdout.write(Buffer.from([0x88,0]));
    else if(cause==='parser')c.stdout.write(Buffer.from([0x81,127,255,255,255,255,255,255,255,255]));
    else if(cause==='stdin')c.stdin.emit('error',new Error('broken pipe'));
    else rpc.close();
    await rejected;
    assert.equal(rpc.pending.size,0);assert(pending.every(p=>p.timer._destroyed));
    assert.equal(closes,cause==='intentional'?0:1);
    await assert.rejects(rpc.request('late'),/closed/);assert.throws(()=>rpc.notify('late'),/closed/);assert.throws(()=>rpc.respond(4,{}),/closed/);
    c.emit('exit',255,null);rpc.close();assert.equal(closes,cause==='intentional'?0:1);
    c.stdin.destroy();c.stdout.destroy();c.stderr.destroy();
  }
});

test('review: old connection initialization success/failure cannot overwrite a new connection',async t=>{
  t.mock.method(RpcClient.prototype,'notify',()=>{});
  t.mock.method(RpcClient.prototype,'connect',async()=>{});
  for(const fail of [false,true]){
    let resolve,reject,started,first=true;const ready=new Promise(r=>started=r);
    t.mock.method(RpcClient.prototype,'request',async function(method){
      if(method==='initialize'&&first){first=false;started();return new Promise((r,j)=>{resolve=r;reject=j;});}
      return method==='initialize'?{userAgent:'new connection'}:{data:[]};
    });
    const runtime=new MachineRuntime({}, {id:'ssh:test',name:'Test',ssh:'test'},()=>{});
    const old=runtime.start(false);await ready;await runtime.connect();const current=runtime.rpc;
    if(fail)reject(new Error('Old initialization timed out'));else resolve({userAgent:'old connection'});
    await old;assert.equal(runtime.rpc,current);assert.equal(runtime.state.userAgent,'new connection');assert.equal(runtime.state.connected,true);
    assert.equal(runtime.reconnectTimer,null);await runtime.stop();
  }
});

test('review: confirmed task mutations survive refresh failure, real mutations still reject',async()=>{
  for(const action of ['rename','archive','unarchive','delete'])for(const failMutation of [false,true]){
    const runtime=activeRuntime();runtime.state.turn=null;runtime.state.threadStatus='idle';
    let mutated=false;
    runtime.refreshLoadedThreads=async()=>{if(mutated)throw new Error('Catalog unavailable');return [{id:'thread-1',name:'Task',status:'idle'}];};
    runtime.listArchivedThreads=async()=>[{id:'thread-1',name:'Task',status:'idle'}];
    runtime.rpc={request:async()=>{if(failMutation)throw new Error('Mutation rejected');mutated=true;return {};}};
    const pending=runtime.taskAction({action,threadId:'thread-1',name:'Renamed',archived:action==='unarchive',confirmed:true});
    if(failMutation)await assert.rejects(pending,/Mutation rejected/);else{await pending;assert(mutated);}
  }
});

test('review: history hydration has a shared deadline, page cap and explicit repeated-cursor failure',async t=>{
  t.mock.timers.enable({apis:['Date']});
  for(const cause of ['pages','time','cursor']){
    const runtime=activeRuntime();let pages=0;const budgets=[];
    runtime.rpc={request:async(method,params,timeout)=>{
      if(method==='thread/turns/list')return {data:[{id:'turn',status:'completed',items:[]}]};
      pages++;budgets.push(timeout);if(cause==='time')t.mock.timers.tick(10001);
      return {data:[],nextCursor:cause==='cursor'?'repeat':String(pages)};
    }};
    await assert.rejects(runtime.history(null,2),/History retrieval incomplete/);
    if(cause==='pages')assert.equal(pages,100);
    if(cause==='time'){assert.equal(pages,2);assert.deepEqual(budgets,[20000,9999]);}
    if(cause==='cursor')assert.equal(pages,2);
  }
});

test('review: remote image completion waits for stdout and contains stream errors',async t=>{
  const cp=(await import('node:child_process')).default,{syncBuiltinESMExports}=await import('node:module');
  const {EventEmitter}=await import('node:events'),{PassThrough}=await import('node:stream');
  let child;t.mock.method(cp,'spawn',()=>{child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>true;return child;});
  syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  t.mock.timers.enable({apis:['setTimeout']});
  for(const cause of ['success','stdout','stderr','size','timeout']){
    const runtime=new MachineRuntime({}, {id:'ssh:test',name:'Test',ssh:'test'},()=>{});
    runtime.trustedImagePaths.add('/tmp/image.png');
    let done=false;const pending=runtime.readSurfacedImage('/tmp/image.png').then(value=>{done=true;return value;});
    const rejected=cause==='success'?null:assert.rejects(pending,/Image unavailable/);
    child.stdout.write(Buffer.from('first'));child.emit('exit',0);await Promise.resolve();assert.equal(done,false);
    if(cause==='success'){child.stdout.end(Buffer.from('last'));await new Promise(setImmediate);child.emit('close',0);assert.equal((await pending).data.toString(),'firstlast');}
    else if(cause==='size'){child.stdout.write(Buffer.alloc(12*1024*1024));await rejected;}
    else if(cause==='timeout'){t.mock.timers.tick(15000);await rejected;}
    else{child[cause].emit('error',new Error('stream failure'));await rejected;}
    child.stdout.destroy();child.stderr.destroy();
  }
});

test('review: native control listener checks Host/origin and permits native requests without Origin',async()=>{
  const {handleControlRequest}=await import('../gateway.ts'),{createServer,request}=await import('node:http');
  let stopped=0,quit=0;const gateway=new PocketGateway({machines:[]});
  const server=createServer((req,res)=>handleControlRequest(req,res,gateway,{host:'0.0.0.0',port:4173},()=>stopped++,()=>quit++));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
  const send=(path,headers={})=>new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port,path,method:'POST',headers},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();});
  try{
    assert.equal(await send('/stop',{Host:'attacker.example',Origin:'http://attacker.example'}),403);
    assert.equal(await send('/shutdown',{Origin:'https://attacker.example'}),403);
    assert.equal(await send('/stop',{'Sec-Fetch-Site':'cross-site'}),403);
    assert.equal(stopped+quit,0);
    assert.equal(await send('/stop'),202);
    assert.equal(await send('/shutdown',{Origin:`http://127.0.0.1:${port}`}),202);
    assert.equal(stopped,1);assert.equal(quit,1);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('review: HTTP message timeout propagates unknown receipt while genuine rejection remains rejected',async()=>{
  const {handleRequest}=await import('../gateway.ts'),{createServer}=await import('node:http');
  const gateway=new PocketGateway({machines:[]});let posts=0,fail='turn/start timed out';
  gateway.sendMessage=async()=>{posts++;throw new Error(fail);};
  gateway.sendQueuedMessage=async()=>{posts++;throw new Error(fail);};
  const server=createServer((req,res)=>handleRequest(req,res,gateway,{required:false},{},{host:'127.0.0.1'},async()=>({}),()=>{},()=>false));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
    for(const route of ['/api/message','/api/message/queue'])for(const unknown of [true,false]){
      fail=unknown?'turn/start timed out':'Upstream rejected';
      const id=gateway.submissions.epoch+'-'+posts+'-'+String(unknown);
      const response=await fetch('http://127.0.0.1:'+server.address().port+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({submissionId:id,machineId:'local',threadId:'task',queueId:'queue',text:'Test',action:'start'})});
      assert.equal(response.status,409);const result=await response.json();
      assert.equal(result.submission.id,id);assert.equal(result.submission.status,unknown?'unknown':'rejected');
      assert.equal((await gateway.submissions.recover(id)).status,result.submission.status);
    }
    assert.equal(posts,4);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('review: uncertain queued sends cannot automatically start again on a later completion',async()=>{
  for(const action of ['start','steer']){
    const runtime=activeRuntime();if(action==='start'){runtime.state.turn=null;runtime.state.threadStatus='idle';}
    runtime.state.queuedMessage={id:'queue',threadId:'thread-1',text:'Once',createdAt:1};
    let sends=0;runtime.rpc={request:async method=>{if(method!=='turn/'+action)return {data:[]};sends++;throw new Error('turn/'+action+' timed out');}};
    await assert.rejects(runtime.sendQueuedMessage(action),/timed out/);
    assert.equal(runtime.state.queuedMessage.deliveryUnknown,true);
    runtime.handleNotification({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'late',status:'completed'}}});
    await runtime.selectionQueue;assert.equal(sends,1);
    await assert.rejects(runtime.sendQueuedMessage('start'),/timed out/);assert.equal(sends,1);
  }
});

test('review: parked queued sends retain uncertainty and accepted sends remove only the original queue',async()=>{
  for(const action of ['start','steer'])for(const outcome of ['unknown','accepted','replaced']){
    const runtime=activeRuntime();if(action==='start'){runtime.state.turn=null;runtime.state.threadStatus='idle';}
    const queued={id:'original',threadId:'thread-1',text:'Once',createdAt:1};runtime.state.queuedMessage=queued;
    let resolve,reject,started;const ready=new Promise(r=>started=r);
    runtime.rpc={request:()=>{started();return new Promise((r,j)=>{resolve=r;reject=j;});}};
    const pending=runtime.sendQueuedMessage(action);const rejected=outcome==='unknown'?assert.rejects(pending):null;
    await ready;runtime.parkTaskQueue();runtime.resetThreadState();runtime.state.thread={id:'other'};runtime.rpc={};
    const replacement={...queued,id:'replacement'};
    if(outcome==='replaced')runtime.taskQueues.set('thread-1',replacement);
    if(outcome==='unknown'){
      reject(new Error('app-server connection closed'));await rejected;
      assert.equal(runtime.taskQueues.get('thread-1').deliveryUnknown,true);
    }else{
      resolve({turn:{id:'accepted',status:'inProgress'}});await pending;
      assert.equal(runtime.taskQueues.get('thread-1'),outcome==='replaced'?replacement:undefined);
    }
    assert.equal(runtime.state.queuedMessage,null);assert.equal(runtime.state.turn,null);
  }
});

test('review: late active-turn hydration preserves terminal state and connection changes',async()=>{
  for(const change of ['terminal','connection','task']){
    const runtime=activeRuntime();let resolve;
    runtime.rpc={request:()=>new Promise(r=>resolve=r)};
    const pending=runtime.loadActiveTurn();
    if(change==='terminal')runtime.state.turn={id:'finished',status:'completed'};
    if(change==='connection')runtime.rpc={};
    if(change==='task')runtime.state.thread={id:'other'};
    const turn=runtime.state.turn;
    resolve({data:[{id:'stale',status:'inProgress'}]});await pending;
    assert.equal(runtime.state.turn,turn);
  }
});

test('queued receipt recovery retires only the delivered Start/Steer queue, including parked entries',async()=>{
  for(const action of ['start','steer'])for(const placement of ['current','parked','disconnected','replacement','unknown']){
    const runtime=activeRuntime(),receipts=new MessageSubmissions();
    if(action==='start'){runtime.state.turn=null;runtime.state.threadStatus='idle';}
    const oldTurn=runtime.state.turn?.id;
    const queued={id:'original-queue',threadId:'thread-1',text:'Deliver this once',createdAt:1};
    runtime.state.queuedMessage=queued;
    let sends=0;runtime.rpc={request:async method=>{if(method!=='turn/'+action)return {data:[]};sends++;throw new Error('turn/'+action+' timed out');}};
    const id=receipts.epoch+'-original';
    await assert.rejects(receipts.run(id,()=>runtime.sendQueuedMessage(action,'thread-1',queued.id,{id,receipts})),/timed out/);
    assert.equal(runtime.state.queuedMessage.deliveryUnknown,true);
    assert.equal((await receipts.recover(id)).status,'unknown');
    let replacement;
    if(placement==='parked'||placement==='disconnected'){
      if(placement==='disconnected'){runtime.handleClose(new Error('SSH peer disconnected'));clearTimeout(runtime.reconnectTimer);runtime.reconnectTimer=null;}
      else{runtime.parkTaskQueue();runtime.resetThreadState();}
      runtime.state.thread={id:'other'};
      runtime.state.queuedMessage={id:'other-queue',threadId:'other',text:'Other task',createdAt:2};
      assert.equal((await receipts.recover(id)).status,'unknown');
      assert.equal(runtime.state.queuedMessage.id,'other-queue');
      runtime.state.thread={id:'thread-1'};runtime.state.queuedMessage=null;
    }
    if(placement==='replacement'){
      replacement={...queued,id:'replacement',submission:undefined,deliveryUnknown:false};
      runtime.state.queuedMessage=replacement;
    }
    const turnId=action==='steer'?oldTurn:'new-turn';
    runtime.state.turn={id:turnId,status:'inProgress'};
    runtime.state.liveMessages=[{id:'delivered-item',role:'user',text:placement==='unknown'?'Unrelated message':queued.text,turnId}];
    const receipt=await receipts.recover(id);
    if(placement==='unknown'){
      assert.equal(receipt.status,'unknown');assert.equal(runtime.state.queuedMessage.deliveryUnknown,true);
      await assert.rejects(runtime.sendQueuedMessage(action),/timed out/);
    }else{
      assert.equal(receipt.status,'accepted');assert.equal(receipt.turnId,turnId);
      assert.equal(runtime.state.queuedMessage,placement==='replacement'?replacement:null);
      assert.equal(runtime.taskQueues.has('thread-1'),false);
      assert.deepEqual(JSON.parse(JSON.stringify(runtime.snapshot())).queuedMessage,placement==='replacement'?JSON.parse(JSON.stringify(replacement)):null);
      assert.equal((await receipts.recover(id)).status,'accepted');
      await receipts.run(id,()=>{sends++;throw new Error('must not resend');});
    }
    assert.equal(sends,1);
  }
});

test('queue confirmation is captured before leaving and cannot clear a later submission identity',async()=>{
  for(const action of ['start','steer']){
    const runtime=activeRuntime(),receipts=new MessageSubmissions();
    if(action==='start'){runtime.state.turn=null;runtime.state.threadStatus='idle';}
    const turnId=runtime.state.turn?.id||'new-turn';
    const queued={id:'queue',threadId:'thread-1',text:'Delivered',createdAt:1};runtime.state.queuedMessage=queued;
    runtime.rpc={request:async()=>{throw new Error('turn/'+action+' timed out');}};
    const id=receipts.epoch+'-original';
    await assert.rejects(receipts.run(id,()=>runtime.sendQueuedMessage(action,'thread-1','queue',{id,receipts})));
    runtime.state.turn={id:turnId,status:'inProgress'};
    runtime.state.liveMessages=[{id:'landed',role:'user',text:'Delivered',turnId}];
    runtime.parkTaskQueue();runtime.resetThreadState();runtime.state.thread={id:'other'};
    assert.equal(runtime.taskQueues.size,0);
    assert.equal((await receipts.recover(id)).status,'accepted');
    const replacement={...queued,submission:{id:'another-submission',requested:{}},deliveryUnknown:true};
    runtime.taskQueues.set('thread-1',replacement);
    runtime.recoverQueuedDelivery(queued);
    assert.equal(runtime.taskQueues.get('thread-1'),replacement);
  }
});

test('a queued browser confirmation requires an authoritative receipt, not just a matching turn',()=>{
  const requested={machineId:'local',threadId:'task',queueId:'queue',action:'start',text:'Hello'};
  const snapshot={machineId:'local',thread:{id:'task'},turn:{id:'new'},liveMessages:[{id:'new-item',role:'user',text:'Hello',turnId:'new'}]};
  assert.equal(reconcileSubmission('receipt',snapshot,requested),'unknown');
  assert.equal(reconcileSubmission('receipt',{...snapshot,submission:{id:'receipt',status:'accepted'}},requested),'accepted');
});

test('rejected queued RPCs and unrelated Steer turns do not retire a queue',async()=>{
  for(const failure of ['Rejected by upstream','turn/steer timed out']){
    const runtime=activeRuntime(),receipts=new MessageSubmissions();
    runtime.state.queuedMessage={id:'queue',threadId:'thread-1',text:'Exact text',createdAt:1};
    runtime.rpc={request:async()=>{throw new Error(failure);}};
    const id=receipts.epoch+'-test';
    await assert.rejects(receipts.run(id,()=>runtime.sendQueuedMessage('steer','thread-1','queue',{id,receipts})));
    const queued=runtime.state.queuedMessage;
    runtime.state.turn={id:'unrelated-turn',status:'inProgress'};
    runtime.upsertLiveMessage({id:'different-turn-input',turnId:'unrelated-turn',role:'user',text:'Exact text'});
    assert.equal(runtime.state.queuedMessage,queued);
    assert.equal((await receipts.recover(id)).status,failure.includes('timed out')?'unknown':'rejected');
    // Even a matching user item cannot turn a genuine rejection into a successful send.
    if(failure==='Rejected by upstream'){
      runtime.state.turn={id:'turn-1',status:'inProgress'};
      runtime.upsertLiveMessage({id:'other-submission',turnId:'turn-1',role:'user',text:'Exact text'});
      assert.equal(runtime.state.queuedMessage,queued);
    }
  }
});

test('automatic dispatch has a delivery receipt distinct from enqueue acceptance and recovers from bounded history',async()=>{
  for(const action of ['start','steer','automatic'])for(const placement of ['active','parked','disconnected','replacement'])for(const evidence of ['delivered','older','unrelated','attachment','later-match']){
    const runtime=activeRuntime(),receipts=runtime.submissions;
    runtime.state.turn={id:'base',status:'inProgress'};runtime.state.liveMessages=[];
    const text='Same text as an older message';
    const old={id:'old-input',type:'userMessage',content:[{type:'text',text}]};
    let after=false,sends=0;const reads=[];
    const turnId=action==='steer'?'base':'delivered';
    const rpc={request:async(method,params)=>{
      if(method==='turn/start'||method==='turn/steer'){sends++;throw new Error(method+' timed out');}
      reads.push({method,params});
      if(method==='thread/turns/list')return {data:after&&action!=='steer'&&evidence!=='older'
        ?[{id:evidence==='unrelated'?'unrelated':turnId,status:'completed'},{id:'base',status:'completed'}]:[{id:'base',status:'completed'}],nextCursor:null};
      if(method==='thread/items/list'){
        const items=params.turnId==='base'?[old]:[];
        if(after&&evidence==='later-match'&&action!=='steer'&&params.turnId===turnId)items.push({id:'unrelated-first-input',type:'userMessage',content:[{type:'text',text:'Other task input'}]});
        if(after&&evidence!=='older'&&params.turnId===(evidence==='unrelated'?'unrelated':turnId))items.push({id:'delivered-input',type:'userMessage',content:[{type:'text',text}]});
        return {data:items.map(item=>({turnId:params.turnId,item})),nextCursor:null};
      }
      return {};
    }};runtime.rpc=rpc;
    await runtime.history(null,1);
    const enqueueId=receipts.epoch+'-enqueue';
    await receipts.run(enqueueId,()=>runtime.sendMessage(text,'queue'));
    if(evidence==='attachment')runtime.state.queuedMessage.files=[{name:'file.txt',path:'/tmp/file.txt',size:1}];
    assert.equal((await receipts.recover(enqueueId)).status,'accepted');assert.equal(runtime.state.queuedMessage.submission,undefined);
    if(action==='automatic'){
      runtime.handleNotification({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'base',status:'completed'}}});
      await runtime.selectionQueue;
    }else{
      if(action==='start'){runtime.state.turn.status='completed';runtime.state.threadStatus='idle';}
      const id=receipts.epoch+'-delivery';
      await assert.rejects(receipts.run(id,()=>runtime.sendQueuedMessage(action,'thread-1',runtime.state.queuedMessage.id,{id,receipts})),/timed out/);
    }
    const original=runtime.state.queuedMessage,deliveryId=original.submission.id;
    assert.notEqual(deliveryId,enqueueId);assert.equal(original.deliveryUnknown,true);assert.equal(sends,1);
    assert.equal((await receipts.recover(deliveryId)).status,'unknown');
    if(evidence==='unrelated'&&action!=='steer'){
      runtime.handleNotification({method:'turn/started',params:{threadId:'thread-1',turn:{id:'delivered',status:'inProgress'}}});
    }
    if(placement==='disconnected'){
      runtime.handleClose(new Error('SSH disconnected'));clearTimeout(runtime.reconnectTimer);runtime.reconnectTimer=null;
    }else if(placement==='parked'){runtime.parkTaskQueue();runtime.resetThreadState();runtime.state.thread={id:'other'};}
    const replacement={...original,id:'replacement',submission:undefined,deliveryUnknown:false};
    if(placement==='replacement')runtime.state.queuedMessage=replacement;
    Object.assign(runtime.state,{connected:true,thread:{id:'thread-1'},turn:null,liveMessages:[]});runtime.rpc=rpc;
    after=true;await runtime.history(null,2);
    const accepted=evidence==='delivered'||(evidence==='later-match'&&action==='steer');
    assert.equal((await receipts.recover(deliveryId)).status,accepted?'accepted':'unknown',`${action}/${placement}/${evidence}`);
    assert.equal((await receipts.recover(enqueueId)).status,'accepted');
    assert.deepEqual(runtime.state.liveMessages,[]);
    if(placement==='replacement')assert.equal(runtime.state.queuedMessage,replacement);
    else if(accepted){assert.equal(runtime.state.queuedMessage,null);assert.equal(runtime.taskQueues.has('thread-1'),false);}
    else assert.equal((runtime.state.queuedMessage||runtime.taskQueues.get('thread-1')).deliveryUnknown,true);
    assert(reads.filter(read=>read.method==='thread/turns/list').every(read=>read.params.limit<=2&&read.params.cursor===null));
    assert.equal(sends,1);
  }
});

test('Start without a live turn takes a fresh bounded boundary instead of trusting stale history',async()=>{
  const runtime=activeRuntime(),receipts=runtime.submissions;runtime.state.turn=null;runtime.state.threadStatus='idle';
  runtime.recentHistory=[{id:'stale-boundary',messages:[]}];
  runtime.state.queuedMessage={id:'queue',threadId:'thread-1',text:'Identical old text',createdAt:1};
  let sends=0,reads=0;
  runtime.rpc={request:async(method,params)=>{
    if(method==='turn/start'){sends++;throw new Error('turn/start timed out');}
    if(method==='thread/turns/list'){reads++;assert.equal(params.limit,1);return {data:[{id:'fresh-boundary',status:'completed'}]};}
    return {data:[]};
  }};
  const id=receipts.epoch+'-delivery';
  await assert.rejects(receipts.run(id,()=>runtime.sendQueuedMessage('start','thread-1','queue',{id,receipts})));
  assert.equal(reads,1);assert.equal(sends,1);assert.equal(runtime.state.queuedMessage.submission.requested.anchorTurnId,'fresh-boundary');
  runtime.recentHistory=[{id:'stale-boundary',messages:[]},{id:'old-successor',firstUserMessageId:'old',messages:[{id:'old',role:'user',text:'Identical old text',turnId:'old-successor'}]}];
  assert.equal((await receipts.recover(id)).status,'unknown');assert.equal(runtime.state.queuedMessage.deliveryUnknown,true);
});

test('automatic timeout immediately reconciles evidence collected while the RPC was pending', async()=>{
  for(const placement of ['active','parked','replacement','unrelated','rejected']){
    const runtime=activeRuntime(),receipts=runtime.submissions;
    let rejectSend,started;const sending=new Promise(resolve=>started=resolve);let sends=0;
    runtime.rpc={request:async method=>{
      if(method==='turn/start'){sends++;started();return new Promise((_,reject)=>rejectSend=reject);}
      return {data:[]};
    }};
    const enqueueId=receipts.epoch+'-enqueue';
    await receipts.run(enqueueId,()=>runtime.sendMessage('Queued original','queue'));
    const original=runtime.state.queuedMessage;
    runtime.handleNotification({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});
    await sending;
    runtime.handleNotification({method:'turn/started',params:{threadId:'thread-1',turn:{id:'delivered',status:'inProgress'}}});
    runtime.upsertLiveMessage({id:'input',role:'user',turnId:'delivered',text:placement==='unrelated'?'Other input':original.text});
    assert.equal(runtime.state.queuedMessage,original,'pending evidence does not retire the queue before the RPC outcome');
    if(placement==='parked'){runtime.parkTaskQueue();runtime.resetThreadState();runtime.state.thread={id:'other'};}
    const replacement={id:'replacement',threadId:'thread-1',text:'Keep me',createdAt:2};
    if(placement==='replacement')runtime.state.queuedMessage=replacement;
    rejectSend(new Error(placement==='rejected'?'Rejected by upstream':'turn/start timed out'));await runtime.selectionQueue;
    // Inspect stored state before any recovery endpoint, snapshot, or further event.
    const delivery=receipts.receipts.get(original.submission.id);
    assert.equal(delivery.status,placement==='rejected'?'rejected':placement==='unrelated'?'unknown':'accepted');
    assert.notEqual(original.submission.id,enqueueId);
    assert.equal(receipts.receipts.get(enqueueId).status,'accepted');
    if(placement==='replacement')assert.equal(runtime.state.queuedMessage,replacement);
    else if(['unrelated','rejected'].includes(placement))assert.equal(runtime.state.queuedMessage.id,original.id);
    else assert.equal(runtime.state.queuedMessage,null);
    if(placement==='unrelated'){assert.equal(runtime.state.queuedMessage.deliveryUnknown,true);assert.equal(await runtime.startQueuedMessage('thread-1'),false);}
    else assert.equal(runtime.taskQueues.size,0);
    assert.equal(sends,1);
  }
});

test('catalog and live recency share upstream activity time across navigation, replay, refresh and old connections',async()=>{
  const events=[],runtime=activeRuntime();runtime.onTaskStatus=value=>events.push(value);
  const rows=[{id:'a',cwd:'/project',source:'cli',status:{type:'idle'},recencyAt:100,updatedAt:999},
    {id:'b',cwd:'/project',source:'cli',status:{type:'idle'},recencyAt:200,updatedAt:888}];
  runtime.rpc={request:async(method,params)=>method==='thread/list'?{data:rows}:method==='thread/loaded/list'?{data:[runtime.state.thread.id]}:
    method==='thread/read'?{thread:rows.find(row=>row.id===params.threadId)}:{data:[]}};
  await runtime.refreshLoadedThreads();
  const order=()=>runtime.loadedThreads.toSorted(compareTaskOrder).map(row=>row.id);
  assert.deepEqual(order(),['b','a']);
  for(const id of ['a','b','a']){
    rows.find(row=>row.id===id).updatedAt=Date.now(); // Metadata writes are not activity.
    runtime.state.thread={id};
    for(const status of ['idle','notLoaded','idle'])runtime.handleNotification({method:'thread/status/changed',params:{threadId:id,status:{type:status}}});
    runtime.handleNotification({method:'turn/completed',params:{threadId:id,turn:{id:'existing-'+id,status:'completed'}}});
    await runtime.refreshTaskRecency(id);await runtime.refreshLoadedThreads();
    assert.deepEqual(order(),['b','a']);
  }
  rows[0].recencyAt=300;
  runtime.handleNotification({method:'item/started',params:{threadId:'a',item:{id:'new-input',type:'userMessage',content:[]}}});
  await Promise.resolve();await Promise.resolve();
  assert.equal(events.at(-1).updatedAt,300000);assert.deepEqual(order(),['a','b']);
  await runtime.refreshLoadedThreads();assert.deepEqual(order(),['a','b']);
  assert.deepEqual((await runtime.listArchivedThreads()).map(row=>row.id),['a','b']);
  rows[1].recencyAt=400;
  runtime.handleNotification({method:'item/completed',params:{threadId:'b',item:{id:'new-command',type:'commandExecution',command:'pwd'}}});
  await Promise.resolve();await Promise.resolve();assert.deepEqual(order(),['b','a']);
  await runtime.refreshLoadedThreads();assert.deepEqual(order(),['b','a']);
  let finish;runtime.rpc={request:()=>new Promise(resolve=>finish=resolve)};
  const late=runtime.refreshTaskRecency('b');runtime.rpc={};finish({thread:{...rows[1],recencyAt:900}});await late;
  assert.equal(runtime.loadedThreads.find(row=>row.id==='b').updatedAt,400000);
  assert.deepEqual(order(),['b','a']);
});
