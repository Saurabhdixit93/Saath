import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Saath — Sit together. Safely.",
    short_name: "Saath",
    description:
      "Verified peer-to-peer seat swaps for Indian trains and flights. Always free for passengers.",
    start_url: "/",
    display: "standalone",
    background_color: "#FAF7F2",
    theme_color: "#E2572B",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
      },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
