import crypto from 'node:crypto';
import { E2E_ENV } from './env.js';

export interface ApiResponse<T = unknown> {
  status: number;
  ok: boolean;
  headers: Headers;
  data: T;
  rawText: string;
}

export interface BinaryApiResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  buffer: Buffer;
}

export interface ProblemJson {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  [key: string]: unknown;
}

export interface RequestOptions {
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
}

export interface AuthTokens {
  access: string;
  refresh: string;
  user: {
    id: string;
    display_alias?: string;
    locale?: string;
    women_only_default?: boolean;
    gender_self?: string | null;
    reliability_accepted?: number;
    reliability_completed?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface OtpStartResponse {
  request_id: string;
  resend_after: number;
  dev_otp?: string;
  otp?: string;
  [key: string]: unknown;
}

export interface MatchCardDto {
  card_id: string;
  kind: 'pair' | 'cycle3' | 'cycle4' | 'plan' | string;
  score: number;
  label: string;
  you_give: string;
  you_get: {
    coach?: string;
    seat_type?: string;
    bay?: number;
    [key: string]: unknown;
  };
  others: Array<{
    alias: string;
    trust: string;
    reliability?: string;
    responds_in?: string;
    [key: string]: unknown;
  }>;
  reasons: string[];
  segment?: { overlap?: string; [key: string]: unknown };
  karma_preview?: { you?: number; [key: string]: unknown };
  [key: string]: unknown;
}

export interface SseChunkEvent {
  event: string;
  data: unknown;
  raw: string;
}

export function assertProblemJson(
  res: ApiResponse<unknown>,
  expectedStatus: number | number[],
  expectedCode?: string,
): ProblemJson {
  const allowedStatuses = Array.isArray(expectedStatus)
    ? expectedStatus
    : [expectedStatus];
  if (!allowedStatuses.includes(res.status)) {
    throw new Error(
      `Expected HTTP ${allowedStatuses.join(' or ')}, got ${res.status}. Body: ${res.rawText}`,
    );
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/problem+json')) {
    throw new Error(
      `Expected Content-Type "application/problem+json", got "${contentType}". Body: ${res.rawText}`,
    );
  }

  const body = res.data as Partial<ProblemJson> | null;
  if (!body || typeof body !== 'object') {
    throw new Error(`Expected JSON object for ProblemJson, got: ${res.rawText}`);
  }
  if (typeof body.type !== 'string' || body.type.length === 0) {
    throw new Error(`ProblemJson missing non-empty "type": ${res.rawText}`);
  }
  if (typeof body.title !== 'string' || body.title.length === 0) {
    throw new Error(`ProblemJson missing non-empty "title": ${res.rawText}`);
  }
  if (typeof body.status !== 'number' || !allowedStatuses.includes(body.status)) {
    throw new Error(
      `ProblemJson "status" (${String(body.status)}) does not match ${allowedStatuses.join('/')}: ${res.rawText}`,
    );
  }
  if (typeof body.detail !== 'string' || body.detail.length === 0) {
    throw new Error(`ProblemJson missing non-empty "detail": ${res.rawText}`);
  }
  if (typeof body.code !== 'string' || body.code.length === 0) {
    throw new Error(`ProblemJson missing non-empty "code": ${res.rawText}`);
  }
  if (expectedCode && body.code !== expectedCode) {
    throw new Error(
      `Expected ProblemJson code "${expectedCode}", got "${body.code}" (${res.rawText})`,
    );
  }

  return body as ProblemJson;
}

function buildUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string | number | boolean | undefined>,
): string {
  const cleanBase = baseUrl.replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`${cleanBase}${normalizedPath}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

function computeHmacSha256Hex(secret: string, rawPayload: string): string {
  return crypto.createHmac('sha256', secret).update(rawPayload, 'utf8').digest('hex');
}

export class SaathApiClient {
  readonly baseUrl: string;

  constructor(baseUrl: string = E2E_ENV.apiUrl) {
    this.baseUrl = baseUrl;
  }

  assertProblemJson(
    res: ApiResponse<unknown>,
    expectedStatus: number | number[],
    expectedCode?: string,
  ): ProblemJson {
    return assertProblemJson(res, expectedStatus, expectedCode);
  }

  async request<T = unknown>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {
      Accept: 'application/json, application/problem+json',
      ...options.headers,
    };

    if (options.token) {
      headers.Authorization = `Bearer ${options.token}`;
    }

    let payload: string | undefined;
    if (options.body !== undefined) {
      if (typeof options.body === 'string') {
        payload = options.body;
      } else {
        payload = JSON.stringify(options.body);
      }
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json';
      }
    }

    const res = await fetch(buildUrl(this.baseUrl, path, options.query), {
      method: method.toUpperCase(),
      headers,
      body: payload,
    });

    const rawText = await res.text();
    let data: unknown = rawText;
    if (rawText.length > 0) {
      try {
        data = JSON.parse(rawText);
      } catch {
        data = rawText;
      }
    } else {
      data = null;
    }

    return {
      status: res.status,
      ok: res.ok,
      headers: res.headers,
      data: data as T,
      rawText,
    };
  }

  async requestBinary(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<BinaryApiResponse> {
    const headers: Record<string, string> = {
      ...options.headers,
    };
    if (options.token) {
      headers.Authorization = `Bearer ${options.token}`;
    }

    const res = await fetch(buildUrl(this.baseUrl, path, options.query), {
      method: method.toUpperCase(),
      headers,
    });
    const arr = await res.arrayBuffer();
    return {
      status: res.status,
      ok: res.ok,
      headers: res.headers,
      buffer: Buffer.from(arr),
    };
  }

  // ---------------------------------------------------------------------------
  // Ops & Health
  // ---------------------------------------------------------------------------

  async healthz(): Promise<ApiResponse<{ status: string }>> {
    return this.request('GET', '/healthz');
  }

  async readyz(): Promise<ApiResponse<{ status: string; db?: string; redis?: string }>> {
    return this.request('GET', '/readyz');
  }

  // ---------------------------------------------------------------------------
  // Auth (#2, #3, #4)
  // ---------------------------------------------------------------------------

  async issueAnonymousToken(
    turnstile: string = E2E_ENV.turnstileTestToken,
  ): Promise<ApiResponse<{ access: string }>> {
    return this.request('POST', '/v1/auth/anonymous', {
      body: { turnstile },
    });
  }

  async startOtp(
    phone: string,
    channel: 'whatsapp' | 'sms' = 'whatsapp',
    turnstile: string = E2E_ENV.turnstileTestToken,
  ): Promise<ApiResponse<OtpStartResponse>> {
    return this.request('POST', '/v1/auth/otp/start', {
      body: { phone, channel, turnstile },
    });
  }

  async verifyOtp(
    requestId: string,
    code: string = E2E_ENV.testOtpCode,
    anonToken?: string,
  ): Promise<ApiResponse<AuthTokens>> {
    return this.request('POST', '/v1/auth/otp/verify', {
      token: anonToken,
      body: { request_id: requestId, code },
    });
  }

  async loginWithOtp(
    phone: string,
    channel: 'whatsapp' | 'sms' = 'whatsapp',
    anonToken?: string,
    otpCode?: string,
  ): Promise<AuthTokens> {
    const startRes = await this.startOtp(phone, channel);
    if (!startRes.ok) {
      throw new Error(
        `OTP start failed (${startRes.status}): ${startRes.rawText}`,
      );
    }

    const headerOtp = startRes.headers.get('x-dev-otp') ?? startRes.headers.get('x-sandbox-otp');
    const resolvedOtp =
      otpCode ??
      startRes.data.dev_otp ??
      startRes.data.otp ??
      headerOtp ??
      E2E_ENV.testOtpCode;

    const verifyRes = await this.verifyOtp(
      startRes.data.request_id,
      resolvedOtp,
      anonToken,
    );
    if (!verifyRes.ok) {
      throw new Error(
        `OTP verify failed (${verifyRes.status}): ${verifyRes.rawText}`,
      );
    }
    return verifyRes.data;
  }

  async refreshTokens(refresh: string): Promise<ApiResponse<AuthTokens>> {
    return this.request('POST', '/v1/auth/refresh', {
      body: { refresh },
    });
  }

  async logout(token: string): Promise<ApiResponse<unknown>> {
    return this.request('POST', '/v1/auth/logout', { token });
  }

  // ---------------------------------------------------------------------------
  // Journeys & Verification (#6 - #11)
  // ---------------------------------------------------------------------------

  async verifyJourney<T = Record<string, unknown>>(
    token: string,
    payload: Record<string, unknown>,
  ): Promise<ApiResponse<T>> {
    return this.request('POST', '/v1/journeys/verify', {
      token,
      body: payload,
    });
  }

  async verifyTrainPnr<T = Record<string, unknown>>(
    token: string,
    pnr: string,
  ): Promise<ApiResponse<T>> {
    return this.verifyJourney<T>(token, { mode: 'train', pnr });
  }

  async verifyTrainSms<T = Record<string, unknown>>(
    token: string,
    smsText: string,
  ): Promise<ApiResponse<T>> {
    return this.verifyJourney<T>(token, { mode: 'train', sms_text: smsText });
  }

  async verifyFlightBcbp<T = Record<string, unknown>>(
    token: string,
    bcbp: string,
  ): Promise<ApiResponse<T>> {
    return this.verifyJourney<T>(token, { mode: 'flight', bcbp });
  }

  async verifyFlightDeclared<T = Record<string, unknown>>(
    token: string,
    declared: { flight_no: string; date: string; seat: string },
  ): Promise<ApiResponse<T>> {
    return this.verifyJourney<T>(token, { mode: 'flight', declared });
  }

  async getJourneys<T = { items: Array<Record<string, unknown>> }>(
    token: string,
  ): Promise<ApiResponse<T>> {
    return this.request('GET', '/v1/journeys', { token });
  }

  async getJourney<T = Record<string, unknown>>(
    token: string,
    journeyId: string,
  ): Promise<ApiResponse<T>> {
    return this.request('GET', `/v1/journeys/${journeyId}`, { token });
  }

  async reverifyJourney<T = Record<string, unknown>>(
    token: string,
    journeyId: string,
  ): Promise<ApiResponse<T>> {
    return this.request('POST', `/v1/journeys/${journeyId}/reverify`, { token });
  }

  async deleteJourney(token: string, journeyId: string): Promise<ApiResponse<unknown>> {
    return this.request('DELETE', `/v1/journeys/${journeyId}`, { token });
  }

  // ---------------------------------------------------------------------------
  // Party & Goals (#12, #13)
  // ---------------------------------------------------------------------------

  async createPartyInvite(
    token: string,
    journeyId: string,
  ): Promise<ApiResponse<{ invite_url: string; expires_at: string; token?: string }>> {
    return this.request('POST', `/v1/journeys/${journeyId}/party/invite`, { token });
  }

  async joinParty<T = Record<string, unknown>>(
    token: string,
    inviteToken: string,
    payload: {
      pnr?: string;
      bcbp?: string;
      sms_text?: string;
      declared?: { flight_no: string; date: string; seat: string };
      mode?: 'train' | 'flight';
    },
  ): Promise<ApiResponse<T>> {
    return this.request('POST', '/v1/party/join', {
      token,
      body: { invite_token: inviteToken, ...payload },
    });
  }

  async removePartyMember(
    token: string,
    partyId: string,
    seatHolderId: string,
  ): Promise<ApiResponse<unknown>> {
    return this.request('DELETE', `/v1/party/${partyId}/members/${seatHolderId}`, {
      token,
    });
  }

  async setGoal<T = Record<string, unknown>>(
    token: string,
    partyId: string,
    goal: Record<string, unknown>,
  ): Promise<ApiResponse<T>> {
    return this.request('PUT', `/v1/parties/${partyId}/goal`, {
      token,
      body: goal,
    });
  }

  async deleteGoal(token: string, partyId: string): Promise<ApiResponse<unknown>> {
    return this.request('DELETE', `/v1/parties/${partyId}/goal`, { token });
  }

  // ---------------------------------------------------------------------------
  // Matches & Coach Map (#14, #15)
  // ---------------------------------------------------------------------------

  async getMatches<T = { match_version: number; items: MatchCardDto[] }>(
    token: string,
    partyId: string,
    kind?: 'pair' | 'cycle' | 'plan',
  ): Promise<ApiResponse<T>> {
    return this.request('GET', `/v1/parties/${partyId}/matches`, {
      token,
      query: kind ? { kind } : undefined,
    });
  }

  async getCoachMap<T = Record<string, unknown>>(
    token: string,
    journeyId: string,
    coach: string,
  ): Promise<ApiResponse<T>> {
    return this.request('GET', `/v1/journeys/${journeyId}/coach-map`, {
      token,
      query: { coach },
    });
  }

  // ---------------------------------------------------------------------------
  // Swaps & Swap Cards (#16, #17, #18)
  // ---------------------------------------------------------------------------

  async createSwap<T = Record<string, unknown>>(
    token: string,
    cardId: string,
    note?: string,
  ): Promise<ApiResponse<T>> {
    return this.request('POST', '/v1/swaps', {
      token,
      body: note !== undefined ? { card_id: cardId, note } : { card_id: cardId },
    });
  }

  async getSwaps<T = { items: Array<Record<string, unknown>> }>(
    token: string,
    state?: 'active' | 'past' | 'all',
  ): Promise<ApiResponse<T>> {
    return this.request('GET', '/v1/swaps', {
      token,
      query: state ? { state } : undefined,
    });
  }

  async getSwap<T = Record<string, unknown>>(
    token: string,
    swapId: string,
  ): Promise<ApiResponse<T>> {
    return this.request('GET', `/v1/swaps/${swapId}`, { token });
  }

  async acceptSwap<T = Record<string, unknown>>(
    token: string,
    swapId: string,
    version: number,
  ): Promise<ApiResponse<T>> {
    return this.request('POST', `/v1/swaps/${swapId}/accept`, {
      token,
      body: { version },
    });
  }

  async declineSwap<T = Record<string, unknown>>(
    token: string,
    swapId: string,
    reason?: string,
  ): Promise<ApiResponse<T>> {
    return this.request('POST', `/v1/swaps/${swapId}/decline`, {
      token,
      body: reason !== undefined ? { reason } : {},
    });
  }

  async cancelSwap<T = Record<string, unknown>>(
    token: string,
    swapId: string,
  ): Promise<ApiResponse<T>> {
    return this.request('POST', `/v1/swaps/${swapId}/cancel`, { token });
  }

  async confirmCompletion<T = Record<string, unknown>>(
    token: string,
    swapId: string,
    answer: 'yes' | 'no' | 'did_not_board',
  ): Promise<ApiResponse<T>> {
    return this.request('POST', `/v1/swaps/${swapId}/confirm-completion`, {
      token,
      body: { answer },
    });
  }

  async getSwapCard<T = Record<string, unknown>>(
    token: string,
    swapId: string,
    format: 'json' | 'svg' | 'png' = 'json',
  ): Promise<ApiResponse<T>> {
    return this.request('GET', `/v1/swaps/${swapId}/card`, {
      token,
      query: { format },
    });
  }

  async verifyPublicSwapCard<T = Record<string, unknown>>(
    code: string,
  ): Promise<ApiResponse<T>> {
    return this.request('GET', `/v1/public/swap-cards/${encodeURIComponent(code)}`);
  }

  // ---------------------------------------------------------------------------
  // Chat & Safety (#27)
  // ---------------------------------------------------------------------------

  async listConversations<T = { items: Array<Record<string, unknown>> }>(
    token: string,
  ): Promise<ApiResponse<T>> {
    return this.request('GET', '/v1/conversations', { token });
  }

  async createConversation<T = Record<string, unknown>>(
    token: string,
    cardId: string,
  ): Promise<ApiResponse<T>> {
    return this.request('POST', '/v1/conversations', {
      token,
      body: { card_id: cardId },
    });
  }

  async getMessages<T = { items: Array<Record<string, unknown>>; next_cursor?: string }>(
    token: string,
    conversationId: string,
    before?: string,
  ): Promise<ApiResponse<T>> {
    return this.request('GET', `/v1/conversations/${conversationId}/messages`, {
      token,
      query: before ? { before } : undefined,
    });
  }

  async sendMessage<T = Record<string, unknown>>(
    token: string,
    conversationId: string,
    body: string,
    clientId: string = crypto.randomUUID(),
  ): Promise<ApiResponse<T>> {
    return this.request('POST', `/v1/conversations/${conversationId}/messages`, {
      token,
      body: { body, client_id: clientId },
    });
  }

  async translateMessage<T = Record<string, unknown>>(
    token: string,
    conversationId: string,
    messageId: string,
    to: string,
  ): Promise<ApiResponse<T>> {
    return this.request('POST', `/v1/conversations/${conversationId}/translate`, {
      token,
      body: { message_id: messageId, to },
    });
  }

  async blockUser(token: string, aliasRef: string): Promise<ApiResponse<{ blocked: boolean }>> {
    return this.request('POST', '/v1/users/block', {
      token,
      body: { alias_ref: aliasRef },
    });
  }

  async reportUser<T = Record<string, unknown>>(
    token: string,
    payload: { conversation_id: string; message_id?: string; reason: string },
  ): Promise<ApiResponse<T>> {
    return this.request('POST', '/v1/reports', {
      token,
      body: payload,
    });
  }

  // ---------------------------------------------------------------------------
  // AI Concierge & Drafts (#22)
  // ---------------------------------------------------------------------------

  async conciergeStream(
    token: string,
    journeyId: string,
    text: string,
  ): Promise<{
    status: number;
    ok: boolean;
    headers: Headers;
    events: SseChunkEvent[];
    rawText: string;
  }> {
    const res = await fetch(buildUrl(this.baseUrl, '/v1/ai/concierge'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream, application/json, application/problem+json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ journey_id: journeyId, text }),
    });

    const rawText = await res.text();
    const events: SseChunkEvent[] = [];

    if (res.ok) {
      const normalized = rawText.replace(/\r\n/g, '\n');
      for (const frame of normalized.split('\n\n')) {
        if (!frame.trim()) {
          continue;
        }
        let eventName = 'message';
        const dataLines: string[] = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) {
            eventName = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart());
          }
        }
        if (dataLines.length === 0) {
          continue;
        }
        const rawData = dataLines.join('\n');
        let parsed: unknown = rawData;
        try {
          parsed = JSON.parse(rawData);
        } catch {
          // keep raw text
        }
        events.push({ event: eventName, data: parsed, raw: rawData });
      }
    }

    return {
      status: res.status,
      ok: res.ok,
      headers: res.headers,
      events,
      rawText,
    };
  }

  async draftRequest(
    token: string,
    cardId: string,
    opts: { tone?: string; lang?: 'en' | 'hi' } = {},
  ): Promise<ApiResponse<{ text: string }>> {
    return this.request('POST', '/v1/ai/draft-request', {
      token,
      body: {
        card_id: cardId,
        tone: opts.tone,
        lang: opts.lang ?? 'en',
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Karma, Profile, Push & DPDP (#21, #23, #29, #32)
  // ---------------------------------------------------------------------------

  async getKarma<T = Record<string, unknown>>(token: string): Promise<ApiResponse<T>> {
    return this.request('GET', '/v1/karma', { token });
  }

  async getRewardsCatalogue<T = Record<string, unknown>>(
    token: string,
  ): Promise<ApiResponse<T>> {
    return this.request('GET', '/v1/karma/rewards', { token });
  }

  async redeemReward<T = Record<string, unknown>>(
    token: string,
    rewardCode: string,
  ): Promise<ApiResponse<T>> {
    return this.request('POST', '/v1/karma/rewards/redeem', {
      token,
      body: { reward_code: rewardCode },
    });
  }

  async getMe<T = Record<string, unknown>>(token: string): Promise<ApiResponse<T>> {
    return this.request('GET', '/v1/me', { token });
  }

  async patchMe<T = Record<string, unknown>>(
    token: string,
    patch: Record<string, unknown>,
  ): Promise<ApiResponse<T>> {
    return this.request('PATCH', '/v1/me', {
      token,
      body: patch,
    });
  }

  async savePushSubscription(
    token: string,
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  ): Promise<ApiResponse<{ subscribed: boolean }>> {
    return this.request('POST', '/v1/me/push-subscriptions', {
      token,
      body: subscription,
    });
  }

  async getConsents<T = Record<string, unknown>>(token: string): Promise<ApiResponse<T>> {
    return this.request('GET', '/v1/me/consents', { token });
  }

  async saveConsents<T = Record<string, unknown>>(
    token: string,
    consents: Array<{ purpose: string; notice_version: string; granted: boolean }>,
  ): Promise<ApiResponse<T>> {
    return this.request('POST', '/v1/me/consents', {
      token,
      body: { consents },
    });
  }

  async exportMyData(token: string): Promise<BinaryApiResponse> {
    return this.requestBinary('GET', '/v1/me/export', { token });
  }

  async deleteMyAccount<T = Record<string, unknown>>(token: string): Promise<ApiResponse<T>> {
    return this.request('DELETE', '/v1/me', { token });
  }

  // ---------------------------------------------------------------------------
  // Growth & Public Utility (#19, #20)
  // ---------------------------------------------------------------------------

  async createSeatInvite<T = Record<string, unknown>>(
    token: string,
    journeyId: string,
    target: { coach?: string; seat_no?: string } = {},
  ): Promise<ApiResponse<T>> {
    return this.request('POST', `/v1/journeys/${journeyId}/invite-seat`, {
      token,
      body: target,
    });
  }

  async getPublicInvite<T = Record<string, unknown>>(
    inviteToken: string,
  ): Promise<ApiResponse<T>> {
    return this.request('GET', `/v1/public/invites/${encodeURIComponent(inviteToken)}`);
  }

  async getPublicPnrStatus<T = Record<string, unknown>>(
    pnr: string,
  ): Promise<ApiResponse<T>> {
    return this.request('GET', `/v1/public/pnr-status/${encodeURIComponent(pnr)}`);
  }

  async getPublicTrainLive<T = Record<string, unknown>>(
    trainNo: string,
    date?: string,
  ): Promise<ApiResponse<T>> {
    return this.request('GET', `/v1/public/train/${encodeURIComponent(trainNo)}/live`, {
      query: date ? { date } : undefined,
    });
  }

  async getPublicTrainComposition<T = Record<string, unknown>>(
    trainNo: string,
  ): Promise<ApiResponse<T>> {
    return this.request(
      'GET',
      `/v1/public/train/${encodeURIComponent(trainNo)}/composition`,
    );
  }

  async getPublicTrainChartTime<T = Record<string, unknown>>(
    trainNo: string,
    date?: string,
  ): Promise<ApiResponse<T>> {
    return this.request(
      'GET',
      `/v1/public/train/${encodeURIComponent(trainNo)}/chart-time`,
      { query: date ? { date } : undefined },
    );
  }

  async getPublicFlightLayouts<T = Record<string, unknown>>(
    airline?: string,
    aircraft?: string,
  ): Promise<ApiResponse<T>> {
    return this.request('GET', '/v1/public/flight-layouts', {
      query: {
        airline,
        aircraft,
      },
    });
  }

  async getPublicStats<T = Record<string, unknown>>(): Promise<ApiResponse<T>> {
    return this.request('GET', '/v1/public/stats');
  }

  // ---------------------------------------------------------------------------
  // Webhooks (#29)
  // ---------------------------------------------------------------------------

  async sendWhatsappWebhook<T = unknown>(
    payload: unknown,
    secret: string = E2E_ENV.whatsappWebhookSecret,
    signatureOverride?: string,
  ): Promise<ApiResponse<T>> {
    const rawBody = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const sig =
      signatureOverride ?? `sha256=${computeHmacSha256Hex(secret, rawBody)}`;
    return this.request('POST', '/v1/webhooks/whatsapp', {
      body: rawBody,
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': sig,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // R3 Pricing, Billing, Entitlements & B2B (#25)
  // ---------------------------------------------------------------------------

  async getPricingPlans<T = Record<string, unknown>>(): Promise<ApiResponse<T>> {
    return this.request('GET', '/v1/pricing/plans');
  }

  async getMyEntitlements<T = Record<string, unknown>>(
    token: string,
  ): Promise<ApiResponse<T>> {
    return this.request('GET', '/v1/me/entitlements', { token });
  }

  async checkoutPlan<T = Record<string, unknown>>(
    token: string,
    payload: {
      plan_code: string;
      journey_id?: string;
      party_id?: string;
      idempotency_key?: string;
    },
  ): Promise<ApiResponse<T>> {
    return this.request('POST', '/v1/billing/checkout', {
      token,
      body: payload,
    });
  }

  async sendSignedPaymentWebhook<T = unknown>(
    payload: unknown,
    secret: string = E2E_ENV.paymentWebhookSecret,
    signatureOverride?: string,
    extraHeaders?: Record<string, string>,
  ): Promise<ApiResponse<T>> {
    const rawBody = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const hexSig = signatureOverride ?? computeHmacSha256Hex(secret, rawBody);
    return this.request('POST', '/v1/webhooks/payments', {
      body: rawBody,
      headers: {
        'Content-Type': 'application/json',
        'X-Razorpay-Signature': hexSig,
        'X-Webhook-Signature': `sha256=${hexSig}`,
        ...extraHeaders,
      },
    });
  }

  async completeSandboxPayment<T = Record<string, unknown>>(
    token: string,
    orderId: string,
  ): Promise<ApiResponse<T>> {
    return this.request('POST', '/v1/billing/sandbox/complete', {
      token,
      body: { order_id: orderId },
    });
  }

  async requestWithApiKey<T = unknown>(
    method: string,
    path: string,
    apiKey: string,
    options: Omit<RequestOptions, 'token'> = {},
  ): Promise<ApiResponse<T>> {
    return this.request<T>(method, path, {
      ...options,
      headers: {
        'X-API-Key': apiKey,
        ...options.headers,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Admin Portal APIs (#31)
  // ---------------------------------------------------------------------------

  async createAdminSession<
    T = {
      access?: string;
      token?: string;
      token_type?: string;
      expires_in?: number;
      email?: string;
      scopes?: string[];
      [key: string]: unknown;
    },
  >(
    email?: string,
    opts?: { id_token?: string; code?: string; redirect_uri?: string },
  ): Promise<ApiResponse<T>> {
    const body: Record<string, unknown> = {};
    if (email !== undefined) {
      body.email = email;
    }
    if (opts?.id_token !== undefined) {
      body.id_token = opts.id_token;
    }
    if (opts?.code !== undefined) {
      body.code = opts.code;
    }
    if (opts?.redirect_uri !== undefined) {
      body.redirect_uri = opts.redirect_uri;
    }
    return this.request('POST', '/v1/admin/auth/session', { body });
  }

  async getAdminFunnel<T = Record<string, unknown>>(
    token: string,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<ApiResponse<T>> {
    return this.request('GET', '/v1/admin/analytics/funnel', { token, query });
  }

  async getAdminProvidersHealth<T = Record<string, unknown>>(
    token: string,
  ): Promise<ApiResponse<T>> {
    return this.request('GET', '/v1/admin/providers/health', { token });
  }

  async getAdminModerationQueue<T = Record<string, unknown>>(
    token: string,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<ApiResponse<T>> {
    return this.request('GET', '/v1/admin/moderation/queue', { token, query });
  }

  async actOnModeration<T = Record<string, unknown>>(
    token: string,
    reportId: string,
    action: 'dismiss' | 'hide' | 'restrict' | 'ban' | string,
    note?: string,
  ): Promise<ApiResponse<T>> {
    return this.request('POST', `/v1/admin/moderation/${reportId}/action`, {
      token,
      body: note !== undefined ? { action, note } : { action },
    });
  }

  async getAdminFraudGraph<T = Record<string, unknown>>(
    token: string,
  ): Promise<ApiResponse<T>> {
    return this.request('GET', '/v1/admin/fraud/graph', { token });
  }

  async getAdminFlags<T = Record<string, unknown>>(
    token: string,
  ): Promise<ApiResponse<T>> {
    return this.request('GET', '/v1/admin/flags', { token });
  }

  async patchAdminFlag<T = Record<string, unknown>>(
    token: string,
    key: string,
    value: unknown,
    description?: string,
  ): Promise<ApiResponse<T>> {
    return this.request('PATCH', `/v1/admin/flags/${encodeURIComponent(key)}`, {
      token,
      body: description !== undefined ? { value, description } : { value },
    });
  }

  async getAdminDisputes<T = Record<string, unknown>>(
    token: string,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<ApiResponse<T>> {
    return this.request('GET', '/v1/admin/disputes', { token, query });
  }

  async overrideAdminDispute<T = Record<string, unknown>>(
    token: string,
    disputeId: string,
    body: {
      action: 'complete' | 'not_completed' | 'reverse_karma' | 'clear_conflict' | 'dismiss';
      note?: string;
    },
  ): Promise<ApiResponse<T>> {
    return this.request('POST', `/v1/admin/disputes/${encodeURIComponent(disputeId)}/override`, {
      token,
      body,
    });
  }

  async getAdminRedemptions<T = Record<string, unknown>>(
    token: string,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<ApiResponse<T>> {
    return this.request('GET', '/v1/admin/redemptions', { token, query });
  }

  async reviewAdminRedemption<T = Record<string, unknown>>(
    token: string,
    redemptionId: string,
    body: {
      action: 'approve' | 'fulfill' | 'reject' | 'cancel';
      note?: string;
    },
  ): Promise<ApiResponse<T>> {
    return this.request(
      'POST',
      `/v1/admin/redemptions/${encodeURIComponent(redemptionId)}/review`,
      {
        token,
        body,
      },
    );
  }

  async getAdminAuditLog<T = Record<string, unknown>>(
    token: string,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<ApiResponse<T>> {
    return this.request('GET', '/v1/admin/audit-log', { token, query });
  }
}
