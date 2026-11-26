export type TransportMode = "ws" | "sse" | "polling";

export interface RealtimeMessagePayload {
  id: string;
  conversation_id: string;
  sender_alias: string;
  client_id: string;
  body: string;
  lang?: string | null;
  moderation: "ok" | "redacted" | "hidden";
  created_at: string;
}

export type RealtimeServerEvent =
  | { type: "ready" }
  | { type: "pong" }
  | {
      type: "match.updated";
      party_id: string;
      journey_instance_id: string;
      match_version: number;
    }
  | {
      type: "swap.updated";
      swap_id: string;
      journey_instance_id: string;
      status: string;
      version: number;
    }
  | {
      type: "message.new";
      conversation_id: string;
      message: RealtimeMessagePayload;
    }
  | {
      type: "journey.chart";
      journey_id: string;
      journey_instance_id?: string;
      state: string;
      changed?: boolean;
    }
  | {
      type: "typing";
      conversation_id: string;
      alias: string;
    }
  | {
      type: "error";
      detail?: string;
    };
