// Connection-safe routing checks for the durable runtime carrier. Pure state machine: no sockets,
// no DSH process, no credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { RequestRouter } from "../dsh/router.mjs";

const socketA = { name: "A" };
const socketB = { name: "B" };
const frame = (id, method, params = {}) => ({ jsonrpc: "2.0", id, method, params });

test("a delayed reply to a superseded connection cannot satisfy a reused id", () => {
  const router = new RequestRouter();
  assert.equal(router.attach(socketA).accepted, true);
  const first = router.fromClient(frame(1, "thread/read"), "first", socketA);
  assert.equal(first.action, "forward");
  assert.equal(JSON.parse(first.line).id, 1, "the private child id");

  // A new gateway connection attaches and reuses the same numeric id.
  const attached = router.attach(socketB);
  assert.equal(attached.accepted, true);
  assert.equal(attached.previous, socketA, "the previous writer is handed back for retirement");
  const second = router.fromClient(frame(1, "thread/read"), "second", socketB);
  assert.equal(second.action, "forward");
  assert.equal(JSON.parse(second.line).id, 2, "the reused client id maps to a distinct child id");

  // The old child reply arrives late. It belongs to A and must never reach B.
  const late = router.reply({ id: 1, result: "old" }, '{"id":1,"result":"old"}');
  assert.equal(late.drop, true, "the late reply is dropped for the superseded connection");
  const own = router.reply({ id: 2, result: "new" }, '{"id":2,"result":"new"}');
  assert.equal(own.deliver.socket, socketB);
  assert.equal(JSON.parse(own.deliver.line).id, 1, "B receives its own id restored");
});

test("a superseded connection can no longer submit work", () => {
  const router = new RequestRouter();
  router.attach(socketA);
  router.attach(socketB);
  assert.equal(router.fromClient(frame(2, "turn/start", { threadId: "t" }), "x", socketA).action, "drop");
  assert.equal(router.fromClient(frame(3, "turn/steer", { threadId: "t" }), "x", socketA).action, "drop");
  assert.equal(router.fromClient(frame(4, "thread/read"), "x", socketB).action, "forward");
});

test("pending server requests transfer with their original identity", () => {
  const router = new RequestRouter();
  router.attach(socketA);
  const line = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "item/tool/requestUserInput", params: { threadId: "t", pocketRequestId: "p1" } });
  router.serverRequest(JSON.parse(line), line);
  const attached = router.attach(socketB);
  assert.deepEqual(attached.replay, [line], "the question is replayed with the same id");
  // The retired connection can no longer answer a question it no longer owns.
  assert.equal(router.fromClient({ id: 7, result: { answers: {} } }, "answer", socketA).action, "drop");
  assert.equal(router.fromClient({ id: 7, result: { answers: {} } }, "answer", socketB).action, "forward");
});

test("a resolved or cancelled server request is never replayed", () => {
  const router = new RequestRouter();
  router.attach(socketA);
  const line = JSON.stringify({ id: 8, method: "item/commandExecution/requestApproval", params: { threadId: "t", pocketRequestId: "p2" } });
  router.serverRequest(JSON.parse(line), line);
  router.resolvePocket("p2");
  assert.deepEqual(router.attach(socketB).replay, []);
});

test("a starting turn keeps the runtime busy across a detach", () => {
  const router = new RequestRouter();
  router.attach(socketA);
  const started = router.fromClient(frame(5, "turn/start", { threadId: "t" }), "start", socketA);
  assert.equal(JSON.parse(started.line).id, 1);
  assert.equal(router.busy(0), true, "a forwarded turn/start counts as work");
  router.attach(socketB);
  assert.equal(router.busy(0), true, "the accepted turn is still starting after a detach");
  router.reply({ id: 1, result: {} }, '{"id":1,"result":{}}');
  assert.equal(router.busy(0), false, "the child reply retires the starting turn");
});

test("draining rejects new work and competing attaches", () => {
  const router = new RequestRouter();
  router.attach(socketA);
  router.startDraining();
  assert.equal(router.busy(0), true);
  assert.equal(router.attach(socketB).accepted, false);
  assert.equal(router.fromClient(frame(6, "thread/start"), "x", socketA).action, "drop");
});
