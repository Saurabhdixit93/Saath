"use client";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export function getAdminToken(): string | null {
  if (typeof window === "undefined") return null;
  return (
    window.localStorage.getItem("saath_admin_token") ||
    window.localStorage.getItem("saath_access_token")
  );
}

export function setAdminToken(token: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem("saath_admin_token", token);
  window.localStorage.setItem("saath_access_token", token);
  document.cookie = `saath_admin_token=${token}; path=/; max-age=86400; SameSite=Lax`;
}

export function clearAdminToken(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem("saath_admin_token");
  window.localStorage.removeItem("saath_access_token");
  document.cookie = "saath_admin_token=; path=/; max-age=0";
}

export async function adminFetch<T = unknown>(
  endpoint: string,
  options: RequestInit = {}
): Promise<{ ok: boolean; status: number; data: T }> {
  const token = getAdminToken();
  const headers = new Headers(options.headers);
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  if (!headers.has("Content-Type") && options.body && typeof options.body === "string") {
    headers.set("Content-Type", "application/json");
  }

  const url = endpoint.startsWith("http") ? endpoint : `${API_BASE_URL}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers,
  });

  let data: unknown = null;
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      data = await res.json();
    } catch {
      data = null;
    }
  } else {
    data = await res.text();
  }

  return {
    ok: res.ok,
    status: res.status,
    data: data as T,
  };
}
