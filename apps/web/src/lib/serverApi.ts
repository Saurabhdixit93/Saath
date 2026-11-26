import { createSaathClient, parseProblemDetail, type ProblemDetail } from "@saath/contracts";
import { publicEnv } from "./env";

export function getServerApiBaseUrl(): string {
  const raw =
    process.env.API_INTERNAL_URL ||
    process.env.API_URL ||
    publicEnv.NEXT_PUBLIC_API_URL ||
    "http://localhost:8000";
  return raw.replace(/\/+$/, "");
}

export function createPublicBrowserClient() {
  return createSaathClient({
    baseUrl: publicEnv.NEXT_PUBLIC_API_URL,
    getAccessToken: () => null,
  });
}

export interface ServerFetchResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  problem: ProblemDetail | null;
  networkError: boolean;
}

export async function fetchPublicJson<T>(
  path: string,
  options: { revalidate?: number | false; cache?: RequestCache } = {}
): Promise<ServerFetchResult<T>> {
  const baseUrl = getServerApiBaseUrl();
  const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;

  const fetchInit: RequestInit & { next?: { revalidate?: number | false } } = {
    headers: { Accept: "application/json, application/problem+json" },
  };
  if (options.cache) {
    fetchInit.cache = options.cache;
  } else if (options.revalidate !== undefined) {
    fetchInit.next = { revalidate: options.revalidate };
  }

  try {
    const res = await fetch(url, fetchInit);
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    if (res.ok) {
      return {
        ok: true,
        status: res.status,
        data: (parsed as T) ?? null,
        problem: null,
        networkError: false,
      };
    }

    return {
      ok: false,
      status: res.status,
      data: null,
      problem: parseProblemDetail(parsed),
      networkError: false,
    };
  } catch {
    return {
      ok: false,
      status: 0,
      data: null,
      problem: null,
      networkError: true,
    };
  }
}
