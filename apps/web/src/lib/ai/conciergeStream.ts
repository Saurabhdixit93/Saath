import type { GoalConstraintsDTO, PutGoalRequest } from "@saath/contracts";

export type ConciergeGoalType = PutGoalRequest["goal_type"];

export interface ConciergeProposal {
  payload: PutGoalRequest;
  summary: string | null;
}

export type ConciergeSseEvent =
  | { event: "proposal"; data: Record<string, unknown> }
  | { event: "explanation"; data: { text?: string; delta?: string } }
  | { event: "message"; data: { text?: string; delta?: string } }
  | { event: "done"; data: { ok?: boolean } };

export class ConciergeApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ConciergeApiError";
    this.status = status;
    this.code = code;
  }
}

const VALID_GOAL_TYPES = new Set<ConciergeGoalType>([
  "together",
  "lower",
  "upper",
  "same_coach",
  "window",
  "aisle",
  "legroom",
  "specific_seats",
  "open_to_help",
]);

export function normalizeProposedGoal(
  raw: Record<string, unknown>,
  fallbackMoverIds: string[]
): ConciergeProposal {
  const rawGoal = typeof raw.goal_type === "string" ? raw.goal_type : "lower";
  const goalType: ConciergeGoalType = VALID_GOAL_TYPES.has(rawGoal as ConciergeGoalType)
    ? (rawGoal as ConciergeGoalType)
    : "lower";

  const rawMovers = Array.isArray(raw.movers)
    ? raw.movers.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  const movers = rawMovers.length > 0 ? rawMovers : fallbackMoverIds;

  const preferredSeats = Array.isArray(raw.preferred_seats)
    ? raw.preferred_seats
        .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
        .map((s) => s.trim().toUpperCase())
        .slice(0, 4)
    : [];

  const rawConstraints =
    raw.constraints && typeof raw.constraints === "object"
      ? (raw.constraints as Record<string, unknown>)
      : {};

  const constraints: GoalConstraintsDTO = {
    women_only: Boolean(rawConstraints.women_only),
    no_middle: Boolean(rawConstraints.no_middle),
    same_coach_only: Boolean(rawConstraints.same_coach_only),
    verified_only: Boolean(rawConstraints.verified_only),
  };

  let standingOffer: PutGoalRequest["standing_offer"] = undefined;
  if (
    goalType === "open_to_help" &&
    raw.standing_offer &&
    typeof raw.standing_offer === "object"
  ) {
    const so = raw.standing_offer as Record<string, unknown>;
    const giveTo =
      so.give_to === "women" || so.give_to === "anyone" || so.give_to === "senior"
        ? so.give_to
        : "senior";
    standingOffer = {
      give_to: giveTo,
      note: typeof so.note === "string" ? so.note : null,
    };
  }

  const summary =
    typeof raw.summary === "string" && raw.summary.trim().length > 0
      ? raw.summary.trim()
      : null;

  return {
    payload: {
      goal_type: goalType,
      movers,
      preferred_seats: preferredSeats,
      constraints,
      ...(standingOffer ? { standing_offer: standingOffer } : {}),
    },
    summary,
  };
}

function parseSseBlock(
  rawBlock: string,
  onEvent: (event: ConciergeSseEvent) => void
): void {
  const lines = rawBlock.split(/\r?\n/);
  let eventName = "message";
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

  const rawData = dataLines.join("\n");
  let parsed: Record<string, unknown>;
  try {
    const val = JSON.parse(rawData) as unknown;
    parsed = val && typeof val === "object" && !Array.isArray(val)
      ? (val as Record<string, unknown>)
      : { text: String(val) };
  } catch {
    parsed = { text: rawData };
  }

  if (eventName === "proposal") {
    onEvent({ event: "proposal", data: parsed });
  } else if (eventName === "explanation") {
    onEvent({
      event: "explanation",
      data: {
        text: typeof parsed.text === "string" ? parsed.text : undefined,
        delta: typeof parsed.delta === "string" ? parsed.delta : undefined,
      },
    });
  } else if (eventName === "done") {
    onEvent({
      event: "done",
      data: { ok: typeof parsed.ok === "boolean" ? parsed.ok : true },
    });
  } else {
    onEvent({
      event: "message",
      data: {
        text: typeof parsed.text === "string" ? parsed.text : undefined,
        delta: typeof parsed.delta === "string" ? parsed.delta : undefined,
      },
    });
  }
}

export interface StreamConciergeOptions {
  apiUrl: string;
  token: string;
  journeyId: string;
  text: string;
  signal?: AbortSignal;
  onEvent: (event: ConciergeSseEvent) => void;
  fetchImpl?: typeof globalThis.fetch;
}

export async function streamConcierge(options: StreamConciergeOptions): Promise<void> {
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  const resp = await fetchFn(`${options.apiUrl}/v1/ai/concierge`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream, application/json, application/problem+json",
      Authorization: `Bearer ${options.token}`,
    },
    body: JSON.stringify({
      journey_id: options.journeyId,
      text: options.text,
    }),
    cache: "no-store",
    signal: options.signal,
  });

  if (!resp.ok) {
    let status = resp.status;
    let code = `http_${resp.status}`;
    let detail = `Request failed (${resp.status})`;
    try {
      const body = (await resp.json()) as Record<string, unknown>;
      if (typeof body.status === "number") {
        status = body.status;
      }
      if (typeof body.code === "string") {
        code = body.code;
      }
      if (typeof body.detail === "string") {
        detail = body.detail;
      } else if (typeof body.title === "string") {
        detail = body.title;
      }
    } catch {
      // keep fallback error details
    }
    throw new ConciergeApiError(status, code, detail);
  }

  if (resp.body && typeof resp.body.getReader === "function") {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (!options.signal?.aborted) {
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
          parseSseBlock(block, options.onEvent);
        }
      }
    }

    if (buffer.trim() && !options.signal?.aborted) {
      parseSseBlock(buffer, options.onEvent);
    }
    return;
  }

  const fullText = await resp.text();
  const normalized = fullText.replace(/\r\n/g, "\n");
  for (const block of normalized.split("\n\n")) {
    if (block.trim()) {
      parseSseBlock(block, options.onEvent);
    }
  }
}
