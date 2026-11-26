import "@testing-library/jest-dom/vitest";
import { expect } from "vitest";
import axe, { type AxeResults } from "axe-core";

if (typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as typeof HTMLCanvasElement.prototype.getContext;
}

declare module "vitest" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Assertion<T = any> {
    toHaveNoViolations(): T;
  }
}

expect.extend({
  toHaveNoViolations(received: AxeResults) {
    const violations = received.violations ?? [];
    if (violations.length === 0) {
      return {
        pass: true,
        message: () => "Expected accessibility violations, but found none.",
      };
    }
    const details = violations
      .map(
        (v) =>
          `[${v.id}] (${v.impact ?? "unknown"}) ${v.help} — ${v.helpUrl}\n` +
          v.nodes.map((n) => `  • ${n.target.join(" ")}`).join("\n")
      )
      .join("\n\n");
    return {
      pass: false,
      message: () => `Found ${violations.length} axe violations:\n\n${details}`,
    };
  },
});

export async function runAxe(container: Element): Promise<AxeResults> {
  return axe.run(container, {
    rules: {
      "color-contrast": { enabled: false },
    },
  });
}
