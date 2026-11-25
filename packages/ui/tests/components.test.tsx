import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  BottomSheet,
  Button,
  EmptyState,
  LanguageSwitcher,
  SaathLogo,
  SeatLegendBadge,
  ThemeToggle,
  Toast,
  ToastProvider,
  useToast,
} from "../src";
import { runAxe } from "../vitest.setup";

function ToastHarness() {
  const { showToast } = useToast();
  return (
    <Button onClick={() => showToast({ variant: "success", message: "Saved preferences" })}>
      Trigger Toast
    </Button>
  );
}

describe("@saath/ui components & accessibility", () => {
  it("renders SaathLogo, Button, EmptyState, and SeatLegendBadge with zero axe violations", async () => {
    const { container } = render(
      <main>
        <SaathLogo subtitle="Sit together. Safely." />
        <Button variant="primary">Verify PNR</Button>
        <Button variant="secondary" loading>
          Checking
        </Button>
        <EmptyState
          title="No matches yet"
          description="Invite your coach mates on WhatsApp."
          primaryAction={<Button variant="primary">Invite coach</Button>}
        />
        <SeatLegendBadge kind="mine" label="Your berth" />
        <SeatLegendBadge kind="match" label="Good match" />
        <SeatLegendBadge kind="women" label="Women-only" />
      </main>
    );

    expect(screen.getByText("Saath")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Checking" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Your berth")).toBeInTheDocument();
    expect(await runAxe(container)).toHaveNoViolations();
  });

  it("toggles language and theme cleanly", async () => {
    const user = userEvent.setup();
    const onLocale = vi.fn();

    function ThemeHarness() {
      const [theme, setTheme] = useState<"light" | "dark">("light");
      return (
        <ThemeToggle
          theme={theme}
          onToggle={() => {
            const next = theme === "light" ? "dark" : "light";
            document.documentElement.dataset.theme = next;
            setTheme(next);
          }}
        />
      );
    }

    const { container } = render(
      <div>
        <LanguageSwitcher locale="en" onToggle={onLocale} />
        <ThemeHarness />
      </div>
    );

    await user.click(screen.getByRole("button", { name: "हिंदी में बदलें" }));
    expect(onLocale).toHaveBeenCalledWith("hi");

    const themeBtn = screen.getByRole("button", { name: "Switch to dark theme" });
    await user.click(themeBtn);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(screen.getByRole("button", { name: "Switch to light theme" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(await runAxe(container)).toHaveNoViolations();
  });

  it("handles BottomSheet Escape, backdrop close, and focus restoration with zero axe violations", async () => {
    const user = userEvent.setup();

    function SheetHarness() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <Button onClick={() => setOpen(true)}>Open sheet</Button>
          <BottomSheet
            open={open}
            onClose={() => setOpen(false)}
            title="Verify phone"
            description="We only use this for swap alerts."
          >
            <Button onClick={() => setOpen(false)}>Confirm</Button>
          </BottomSheet>
        </div>
      );
    }

    const { container } = render(<SheetHarness />);
    const trigger = screen.getByRole("button", { name: "Open sheet" });
    await user.click(trigger);

    expect(screen.getByRole("dialog", { name: "Verify phone" })).toBeInTheDocument();
    expect(await runAxe(container)).toHaveNoViolations();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    await user.click(screen.getByTestId("bottom-sheet-backdrop"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders Toast and ToastProvider cleanly", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ToastProvider>
        <ToastHarness />
        <Toast variant="error" message="Something went wrong" onDismiss={() => {}} duration={0} />
      </ToastProvider>
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong");
    await user.click(screen.getByRole("button", { name: "Trigger Toast" }));
    expect(screen.getByRole("status")).toHaveTextContent("Saved preferences");
    expect(await runAxe(container)).toHaveNoViolations();
  });
});
