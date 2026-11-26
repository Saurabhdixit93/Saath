import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import enMessages from "../messages/en.json";
import { PnrStatusClient } from "../src/app/[locale]/pnr-status/PnrStatusClient";
import robots from "../src/app/robots";
import sitemap from "../src/app/sitemap";
import { JsonLd } from "../src/components/JsonLd";
import { AIRCRAFT_LAYOUTS } from "../src/lib/aircraftLayouts";
import { BLOG_ARTICLES } from "../src/lib/blogArticles";
import { buildFaqJsonLd } from "../src/lib/seo";
import { isValidTrainNo, TOP_TRAINS } from "../src/lib/topTrains";
import { runAxe } from "../vitest.setup";

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/pnr-status",
  Link: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

describe("SEO utility pages, catalog, sitemap, and robots", () => {
  it("exposes 3,000 trains, 25 aircraft layouts, and bilingual blog articles", () => {
    expect(TOP_TRAINS).toHaveLength(3000);
    const nos = new Set(TOP_TRAINS.map((t) => t.trainNo));
    expect(nos.size).toBe(3000);
    expect(nos.has("12951")).toBe(true);
    expect(nos.has("12009")).toBe(true);
    expect(nos.has("12627")).toBe(true);
    expect(nos.has("22436")).toBe(true);
    expect(isValidTrainNo("00000")).toBe(false);
    expect(isValidTrainNo("12951")).toBe(true);

    expect(Object.keys(AIRCRAFT_LAYOUTS)).toHaveLength(25);
    expect(BLOG_ARTICLES.some((b) => b.slug === "how-seat-swapping-works-in-indian-railways")).toBe(
      true
    );
  });

  it("generates flat sitemap with /pnr-status + 3,000 trains and valid robots.txt", () => {
    const entries = sitemap();
    expect(entries.length).toBeGreaterThan(9000);
    const urls = new Set(entries.map((e) => e.url));
    expect(Array.from(urls).some((u) => u.endsWith("/pnr-status"))).toBe(true);
    expect(Array.from(urls).some((u) => u.endsWith("/train/12951/live"))).toBe(true);
    expect(Array.from(urls).some((u) => u.endsWith("/flights/6E/A320neo/seat-map"))).toBe(true);

    const robotsConfig = robots();
    expect(String(robotsConfig.sitemap)).toContain("sitemap.xml");
  });

  it("renders JsonLd script cleanly without unescaped script tags", () => {
    const { container } = render(
      <JsonLd data={buildFaqJsonLd([{ question: "Test <tag>?", answer: "Answer" }])} />
    );
    const script = container.querySelector('script[type="application/ld+json"]');
    expect(script).not.toBeNull();
    expect(script?.innerHTML).toContain("FAQPage");
    expect(script?.innerHTML).toContain("\\u003c");
  });

  it("handles valid aggregate PNR check and flushed 422 error in PnrStatusClient with zero axe violations", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith("/9999999991")) {
          return new Response(
            JSON.stringify({
              type: "https://saath.app/problems/pnr-flushed",
              title: "PNR Flushed or Cancelled",
              status: 422,
              detail: "This PNR looks flushed or cancelled. Double-check the 10 digits.",
              code: "pnr_flushed",
            }),
            { status: 422, headers: { "content-type": "application/problem+json" } }
          );
        }
        return new Response(
          JSON.stringify({
            train_no: "12951",
            train_name: "Mumbai Tejas Rajdhani Express",
            service_date: "2026-11-28",
            travel_class: "3A",
            from_code: "NDLS",
            to_code: "MMCT",
            departure_at: "2026-11-28T11:25:00Z",
            arrival_at: "2026-11-29T03:05:00Z",
            chart_state: "pending",
            chart_due_at: "2026-11-28T01:25:00Z",
            passenger_count: 2,
            confirmed_count: 2,
            rac_count: 0,
            wl_count: 0,
            coaches: ["B3", "B5"],
            berth_types: ["MB", "UB"],
            status_summary: [
              { pax_seq: 1, booking_status: "CNF", current_status: "CNF", coach: "B5", seat_type: "UB", bay: 2 },
              { pax_seq: 2, booking_status: "CNF", current_status: "CNF", coach: "B3", seat_type: "MB", bay: 6 },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      })
    );

    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <PnrStatusClient />
      </NextIntlClientProvider>
    );

    const input = screen.getByRole("textbox");
    await user.type(input, "9999999991");
    await user.click(screen.getByRole("button", { name: /Check PNR status/i }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/flushed|cancelled|double-check/i)
    );

    await user.clear(input);
    await user.type(input, "2415678901");
    await user.click(screen.getByRole("button", { name: /Check PNR status/i }));
    await waitFor(() =>
      expect(screen.getByText(/12951 · Mumbai Tejas Rajdhani Express/)).toBeInTheDocument()
    );
    expect(screen.getByText(/CNF: 2 · RAC: 0 · WL: 0/)).toBeInTheDocument();
    expect(await runAxe(container)).toHaveNoViolations();
    vi.unstubAllGlobals();
  });
});
