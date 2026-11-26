import type { Metadata } from "next";
import { setRequestLocale } from "next-intl/server";
import type { PublicSeatInviteResponse } from "@saath/contracts";
import { fetchPublicJson } from "@/lib/serverApi";
import { buildMetadata } from "@/lib/seo";
import { InviteLandingClient } from "./InviteLandingClient";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; token: string }>;
}): Promise<Metadata> {
  const { locale, token } = await params;
  const isHi = locale === "hi";
  return buildMetadata({
    locale,
    path: `/j/${token}`,
    title: isHi ? "सीट स्वैप आमंत्रण — साथ" : "Help a co-traveller swap seats — Saath",
    description: isHi
      ? "सुरक्षित और ₹0 पीयर-टू-पीयर सीट स्वैप के लिए अपना टिकट सत्यापित करें।"
      : "Verify your PNR or boarding pass to help a co-traveller swap seats safely—always ₹0.",
    noIndex: true,
  });
}

export default async function SeatInviteLandingPage({
  params,
}: {
  params: Promise<{ locale: string; token: string }>;
}) {
  const { locale, token } = await params;
  setRequestLocale(locale);

  const res = await fetchPublicJson<PublicSeatInviteResponse>(
    `/v1/public/invites/${encodeURIComponent(token)}`,
    { cache: "no-store" }
  );

  return (
    <InviteLandingClient
      token={token}
      invite={res.ok && res.data?.valid ? res.data : null}
    />
  );
}
