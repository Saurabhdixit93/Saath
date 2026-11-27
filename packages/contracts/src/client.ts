import createClient, { type Middleware } from "openapi-fetch";
import type { paths, components } from "./schema";

export type ProblemFieldError = components["schemas"]["ProblemFieldError"];

export interface ProblemDetail {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  errors?: ProblemFieldError[] | null;
  [key: string]: unknown;
}

export type NotificationChannelsDTO = components["schemas"]["NotificationChannelsDTO"];
export type NotificationChannelsPatchDTO = components["schemas"]["NotificationChannelsPatchDTO"];
export type UserProfile = components["schemas"]["UserProfile"];
export type UpdateMeRequest = components["schemas"]["UpdateMeRequest"];
export type VerifyJourneyRequest = components["schemas"]["VerifyJourneyRequest"];
export type VerifyJourneyResponse = components["schemas"]["VerifyJourneyResponse"];
export type JourneySummaryDTO = components["schemas"]["JourneySummaryDTO"];
export type BookingSummaryDTO = components["schemas"]["BookingSummaryDTO"];
export type SeatHolderOwnDTO = components["schemas"]["SeatHolderOwnDTO"];
export type ChartStatusDTO = components["schemas"]["ChartStatusDTO"];
export type JourneyListItemDTO = components["schemas"]["JourneyListItemDTO"];
export type JourneyListResponse = components["schemas"]["JourneyListResponse"];
export type JourneyHubResponse = components["schemas"]["JourneyHubResponse"];
export type PartySummaryDTO = components["schemas"]["PartySummaryDTO"];
export type SmartSuggestionDTO = components["schemas"]["SmartSuggestionDTO"];
export type GoalDTO = components["schemas"]["GoalDTO"];
export type GoalConstraintsDTO = components["schemas"]["GoalConstraintsDTO"];
export type PutGoalRequest = components["schemas"]["PutGoalRequest"];
export type PartyInviteResponse = components["schemas"]["PartyInviteResponse"];
export type PartyJoinRequest = components["schemas"]["PartyJoinRequest"];
export type AircraftLayoutSummaryDTO = components["schemas"]["AircraftLayoutSummaryDTO"];
export type OrganiserSummaryResponse = components["schemas"]["OrganiserSummaryResponse"];
export type PricingPlanDTO = components["schemas"]["PricingPlanDTO"];
export type PricingPlansResponse = components["schemas"]["PricingPlansResponse"];
export type EntitlementDTO = components["schemas"]["EntitlementDTO"];
export type MyEntitlementsResponse = components["schemas"]["MyEntitlementsResponse"];
export type CheckoutRequest = components["schemas"]["CheckoutRequest"];
export type CheckoutResponse = components["schemas"]["CheckoutResponse"];
export type SandboxCompleteResponse = components["schemas"]["SandboxCompleteResponse"];
export type B2BKeyCreatedResponse = components["schemas"]["B2BKeyCreatedResponse"];
export type B2BStatsResponse = components["schemas"]["B2BStatsResponse"];
export type YouGetDTO = components["schemas"]["YouGetDTO"];
export type MatchOtherDTO = components["schemas"]["MatchOtherDTO"];
export type MatchCardDTO = components["schemas"]["MatchCardDTO"];
export type MatchesResponse = components["schemas"]["MatchesResponse"];
export type CoachMapSeatDTO = components["schemas"]["CoachMapSeatDTO"];
export type CoachMapResponse = components["schemas"]["CoachMapResponse"];
export type CreateSwapRequest = components["schemas"]["CreateSwapRequest"];
export type AcceptSwapRequest = components["schemas"]["AcceptSwapRequest"];
export type DeclineSwapRequest = components["schemas"]["DeclineSwapRequest"];
export type ConfirmCompletionRequest = components["schemas"]["ConfirmCompletionRequest"];
export type SwapParticipantViewDTO = components["schemas"]["SwapParticipantViewDTO"];
export type SwapDetailDTO = components["schemas"]["SwapDetailDTO"];
export type SwapProposalDTO = SwapDetailDTO;
export type SwapParticipantDTO = SwapParticipantViewDTO;
export type SwapListResponse = components["schemas"]["SwapListResponse"];
export type SwapCardParticipantDTO = components["schemas"]["SwapCardParticipantDTO"];
export type SwapCardJsonResponse = components["schemas"]["SwapCardJsonResponse"];
export type SwapCardDTO = SwapCardJsonResponse;
export type PublicSwapCardVerifyResponse = components["schemas"]["PublicSwapCardVerifyResponse"];
export type PublicSwapCardResponse = PublicSwapCardVerifyResponse;
export type ConversationParticipantDTO = components["schemas"]["ConversationParticipantDTO"];
export type MessageDTO = components["schemas"]["MessageDTO"];
export type ConversationDTO = components["schemas"]["ConversationDTO"];
export type ConversationListResponse = components["schemas"]["ConversationListResponse"];
export type CreateConversationRequest = components["schemas"]["CreateConversationRequest"];
export type MessagesResponse = components["schemas"]["MessagesResponse"];
export type SendMessageRequest = components["schemas"]["SendMessageRequest"];
export type TranslateMessageRequest = components["schemas"]["TranslateMessageRequest"];
export type TranslateMessageResponse = components["schemas"]["TranslateMessageResponse"];
export type BlockUserRequest = components["schemas"]["BlockUserRequest"];
export type BlockUserResponse = components["schemas"]["BlockUserResponse"];
export type CreateReportRequest = components["schemas"]["CreateReportRequest"];
export type CreateReportResponse = components["schemas"]["CreateReportResponse"];
export type PushSubscriptionKeysDTO = components["schemas"]["PushSubscriptionKeysDTO"];
export type PushSubscriptionRequest = components["schemas"]["PushSubscriptionRequest"];
export type PushSubscriptionResponse = components["schemas"]["PushSubscriptionResponse"];
export type WhatsAppWebhookResponse = components["schemas"]["WhatsAppWebhookResponse"];
export type PublicChartTimeResponse = components["schemas"]["PublicChartTimeResponse"];
export type CreateSeatInviteRequest = components["schemas"]["CreateSeatInviteRequest"];
export type SeatInviteResponse = components["schemas"]["SeatInviteResponse"];
export type PublicSeatInviteResponse = components["schemas"]["PublicSeatInviteResponse"];
export type PublicPnrStatusItemDTO = components["schemas"]["PublicPnrStatusItemDTO"];
export type PublicPnrStatusResponse = components["schemas"]["PublicPnrStatusResponse"];
export type PublicTrainLiveResponse = components["schemas"]["PublicTrainLiveResponse"];
export type PublicTrainCoachDTO = components["schemas"]["PublicTrainCoachDTO"];
export type PublicTrainCompositionResponse = components["schemas"]["PublicTrainCompositionResponse"];
export type PublicFlightLayoutsResponse = components["schemas"]["PublicFlightLayoutsResponse"];
export type PublicStatsResponse = components["schemas"]["PublicStatsResponse"];
export type KarmaLedgerEntryDTO = components["schemas"]["KarmaLedgerEntryDTO"];
export type KarmaBadgeDTO = components["schemas"]["KarmaBadgeDTO"];
export type LeaderboardEntryDTO = components["schemas"]["LeaderboardEntryDTO"];
export type KarmaWalletResponse = components["schemas"]["KarmaWalletResponse"];
export type RewardItemDTO = components["schemas"]["RewardItemDTO"];
export type RewardRedemptionDTO = components["schemas"]["RewardRedemptionDTO"];
export type RewardsCatalogueResponse = components["schemas"]["RewardsCatalogueResponse"];
export type RedeemRewardRequest = components["schemas"]["RedeemRewardRequest"];
export type RedeemRewardResponse = components["schemas"]["RedeemRewardResponse"];
export type ConciergeRequest = components["schemas"]["ConciergeRequest"];
export type DraftRequestBody = components["schemas"]["DraftRequestBody"];
export type DraftRequestResponse = components["schemas"]["DraftRequestResponse"];

export interface ConsentItemInput {
  purpose: "verification" | "matching" | "notifications" | "analytics" | "whatsapp" | string;
  notice_version: string;
  granted: boolean;
}

export interface ConsentRecordDTO {
  purpose: string;
  notice_version: string;
  granted: boolean;
  at?: string | null;
}

export interface ConsentsListResponse {
  notice_version: string;
  purposes: string[];
  consents: ConsentRecordDTO[];
}

export interface SaveConsentsRequest {
  consents: ConsentItemInput[];
}

export interface SaveConsentsResponse {
  consents: ConsentRecordDTO[];
}

export interface DeleteAccountResponse {
  status: string;
  scheduled_within_hours: number;
}

export interface SaathClientOptions {
  baseUrl: string;
  getAccessToken: () => string | null;
  refreshTokens?: () => Promise<string | null>;
  fetch?: typeof globalThis.fetch;
}

const SKIP_REFRESH_PREFIXES = ["/v1/auth/refresh", "/v1/auth/otp/", "/v1/auth/anonymous"];

export function parseProblemDetail(error: unknown): ProblemDetail | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const obj = error as Record<string, unknown>;
  if (typeof obj.status === "number" && typeof obj.code === "string" && typeof obj.title === "string") {
    return {
      type: typeof obj.type === "string" ? obj.type : "https://saath.app/problems/error",
      title: obj.title,
      status: obj.status,
      detail: typeof obj.detail === "string" ? obj.detail : obj.title,
      code: obj.code,
      errors: Array.isArray(obj.errors) ? (obj.errors as ProblemFieldError[]) : null,
    };
  }
  return null;
}

export function createSaathClient(options: SaathClientOptions) {
  const client = createClient<paths>({
    baseUrl: options.baseUrl,
    fetch:
      options.fetch ??
      (((input: RequestInfo | URL, init?: RequestInit) =>
        globalThis.fetch(input, init)) as typeof globalThis.fetch),
  });

  let inflightRefresh: Promise<string | null> | null = null;
  const retriedRequests = new WeakSet<Request>();
  const clonedRequests = new WeakMap<Request, Request>();

  const runSingleFlightRefresh = async (): Promise<string | null> => {
    if (!options.refreshTokens) {
      return null;
    }
    if (!inflightRefresh) {
      inflightRefresh = options.refreshTokens().finally(() => {
        inflightRefresh = null;
      });
    }
    return inflightRefresh;
  };

  const authMiddleware: Middleware = {
    async onRequest({ request }) {
      const token = options.getAccessToken();
      if (token && !request.headers.has("Authorization")) {
        request.headers.set("Authorization", `Bearer ${token}`);
      }
      // Snapshot unconsumed Request before fetch() drains request.body
      clonedRequests.set(request, request.clone());
      return request;
    },

    async onResponse({ request, response }) {
      const retrySource = clonedRequests.get(request);
      clonedRequests.delete(request);

      if (response.status !== 401 || !options.refreshTokens) {
        return response;
      }

      if (retriedRequests.has(request)) {
        return response;
      }

      const url = new URL(request.url, options.baseUrl);
      if (SKIP_REFRESH_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
        return response;
      }

      const freshToken = await runSingleFlightRefresh();
      if (!freshToken) {
        return response;
      }

      const sourceRequest = retrySource ?? request;
      const retryHeaders = new Headers(sourceRequest.headers);
      retryHeaders.set("Authorization", `Bearer ${freshToken}`);
      const retryReq = new Request(sourceRequest, {
        headers: retryHeaders,
      });
      retriedRequests.add(retryReq);

      const fetchImpl = options.fetch ?? globalThis.fetch;
      return fetchImpl(retryReq);
    },
  };

  client.use(authMiddleware);
  return client;
}
