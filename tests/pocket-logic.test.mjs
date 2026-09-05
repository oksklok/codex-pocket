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
} from "../public/pocket-logic.js";
import { MachineRuntime } from "../gateway.ts";

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
