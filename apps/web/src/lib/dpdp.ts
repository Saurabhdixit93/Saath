import { parseProblemDetail } from "@saath/contracts";
import { publicEnv } from "./env";

export const DPDP_PURPOSES = [
  "verification",
  "matching",
  "notifications",
  "analytics",
  "whatsapp",
] as const;

export type DpdpPurpose = (typeof DPDP_PURPOSES)[number];

export const DPDP_NOTICE_VERSION = "1.0";

export const ESSENTIAL_DPDP_PURPOSES: ReadonlySet<DpdpPurpose> = new Set([
  "verification",
  "matching",
]);

export const DEFAULT_DPDP_SELECTIONS: Record<DpdpPurpose, boolean> = {
  verification: true,
  matching: true,
  notifications: true,
  analytics: false,
  whatsapp: true,
};

export interface ConsentItemInput {
  purpose: DpdpPurpose;
  notice_version: string;
  granted: boolean;
}

export interface ConsentRecordDTO {
  purpose: DpdpPurpose;
  notice_version: string;
  granted: boolean;
  at?: string | null;
}

export interface ConsentsListResponse {
  notice_version: string;
  purposes: DpdpPurpose[];
  consents: ConsentRecordDTO[];
}

export interface SaveConsentsResponse {
  consents: ConsentRecordDTO[];
}

export interface DeleteAccountResponse {
  status: string;
  scheduled_within_hours?: number;
}

export interface DpdpAuthSource {
  getAccessToken: () => string | null;
  refreshTokens?: () => Promise<string | null>;
}

export type DpdpAuthInput = string | null | DpdpAuthSource;

export const PENDING_CONSENTS_KEY = "saath_dpdp_pending_consents";
export const CONSENT_ACK_KEY = "saath_dpdp_consent_ack";

let inflightDpdpRefresh: Promise<string | null> | null = null;

function resolveAuthSource(auth: DpdpAuthInput): DpdpAuthSource {
  if (typeof auth === "string" || auth === null) {
    return { getAccessToken: () => auth };
  }
  return auth;
}

function getApiBaseUrl(): string {
  return publicEnv.NEXT_PUBLIC_API_URL.replace(/\/+$/, "");
}

async function runSingleFlightRefresh(
  refreshTokens?: () => Promise<string | null>
): Promise<string | null> {
  if (!refreshTokens) {
    return null;
  }
  if (!inflightDpdpRefresh) {
    inflightDpdpRefresh = refreshTokens().finally(() => {
      inflightDpdpRefresh = null;
    });
  }
  return inflightDpdpRefresh;
}

export class DpdpApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "DpdpApiError";
    this.status = status;
    this.code = code;
  }
}

async function parseErrorResponse(res: Response): Promise<DpdpApiError> {
  try {
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("json")) {
      const payload = (await res.json()) as unknown;
      const problem = parseProblemDetail(payload);
      if (problem) {
        return new DpdpApiError(problem.detail || problem.title, res.status, problem.code);
      }
      if (payload && typeof payload === "object" && "detail" in payload) {
        const detail = (payload as { detail?: unknown }).detail;
        if (typeof detail === "string" && detail.trim()) {
          return new DpdpApiError(detail, res.status);
        }
      }
    }
  } catch {
    // ignore JSON parse failures
  }
  return new DpdpApiError(res.statusText || `Request failed (${res.status})`, res.status);
}

async function dpdpFetch(
  path: string,
  auth: DpdpAuthInput,
  init: RequestInit = {}
): Promise<Response> {
  const source = resolveAuthSource(auth);
  const url = `${getApiBaseUrl()}${path}`;

  const execute = (token: string | null) => {
    const headers = new Headers(init.headers);
    if (token && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    return fetch(url, {
      ...init,
      headers,
    });
  };

  let res = await execute(source.getAccessToken());
  if (res.status === 401 && source.refreshTokens) {
    const freshToken = await runSingleFlightRefresh(source.refreshTokens);
    if (freshToken) {
      res = await execute(freshToken);
    }
  }
  return res;
}

export async function getMyConsents(auth: DpdpAuthInput): Promise<ConsentsListResponse> {
  const res = await dpdpFetch("/v1/me/consents", auth, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw await parseErrorResponse(res);
  }
  return (await res.json()) as ConsentsListResponse;
}

export async function saveMyConsents(
  auth: DpdpAuthInput,
  consents: ConsentItemInput[]
): Promise<SaveConsentsResponse> {
  const res = await dpdpFetch("/v1/me/consents", auth, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ consents }),
  });
  if (!res.ok) {
    throw await parseErrorResponse(res);
  }
  return (await res.json()) as SaveConsentsResponse;
}

export function extractDownloadFilename(
  contentDisposition: string | null,
  fallback = "saath-data-export.zip"
): string {
  if (!contentDisposition) {
    return fallback;
  }
  const utf8Match = /filename\*=UTF-8''([^;\s]+)/i.exec(contentDisposition);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1].replace(/["']/g, ""));
    } catch {
      return utf8Match[1].replace(/["']/g, "");
    }
  }
  const quotedMatch = /filename="([^"]+)"/i.exec(contentDisposition);
  if (quotedMatch?.[1]) {
    return quotedMatch[1];
  }
  const plainMatch = /filename=([^;\s]+)/i.exec(contentDisposition);
  if (plainMatch?.[1]) {
    return plainMatch[1].replace(/["']/g, "");
  }
  return fallback;
}

export async function exportMyDataZip(
  auth: DpdpAuthInput
): Promise<{ blob: Blob; filename: string }> {
  const res = await dpdpFetch("/v1/me/export", auth, {
    method: "GET",
    headers: { Accept: "application/zip, application/octet-stream" },
  });
  if (!res.ok) {
    throw await parseErrorResponse(res);
  }
  const blob = await res.blob();
  const filename = extractDownloadFilename(
    res.headers.get("content-disposition"),
    "saath-data-export.zip"
  );
  return { blob, filename };
}

export async function deleteMyAccount(auth: DpdpAuthInput): Promise<DeleteAccountResponse> {
  const res = await dpdpFetch("/v1/me", auth, {
    method: "DELETE",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw await parseErrorResponse(res);
  }
  return (await res.json()) as DeleteAccountResponse;
}

export function buildConsentItems(
  selections: Record<DpdpPurpose, boolean>,
  noticeVersion = DPDP_NOTICE_VERSION
): ConsentItemInput[] {
  return DPDP_PURPOSES.map((purpose) => ({
    purpose,
    notice_version: noticeVersion,
    granted: ESSENTIAL_DPDP_PURPOSES.has(purpose) ? true : Boolean(selections[purpose]),
  }));
}

export function selectionsFromConsents(
  consents: Array<Pick<ConsentRecordDTO, "purpose" | "granted">>,
  fallback: Record<DpdpPurpose, boolean> = DEFAULT_DPDP_SELECTIONS
): Record<DpdpPurpose, boolean> {
  const next: Record<DpdpPurpose, boolean> = { ...fallback };
  for (const item of consents) {
    if (DPDP_PURPOSES.includes(item.purpose)) {
      next[item.purpose] = ESSENTIAL_DPDP_PURPOSES.has(item.purpose)
        ? true
        : Boolean(item.granted);
    }
  }
  return next;
}

export function getPendingDpdpConsents(): ConsentItemInput[] | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(PENDING_CONSENTS_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    const valid = parsed.filter(
      (item): item is ConsentItemInput =>
        Boolean(item) &&
        typeof item === "object" &&
        DPDP_PURPOSES.includes((item as ConsentItemInput).purpose) &&
        typeof (item as ConsentItemInput).notice_version === "string" &&
        typeof (item as ConsentItemInput).granted === "boolean"
    );
    return valid.length > 0 ? valid : null;
  } catch {
    return null;
  }
}

export function setPendingDpdpConsents(consents: ConsentItemInput[]): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(PENDING_CONSENTS_KEY, JSON.stringify(consents));
  } catch {
    // ignore storage failures
  }
}

export function clearPendingDpdpConsents(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.removeItem(PENDING_CONSENTS_KEY);
  } catch {
    // ignore storage failures
  }
}

export function hasAcknowledgedDpdpConsent(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem(CONSENT_ACK_KEY) === "1";
  } catch {
    return false;
  }
}

export function setAcknowledgedDpdpConsent(ack: boolean): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (ack) {
      window.localStorage.setItem(CONSENT_ACK_KEY, "1");
    } else {
      window.localStorage.removeItem(CONSENT_ACK_KEY);
    }
  } catch {
    // ignore storage failures
  }
}
