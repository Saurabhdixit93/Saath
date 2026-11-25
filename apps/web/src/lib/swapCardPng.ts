import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import QRCode from "qrcode";
import satori, { type Font } from "satori";
import { Resvg } from "@resvg/resvg-js";
import type { SwapCardDTO } from "@saath/contracts";

const require = createRequire(import.meta.url);

let cachedFonts: Font[] | null = null;

async function loadFonts(): Promise<Font[]> {
  if (cachedFonts) {
    return cachedFonts;
  }
  const [interReg, interBold, devReg, monoBold] = await Promise.all([
    readFile(require.resolve("@fontsource/inter/files/inter-latin-400-normal.woff")),
    readFile(require.resolve("@fontsource/inter/files/inter-latin-700-normal.woff")),
    readFile(
      require.resolve(
        "@fontsource/noto-sans-devanagari/files/noto-sans-devanagari-devanagari-400-normal.woff"
      )
    ),
    readFile(
      require.resolve("@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff")
    ),
  ]);

  cachedFonts = [
    { name: "Inter", data: interReg, weight: 400, style: "normal" },
    { name: "Inter", data: interBold, weight: 700, style: "normal" },
    { name: "Noto Sans Devanagari", data: devReg, weight: 400, style: "normal" },
    { name: "JetBrains Mono", data: monoBold, weight: 700, style: "normal" },
  ];
  return cachedFonts;
}

export async function renderSwapCardPngBuffer(
  card: SwapCardDTO,
  locale: "en" | "hi" = "en"
): Promise<Buffer> {
  const fonts = await loadFonts();
  const qrSvg = await QRCode.toString(card.qr_url, {
    type: "svg",
    margin: 1,
    width: 160,
    color: { dark: "#1C1A17", light: "#FFFFFF" },
  });
  const qrDataUri = `data:image/svg+xml;base64,${Buffer.from(qrSvg, "utf8").toString("base64")}`;

  const isHi = locale === "hi";
  const titleText = isHi ? "साथ स्वैप कार्ड (SAATH SWAP CARD)" : "SAATH SWAP CARD";
  const tteText = isHi
    ? "TTE की स्वीकृति के अधीन · कोई व्यक्तिगत डेटा नहीं"
    : "Subject to TTE approval · No personal data shown";
  const statusText = card.revoked
    ? isHi
      ? "रद्द"
      : "REVOKED"
    : isHi
      ? "सत्यापित"
      : "VERIFIED";

  const height = Math.max(460, 240 + card.participants.length * 64);

  const element = {
    type: "div",
    props: {
      style: {
        width: "880px",
        height: `${height}px`,
        display: "flex",
        flexDirection: "column",
        backgroundColor: "#FAF7F2",
        border: "2px solid #E4DDD2",
        borderRadius: "20px",
        overflow: "hidden",
        fontFamily: isHi ? "Noto Sans Devanagari, Inter" : "Inter",
        color: "#1C1A17",
      },
      children: [
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              backgroundColor: "#1F6F78",
              color: "#FFFFFF",
              padding: "20px 28px",
            },
            children: [
              {
                type: "div",
                props: {
                  style: { display: "flex", flexDirection: "column" },
                  children: [
                    {
                      type: "span",
                      props: {
                        style: { fontSize: "14px", fontWeight: 700, letterSpacing: "1.2px" },
                        children: titleText,
                      },
                    },
                    {
                      type: "span",
                      props: {
                        style: {
                          fontSize: "26px",
                          fontWeight: 700,
                          fontFamily: "JetBrains Mono",
                          marginTop: "4px",
                        },
                        children: `#${card.public_code}`,
                      },
                    },
                  ],
                },
              },
              {
                type: "div",
                props: {
                  style: {
                    backgroundColor: card.revoked ? "#C2362F" : "#2E8B57",
                    color: "#FFFFFF",
                    padding: "8px 16px",
                    borderRadius: "999px",
                    fontSize: "14px",
                    fontWeight: 700,
                  },
                  children: statusText,
                },
              },
            ],
          },
        },
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              justifyContent: "space-between",
              padding: "24px 28px",
              flex: 1,
            },
            children: [
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    flexDirection: "column",
                    gap: "12px",
                    flex: 1,
                    paddingRight: "24px",
                  },
                  children: [
                    {
                      type: "div",
                      props: {
                        style: {
                          fontSize: "18px",
                          fontWeight: 700,
                          fontFamily: "JetBrains Mono",
                        },
                        children: `${card.service} · ${card.date}`,
                      },
                    },
                    ...card.participants.slice(0, 6).map((p) => ({
                      type: "div",
                      props: {
                        style: {
                          display: "flex",
                          flexDirection: "column",
                          backgroundColor: "#F2EEE7",
                          border: "1px solid #E4DDD2",
                          borderRadius: "10px",
                          padding: "10px 14px",
                        },
                        children: [
                          {
                            type: "span",
                            props: {
                              style: {
                                fontSize: "18px",
                                fontWeight: 700,
                                fontFamily: "JetBrains Mono",
                              },
                              children: `${p.from_seat} <-> ${p.to_seat}`,
                            },
                          },
                          {
                            type: "span",
                            props: {
                              style: { fontSize: "12px", color: "#6B645A", marginTop: "2px" },
                              children: p.alias,
                            },
                          },
                        ],
                      },
                    })),
                    {
                      type: "div",
                      props: {
                        style: {
                          fontSize: "14px",
                          fontWeight: 700,
                          color: "#1F6F78",
                          marginTop: "auto",
                        },
                        children: tteText,
                      },
                    },
                  ],
                },
              },
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: "#FFFFFF",
                    border: "1px solid #E4DDD2",
                    borderRadius: "12px",
                    padding: "12px",
                    height: "196px",
                    width: "196px",
                  },
                  children: [
                    {
                      type: "img",
                      props: {
                        src: qrDataUri,
                        width: 160,
                        height: 160,
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    },
  };

  const svg = await satori(element as Parameters<typeof satori>[0], {
    width: 880,
    height,
    fonts,
  });

  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: 880 },
  });
  const rendered = resvg.render();
  return Buffer.from(rendered.asPng());
}
