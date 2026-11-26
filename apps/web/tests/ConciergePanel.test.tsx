import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SeatHolderOwnDTO } from "@saath/contracts";
import enMessages from "../messages/en.json";
import hiMessages from "../messages/hi.json";
import { AuthProvider } from "../src/components/AuthProvider";
import { ConciergePanel } from "../src/components/ConciergePanel";
import { runAxe } from "../vitest.setup";

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/journeys/j-1",
  Link: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const MEMBERS: SeatHolderOwnDTO[] = [
  {
    id: "0193632e-0000-7000-8000-000000000101",
    pax_seq: 1,
    coach: "B3",
    seat_no: "11",
    seat_type: "UB",
    bay: 2,
    age_band: "senior",
    gender_band: "F",
    booking_status: "CNF",
    current_status: "CNF",
  },
];

function seedUserSession() {
  const header = btoa(JSON.stringify({ alg: "EdDSA", typ: "JWT" }));
  const payload = btoa(
    JSON.stringify({
      sub: "0193632e-0000-7000-8000-000000000777",
      kind: "user",
      exp: Math.floor(Date.now() / 1000) + 900,
    })
  );
  window.sessionStorage.setItem("saath_access", `${header}.${payload}.sig`);
  window.sessionStorage.setItem("saath_auth_kind", "user");
}

function makeSseResponse(events: Array<{ event: string; data: unknown }>): Response {
  const encoder = new TextEncoder();
  const payload = events
    .map((evt) => `event: ${evt.event}\ndata: ${JSON.stringify(evt.data)}\n\n`)
    .join("");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("ConciergePanel", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    seedUserSession();
  });

  it("streams proposal without auto-submitting until user clicks Confirm & apply goal, and passes axe", async () => {
    const user = userEvent.setup();
    const onApplyGoal = vi.fn(async () => {});

    const fetchMock = vi.fn(async () =>
      makeSseResponse([
        {
          event: "proposal",
          data: {
            goal_type: "lower",
            movers: [MEMBERS[0]!.id],
            preferred_seats: [],
            constraints: {
              women_only: false,
              no_middle: false,
              same_coach_only: true,
              verified_only: false,
            },
          },
        },
        {
          event: "explanation",
          data: {
            text: "Suggested a lower berth goal for your senior traveller in the same coach.",
          },
        },
        { event: "done", data: { ok: true } },
      ])
    );

    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AuthProvider>
          <main>
            <ConciergePanel
              journeyId="0193632e-0000-7000-8000-000000000010"
              members={MEMBERS}
              onApplyGoal={onApplyGoal}
              fetchImpl={fetchMock as unknown as typeof globalThis.fetch}
            />
          </main>
        </AuthProvider>
      </NextIntlClientProvider>
    );

    const input = screen.getByRole("textbox", { name: /concierge|ask|help|goal/i });
    await user.type(input, "My senior mother needs a lower berth in the same coach");
    await user.click(screen.getByRole("button", { name: /ask|suggest|send/i }));

    const confirmBtn = await screen.findByRole("button", { name: /confirm|apply goal/i });
    expect(confirmBtn).toBeVisible();
    expect(
      screen.getByText(/Suggested a lower berth goal for your senior traveller/i)
    ).toBeInTheDocument();

    // Critical invariant: proposal arrival must NOT auto-submit PutGoalRequest
    expect(onApplyGoal).not.toHaveBeenCalled();

    await user.click(confirmBtn);
    await waitFor(() => expect(onApplyGoal).toHaveBeenCalledTimes(1));
    expect(onApplyGoal).toHaveBeenCalledWith({
      goal_type: "lower",
      movers: [MEMBERS[0]!.id],
      preferred_seats: [],
      constraints: {
        women_only: false,
        no_middle: false,
        same_coach_only: true,
        verified_only: false,
      },
    });
    expect(await runAxe(container)).toHaveNoViolations();
  });

  it("renders inline alert on 429 rate limit and renders Hindi locale cleanly", async () => {
    const user = userEvent.setup();
    const onApplyGoal = vi.fn(async () => {});
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: 429,
            code: "rate_limited",
            title: "Daily AI Limit Reached",
            detail: "Limit reached",
          }),
          { status: 429, headers: { "content-type": "application/problem+json" } }
        )
    );

    const { container } = render(
      <NextIntlClientProvider locale="hi" messages={hiMessages}>
        <AuthProvider>
          <main>
            <ConciergePanel
              journeyId="0193632e-0000-7000-8000-000000000010"
              members={MEMBERS}
              onApplyGoal={onApplyGoal}
              fetchImpl={fetchMock as unknown as typeof globalThis.fetch}
            />
          </main>
        </AuthProvider>
      </NextIntlClientProvider>
    );

    expect(screen.getByText("AI स्वैप सहायक")).toBeInTheDocument();
    const input = screen.getByRole("textbox", { name: /सहायक/i });
    await user.type(input, "निचली बर्थ चाहिए");
    await user.click(screen.getByRole("button", { name: /सुझाव लें/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/[\u0900-\u097F]/);
    expect(alert.textContent).toContain("20");
    expect(alert.textContent).not.toMatch(/[०-९]/);
    expect(await runAxe(container)).toHaveNoViolations();
  });
});
