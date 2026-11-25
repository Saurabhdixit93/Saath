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

export type UserProfile = components["schemas"]["UserProfile"];
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
    ...(options.fetch ? { fetch: options.fetch } : {}),
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
