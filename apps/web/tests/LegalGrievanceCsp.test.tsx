import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@saath/ui";
import enMessages from "../messages/en.json";
import hiMessages from "../messages/hi.json";
import GrievancePage from "../src/app/[locale]/grievance/page";
import PrivacyPolicyPage from "../src/app/[locale]/legal/privacy/page";
import TermsOfUsePage from "../src/app/[locale]/legal/terms/page";
import { AppFooter } from "../src/components/AppFooter";
import { buildCspHeader, generateCspNonce } from "../src/lib/csp";
import middleware from "../src/middleware";
import { runAxe } from "../vitest.setup";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
}));

function lookupKey(obj: Record<string, unknown>, path: string): string {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur && typeof cur === "object" && part in cur) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return path;
    }
  }
  return typeof cur === "string" ? cur : path;
}

vi.mock("next-intl/server", () => ({
  setRequestLocale: vi.fn(),
  getTranslations: vi.fn(
    async ({ locale, namespace }: { locale: string; namespace: string }) => {
      const messages = (locale === "hi" ? hiMessages : enMessages) as Record<string, unknown>;
      return (key: string, values?: Record<string, string | number>) => {
        let str = lookupKey(messages, namespace ? `${namespace}.${key}` : key);
        if (values) {
          for (const [k, v] of Object.entries(values)) {
            str = str.replaceAll(`{${k}}`, String(v));
          }
        }
        return str;
      };
    }
  ),
}));

describe("Bilingual Legal Pages, Grievance Officer, Footer & Nonce CSP", () => {
  it("contains zero Devanagari digits in hi.json", () => {
    expect(JSON.stringify(hiMessages)).not.toMatch(/[०-९]/);
  });

  it("renders AppFooter with legal links and disclaimer in en & hi with zero axe violations", async () => {
    const { container, rerender } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AppFooter />
      </NextIntlClientProvider>
    );
    expect(screen.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute(
      "href",
      "/legal/privacy"
    );
    expect(screen.getByRole("link", { name: "Terms of Use" })).toHaveAttribute(
      "href",
      "/legal/terms"
    );
    expect(screen.getByRole("link", { name: "Grievance Officer" })).toHaveAttribute(
      "href",
      "/grievance"
    );
    expect(await runAxe(container)).toHaveNoViolations();

    rerender(
      <NextIntlClientProvider locale="hi" messages={hiMessages}>
        <AppFooter />
      </NextIntlClientProvider>
    );
    expect(container.textContent).not.toMatch(/[०-९]/);
    expect(await runAxe(container)).toHaveNoViolations();
  });

  it("renders bilingual Privacy Policy page with 5 DPDP purposes, 6 processors, retention & zero axe violations", async () => {
    for (const locale of ["en", "hi"] as const) {
      const messages = locale === "hi" ? hiMessages : enMessages;
      const pageEl = await PrivacyPolicyPage({
        params: Promise.resolve({ locale }),
      });
      const { container, unmount } = render(
        <NextIntlClientProvider locale={locale} messages={messages}>
          <main>{pageEl}</main>
        </NextIntlClientProvider>
      );

      const text = container.textContent ?? "";
      expect(text).toMatch(/verification/i);
      expect(text).toMatch(/matching/i);
      expect(text).toMatch(/notifications/i);
      expect(text).toMatch(/analytics/i);
      expect(text).toMatch(/whatsapp/i);
      expect(text).toMatch(/Cloudflare/);
      expect(text).toMatch(/Railway/);
      expect(text).toMatch(/PostHog/);
      expect(text).toMatch(/MSG91/);
      expect(text).toMatch(/Meta/);
      expect(text).toMatch(/Anthropic/);
      expect(text).toContain("[TO BE CONFIRMED BY COUNSEL]");
      if (locale === "hi") {
        expect(text).not.toMatch(/[०-९]/);
      }
      expect(await runAxe(container)).toHaveNoViolations();
      unmount();
    }
  });

  it("renders bilingual Terms of Use page with 18+, TTE, non-IRCTC, ₹0 rules & zero axe violations", async () => {
    for (const locale of ["en", "hi"] as const) {
      const messages = locale === "hi" ? hiMessages : enMessages;
      const pageEl = await TermsOfUsePage({
        params: Promise.resolve({ locale }),
      });
      const { container, unmount } = render(
        <NextIntlClientProvider locale={locale} messages={messages}>
          <main>{pageEl}</main>
        </NextIntlClientProvider>
      );

      const text = container.textContent ?? "";
      expect(text).toMatch(/18/);
      expect(text).toMatch(/TTE/i);
      expect(text).toMatch(/IRCTC/i);
      expect(text).toMatch(/₹0/);
      expect(text).toContain("[TO BE CONFIRMED BY COUNSEL]");
      if (locale === "hi") {
        expect(text).not.toMatch(/[०-९]/);
      }
      expect(await runAxe(container)).toHaveNoViolations();
      unmount();
    }
  });

  it("renders bilingual Grievance Officer page and interactive GrievanceForm", async () => {
    const writeTextMock = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: writeTextMock },
    });

    const user = userEvent.setup();
    const pageEl = await GrievancePage({
      params: Promise.resolve({ locale: "en" }),
    });
    const { container, unmount } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ToastProvider>
          <main>{pageEl}</main>
        </ToastProvider>
      </NextIntlClientProvider>
    );

    const text = container.textContent ?? "";
    expect(text).toMatch(/Grievance Officer/i);
    expect(text).toContain("grievance@saath.example");
    expect(text).toMatch(/48 hours/i);
    expect(text).toContain("[TO BE CONFIRMED BY COUNSEL]");

    await user.click(screen.getByRole("button", { name: "Generate Grievance Reference" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/enter both a subject and details/i);

    await user.type(screen.getByLabelText("Subject"), "Consent withdrawal query");
    await user.type(
      screen.getByLabelText(/Details/i),
      "Please confirm analytics consent withdrawal status."
    );
    await user.click(screen.getByRole("button", { name: "Generate Grievance Reference" }));

    expect(await screen.findByText(/Grievance reference ready: SAATH-GRV-/i)).toBeInTheDocument();
    const mailtoLink = screen.getByRole("link", { name: "Open Email Draft" });
    expect(mailtoLink).toHaveAttribute("href", expect.stringContaining("mailto:grievance@saath.example"));

    await user.click(screen.getByRole("button", { name: "Copy Grievance Summary" }));
    await waitFor(() => expect(writeTextMock).toHaveBeenCalledTimes(1));

    expect(await runAxe(container)).toHaveNoViolations();
    unmount();

    const hiPageEl = await GrievancePage({
      params: Promise.resolve({ locale: "hi" }),
    });
    const hiRender = render(
      <NextIntlClientProvider locale="hi" messages={hiMessages}>
        <ToastProvider>
          <main>{hiPageEl}</main>
        </ToastProvider>
      </NextIntlClientProvider>
    );
    expect(hiRender.container.textContent).not.toMatch(/[०-९]/);
    expect(await runAxe(hiRender.container)).toHaveNoViolations();
    hiRender.unmount();
  });

  it("builds strict nonce CSP without script-src unsafe-inline and applies it in middleware", () => {
    const nonce = generateCspNonce();
    expect(nonce.length).toBeGreaterThan(10);

    const prodHttpCsp = buildCspHeader({
      nonce,
      apiUrl: "http://localhost:8000",
      wsUrl: "ws://localhost:8000/v1/ws",
      appUrl: "http://localhost:3000",
      isDev: false,
    });
    expect(prodHttpCsp).toContain(`'nonce-${nonce}'`);
    expect(prodHttpCsp).toContain("'wasm-unsafe-eval'");
    expect(prodHttpCsp).toContain("worker-src 'self' blob:");
    expect(prodHttpCsp).not.toContain("upgrade-insecure-requests");
    const prodScriptSrc = /script-src[^;]*/.exec(prodHttpCsp)?.[0] ?? "";
    expect(prodScriptSrc).not.toContain("'unsafe-inline'");
    expect(prodScriptSrc).not.toContain("'unsafe-eval'");

    const prodHttpsCsp = buildCspHeader({
      nonce,
      apiUrl: "https://api.saath.app",
      wsUrl: "wss://api.saath.app/v1/ws",
      appUrl: "https://saath.app",
      isDev: false,
    });
    expect(prodHttpsCsp).toContain("upgrade-insecure-requests");

    const req = new NextRequest("http://localhost:3000/");
    const res = middleware(req);
    const cspHeader = res.headers.get("Content-Security-Policy") ?? "";
    expect(cspHeader).toContain("nonce-");
    const mwScriptSrc = /script-src[^;]*/i.exec(cspHeader)?.[0] ?? "";
    expect(mwScriptSrc).not.toContain("'unsafe-inline'");
    expect(res.headers.get("x-middleware-request-x-nonce")).toBeTruthy();
    expect(res.headers.get("x-middleware-request-content-security-policy")).toBe(cspHeader);
    expect(res.headers.get("x-middleware-override-headers")).toContain("x-nonce");
    expect(res.headers.get("x-middleware-override-headers")).toContain("content-security-policy");

    const redirectReq = new NextRequest("http://localhost:3000/en");
    const redirectRes = middleware(redirectReq);
    expect(redirectRes.headers.get("Content-Security-Policy")).toContain("nonce-");
  });
});
