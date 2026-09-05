import test from "node:test";
import assert from "node:assert/strict";

import {
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
  resolvedAsyncAnswer,
} from "../public/pocket-logic.js";
import { MachineRuntime, MessageSubmissions } from "../gateway.ts";

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
  }), "Done");
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
  assert.equal(failed.snapshot().message.allowed, false);
  assert.equal(failed.state.turn.status, "failed");
  assert.equal(failed.state.connectionError, null);
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
  assert.deepEqual(contextSnapshot(usage), { usedTokens: 27000, contextWindow: 100000, remainingPercent: 73 });
  assert.equal(contextSnapshot({ ...usage, modelContextWindow: null }), null);
  assert.equal(contextSnapshot({ ...usage, last: { totalTokens: -1 } }), null);
  assert.equal(contextSnapshot({ ...usage, last: { totalTokens: 200000 } }).remainingPercent, 0);
  const runtime = activeRuntime();
  const update = (threadId) => runtime.handleNotification({ method: "thread/tokenUsage/updated", params: { threadId, tokenUsage: usage } });
  update("unrelated"); assert.equal(runtime.snapshot().context, null);
  update("thread-1"); assert.equal(runtime.snapshot().context.remainingPercent, 73);
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
      assert.equal(runtime.snapshot().context, null);
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
