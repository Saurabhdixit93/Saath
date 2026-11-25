import WebSocket from 'ws';
import { E2E_ENV } from './env.js';

export interface RealtimeEvent {
  type: string;
  [key: string]: unknown;
}

interface PendingWaiter<T extends RealtimeEvent> {
  type: string;
  predicate?: (event: T) => boolean;
  resolve: (event: T) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function rawDataToString(raw: WebSocket.RawData): string {
  if (typeof raw === 'string') {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString('utf8');
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString('utf8');
  }
  return Buffer.from(raw).toString('utf8');
}

function resolveWsEndpoint(baseOrFullUrl: string): string {
  const trimmed = baseOrFullUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/v1/ws') ? trimmed : `${trimmed}/v1/ws`;
}

function resolveSseEndpoint(baseUrl: string, pathOrUrl: string, query?: Record<string, string>): string {
  const raw = /^https?:\/\//i.test(pathOrUrl)
    ? pathOrUrl
    : `${baseUrl.replace(/\/+$/, '')}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
  const url = new URL(raw);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.set(k, v);
    }
  }
  return url.toString();
}

export class SaathWsClient {
  private ws: WebSocket | null = null;
  private buffer: RealtimeEvent[] = [];
  private waiters: PendingWaiter<RealtimeEvent>[] = [];
  private closed = false;

  async connectAndAuth(
    token: string,
    wsUrl: string = E2E_ENV.wsUrl,
    timeoutMs = 10_000,
  ): Promise<void> {
    if (this.ws) {
      await this.close();
    }
    this.buffer = [];
    this.waiters = [];
    this.closed = false;

    const targetUrl = resolveWsEndpoint(wsUrl);
    const socket = new WebSocket(targetUrl);
    this.ws = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.terminate();
          reject(new Error(`WS auth timed out after ${timeoutMs}ms (${targetUrl})`));
        }
      }, timeoutMs);

      const fail = (err: Error): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      };

      socket.on('open', () => {
        socket.send(JSON.stringify({ type: 'auth', token }));
      });

      socket.on('message', (raw) => {
        const text = rawDataToString(raw);
        let parsed: RealtimeEvent;
        try {
          parsed = JSON.parse(text) as RealtimeEvent;
        } catch {
          return;
        }

        if (!settled) {
          if (parsed.type === 'ready') {
            settled = true;
            clearTimeout(timer);
            resolve();
            return;
          }
          if (parsed.type === 'error') {
            fail(new Error(`WS auth rejected: ${text}`));
            return;
          }
        }

        this.dispatchEvent(parsed);
      });

      socket.on('error', (err) => {
        fail(err instanceof Error ? err : new Error(String(err)));
      });

      socket.on('close', (code, reasonBuf) => {
        this.closed = true;
        const reason = reasonBuf.toString('utf8');
        if (!settled) {
          fail(new Error(`WS closed before ready (code=${code}, reason=${reason})`));
        } else {
          this.rejectAllWaiters(
            new Error(`WS closed while waiting for event (code=${code}, reason=${reason})`),
          );
        }
      });
    });
  }

  private dispatchEvent(event: RealtimeEvent): void {
    const idx = this.waiters.findIndex(
      (w) => w.type === event.type && (!w.predicate || w.predicate(event)),
    );
    if (idx !== -1) {
      const waiter = this.waiters.splice(idx, 1)[0];
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(event);
        return;
      }
    }
    this.buffer.push(event);
  }

  private rejectAllWaiters(err: Error): void {
    const pending = this.waiters.splice(0, this.waiters.length);
    for (const waiter of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
  }

  async waitForEvent<T extends RealtimeEvent = RealtimeEvent>(
    type: string,
    predicate?: (event: T) => boolean,
    timeoutMs = 15_000,
  ): Promise<T> {
    const bufferedIdx = this.buffer.findIndex(
      (evt) => evt.type === type && (!predicate || predicate(evt as T)),
    );
    if (bufferedIdx !== -1) {
      const matched = this.buffer.splice(bufferedIdx, 1)[0];
      if (matched) {
        return matched as T;
      }
    }

    if (this.closed || !this.ws) {
      throw new Error(`Cannot waitForEvent("${type}"): WebSocket is not connected`);
    }

    return new Promise<T>((resolve, reject) => {
      const waiter: PendingWaiter<RealtimeEvent> = {
        type,
        predicate: predicate as ((event: RealtimeEvent) => boolean) | undefined,
        resolve: resolve as (event: RealtimeEvent) => void,
        reject,
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i !== -1) {
            this.waiters.splice(i, 1);
          }
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for WS event "${type}"`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  sendTyping(conversationId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Cannot send typing frame: WebSocket is not open');
    }
    this.ws.send(JSON.stringify({ type: 'typing', conversation_id: conversationId }));
  }

  sendPing(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Cannot send ping frame: WebSocket is not open');
    }
    this.ws.send(JSON.stringify({ type: 'ping' }));
  }

  async expectAuthRejection(
    badToken?: string,
    wsUrl: string = E2E_ENV.wsUrl,
    timeoutMs = 10_000,
  ): Promise<{ code: number; reason: string }> {
    const targetUrl = resolveWsEndpoint(wsUrl);
    const socket = new WebSocket(targetUrl);

    return new Promise<{ code: number; reason: string }>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.terminate();
          reject(
            new Error(
              `Expected WS auth rejection within ${timeoutMs}ms, but socket stayed open`,
            ),
          );
        }
      }, timeoutMs);

      socket.on('open', () => {
        if (badToken !== undefined) {
          socket.send(JSON.stringify({ type: 'auth', token: badToken }));
        }
      });

      socket.on('message', (raw) => {
        const text = rawDataToString(raw);
        try {
          const parsed = JSON.parse(text) as RealtimeEvent;
          if (parsed.type === 'ready' && !settled) {
            settled = true;
            clearTimeout(timer);
            socket.terminate();
            reject(new Error('WS unexpectedly accepted invalid/missing auth and emitted ready'));
          }
        } catch {
          // ignore non-JSON frame
        }
      });

      socket.on('close', (code, reasonBuf) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ code, reason: reasonBuf.toString('utf8') });
        }
      });

      socket.on('error', () => {
        // Error during handshake/rejection is typically followed by close; if not closed yet, keep waiting briefly.
      });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.rejectAllWaiters(new Error('WebSocket closed by test client'));
    const socket = this.ws;
    this.ws = null;
    if (!socket) {
      return;
    }
    if (socket.readyState === WebSocket.CLOSED) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        socket.terminate();
        resolve();
      }, 2_000);
      socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.close();
    });
  }
}

export class SseHttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`SSE connection failed with HTTP ${status}: ${body}`);
    this.name = 'SseHttpError';
    this.status = status;
    this.body = body;
  }
}

export class SaathSseClient {
  private controller: AbortController | null = null;
  private buffer: RealtimeEvent[] = [];
  private waiters: PendingWaiter<RealtimeEvent>[] = [];
  private streamDone = false;
  public status: number | null = null;

  async connect(
    token: string,
    pathOrUrl = '/v1/events/stream',
    query?: Record<string, string>,
  ): Promise<void> {
    this.close();
    this.buffer = [];
    this.waiters = [];
    this.streamDone = false;
    this.controller = new AbortController();

    const targetUrl = resolveSseEndpoint(E2E_ENV.apiUrl, pathOrUrl, query);
    const res = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      signal: this.controller.signal,
    });

    this.status = res.status;
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new SseHttpError(res.status, text);
    }

    void this.pumpStream(res.body);
  }

  private async pumpStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let rawBuffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          const flushed = decoder.decode();
          rawBuffer = (rawBuffer + flushed).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          let boundary = rawBuffer.indexOf('\n\n');
          while (boundary !== -1) {
            const frame = rawBuffer.slice(0, boundary);
            rawBuffer = rawBuffer.slice(boundary + 2);
            this.parseAndDispatchFrame(frame);
            boundary = rawBuffer.indexOf('\n\n');
          }
          if (rawBuffer.trim().length > 0) {
            this.parseAndDispatchFrame(rawBuffer);
            rawBuffer = '';
          }
          break;
        }
        rawBuffer = (rawBuffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');

        let boundary = rawBuffer.indexOf('\n\n');
        while (boundary !== -1) {
          const frame = rawBuffer.slice(0, boundary);
          rawBuffer = rawBuffer.slice(boundary + 2);
          this.parseAndDispatchFrame(frame);
          boundary = rawBuffer.indexOf('\n\n');
        }
      }
    } catch (err) {
      if (!(err instanceof Error && err.name === 'AbortError')) {
        this.rejectAllWaiters(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      this.streamDone = true;
      reader.releaseLock();
      this.rejectAllWaiters(new Error('SSE stream ended before expected event arrived'));
    }
  }

  private parseAndDispatchFrame(frame: string): void {
    const lines = frame.split('\n');
    let eventName = '';
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith(':') || line.trim() === '') {
        continue;
      }
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    if (dataLines.length === 0) {
      return;
    }

    const payloadStr = dataLines.join('\n');
    let eventObj: RealtimeEvent;
    try {
      const parsed: unknown = JSON.parse(payloadStr);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const rec = parsed as Record<string, unknown>;
        eventObj = {
          ...rec,
          type:
            typeof rec.type === 'string' && rec.type.length > 0
              ? rec.type
              : eventName || 'message',
        };
      } else {
        eventObj = { type: eventName || 'message', data: parsed };
      }
    } catch {
      eventObj = { type: eventName || 'message', raw: payloadStr };
    }

    const idx = this.waiters.findIndex(
      (w) => w.type === eventObj.type && (!w.predicate || w.predicate(eventObj)),
    );
    if (idx !== -1) {
      const waiter = this.waiters.splice(idx, 1)[0];
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(eventObj);
        return;
      }
    }
    this.buffer.push(eventObj);
  }

  private rejectAllWaiters(err: Error): void {
    const pending = this.waiters.splice(0, this.waiters.length);
    for (const waiter of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
  }

  async waitForEvent<T extends RealtimeEvent = RealtimeEvent>(
    type: string,
    predicate?: (event: T) => boolean,
    timeoutMs = 15_000,
  ): Promise<T> {
    const bufferedIdx = this.buffer.findIndex(
      (evt) => evt.type === type && (!predicate || predicate(evt as T)),
    );
    if (bufferedIdx !== -1) {
      const matched = this.buffer.splice(bufferedIdx, 1)[0];
      if (matched) {
        return matched as T;
      }
    }

    if (this.streamDone) {
      throw new Error(`Cannot waitForEvent("${type}"): SSE stream is already closed`);
    }

    return new Promise<T>((resolve, reject) => {
      const waiter: PendingWaiter<RealtimeEvent> = {
        type,
        predicate: predicate as ((event: RealtimeEvent) => boolean) | undefined,
        resolve: resolve as (event: RealtimeEvent) => void,
        reject,
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i !== -1) {
            this.waiters.splice(i, 1);
          }
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for SSE event "${type}"`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  close(): void {
    this.streamDone = true;
    this.rejectAllWaiters(new Error('SSE client closed'));
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
  }
}
