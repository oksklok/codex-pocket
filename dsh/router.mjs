// Connection-safe correlation for the runtime's client <-> DSH-child request flow. This is a small
// routing state machine, not a broker: runtime.mjs owns the sockets and the child process, and this
// module only decides which connection a frame belongs to.
//
// Every client request forwarded to the child gets a private child id. The child's reply is mapped
// back to the client's own id and is delivered only to the connection that sent the request, so a
// delayed reply belonging to a superseded connection can never satisfy a newer connection that
// reused the same numeric id. A superseded or draining connection may not submit anything.
export class RequestRouter {
  constructor() {
    this.client = null;
    this.childSeq = 0;
    this.pending = new Map(); // child server-request id -> { line, connection, pocketRequestId }
    this.pocketPending = new Map(); // pocketRequestId -> child server-request id
    this.clientRequests = new Map(); // child id -> { connection, clientId }
    this.starting = new Set(); // child ids of turn/start and turn/steer awaiting their reply
    this.draining = false;
  }

  // A new connection becomes the sole writer. Genuinely pending server requests are handed over with
  // their original identities so the new connection can answer them; the previous writer is returned
  // so the runtime can retire it.
  attach(socket) {
    if (this.draining) return { accepted: false };
    const previous = this.client;
    this.client = socket;
    for (const entry of this.pending.values()) entry.connection = socket;
    return { accepted: true, previous, replay: [...this.pending.values()].map((entry) => entry.line) };
  }

  detach(socket) {
    if (this.client === socket) this.client = null;
  }

  // A frame from a client connection. Answers to server requests are forwarded unchanged; client
  // requests are rewritten to a private child id; notifications pass through. Anything from a
  // superseded connection, or any new work while draining, is dropped.
  fromClient(frame, line, socket) {
    if (this.draining || socket !== this.client) return { action: "drop" };
    if (frame.method === undefined) {
      if (frame.id === undefined) return { action: "drop" };
      const id = String(frame.id);
      const entry = this.pending.get(id);
      if (!entry || entry.connection !== socket) return { action: "drop" };
      this.pending.delete(id);
      if (entry.pocketRequestId) this.pocketPending.delete(entry.pocketRequestId);
      return { action: "forward", line };
    }
    if (frame.id === undefined) return { action: "forward", line };
    const childId = String(++this.childSeq);
    this.clientRequests.set(childId, { connection: socket, clientId: frame.id });
    if (frame.method === "turn/start" || frame.method === "turn/steer") this.starting.add(childId);
    return { action: "forward", line: JSON.stringify({ ...frame, id: Number(childId) }) };
  }

  // A server request from the child (approval or structured question) is remembered with the
  // connection it was delivered to and its pocket identity.
  serverRequest(frame, line) {
    const id = String(frame.id);
    const pocketRequestId = typeof frame.params?.pocketRequestId === "string" ? frame.params.pocketRequestId : null;
    this.pending.set(id, { line, connection: this.client, pocketRequestId });
    if (pocketRequestId) this.pocketPending.set(pocketRequestId, id);
  }

  // The child reports a server request resolved or cancelled: retire it so it is never replayed.
  resolvePocket(pocketRequestId) {
    const id = this.pocketPending.get(pocketRequestId);
    if (id === undefined) return;
    this.pending.delete(id);
    this.pocketPending.delete(pocketRequestId);
  }

  // A reply from the child to an earlier client request. Returns the owner and the client-id
  // restored line, or marks it dropped when the owner has been superseded or is unknown.
  reply(frame, line) {
    const childId = String(frame.id);
    const entry = this.clientRequests.get(childId);
    if (!entry) return { drop: true };
    this.clientRequests.delete(childId);
    this.starting.delete(childId);
    if (entry.connection !== this.client) return { drop: true };
    return { deliver: { socket: entry.connection, line: JSON.stringify({ ...frame, id: entry.clientId }) } };
  }

  startDraining() {
    this.draining = true;
  }

  busy(activeTurns = 0) {
    return this.draining || activeTurns > 0 || this.starting.size > 0;
  }
}
