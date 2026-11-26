import { parseProblemDetail } from "@saath/contracts";
import type { createBrowserApiClient } from "@/lib/api";
import { publicEnv } from "@/lib/env";

export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export function isIosNonStandalone(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return false;
  }
  const ua = navigator.userAgent || "";
  const isIos = /iPad|iPhone|iPod/.test(ua);
  const navWithStandalone = navigator as Navigator & { standalone?: boolean };
  const isStandalone =
    navWithStandalone.standalone === true ||
    (typeof window.matchMedia === "function" &&
      window.matchMedia("(display-mode: standalone)").matches);
  return isIos && !isStandalone;
}

function arrayBufferToBase64Url(buf: ArrayBuffer | null): string {
  if (!buf) return "";
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function subscribeBrowserWebPush(
  apiClient: ReturnType<typeof createBrowserApiClient>
): Promise<{ subscribed: boolean; permission: NotificationPermission | "unsupported" }> {
  if (typeof window === "undefined" || typeof Notification === "undefined") {
    return { subscribed: false, permission: "unsupported" };
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return { subscribed: false, permission };
  }

  const vapidPublicKey = publicEnv.NEXT_PUBLIC_VAPID_PUBLIC_KEY.trim();
  let endpoint: string | null = null;
  let p256dh = "";
  let auth = "";

  if ("serviceWorker" in navigator && "PushManager" in window) {
    try {
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      const sub =
        existing ??
        (vapidPublicKey
          ? await reg.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: urlBase64ToUint8Array(
                vapidPublicKey
              ) as BufferSource,
            })
          : null);
      if (sub) {
        const subJson = sub.toJSON();
        endpoint = sub.endpoint;
        p256dh = subJson.keys?.p256dh || arrayBufferToBase64Url(sub.getKey("p256dh"));
        auth = subJson.keys?.auth || arrayBufferToBase64Url(sub.getKey("auth"));
      }
    } catch (err) {
      if (vapidPublicKey) {
        throw err instanceof Error
          ? err
          : new Error("Failed to subscribe to Web Push notifications");
      }
      // Fallback to synthetic local registration payload when VAPID key is unset in local dev
    }
  }

  if (!endpoint || !p256dh || !auth) {
    if (vapidPublicKey) {
      throw new Error("Web Push subscription is unavailable in this browser");
    }
    endpoint = `https://push.saath.local/sub/${Date.now()}`;
    p256dh =
      "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8";
    auth = "tBHItJI5svbpez7KI4CCXg";
  }

  const { data, error } = await apiClient.POST("/v1/me/push-subscriptions", {
    body: {
      endpoint,
      keys: { p256dh, auth },
    },
  });
  if (error || !data?.subscribed) {
    throw new Error(parseProblemDetail(error)?.detail || "Failed to register push subscription");
  }
  return { subscribed: true, permission };
}
