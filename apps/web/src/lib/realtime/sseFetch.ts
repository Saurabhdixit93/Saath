import type { RealtimeServerEvent } from "./types";

export interface SseStreamOptions {
  url: string;
  token: string;
  signal: AbortSignal;
  onOpen?: () => void;
  onEvent: (event: RealtimeServerEvent) => void;
  onError?: (err: unknown) => void;
  fetchImpl?: typeof globalThis.fetch;
}

function dispatchRawFrame(
  rawBlock: string,
  onEvent: (event: RealtimeServerEvent) => void
): void {
  const lines = rawBlock.split(/\r?\n/);
  let eventName = "";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return;
  }

  try {
    const parsed = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
    if (!parsed.type && eventName) {
      parsed.type = eventName;
    }
    if (typeof parsed.type === "string") {
      onEvent(parsed as unknown as RealtimeServerEvent);
    }
  } catch {
    // Ignore malformed event payloads
  }
}

export async function connectSseStream(options: SseStreamOptions): Promise<void> {
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  try {
    const resp = await fetchFn(options.url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${options.token}`,
        Accept: "text/event-stream",
      },
      cache: "no-store",
      signal: options.signal,
    });

    if (!resp.ok || !resp.body) {
      throw new Error(`SSE stream rejected (${resp.status})`);
    }

    options.onOpen?.();

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (!options.signal.aborted) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const normalized = buffer.replace(/\r\n/g, "\n");
      const parts = normalized.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const block of parts) {
        if (block.trim()) {
          dispatchRawFrame(block, options.onEvent);
        }
      }
    }

    if (buffer.trim() && !options.signal.aborted) {
      dispatchRawFrame(buffer, options.onEvent);
    }

    if (!options.signal.aborted) {
      options.onError?.(new Error("SSE stream closed"));
    }
  } catch (err) {
    if (!options.signal.aborted) {
      options.onError?.(err);
    }
  }
}
