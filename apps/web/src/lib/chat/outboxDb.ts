export type OutboxStatus = "queued" | "sending" | "failed";

export interface PendingChatMessage {
  client_id: string;
  conversation_id: string;
  body: string;
  lang?: "en" | "hi";
  created_at: string;
  status: OutboxStatus;
  attempts: number;
  error_detail?: string;
}

const DB_NAME = "saath_chat_outbox";
const DB_VERSION = 1;
const STORE_NAME = "pending_messages";

const memoryFallback = new Map<string, PendingChatMessage>();
const inFlightFlushes = new Map<string, Promise<number>>();

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

function openOutboxDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "client_id" });
        store.createIndex("by_conversation", "conversation_id", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Failed to open IndexedDB"));
  });
}

export async function enqueuePendingMessage(
  msg: PendingChatMessage
): Promise<void> {
  if (!hasIndexedDb()) {
    memoryFallback.set(msg.client_id, msg);
    return;
  }
  const db = await openOutboxDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(msg);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Failed to enqueue message"));
  });
  db.close();
}

export async function listPendingForConversation(
  conversationId: string
): Promise<PendingChatMessage[]> {
  if (!hasIndexedDb()) {
    return Array.from(memoryFallback.values())
      .filter((m) => m.conversation_id === conversationId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  const db = await openOutboxDb();
  const rows = await new Promise<PendingChatMessage[]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const idx = tx.objectStore(STORE_NAME).index("by_conversation");
    const req = idx.getAll(IDBKeyRange.only(conversationId));
    req.onsuccess = () => resolve((req.result as PendingChatMessage[]) ?? []);
    req.onerror = () => reject(req.error ?? new Error("Failed to read outbox"));
  });
  db.close();
  return rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function listAllPendingMessages(): Promise<PendingChatMessage[]> {
  if (!hasIndexedDb()) {
    return Array.from(memoryFallback.values()).sort((a, b) =>
      a.created_at.localeCompare(b.created_at)
    );
  }
  const db = await openOutboxDb();
  const rows = await new Promise<PendingChatMessage[]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve((req.result as PendingChatMessage[]) ?? []);
    req.onerror = () => reject(req.error ?? new Error("Failed to read all outbox"));
  });
  db.close();
  return rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function updatePendingStatus(
  clientId: string,
  patch: Partial<Pick<PendingChatMessage, "status" | "attempts" | "error_detail">>
): Promise<void> {
  if (!hasIndexedDb()) {
    const existing = memoryFallback.get(clientId);
    if (existing) {
      memoryFallback.set(clientId, { ...existing, ...patch });
    }
    return;
  }
  const db = await openOutboxDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(clientId);
    getReq.onsuccess = () => {
      const existing = getReq.result as PendingChatMessage | undefined;
      if (existing) {
        store.put({ ...existing, ...patch });
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Failed to update outbox status"));
  });
  db.close();
}

export async function removePendingMessage(clientId: string): Promise<void> {
  if (!hasIndexedDb()) {
    memoryFallback.delete(clientId);
    return;
  }
  const db = await openOutboxDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(clientId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Failed to remove outbox item"));
  });
  db.close();
}

export async function clearOutboxMemoryForTests(): Promise<void> {
  memoryFallback.clear();
  inFlightFlushes.clear();
}

export interface SendQueuedFnResult {
  ok: boolean;
  permanentFailure?: boolean;
  errorDetail?: string;
}

export async function flushConversationOutbox(
  conversationId: string,
  sendFn: (msg: PendingChatMessage) => Promise<SendQueuedFnResult>
): Promise<number> {
  const existing = inFlightFlushes.get(conversationId);
  if (existing) {
    await existing.catch(() => 0);
    const remaining = await listPendingForConversation(conversationId);
    if (!remaining.some((m) => m.status === "queued")) {
      return 0;
    }
    return flushConversationOutbox(conversationId, sendFn);
  }

  const runFlush = (async () => {
    const pending = await listPendingForConversation(conversationId);
    let sentCount = 0;

    for (const item of pending) {
      if (item.status === "failed" || item.status === "sending") {
        continue;
      }
      await updatePendingStatus(item.client_id, { status: "sending" });
      try {
        const res = await sendFn(item);
        if (res.ok) {
          await removePendingMessage(item.client_id);
          sentCount += 1;
        } else if (res.permanentFailure) {
          await updatePendingStatus(item.client_id, {
            status: "failed",
            attempts: item.attempts + 1,
            error_detail: res.errorDetail || "Message blocked or rejected",
          });
        } else {
          await updatePendingStatus(item.client_id, {
            status: "queued",
            attempts: item.attempts + 1,
            error_detail: res.errorDetail,
          });
        }
      } catch (err) {
        await updatePendingStatus(item.client_id, {
          status: "queued",
          attempts: item.attempts + 1,
          error_detail: err instanceof Error ? err.message : "Network error",
        });
      }
    }
    return sentCount;
  })();

  inFlightFlushes.set(conversationId, runFlush);
  try {
    return await runFlush;
  } finally {
    if (inFlightFlushes.get(conversationId) === runFlush) {
      inFlightFlushes.delete(conversationId);
    }
  }
}

export async function flushAllOutbox(
  sendFn: (msg: PendingChatMessage) => Promise<SendQueuedFnResult>
): Promise<number> {
  const all = await listAllPendingMessages();
  const convoIds = Array.from(new Set(all.map((m) => m.conversation_id)));
  let total = 0;
  for (const cid of convoIds) {
    total += await flushConversationOutbox(cid, sendFn);
  }
  return total;
}
