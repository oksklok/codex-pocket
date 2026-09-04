import test from "node:test";
import assert from "node:assert/strict";

import {
  destinationTaskStatus,
  historyTurnTimestamp,
  isUnsupportedMethodError,
  pocketPhase,
  preserveMessageCreatedAt,
  shouldShowWorkingFallback,
} from "../public/pocket-logic.js";

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

test("working fallback appears only when no visible current activity is running", () => {
  assert.equal(shouldShowWorkingFallback("working", [], "turn-1"), true);
  assert.equal(shouldShowWorkingFallback("working", [{ status: "running", turnId: "turn-1" }], "turn-1"), false);
  assert.equal(shouldShowWorkingFallback("working", [{ status: "running", turnId: "turn-old" }], "turn-1"), true);
  assert.equal(shouldShowWorkingFallback("done", [], "turn-1"), false);
});

test("legacy item history fallback recognizes only unsupported-method errors", () => {
  assert.equal(isUnsupportedMethodError("Method not found (-32601)"), true);
  assert.equal(isUnsupportedMethodError("unsupported app-server method"), true);
  assert.equal(isUnsupportedMethodError("thread/items/list timed out"), false);
  assert.equal(isUnsupportedMethodError("connection closed"), false);
});
