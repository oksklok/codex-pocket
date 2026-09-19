// Private stdio carrier for DSH's existing Host services. DSH owns all agent work.
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";
import { DeepSeekBalanceMonitor } from "../deepseek.ts";
import {
  DSH_VERSION,
  sessionId,
  permission,
  projectEvents,
} from "./projection.mjs";

export const name = "pocket-dsh";
export const inject = [
  "sessionController",
  "permissionPresets",
  "loader",
  "agents",
  "workspaceRegistry",
  "credentials",
  "goals",
  "llm",
];
export function apply(ctx) {
  const wire = new JsonRpcLineTransport(process.stdin, process.stdout);
  const api = ctx.sessionController;
  const notify = (method, params) => wire.notify(method, params);
  const lifecycle = new AbortController();
  const signal = lifecycle.signal;
  ctx.effect(() => () => lifecycle.abort());
  const active = new Map();
  const attempts = new Map();
  const usageSeq = new Map();
  const goalValue = (g) =>
    g ? { objective: g.objective, status: g.phase } : null;
  async function usage(id, events) {
    const e = events.findLast(
      (e) =>
        e.type === "assistant/message" &&
        Number.isFinite(e.data.usage?.totalTokens),
    );
    const request = events.findLast(
      (event) => event.type === "request/header" && (!e || event.seq < e.seq),
    );
    if (!e || !request) return;
    usageSeq.set(id, e.seq);
    try {
      const config = request.data.header.config;
      const model = await ctx.llm.resolveModelInfo(
        config.provider,
        config.model,
      );
      if (
        usageSeq.get(id) !== e.seq ||
        !Number.isFinite(model.context?.contextWindow)
      )
        return;
      notify("thread/tokenUsage/updated", {
        threadId: id,
        tokenUsage: {
          last: { totalTokens: e.data.usage.totalTokens },
          modelContextWindow: model.context?.contextWindow,
        },
      });
    } catch {
      /* Unknown capacity stays unknown. */
    }
  }
  let balance;
  ctx.effect(() => () => balance?.stop());
  async function agent(id) {
    const found = await api.resolveAgent(sessionId(id));
    if (found.error) throw found.error;
    return found.agent;
  }
  async function settings(id) {
    const a = await agent(id);
    const preset = ctx.permissionPresets.current(a.session);
    const inspected = await api.inspect(id);
    const selection = inspected.events.findLast(
      (e) => e.type === "model/selection",
    )?.data ?? { model: "deepseek-flash", reasoningEffort: "high" };
    return {
      cwd: inspected.meta.cwd,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort,
      activePermissionProfile: {
        id:
          preset === "danger-full-access"
            ? ":danger-full-access"
            : ":workspace",
      },
      approvalsReviewer: "user",
      approvalPolicy: preset === "danger-full-access" ? "never" : "on-request",
      sandbox: {
        type:
          preset === "danger-full-access"
            ? "dangerFullAccess"
            : "workspaceWrite",
      },
    };
  }
  async function read(id, includeTurns = false) {
    sessionId(id);
    const { meta, events } = await api.inspect(id);
    const turns = projectEvents(events);
    return {
      id,
      name:
        events.findLast((e) => e.type === "session/title")?.data.title ?? "",
      preview:
        turns
          .flatMap((t) => t.items)
          .find((i) => i.type === "userMessage")
          ?.content?.find((p) => p.type === "text")?.text ?? "",
      cwd: meta.cwd,
      source: "appServer",
      modelProvider: "deepseek",
      createdAt: meta.createdAt,
      updatedAt: events.at(-1)?.time ?? meta.createdAt,
      status: {
        type: ctx.agents.get(id)?.status === "running" ? "active" : "idle",
      },
      canAcceptDirectInput: true,
      ...(includeTurns ? { turns } : {}),
    };
  }
  async function update(id, p) {
    const a = await agent(id);
    if (p.cwd && p.cwd !== a.session.header.cwd)
      throw new Error(
        "DSH does not expose changing an existing session workspace; create a task in that folder",
      );
    const target = permission(p, ctx.permissionPresets.current(a.session));
    ctx.permissionPresets.set(a.session, target);
    if (p.model || p.effort) {
      const old = await settings(id);
      await api.selectModel({
        sessionId: id,
        provider: "deepseek-official",
        model: p.model ?? old.model,
        reasoningEffort: p.effort ?? old.reasoningEffort,
      });
    }
    notify("thread/settings/updated", {
      threadId: id,
      threadSettings: await settings(id),
    });
  }
  wire.onRequest(async (method, p = {}) => {
    await ctx.loader.await();
    if (method === "initialize")
      return {
        userAgent: `DeepSeek Harness ${DSH_VERSION}`,
        platformFamily: process.platform,
        platformOs: process.platform,
        backend: "dsh",
      };
    if (method === "pocket/home") return { home: homedir() };
    if (method === "pocket/balance") {
      balance ??= new DeepSeekBalanceMonitor({
        key: (await ctx.credentials.resolve("DEEPSEEK_API_KEY"))?.value,
      });
      await balance.refresh();
      return balance.snapshot();
    }
    if (method === "model/list") {
      const catalog = await api.modelCatalog();
      return {
        data: catalog.groups
          .filter((g) => g.id === "deepseek-official")
          .flatMap((g) =>
            g.models.map((m) => ({
              id: m.id,
              model: m.id,
              displayName: m.name,
              description: m.description,
              defaultReasoningEffort: m.reasoning?.defaultEffort,
              supportedReasoningEfforts: m.reasoning?.efforts.map((e) => ({
                reasoningEffort: e.id,
                description: e.description,
              })),
            })),
          ),
        nextCursor: null,
      };
    }
    if (method === "configRequirements/read")
      return { requirements: { allowedApprovalsReviewers: ["user"] } };
    if (method === "permissionProfile/list")
      return {
        data: [
          { id: ":workspace", name: "Ask", allowed: true },
          { id: ":danger-full-access", name: "Full access", allowed: true },
        ],
        nextCursor: null,
      };
    if (method === "thread/list" || method === "thread/loaded/list") {
      const list = await api.list({}, signal);
      const archived = new Set(ctx.workspaceRegistry.archivedSessionIds);
      const ids = list.items.filter(
        (i) =>
          /^dsh-/.test(i.sessionId) &&
          !i.parentSessionId &&
          archived.has(i.sessionId) === (p.archived === true),
      );
      return {
        data:
          method === "thread/loaded/list"
            ? ids
                .filter((i) => ctx.agents.get(i.sessionId))
                .map((i) => i.sessionId)
            : ids.map((i) => ({
                id: i.sessionId,
                name: i.projections?.values.title ?? "",
                cwd: i.cwd,
                updatedAt: i.updatedAt,
                status: { type: i.running ? "active" : "idle" },
                source: "appServer",
                modelProvider: "deepseek",
                canAcceptDirectInput: true,
              })),
        nextCursor: null,
      };
    }
    if (method === "thread/start") {
      // Validate before creating any durable state.
      permission(p);
      const { sessionId: id } = await api.create({
        sessionId: `dsh-${randomUUID()}`,
        cwd: p.cwd || homedir(),
      });
      await update(id, p);
      return { thread: await read(id), ...(await settings(id)) };
    }
    if (method === "thread/read")
      return { thread: await read(p.threadId, p.includeTurns === true) };
    if (method === "thread/resume") {
      await agent(p.threadId);
      await usage(p.threadId, (await api.inspect(p.threadId)).events);
      return {
        thread: await read(p.threadId),
        ...(await settings(p.threadId)),
      };
    }
    if (method === "thread/unsubscribe") return {};
    if (method === "thread/settings/update") {
      await update(p.threadId, p);
      return {};
    }
    if (method === "thread/name/set") {
      await api.rename({ sessionId: sessionId(p.threadId), title: p.name });
      return {};
    }
    if (method === "thread/archive" || method === "thread/unarchive") {
      const id = sessionId(p.threadId);
      if (ctx.agents.get(id)?.status === "running")
        throw new Error("Stop the task first");
      await ctx.workspaceRegistry[
        method === "thread/archive" ? "archiveSession" : "unarchiveSession"
      ](id);
      return {};
    }
    if (method === "thread/delete")
      throw new Error(
        "DSH 0.1.6-alpha.2 has no session-deletion Host operation; archive is available",
      );
    if (method === "thread/goal/get")
      return { goal: goalValue(ctx.goals.get(await agent(p.threadId))) };
    if (method === "thread/goal/set" || method === "thread/goal/clear") {
      const a = await agent(p.threadId),
        g = ctx.goals.get(a);
      if (!g) throw new Error("No DSH goal is active");
      const ref = { id: g.id, revision: g.revision };
      if (method === "thread/goal/clear") {
        ctx.goals.clear(a, ref);
        return { cleared: true };
      }
      if (!["active", "paused"].includes(p.status))
        throw new Error("Unsupported DSH goal transition");
      const updated =
        p.status === "paused"
          ? ctx.goals.pause(a, ref)
          : ctx.goals.resume(a, ref);
      return { goal: goalValue(updated) };
    }
    if (method === "thread/turns/list" || method === "thread/items/list") {
      const thread = await read(p.threadId, true);
      return {
        data:
          method === "thread/turns/list"
            ? [...thread.turns].reverse()
            : thread.turns
                .filter((t) => !p.turnId || t.id === p.turnId)
                .flatMap((t) =>
                  t.items.map((item) => ({ turnId: t.id, item })),
                ),
        nextCursor: null,
      };
    }
    if (method === "turn/interrupt") {
      const id = sessionId(p.threadId);
      if (String(active.get(id)) !== String(p.turnId))
        throw new Error("DSH active turn changed before Stop");
      return api.cancel({ sessionId: id });
    }
    if (method === "turn/start" || method === "turn/steer") {
      const id = sessionId(p.threadId);
      if (
        method === "turn/steer" &&
        String(active.get(id)) !== String(p.expectedTurnId)
      )
        throw new Error("DSH active turn changed before steering");
      const a = await agent(id);
      if (method === "turn/start" && a.status === "running")
        throw new Error("DSH task is already running; start was not admitted");
      const content = (p.input ?? []).map((part) => {
        if (part.type === "text") return { type: "text", text: part.text };
        if (part.type === "image") {
          const m =
            /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(
              part.url ?? "",
            );
          if (!m) throw new Error("DSH requires inline image input");
          return { type: "image", mediaType: m[1], data: m[2] };
        }
        throw new Error("Unsupported DSH input type");
      });
      await api.prompt(
        {
          sessionId: id,
          requestId: p.requestId ?? randomUUID(),
          mode: method === "turn/steer" ? "steer" : "queue",
          content,
        },
        signal,
      );
      const turn = (await read(id, true)).turns.at(-1);
      return method === "turn/steer" ? { turnId: turn?.id } : { turn };
    }
    if (method === "fs/readFile")
      return { dataBase64: (await readFile(p.path)).toString("base64") };
    throw new Error(`DSH adapter does not support ${method}`);
  });
  ctx.on("goal/changed", ({ agent, change }) => {
    if (!/^dsh-/.test(agent.id)) return;
    notify(change.goal ? "thread/goal/updated" : "thread/goal/cleared", {
      threadId: agent.id,
      goal: goalValue(change.goal),
    });
  });
  ctx.on("session/event", (session, event) => {
    if (!/^dsh-/.test(session.id)) return;
    if (
      ![
        "turn/start",
        "turn/end",
        "user/message",
        "assistant/message",
        "tool/call",
        "tool/result",
        "compaction/start",
        "compaction/end",
      ].includes(event.type)
    )
      return;
    if (event.type === "assistant/message")
      void usage(session.id, session.snapshotEvents());
    const threadId = session.id,
      d = event.data;
    const turns = projectEvents(session.snapshotEvents());
    const turn = turns.at(-1);
    if (event.type === "turn/start") active.set(threadId, String(d.turn));
    if (event.type === "turn/start") notify("turn/started", { threadId, turn });
    if (event.type === "turn/end") notify("turn/completed", { threadId, turn });
    if (event.type === "compaction/start" || event.type === "compaction/end") {
      const item = turn?.items.findLast((i) => i.type === "contextCompaction");
      if (item)
        notify(
          event.type === "compaction/start" ? "item/started" : "item/completed",
          { threadId, turnId: turn.id, item },
        );
    }
    if (
      [
        "user/message",
        "assistant/message",
        "tool/call",
        "tool/result",
        "compaction/start",
        "compaction/end",
      ].includes(event.type)
    ) {
      const items = turn?.items ?? [];
      const item =
        event.type === "tool/result"
          ? items.find(
              (i) =>
                i.id ===
                (d.message.content?.[0]?.toolCallId ??
                  d.message.content?.[0]?.callId),
            )
          : items.at(-1);
      if (item)
        notify(event.type === "tool/call" ? "item/started" : "item/completed", {
          threadId,
          turnId: turn.id,
          item,
        });
    }
  });
  ctx.on("agent/assistant-stream", ({ agent, frame }) => {
    if (!/^dsh-/.test(agent.id)) return;
    if (frame.type === "start")
      attempts.set(agent.id, {
        turnId: String(frame.turn),
        itemId: `assistant-${frame.turn}-${frame.step}`,
      });
    const attempt = attempts.get(agent.id);
    if (frame.type === "chunk" && frame.chunk.type === "text-delta" && attempt)
      notify("item/agentMessage/delta", {
        threadId: agent.id,
        ...attempt,
        delta: frame.chunk.text,
      });
    if (frame.type === "end") attempts.delete(agent.id);
  });
  ctx.on("agent/status", ({ agent, status }) =>
    notify("thread/status/changed", {
      threadId: agent.id,
      status: { type: status === "running" ? "active" : "idle" },
    }),
  );
  async function humanRequest(method, params, signal) {
    const pocketRequestId = randomUUID();
    try {
      return await wire.request(method, { ...params, pocketRequestId }, signal);
    } finally {
      notify("pocket/requestResolved", { pocketRequestId });
    }
  }
  ctx.on("user-questions/request", async (req, next) => {
    if (!req.agent || !/^dsh-/.test(req.agent.id)) return next();
    if (
      req.questions.length > 3 ||
      req.questions.some((q) => q.multiSelect || (q.options?.length ?? 0) > 20)
    )
      throw new Error(
        "Pocket supports at most three single-selection DSH questions with at most twenty options each",
      );
    const result = await humanRequest(
      "item/tool/requestUserInput",
      {
        threadId: req.agent.id,
        turnId: active.get(req.agent.id),
        itemId: `question-${randomUUID()}`,
        isBlocking: true,
        questions: req.questions.map((q) => ({
          ...q,
          header: q.header ?? "Question",
          question: [q.question, q.detail].filter(Boolean).join("\n\n"),
          isOther: true,
          options: q.options?.map((o) => ({
            ...o,
            description: o.description ?? "",
          })),
        })),
      },
      req.signal,
    );
    return {
      answers: req.questions.map((q) => {
        const values = result.answers?.[q.id]?.answers ?? [];
        return {
          id: q.id,
          selected: values.filter((v) => q.options?.some((o) => o.label === v)),
          custom: values
            .filter((v) => !q.options?.some((o) => o.label === v))
            .join("\n"),
        };
      }),
    };
  });
  ctx.on("approval/request", async (req, next) => {
    if (!/^dsh-/.test(req.agent.id)) return next();
    const call = req.agent.session
      .snapshotEvents()
      .findLast((e) => e.type === "tool/call" && e.data.callId === req.callId);
    let command = req.toolName;
    if (call) {
      try {
        command =
          JSON.parse(call.data.arguments).command ??
          `${req.toolName} ${call.data.arguments}`;
      } catch {}
    }
    const answer = await humanRequest(
      "item/commandExecution/requestApproval",
      {
        threadId: req.agent.id,
        turnId: active.get(req.agent.id),
        itemId: req.callId,
        command,
        reason: req.reason,
      },
      req.signal,
    );
    return answer?.decision === "accept" ? "allowed-once" : "rejected";
  });
  ctx.effect(() => {
    wire.start();
    return () => wire.close();
  });
}
