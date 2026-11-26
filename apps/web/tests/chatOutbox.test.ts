import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearOutboxMemoryForTests,
  enqueuePendingMessage,
  flushConversationOutbox,
  listPendingForConversation,
} from "../src/lib/chat/outboxDb";

describe("IndexedDB / fallback chat offline outbox", () => {
  beforeEach(async () => {
    await clearOutboxMemoryForTests();
  });

  it("queues messages offline and flushes cleanly on reconnect", async () => {
    await enqueuePendingMessage({
      client_id: "cli-100",
      conversation_id: "convo-1",
      body: "Happy to swap!",
      created_at: "2026-11-26T00:00:00Z",
      status: "queued",
      attempts: 0,
    });

    const queued = await listPendingForConversation("convo-1");
    expect(queued).toHaveLength(1);
    expect(queued[0]!.client_id).toBe("cli-100");

    const sendFn = vi.fn(async () => ({ ok: true }));
    const sent = await flushConversationOutbox("convo-1", sendFn);
    expect(sent).toBe(1);
    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(await listPendingForConversation("convo-1")).toHaveLength(0);
  });

  it("marks permanent 403/422 errors as failed without dropping the record", async () => {
    await enqueuePendingMessage({
      client_id: "cli-200",
      conversation_id: "convo-2",
      body: "Blocked message",
      created_at: "2026-11-26T00:00:00Z",
      status: "queued",
      attempts: 0,
    });

    const sent = await flushConversationOutbox("convo-2", async () => ({
      ok: false,
      permanentFailure: true,
      errorDetail: "You cannot message a blocked traveller.",
    }));
    expect(sent).toBe(0);

    const remaining = await listPendingForConversation("convo-2");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.status).toBe("failed");
    expect(remaining[0]!.error_detail).toContain("blocked");
  });

  it("serializes concurrent flushes per conversation without double-sending client_id", async () => {
    await enqueuePendingMessage({
      client_id: "cli-concurrent-1",
      conversation_id: "convo-concurrent",
      body: "Meet at coach door",
      created_at: "2026-11-26T00:00:00Z",
      status: "queued",
      attempts: 0,
    });

    const sendFn = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { ok: true };
    });

    const [sentA, sentB] = await Promise.all([
      flushConversationOutbox("convo-concurrent", sendFn),
      flushConversationOutbox("convo-concurrent", sendFn),
    ]);

    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(sentA + sentB).toBe(1);
    expect(await listPendingForConversation("convo-concurrent")).toHaveLength(0);
  });
});
