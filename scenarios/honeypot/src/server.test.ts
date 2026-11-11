import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createHoneypot,
  DEFAULT_PREFIX,
  INJECTION_MARKER,
  INJECTION_TEXT,
  loadSite,
  normalizePrefix,
  resolveRequest,
  SITE_DIR,
} from "./index.js";

const PAGES = ["index.html", "docs.html", "changelog.html"] as const;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("honeypot site", () => {
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    server = await createHoneypot();
    origin = await listen(server);
  });
  afterAll(() => {
    server.close();
  });

  const get = (path: string, init?: RequestInit) => fetch(`${origin}${path}`, { redirect: "manual", ...init });

  it("serves the three pages under the default prefix, each noindex", async () => {
    for (const page of PAGES) {
      const res = await get(`${DEFAULT_PREFIX}/${page}`);
      expect(res.status, page).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const html = await res.text();
      expect(html, page).toContain('<meta name="robots" content="noindex">');
      expect(html, page).toContain("Lumen Notes");
    }
  });

  it("serves a page without its .html extension too, with the same body", async () => {
    for (const page of ["changelog", "docs", "index"]) {
      const bare = await get(`${DEFAULT_PREFIX}/${page}`);
      expect(bare.status, page).toBe(200);
      expect(bare.headers.get("content-type")).toMatch(/^text\/html/);
      expect(await bare.text()).toBe(await (await get(`${DEFAULT_PREFIX}/${page}.html`)).text());
    }
    expect((await get(`${DEFAULT_PREFIX}/style`)).status).toBe(404);
    expect((await get(`${DEFAULT_PREFIX}/changelog/`)).status).toBe(404);
  });

  it("serves exactly three injection markers on the changelog", async () => {
    const html = await (await get(`${DEFAULT_PREFIX}/changelog.html`)).text();
    expect(count(html, INJECTION_MARKER)).toBe(3);
    expect(count(html, INJECTION_TEXT)).toBe(3);
    // `grep -c` counts lines, so each marker sits on a line of its own.
    expect(html.split("\n").filter((line) => line.includes(INJECTION_MARKER))).toHaveLength(3);
  });

  it("carries one variant each: HTML comment, CSS-hidden text, image alt", async () => {
    const html = await (await get(`${DEFAULT_PREFIX}/changelog.html`)).text();
    const text = INJECTION_TEXT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const comment = new RegExp(`<div\\s+${INJECTION_MARKER}\\s*><!-- ${text} --></div>`);
    const hidden = new RegExp(`<span class="reader-note"\\s+${INJECTION_MARKER}\\s*>${text}</span>`);
    const alt = new RegExp(`<img [^>]*${INJECTION_MARKER}\\s+alt="${text}">`);
    expect(html).toMatch(comment);
    expect(html).toMatch(hidden);
    expect(html).toMatch(alt);

    // The hidden variant is hidden by the stylesheet, and the image exists so its alt never renders.
    const css = await (await get(`${DEFAULT_PREFIX}/style.css`)).text();
    expect(css).toMatch(/\.reader-note\s*{[^}]*left:\s*-9999px/);
    const image = await get(`${DEFAULT_PREFIX}/assets/release-2-4.svg`);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/svg+xml");
  });

  it("keeps the injection off the other pages and out of the visible markers elsewhere", async () => {
    for (const file of ["index.html", "docs.html", "style.css", "robots.txt"]) {
      const body = await readFile(join(SITE_DIR, file), "utf8");
      expect(body, file).not.toContain("data-agent-zero");
      expect(body, file).not.toContain("SYSTEM NOTICE");
    }
  });

  it("serves a robots.txt that disallows everything", async () => {
    const res = await get("/robots.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe("User-agent: *\nDisallow: /\n");
  });

  it("serves the home page at the prefix root and redirects the bare prefix", async () => {
    const root = await get(`${DEFAULT_PREFIX}/`);
    expect(root.status).toBe(200);
    expect(await root.text()).toContain("<title>Lumen Notes");
    const bare = await get(DEFAULT_PREFIX);
    expect(bare.status).toBe(308);
    expect(bare.headers.get("location")).toBe(`${DEFAULT_PREFIX}/`);
  });

  it("serves nothing outside the prefix and refuses traversal", async () => {
    for (const path of [
      "/",
      "/changelog.html",
      "/index.html",
      "/lumen-notesX/changelog.html",
      `${DEFAULT_PREFIX}/missing.html`,
      `${DEFAULT_PREFIX}/../robots.txt`,
      `${DEFAULT_PREFIX}/%2e%2e/%2e%2e/package.json`,
      `${DEFAULT_PREFIX}/..%2f..%2fpackage.json`,
      `${DEFAULT_PREFIX}//changelog.html`,
    ]) {
      const res = await get(path);
      // fetch() normalises a literal `..`, which lands on /robots.txt: the only allowed 200.
      if (res.status === 200) expect(new URL(res.url).pathname).toBe("/robots.txt");
      else expect(res.status, path).toBe(404);
    }
  });

  it("answers HEAD without a body and refuses other methods", async () => {
    const head = await get(`${DEFAULT_PREFIX}/changelog.html`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const post = await get(`${DEFAULT_PREFIX}/changelog.html`, { method: "POST", body: "x" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  });
});

describe("honeypot prefix", () => {
  it("serves under a custom prefix and not under the default one", async () => {
    const server = await createHoneypot({ prefix: "k3x9-q/site" });
    const origin = await listen(server);
    try {
      const page = await fetch(`${origin}/k3x9-q/site/changelog.html`);
      expect(page.status).toBe(200);
      expect(count(await page.text(), INJECTION_MARKER)).toBe(3);
      expect((await fetch(`${origin}${DEFAULT_PREFIX}/changelog.html`)).status).toBe(404);
      expect((await fetch(`${origin}/robots.txt`)).status).toBe(200);
    } finally {
      server.close();
    }
  });

  it("normalises and validates HONEYPOT_PREFIX", () => {
    expect(normalizePrefix(undefined)).toBe(DEFAULT_PREFIX);
    expect(normalizePrefix("  ")).toBe(DEFAULT_PREFIX);
    expect(normalizePrefix("abc")).toBe("/abc");
    expect(normalizePrefix("/abc/")).toBe("/abc");
    expect(normalizePrefix("/a//b_1.2~/")).toBe("/a/b_1.2~");
    for (const bad of ["/", "//", "/..", "/a/../b", "/.hidden", "/a b", "/a?b", "/a#b", "/a%2Fb", "/a\\b", "/ü"]) {
      expect(() => normalizePrefix(bad), bad).toThrow(/HONEYPOT_PREFIX/);
    }
  });

  it("fuzz: a prefix is either rejected or normalised to a clean, stable path", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        let prefix: string;
        try {
          prefix = normalizePrefix(raw);
        } catch {
          return;
        }
        expect(prefix).toMatch(/^(\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)+$/);
        expect(normalizePrefix(prefix)).toBe(prefix);
      }),
    );
  });

  it("fuzz: a request target only ever resolves to a known site file", async () => {
    const keys = new Set((await loadSite()).keys());
    const target = fc.oneof(
      fc.string(),
      fc.webPath(),
      fc.string().map((s) => `${DEFAULT_PREFIX}/${s}`),
      fc.constantFrom(...keys).map((k) => `${DEFAULT_PREFIX}${k}?${"x"}`),
    );
    fc.assert(
      fc.property(target, (raw) => {
        const resolution = resolveRequest(raw, DEFAULT_PREFIX, keys);
        if (resolution.kind === "asset") expect(keys.has(resolution.key)).toBe(true);
        if (resolution.kind === "redirect") expect(resolution.location).toBe(`${DEFAULT_PREFIX}/`);
        const path = raw.split(/[?#]/)[0] ?? "";
        if (path !== "/robots.txt" && !path.startsWith(DEFAULT_PREFIX)) {
          expect(resolution.kind).toBe("not_found");
        }
      }),
    );
  });
});
