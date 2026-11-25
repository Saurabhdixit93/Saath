/**
 * OpenAPI schema definitions aligned with apps/api M1+M2 endpoints.
 * Regenerated via `pnpm --filter @saath/contracts generate` from openapi.json.
 */

export interface paths {
  "/healthz": {
    get: operations["healthz_healthz_get"];
  };
  "/readyz": {
    get: operations["readyz_readyz_get"];
  };
  "/v1/auth/anonymous": {
    post: operations["post_auth_anonymous_v1_auth_anonymous_post"];
  };
  "/v1/auth/otp/start": {
    post: operations["post_auth_otp_start_v1_auth_otp_start_post"];
  };
  "/v1/auth/otp/verify": {
    post: operations["post_auth_otp_verify_v1_auth_otp_verify_post"];
  };
  "/v1/auth/refresh": {
    post: operations["post_auth_refresh_v1_auth_refresh_post"];
  };
  "/v1/auth/logout": {
    post: operations["post_auth_logout_v1_auth_logout_post"];
  };
  "/v1/me": {
    get: operations["get_v1_me_v1_me_get"];
    patch: operations["patch_v1_me_v1_me_patch"];
  };
  "/v1/flights/layouts": {
    get: operations["get_v1_flight_layouts_v1_flights_layouts_get"];
  };
  "/v1/journeys/verify": {
    post: operations["post_v1_journeys_verify_v1_journeys_verify_post"];
  };
  "/v1/journeys": {
    get: operations["get_v1_journeys_v1_journeys_get"];
  };
  "/v1/journeys/{journey_id}": {
    get: operations["get_v1_journey_detail_v1_journeys__journey_id__get"];
    delete: operations["delete_v1_journey_v1_journeys__journey_id__delete"];
  };
  "/v1/journeys/{journey_id}/reverify": {
    post: operations["post_v1_journey_reverify_v1_journeys__journey_id__reverify_post"];
  };
  "/v1/journeys/{journey_id}/party/invite": {
    post: operations["post_v1_party_invite_v1_journeys__journey_id__party_invite_post"];
  };
  "/v1/party/join": {
    post: operations["post_v1_party_join_v1_party_join_post"];
  };
  "/v1/party/{party_id}/members/{seat_holder_id}": {
    delete: operations["delete_v1_party_member_v1_party__party_id__members__seat_holder_id__delete"];
  };
  "/v1/parties/{party_id}/goal": {
    put: operations["put_v1_party_goal_v1_parties__party_id__goal_put"];
    delete: operations["delete_v1_party_goal_v1_parties__party_id__goal_delete"];
  };
  "/v1/parties/{party_id}/organiser-summary": {
    get: operations["get_v1_party_organiser_summary_v1_parties__party_id__organiser_summary_get"];
  };
  "/v1/pricing/plans": {
    get: operations["get_v1_pricing_plans_v1_pricing_plans_get"];
  };
  "/v1/me/entitlements": {
    get: operations["get_v1_me_entitlements_v1_me_entitlements_get"];
  };
  "/v1/billing/checkout": {
    post: operations["post_v1_billing_checkout_v1_billing_checkout_post"];
  };
  "/v1/webhooks/payments": {
    post: operations["post_v1_webhooks_payments_v1_webhooks_payments_post"];
  };
  "/v1/billing/sandbox/complete": {
    post: operations["post_v1_billing_sandbox_complete_v1_billing_sandbox_complete_post"];
  };
  "/v1/b2b/keys": {
    post: operations["post_v1_b2b_keys_v1_b2b_keys_post"];
  };
  "/v1/b2b/stats": {
    get: operations["get_v1_b2b_stats_v1_b2b_stats_get"];
  };
}

export interface components {
  schemas: {
    AnonymousAuthRequest: {
      turnstile: string;
    };
    AnonymousAuthResponse: {
      access: string;
      token_type?: "bearer";
      expires_in: number;
    };
    OtpStartRequest: {
      phone: string;
      channel?: "whatsapp" | "sms";
      turnstile: string;
      locale?: "en" | "hi";
    };
    OtpStartResponse: {
      request_id: string;
      resend_after: number;
    };
    OtpVerifyRequest: {
      request_id: string;
      code: string;
    };
    UserProfile: {
      id: string;
      display_alias?: string | null;
      gender_self: "female" | "male" | "other" | "undisclosed";
      locale: "en" | "hi";
      women_only_default: boolean;
      reliability_accepted: number;
      reliability_completed: number;
      status: "active" | "restricted" | "banned" | "deleted";
      created_at: string;
    };
    OtpVerifyResponse: {
      access: string;
      refresh: string;
      expires_in: number;
      user: components["schemas"]["UserProfile"];
    };
    RefreshRequest: {
      refresh: string;
    };
    TokenPairResponse: {
      access: string;
      refresh: string;
      expires_in: number;
    };
    LogoutResponse: {
      ok?: boolean;
    };
    UpdateMeRequest: {
      locale?: "en" | "hi" | null;
      women_only_default?: boolean | null;
      display_alias?: string | null;
      gender_self?: "female" | "male" | "other" | "undisclosed" | null;
    };
    ProblemFieldError: {
      field: string;
      message: string;
      type: string;
    };
    ProblemDetail: {
      type?: string;
      title: string;
      status: number;
      detail: string;
      code: string;
      errors?: components["schemas"]["ProblemFieldError"][] | null;
    };
    HealthResponse: {
      status: string;
    };
    ReadyChecks: {
      postgres: string;
      redis: string;
    };
    ReadyResponse: {
      status: string;
      checks: components["schemas"]["ReadyChecks"];
    };
    FlightDeclaredInput: {
      flight_no: string;
      date: string;
      seat: string;
      layout_ref?: string | null;
    };
    VerifyJourneyRequest: {
      mode: "train" | "flight" | "bus";
      pnr?: string | null;
      sms_text?: string | null;
      bcbp?: string | null;
      leg_index?: number;
      declared?: components["schemas"]["FlightDeclaredInput"] | null;
      layout_ref?: string | null;
    };
    SeatHolderOwnDTO: {
      id: string;
      pax_seq: number;
      booking_status?: string | null;
      current_status?: string | null;
      coach?: string | null;
      seat_no?: string | null;
      seat_type?: string | null;
      bay?: number | null;
      age_band: "child" | "adult" | "senior" | "unknown";
      gender_band: "F" | "M" | "U";
      linked_user_id?: string | null;
    };
    ChartStatusDTO: {
      state: "pending" | "first" | "final" | "na";
      chart_due_at?: string | null;
      seconds_until_chart?: number | null;
    };
    JourneySummaryDTO: {
      id: string;
      mode: "train" | "flight" | "bus";
      carrier_code: string;
      service_no: string;
      service_date: string;
      departure_at?: string | null;
      arrival_at?: string | null;
      chart_due_at?: string | null;
      chart_state: "pending" | "first" | "final" | "na";
      layout_ref?: string | null;
      match_version: number;
    };
    BookingSummaryDTO: {
      id: string;
      travel_class?: string | null;
      from_code?: string | null;
      to_code?: string | null;
      trust_tier: "verified_provider" | "verified_bcbp" | "verified_doc" | "declared";
      claim_conflict_flagged: boolean;
      last_verified_at?: string | null;
    };
    GoalConstraintsDTO: {
      women_only?: boolean;
      no_middle?: boolean;
      same_coach_only?: boolean;
      verified_only?: boolean;
    };
    StandingOfferDTO: {
      give_to?: "senior" | "women" | "anyone";
      note?: string | null;
    };
    GoalDTO: {
      id: string;
      party_id: string;
      goal_type:
        | "together"
        | "lower"
        | "upper"
        | "same_coach"
        | "window"
        | "aisle"
        | "legroom"
        | "specific_seats"
        | "open_to_help";
      movers: string[];
      preferred_seats: string[];
      constraints: components["schemas"]["GoalConstraintsDTO"];
      standing_offer?: components["schemas"]["StandingOfferDTO"] | null;
      active: boolean;
      updated_at: string;
    };
    SmartSuggestionDTO: {
      code: string;
      title_key: string;
      seat_holder_ids?: string[];
      recommended_goal_type: string;
    };
    PartySummaryDTO: {
      id: string;
      leader_is_me: boolean;
      members: components["schemas"]["SeatHolderOwnDTO"][];
      member_count: number;
      max_party_members: number;
      has_organiser_pass: boolean;
      invite_expires_at?: string | null;
    };
    JourneyCountsDTO: {
      coach_active_count: number;
      journey_active_count: number;
    };
    VerifyJourneyResponse: {
      journey: components["schemas"]["JourneySummaryDTO"];
      booking: components["schemas"]["BookingSummaryDTO"];
      seat_holders: components["schemas"]["SeatHolderOwnDTO"][];
      party_id: string;
      trust_tier: "verified_provider" | "verified_bcbp" | "verified_doc" | "declared";
      chart: components["schemas"]["ChartStatusDTO"];
    };
    JourneyListItemDTO: {
      journey: components["schemas"]["JourneySummaryDTO"];
      booking: components["schemas"]["BookingSummaryDTO"];
      party_id: string;
      member_count: number;
      seat_holders: components["schemas"]["SeatHolderOwnDTO"][];
      goal?: components["schemas"]["GoalDTO"] | null;
    };
    JourneyListResponse: {
      items: components["schemas"]["JourneyListItemDTO"][];
    };
    JourneyHubResponse: {
      journey: components["schemas"]["JourneySummaryDTO"];
      chart: components["schemas"]["ChartStatusDTO"];
      booking: components["schemas"]["BookingSummaryDTO"];
      party: components["schemas"]["PartySummaryDTO"];
      goal?: components["schemas"]["GoalDTO"] | null;
      suggestions?: components["schemas"]["SmartSuggestionDTO"][];
      counts: components["schemas"]["JourneyCountsDTO"];
    };
    DeleteJourneyResponse: {
      ok?: boolean;
      deleted_booking_id: string;
    };
    AircraftLayoutSummaryDTO: {
      layout_ref: string;
      carrier_code: string;
      aircraft_name: string;
      configuration: string;
      rows: number;
      columns: string[];
      aisle_after_indices: number[];
      exit_rows: number[];
      premium_rows: number[];
      total_seats: number;
    };
    FlightLayoutsResponse: {
      layouts: components["schemas"]["AircraftLayoutSummaryDTO"][];
    };
    PartyInviteResponse: {
      party_id: string;
      invite_token: string;
      invite_url: string;
      expires_at: string;
    };
    PartyJoinRequest: {
      invite_token: string;
      mode: "train" | "flight";
      pnr?: string | null;
      sms_text?: string | null;
      bcbp?: string | null;
      leg_index?: number;
      declared?: components["schemas"]["FlightDeclaredInput"] | null;
      layout_ref?: string | null;
    };
    PutGoalRequest: {
      goal_type:
        | "together"
        | "lower"
        | "upper"
        | "same_coach"
        | "window"
        | "aisle"
        | "legroom"
        | "specific_seats"
        | "open_to_help";
      movers?: string[];
      preferred_seats?: string[];
      constraints?: components["schemas"]["GoalConstraintsDTO"];
      standing_offer?: components["schemas"]["StandingOfferDTO"] | null;
    };
    GoalMutationResponse: {
      goal: components["schemas"]["GoalDTO"];
      match_version: number;
    };
    DeleteGoalResponse: {
      ok?: boolean;
      match_version: number;
    };
    OrganiserCoachBucket: {
      coach: string;
      member_count: number;
      seat_types: Record<string, number>;
    };
    OrganiserSummaryResponse: {
      party_id: string;
      journey_instance_id: string;
      mode: "train" | "flight" | "bus";
      service_no: string;
      service_date: string;
      member_count: number;
      bookings_count: number;
      coach_breakdown: components["schemas"]["OrganiserCoachBucket"][];
      seat_type_breakdown: Record<string, number>;
      status_breakdown: Record<string, number>;
    };
    PricingPlanDTO: {
      code: string;
      name: string;
      price_inr_paise: number;
      currency: string;
      billing_type: "free" | "per_trip" | "subscription";
      scope?: string | null;
      max_party_members: number;
      organiser_dashboard: boolean;
      summary_export: boolean;
      b2b_api: boolean;
      widget_access: boolean;
      priority_seat_bump: boolean;
    };
    PricingPlansResponse: {
      plans: components["schemas"]["PricingPlanDTO"][];
      anti_seat_sale_guarantee?: boolean;
    };
    EntitlementDTO: {
      id: string;
      plan_code: string;
      order_id?: string | null;
      scope_journey_instance_id?: string | null;
      scope_party_id?: string | null;
      features: Record<string, unknown>;
      status: "active" | "expired" | "revoked";
      valid_from: string;
      valid_until?: string | null;
      created_at: string;
    };
    B2BApiKeyMetaDTO: {
      id: string;
      partner_name: string;
      key_prefix: string;
      scopes: string[];
      rate_limit_rpm: number;
      status: "active" | "revoked";
      created_at: string;
    };
    MyEntitlementsResponse: {
      entitlements: components["schemas"]["EntitlementDTO"][];
      b2b_api_keys: components["schemas"]["B2BApiKeyMetaDTO"][];
      free_party_limit: number;
    };
    CheckoutRequest: {
      plan_code: string;
      journey_instance_id?: string | null;
      party_id?: string | null;
      idempotency_key?: string | null;
    };
    CheckoutResponse: {
      order_id: string;
      plan_code: string;
      provider: "sandbox" | "razorpay";
      provider_order_id: string;
      amount_paise: number;
      currency: string;
      checkout_mode: string;
      key_id?: string | null;
      status: "created" | "pending" | "paid" | "failed" | "refunded";
    };
    SandboxCompleteRequest: {
      order_id: string;
      outcome?: "paid" | "failed";
    };
    SandboxCompleteResponse: {
      ok: boolean;
      order_id: string;
      status: "paid" | "failed";
      entitlement?: components["schemas"]["EntitlementDTO"] | null;
      b2b_api_key?: string | null;
    };
    WebhookAckResponse: {
      ok?: boolean;
      duplicate?: boolean;
    };
    CreateB2BKeyRequest: {
      partner_name: string;
      scopes?: string[];
    };
    B2BKeyCreatedResponse: {
      id: string;
      partner_name: string;
      key_prefix: string;
      api_key: string;
      scopes: string[];
      rate_limit_rpm: number;
      created_at: string;
    };
    B2BStatsResponse: {
      partner_name: string;
      total_journeys: number;
      verified_bookings: number;
      active_parties: number;
      supported_modes: string[];
      anti_seat_sale_guarantee?: boolean;
    };
  };
}

type ProblemResp = {
  content: {
    "application/problem+json": components["schemas"]["ProblemDetail"];
  };
};

export interface operations {
  healthz_healthz_get: {
    responses: {
      200: { content: { "application/json": components["schemas"]["HealthResponse"] } };
    };
  };
  readyz_readyz_get: {
    responses: {
      200: { content: { "application/json": components["schemas"]["ReadyResponse"] } };
      503: ProblemResp;
    };
  };
  post_auth_anonymous_v1_auth_anonymous_post: {
    requestBody: { content: { "application/json": components["schemas"]["AnonymousAuthRequest"] } };
    responses: {
      200: { content: { "application/json": components["schemas"]["AnonymousAuthResponse"] } };
      403: ProblemResp;
      422: ProblemResp;
      429: ProblemResp;
    };
  };
  post_auth_otp_start_v1_auth_otp_start_post: {
    requestBody: { content: { "application/json": components["schemas"]["OtpStartRequest"] } };
    responses: {
      200: { content: { "application/json": components["schemas"]["OtpStartResponse"] } };
      403: ProblemResp;
      422: ProblemResp;
      429: ProblemResp;
      503: ProblemResp;
    };
  };
  post_auth_otp_verify_v1_auth_otp_verify_post: {
    requestBody: { content: { "application/json": components["schemas"]["OtpVerifyRequest"] } };
    responses: {
      200: { content: { "application/json": components["schemas"]["OtpVerifyResponse"] } };
      401: ProblemResp;
      403: ProblemResp;
      422: ProblemResp;
      429: ProblemResp;
    };
  };
  post_auth_refresh_v1_auth_refresh_post: {
    requestBody: { content: { "application/json": components["schemas"]["RefreshRequest"] } };
    responses: {
      200: { content: { "application/json": components["schemas"]["TokenPairResponse"] } };
      401: ProblemResp;
      403: ProblemResp;
      422: ProblemResp;
    };
  };
  post_auth_logout_v1_auth_logout_post: {
    responses: {
      200: { content: { "application/json": components["schemas"]["LogoutResponse"] } };
      401: ProblemResp;
      403: ProblemResp;
    };
  };
  get_v1_me_v1_me_get: {
    responses: {
      200: { content: { "application/json": components["schemas"]["UserProfile"] } };
      401: ProblemResp;
      403: ProblemResp;
      404: ProblemResp;
    };
  };
  patch_v1_me_v1_me_patch: {
    requestBody: { content: { "application/json": components["schemas"]["UpdateMeRequest"] } };
    responses: {
      200: { content: { "application/json": components["schemas"]["UserProfile"] } };
      401: ProblemResp;
      403: ProblemResp;
      404: ProblemResp;
      422: ProblemResp;
    };
  };
  get_v1_flight_layouts_v1_flights_layouts_get: {
    responses: {
      200: { content: { "application/json": components["schemas"]["FlightLayoutsResponse"] } };
    };
  };
  post_v1_journeys_verify_v1_journeys_verify_post: {
    requestBody: { content: { "application/json": components["schemas"]["VerifyJourneyRequest"] } };
    responses: {
      200: { content: { "application/json": components["schemas"]["VerifyJourneyResponse"] } };
      401: ProblemResp;
      403: ProblemResp;
      404: ProblemResp;
      409: ProblemResp;
      422: ProblemResp;
      429: ProblemResp;
      503: ProblemResp;
    };
  };
  get_v1_journeys_v1_journeys_get: {
    responses: {
      200: { content: { "application/json": components["schemas"]["JourneyListResponse"] } };
      401: ProblemResp;
    };
  };
  get_v1_journey_detail_v1_journeys__journey_id__get: {
    parameters: { path: { journey_id: string } };
    responses: {
      200: { content: { "application/json": components["schemas"]["JourneyHubResponse"] } };
      401: ProblemResp;
      403: ProblemResp;
      404: ProblemResp;
    };
  };
  delete_v1_journey_v1_journeys__journey_id__delete: {
    parameters: { path: { journey_id: string } };
    responses: {
      200: { content: { "application/json": components["schemas"]["DeleteJourneyResponse"] } };
      401: ProblemResp;
      403: ProblemResp;
      404: ProblemResp;
    };
  };
  post_v1_journey_reverify_v1_journeys__journey_id__reverify_post: {
    parameters: { path: { journey_id: string } };
    responses: {
      200: { content: { "application/json": components["schemas"]["JourneyHubResponse"] } };
      401: ProblemResp;
      403: ProblemResp;
      404: ProblemResp;
    };
  };
  post_v1_party_invite_v1_journeys__journey_id__party_invite_post: {
    parameters: { path: { journey_id: string } };
    responses: {
      200: { content: { "application/json": components["schemas"]["PartyInviteResponse"] } };
      401: ProblemResp;
      403: ProblemResp;
      404: ProblemResp;
    };
  };
  post_v1_party_join_v1_party_join_post: {
    requestBody: { content: { "application/json": components["schemas"]["PartyJoinRequest"] } };
    responses: {
      200: { content: { "application/json": components["schemas"]["JourneyHubResponse"] } };
      401: ProblemResp;
      402: ProblemResp;
      403: ProblemResp;
      404: ProblemResp;
      409: ProblemResp;
      410: ProblemResp;
      422: ProblemResp;
      429: ProblemResp;
      503: ProblemResp;
    };
  };
  delete_v1_party_member_v1_party__party_id__members__seat_holder_id__delete: {
    parameters: { path: { party_id: string; seat_holder_id: string } };
    responses: {
      200: { content: { "application/json": components["schemas"]["JourneyHubResponse"] } };
      401: ProblemResp;
      403: ProblemResp;
      404: ProblemResp;
      422: ProblemResp;
    };
  };
  put_v1_party_goal_v1_parties__party_id__goal_put: {
    parameters: { path: { party_id: string } };
    requestBody: { content: { "application/json": components["schemas"]["PutGoalRequest"] } };
    responses: {
      200: { content: { "application/json": components["schemas"]["GoalMutationResponse"] } };
      401: ProblemResp;
      403: ProblemResp;
      404: ProblemResp;
      422: ProblemResp;
    };
  };
  delete_v1_party_goal_v1_parties__party_id__goal_delete: {
    parameters: { path: { party_id: string } };
    responses: {
      200: { content: { "application/json": components["schemas"]["DeleteGoalResponse"] } };
      401: ProblemResp;
      403: ProblemResp;
      404: ProblemResp;
    };
  };
  get_v1_party_organiser_summary_v1_parties__party_id__organiser_summary_get: {
    parameters: { path: { party_id: string } };
    responses: {
      200: { content: { "application/json": components["schemas"]["OrganiserSummaryResponse"] } };
      401: ProblemResp;
      402: ProblemResp;
      403: ProblemResp;
      404: ProblemResp;
    };
  };
  get_v1_pricing_plans_v1_pricing_plans_get: {
    responses: {
      200: { content: { "application/json": components["schemas"]["PricingPlansResponse"] } };
    };
  };
  get_v1_me_entitlements_v1_me_entitlements_get: {
    responses: {
      200: { content: { "application/json": components["schemas"]["MyEntitlementsResponse"] } };
      401: ProblemResp;
      403: ProblemResp;
    };
  };
  post_v1_billing_checkout_v1_billing_checkout_post: {
    requestBody: { content: { "application/json": components["schemas"]["CheckoutRequest"] } };
    responses: {
      200: { content: { "application/json": components["schemas"]["CheckoutResponse"] } };
      401: ProblemResp;
      403: ProblemResp;
      404: ProblemResp;
      422: ProblemResp;
    };
  };
  post_v1_webhooks_payments_v1_webhooks_payments_post: {
    responses: {
      200: { content: { "application/json": components["schemas"]["WebhookAckResponse"] } };
      400: ProblemResp;
      401: ProblemResp;
    };
  };
  post_v1_billing_sandbox_complete_v1_billing_sandbox_complete_post: {
    requestBody: { content: { "application/json": components["schemas"]["SandboxCompleteRequest"] } };
    responses: {
      200: { content: { "application/json": components["schemas"]["SandboxCompleteResponse"] } };
      401: ProblemResp;
      403: ProblemResp;
      404: ProblemResp;
    };
  };
  post_v1_b2b_keys_v1_b2b_keys_post: {
    requestBody: { content: { "application/json": components["schemas"]["CreateB2BKeyRequest"] } };
    responses: {
      200: { content: { "application/json": components["schemas"]["B2BKeyCreatedResponse"] } };
      401: ProblemResp;
      403: ProblemResp;
      422: ProblemResp;
    };
  };
  get_v1_b2b_stats_v1_b2b_stats_get: {
    responses: {
      200: { content: { "application/json": components["schemas"]["B2BStatsResponse"] } };
      401: ProblemResp;
      403: ProblemResp;
    };
  };
}
