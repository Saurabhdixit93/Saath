/// <reference lib="webworker" />

import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { ExpirationPlugin, NetworkFirst, NetworkOnly, Serwist } from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    {
      matcher: ({ url }) =>
        /^\/v1\/(swaps\/[^/]+\/card|public\/swap-cards\/[^/]+)$/.test(url.pathname),
      handler: new NetworkFirst({
        cacheName: "saath-swap-cards-api",
        plugins: [
          new ExpirationPlugin({
            maxEntries: 32,
            maxAgeSeconds: 7 * 24 * 60 * 60,
          }),
        ],
      }),
    },
    {
      matcher: ({ url }) =>
        /^\/(?:(?:en|hi)\/)?swaps\/[^/]+\/card$/.test(url.pathname),
      handler: new NetworkFirst({
        cacheName: "saath-swap-card-pages",
        plugins: [
          new ExpirationPlugin({
            maxEntries: 16,
            maxAgeSeconds: 7 * 24 * 60 * 60,
          }),
        ],
      }),
    },
    {
      matcher: ({ url }) => url.pathname.startsWith("/v1/"),
      handler: new NetworkOnly(),
    },
    ...defaultCache,
  ],
});

serwist.addEventListeners();

self.addEventListener("push", (event) => {
  const pushEvent = event as PushEvent;
  let title = "Saath";
  let body = "You have a new seat swap update.";
  let url = "/inbox";
  let tag = "saath-alert";

  try {
    const payload = pushEvent.data?.json() as
      | { title?: string; body?: string; url?: string; data?: { event?: string } }
      | undefined;
    if (payload) {
      if (payload.title) title = payload.title;
      if (payload.body) body = payload.body;
      if (payload.url) url = payload.url;
      if (payload.data?.event) tag = `saath-${payload.data.event}`;
    }
  } catch {
    const text = pushEvent.data?.text();
    if (text) body = text;
  }

  pushEvent.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag,
      data: { url },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  const notifEvent = event as NotificationEvent;
  notifEvent.notification.close();
  const targetUrl =
    (notifEvent.notification.data as { url?: string } | undefined)?.url || "/inbox";

  notifEvent.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client && client.url.includes(targetUrl)) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
      return undefined;
    })
  );
});
