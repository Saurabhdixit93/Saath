import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function srgbChannelToLinear(channel255: number): number {
  const c = channel255 / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number {
  const normalized = hex.replace("#", "").trim();
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  return (
    0.2126 * srgbChannelToLinear(r) +
    0.7152 * srgbChannelToLinear(g) +
    0.0722 * srgbChannelToLinear(b)
  );
}

function contrastRatio(hexA: string, hexB: string): number {
  const l1 = relativeLuminance(hexA);
  const l2 = relativeLuminance(hexB);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function extractVars(block: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const regex = /(--[a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{6})\s*;/g;
  for (const match of block.matchAll(regex)) {
    if (match[1] && match[2]) {
      vars[match[1]] = match[2].toUpperCase();
    }
  }
  return vars;
}

describe("tokens.css WCAG 2.2 AA contrast ratios", () => {
  const css = fs.readFileSync(path.resolve(__dirname, "../src/tokens.css"), "utf8");
  const lightMatch = css.match(/:root\s*\{([\s\S]*?)\n\}/);
  const darkMatch = css.match(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/);
  const mediaDarkMatch = css.match(
    /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([\s\S]*?)\n\s*\}\s*\}/
  );

  it("defines both light and explicit data-theme dark blocks", () => {
    expect(lightMatch).not.toBeNull();
    expect(darkMatch).not.toBeNull();
    expect(mediaDarkMatch).not.toBeNull();
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("satisfies >= 4.5:1 WCAG AA contrast for all light mode pairs and SeatLegendBadge", () => {
    const light = extractVars(lightMatch?.[1] ?? "");
    const pairs: Array<[string, string]> = [
      [light["--text"]!, light["--bg"]!],
      [light["--text"]!, light["--surface"]!],
      [light["--text"]!, light["--surface-2"]!],
      [light["--text-muted"]!, light["--bg"]!],
      [light["--text-muted"]!, light["--surface"]!],
      [light["--text-muted"]!, light["--surface-2"]!],
      [light["--primary-text"]!, light["--bg"]!],
      [light["--primary-text"]!, light["--surface"]!],
      [light["--danger-text"]!, light["--bg"]!],
      [light["--danger-text"]!, light["--surface"]!],
      [light["--primary-ink"]!, light["--primary-btn-bg"]!],
      [light["--secondary-ink"]!, light["--secondary"]!],
      [light["--success-ink"]!, light["--success-btn-bg"]!],
      [light["--warning-ink"]!, light["--warning"]!],
      [light["--danger-ink"]!, light["--danger"]!],
      [light["--women-mode-ink"]!, light["--women-mode"]!],
      // SeatLegendBadge pairs (text >= 4.5:1)
      [light["--secondary-ink"]!, light["--seat-match"]!],
      [light["--warning-ink"]!, light["--seat-request"]!],
      [light["--text"]!, light["--seat-empty"]!],
      [light["--women-mode-ink"]!, light["--women-mode"]!],
    ];

    for (const [fg, bg] of pairs) {
      expect(fg).toMatch(/^#[0-9A-F]{6}$/);
      expect(bg).toMatch(/^#[0-9A-F]{6}$/);
      expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
    }

    // Graphical seat-mine symbol (>= 3.0:1 non-text WCAG AA)
    expect(contrastRatio(light["--primary-ink"]!, light["--seat-mine"]!)).toBeGreaterThanOrEqual(
      3.0
    );
  });

  it("satisfies >= 4.5:1 WCAG AA contrast for all dark mode pairs and SeatLegendBadge", () => {
    const light = extractVars(lightMatch?.[1] ?? "");
    const dark = { ...light, ...extractVars(darkMatch?.[1] ?? "") };
    const mediaDark = { ...light, ...extractVars(mediaDarkMatch?.[1] ?? "") };
    expect(dark).toEqual(mediaDark);

    const pairs: Array<[string, string]> = [
      [dark["--text"]!, dark["--bg"]!],
      [dark["--text"]!, dark["--surface"]!],
      [dark["--text"]!, dark["--surface-2"]!],
      [dark["--text-muted"]!, dark["--bg"]!],
      [dark["--text-muted"]!, dark["--surface"]!],
      [dark["--primary-text"]!, dark["--bg"]!],
      [dark["--danger-text"]!, dark["--bg"]!],
      [dark["--danger-text"]!, dark["--surface"]!],
      [dark["--primary-ink"]!, dark["--primary-btn-bg"]!],
      [dark["--secondary-ink"]!, dark["--secondary"]!],
      [dark["--success-ink"]!, dark["--success-btn-bg"]!],
      [dark["--warning-ink"]!, dark["--warning"]!],
      [dark["--danger-ink"]!, dark["--danger"]!],
      [dark["--women-mode-ink"]!, dark["--women-mode"]!],
      // SeatLegendBadge pairs in dark mode
      [dark["--primary-ink"]!, dark["--seat-mine"]!],
      [dark["--secondary-ink"]!, dark["--seat-match"]!],
      [dark["--warning-ink"]!, dark["--seat-request"]!],
      [dark["--text"]!, dark["--seat-empty"]!],
      [dark["--women-mode-ink"]!, dark["--women-mode"]!],
    ];

    for (const [fg, bg] of pairs) {
      expect(fg).toMatch(/^#[0-9A-F]{6}$/);
      expect(bg).toMatch(/^#[0-9A-F]{6}$/);
      expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
