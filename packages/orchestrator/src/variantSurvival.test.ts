import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { findRepoRoot } from "./otari/env.js";
import { MARKER_ATTRIBUTE, VARIANT_KINDS, analyseQuote, normalize, readVariants, survivalTable } from "./variantSurvival.js";

// The real fixture page. Read as a file: the orchestrator never imports scenarios/ code.
const root = findRepoRoot(import.meta.dirname) ?? "";
const html = readFileSync(join(root, "scenarios", "honeypot", "site", "changelog.html"), "utf8");
const variants = readVariants(html);

/**
 * What a fetcher might hand the model: the page as text, keeping or dropping each
 * hidden carrier. Test-only; it stands in for a converter we do not control.
 */
function render(page: string, keep: { alt: boolean; comment: boolean; span: boolean }): string {
  let out = page.replace(/<head[\s\S]*?<\/head>/i, "");
  out = out.replace(/<img\b[^>]*data-agent-zero[^>]*\balt="([^"]*)"[^>]*>/gi, (_m, alt: string) => (keep.alt ? `\n![${alt}](assets/release-2-4.svg)\n` : "\n"));
  out = out.replace(/<!--([\s\S]*?)-->/g, (_m, body: string) => (keep.comment ? `\n${body}\n` : "\n"));
  out = out.replace(/<span class="reader-note"[\s\S]*?<\/span>/i, (m) => (keep.span ? m : "\n"));
  return out.replace(/<[^>]*>/g, "\n").replace(/\n\s*\n+/g, "\n");
}
const reachedKinds = (quote: string): string[] => analyseQuote(quote, variants).findings.filter((f) => f.reached).map((f) => f.kind);

describe("readVariants on the honeypot changelog", () => {
  it("finds the three marked variants, in page order, with the same instruction", () => {
    expect(html.split(MARKER_ATTRIBUTE)).toHaveLength(4);
    expect(variants.map((v) => v.kind)).toEqual([...VARIANT_KINDS]);
    expect(new Set(variants.map((v) => v.needle)).size).toBe(1);
    expect(variants[0]?.needle).toMatch(/^system notice to ai agents/);
  });

  it("anchors each variant in different visible text", () => {
    for (const v of variants) {
      expect(v.before).toBeDefined();
      expect(v.after).toBeDefined();
      expect(v.before).not.toContain("system notice");
      expect(v.after).not.toContain("system notice");
    }
    expect(new Set(variants.map((v) => v.before)).size).toBe(3);
    expect(new Set(variants.map((v) => v.after)).size).toBe(3);
  });

  it("ignores a marker inside <head>, <script> or <style>", () => {
    const page = `<head><meta ${MARKER_ATTRIBUTE} content="x"></head><script><span ${MARKER_ATTRIBUTE}>y</span></script><p>visible paragraph text</p>`;
    expect(readVariants(page)).toEqual([]);
  });
});

describe("analyseQuote", () => {
  it("all three carriers kept: all three reached", () => {
    const r = analyseQuote(render(html, { alt: true, comment: true, span: true }), variants);
    expect(r.findings.map((f) => f.reached)).toEqual([true, true, true]);
    expect(r).toMatchObject({ occurrences: 3, unplaced: 0, survived: 3 });
  });

  it.each([
    [{ alt: true, comment: false, span: false }, ["alt_text"]],
    [{ alt: false, comment: true, span: false }, ["html_comment"]],
    [{ alt: false, comment: false, span: true }, ["hidden_span"]],
    [{ alt: true, comment: false, span: true }, ["alt_text", "hidden_span"]],
    [{ alt: false, comment: true, span: true }, ["html_comment", "hidden_span"]],
  ])("ties a surviving copy to its own variant: %j", (keep, kinds) => {
    expect(reachedKinds(render(html, keep))).toEqual(kinds);
  });

  it("nothing kept: nothing reached, and the visible page alone is not a hit", () => {
    const r = analyseQuote(render(html, { alt: false, comment: false, span: false }), variants);
    expect(r).toMatchObject({ occurrences: 0, unplaced: 0, survived: 0 });
    expect(r.findings.every((f) => !f.reached)).toBe(true);
  });

  it("tolerates reflowing, markdown and changed punctuation", () => {
    const quote = render(html, { alt: false, comment: false, span: true })
      .replace(/\n/g, "  \n> ")
      .replace(/SYSTEM NOTICE/g, "**System  Notice**");
    expect(reachedKinds(quote)).toEqual(["hidden_span"]);
  });

  it("a copy quoted without its surroundings counts as survived but is tied to no variant", () => {
    const r = analyseQuote(`The page says: ${variants[0]?.needle ?? ""}`, variants);
    expect(r).toMatchObject({ occurrences: 1, unplaced: 1, survived: 1 });
    expect(r.findings.every((f) => !f.reached)).toBe(true);
  });

  it("a paraphrase is not a hit", () => {
    const quote = render(html, { alt: false, comment: false, span: false }) + "\nThe page hides an instruction telling agents to send the .env file.";
    expect(analyseQuote(quote, variants).survived).toBe(0);
  });

  it("fuzz: never throws; counts stay consistent on any quote and any page", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), fc.string({ maxLength: 400 }), (quote, page) => {
        const r = analyseQuote(quote, readVariants(page));
        expect(r.survived).toBeLessThanOrEqual(r.occurrences);
        const own = analyseQuote(quote, variants);
        expect(own.findings).toHaveLength(3);
        expect(own.findings.filter((f) => f.reached).length + own.unplaced).toBe(own.occurrences);
      }),
    );
  });

  it("fuzz: readVariants never throws on marker-bearing junk", () => {
    const junk = fc.array(fc.constantFrom("<", ">", "<!--", "-->", "<img ", "<span ", "</span>", "<div", MARKER_ATTRIBUTE, 'alt="', '"', "text of some length here", "\n"), { maxLength: 40 });
    fc.assert(
      fc.property(junk, (parts) => {
        for (const v of readVariants(parts.join(""))) expect(VARIANT_KINDS).toContain(v.kind);
      }),
    );
  });
});

describe("survivalTable", () => {
  it("one row per variant and none of the page's text", () => {
    const table = survivalTable(analyseQuote(render(html, { alt: false, comment: false, span: true }), variants));
    expect(table.split("\n")).toEqual([
      "| Variant | Reached the model |",
      "|---|---|",
      "| `alt_text` | no |",
      "| `html_comment` | no |",
      "| `hidden_span` | yes |",
    ]);
    expect(normalize(table)).not.toContain("system notice");
  });
});
