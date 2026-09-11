import test from "node:test";
import assert from "node:assert/strict";

import {
  createSelectionHold,
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
    if (method === "thread/resume") {
      if (params.excludeTurns === false) materialized.add(params.threadId);
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
  assert.deepEqual((await runtime.history(null, 20)).turns, []);
  assert.ok((await runtime.listLoadedThreads()).some(t => t.id === first.thread.id));
  assert.ok(!calls.some(c => c.method === "turn/start"));
  assert.deepEqual(calls.slice(0, 3).map(c => c.method), ["thread/start", "thread/resume", "thread/name/set"]);
  assert.equal(calls[1].params.excludeTurns, false);
  await runtime.taskAction({ action: "create", name: "Other task", cwd: "/tmp/other-project" });
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
    assert.equal((await post("/api/login", { Origin: origin, "Content-Type": "application/json; charset=utf-8", "Sec-Fetch-Site": "same-origin" }, "{}")).status, 200);
    assert.equal((await post("/api/shutdown", { Origin: "https://attacker.example" })).status, 403);
    assert.equal((await post("/api/shutdown", { "Sec-Fetch-Site": "cross-site" })).status, 403);
    assert.equal((await post("/api/shutdown", { Origin: "null" })).status, 403);
    assert.equal((await post("/api/login", { Origin: origin, "Content-Type": "text/plain" }, "{}")).status, 415);
    assert.equal((await post("/api/login", { Origin: origin })).status, 415);
    const runtime = gateway.runtimes.get("local");
    runtime.state.queuedMessage = { threadId: "queued-task", text: "Keep until cancelled" };
    const cancel = headers => fetch(origin + "/api/message/queue?machineId=local", { method: "DELETE", headers });
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

test("release cancels a waiting queue and clears state after existing task operations settle", async () => {
  const runtime = activeRuntime();
  runtime.state.queuedMessage = { threadId: "thread-1", text: "Cancel on leave" };
  let finish;
  runtime.selectionQueue = new Promise(resolve => { finish = resolve; }).then(() => {
    runtime.state.liveMessages = [{ id: "late", role: "assistant", text: "Late operation result" }];
  });
  const released = runtime.releaseTask();
  assert.equal(runtime.state.queuedMessage, null);
  finish();
  await released;
  assert.equal(runtime.state.thread, null);
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

test('New Task naming failure still hands ownership to the destination machine', async () => {
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
      if (method === 'thread/loaded/list') return { data: ['new-b'] };
      if (method === 'thread/read') return { thread: created };
      return { data: [] };
    } };
  }
  const result = await gateway.taskAction({ action: 'create', machineId: 'ssh:b', expectedMachineId: 'local', expectedThreadId: 'a', name: 'New name', cwd: '/project' });
  assert.equal(result.machineId, 'ssh:b');
  assert.equal(result.thread.id, 'new-b');
  assert.match(result.warning, /created.*name.*rename/);
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
  let resolveStart;
  runtime.rpc = { request: method => {
    assert.equal(method, 'turn/start');
    return new Promise(resolve => { resolveStart = resolve; });
  } };
  const delivery = runtime.startQueuedMessage('thread-1');
  assert.equal(runtime.startingQueuedMessage, true);
  assert.deepEqual(runtime.cancelQueuedMessage(), { cancelled: false });
  assert.equal(runtime.state.queuedMessage, queued);
  resolveStart({ turn: { id: 'delivered', status: 'inProgress' } });
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


test('New Task materialization failure preserves selection and never names or exposes the task', async () => {
  for (const machineId of ['local', 'ssh:b']) {
    const gateway = new PocketGateway({ machines: [{ name: 'B', ssh: 'b' }] });
    const a = gateway.runtimes.get('local'), b = gateway.runtimes.get(machineId);
    Object.assign(a.state, { connected: true, thread: { id: 'a' }, threadStatus: 'idle' });
    b.state.connected = true;
    const before = structuredClone(a.state);
    const calls = [];
    b.rpc = { request: async (method, params) => {
      calls.push(method);
      if (method === 'thread/start') return { thread: { id: 'new' } };
      if (method === 'thread/unsubscribe') { assert.equal(params.threadId, 'new'); return {}; }
      if (method === 'thread/list') return { data: [{ id: 'new', source: 'cli', cwd: '/project' }] };
      if (method === 'thread/loaded/list') return { data: ['new'] };
      assert.equal(method, 'thread/resume');
      assert.deepEqual(params, { threadId: 'new', excludeTurns: false });
      throw new Error('Materialization failed');
    } };
    await assert.rejects(gateway.taskAction({ action: 'create', machineId, expectedMachineId: 'local', expectedThreadId: 'a', name: 'New', cwd: '/project' }), /Materialization failed/);
    assert.equal(gateway.selectedMachineId, 'local');
    assert.deepEqual(a.state, before);
    assert(!b.loadedThreads.some(t => t.id === 'new'));
    assert.deepEqual(calls, ['thread/start', 'thread/resume', 'thread/unsubscribe']);
    assert.deepEqual(await b.refreshLoadedThreads(), []);
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
  assert.equal(runtime.snapshot().taskTerminalResults['thread-1'], 'Done');
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
    assert.equal(gateway.snapshot().taskTerminalResults.b, 'Done');
    // Reload/snapshot and a redundant selection of the current task are not acknowledgment.
    assert.equal(gateway.snapshot().taskTerminalResults.b, 'Done');
    await gateway.selectDestination(targetId, 'b', targetId, 'b');
    assert.equal(gateway.snapshot().taskTerminalResults.b, 'Done');
  }
});
