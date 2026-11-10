// Repo hygiene: ignores, env example, secret scanning.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const inGit = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: ROOT }).status === 0;
const hasGitleaks = spawnSync("gitleaks", ["version"]).status === 0;

describe.skipIf(!inGit)(".gitignore", () => {
  const ignored = (...paths: string[]) => {
    const r = spawnSync("git", ["check-ignore", ...paths], { cwd: ROOT, encoding: "utf8" });
    return r.stdout.split("\n").filter(Boolean);
  };

  it("ignores secrets, runs, vendor and the private notes", () => {
    const paths = [
      ".env", ".env.local", "runs/x", "vendor/otari",
      "docs/VERSIONS.md", "docs/DEVIATIONS.md", "docs/FAILURES.md", "docs/IDEAS.md", "docs/LOG.md",
    ];
    expect(ignored(...paths)).toEqual(paths);
  });

  it("keeps golden runs, the env example and the FAKE mission .env", () => {
    // docs/ is ignored as a whole until the submission review; not asserted either way.
    expect(ignored("runs/golden/x", ".env.example", "scenarios/mission/.env")).toEqual([]);
  });
});

describe(".env.example", () => {
  it("lists exactly the expected keys, with no values except the defaults", () => {
    const lines = readFileSync(join(ROOT, ".env.example"), "utf8")
      .split("\n")
      .filter((l) => l && !l.startsWith("#"));
    const env = Object.fromEntries(lines.map((l) => l.split(/=(.*)/s).slice(0, 2)));
    expect(env).toEqual({
      OTARI_BASE_URL: `https://${["eu", "api", "otari", "ai"].join(".")}/api/v1`,
      OTARI_API_KEY_AGENT: "",
      OTARI_API_KEY_JUDGE: "",
      OTARI_API_KEY_REPORT: "",
      OTARI_API_KEY_CAPPED: "",
      OTARI_API_KEY_SERVICE: "",
      MODEL_PROFILE: "dev",
      TUNNEL_TOKEN: "",
      HONEYPOT_PUBLIC_URL: "",
      COLLECTOR_PUBLIC_URL: "",
      COLLECTOR_BEARER: "",
      COLLECTOR_MCP_SERVER_ID: "",
      HONEYPOT_PREFIX: "/lumen-notes",
    });
  });
});

describe.skipIf(!hasGitleaks)("gitleaks config (.gitleaks.toml)", () => {
  const scan = (content: string, file = "dummy.txt") => {
    const dir = mkdtempSync(join(tmpdir(), "rp-leaks-"));
    try {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), content);
      return spawnSync(
        "gitleaks",
        ["dir", dir, "--config", join(ROOT, ".gitleaks.toml"), "--no-banner", "--redact", "--exit-code", "1"],
        { encoding: "utf8" },
      ).status;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  // Key-shaped strings are assembled at runtime so this file passes the hook itself.
  const tk = (rest: string) => ["tk", rest].join("-");
  const gw = (rest: string) => ["gw", rest].join("_");
  const otk = (rest: string) => ["otk", "v1", "eu", rest].join("_");

  it("flags Otari-style keys", () => {
    expect(scan(`OTARI_API_KEY_AGENT=${tk("abcdef")}\n`)).toBe(1);
    expect(scan(`key: ${gw("abcdef123456")}\n`)).toBe(1);
    expect(scan(`OTARI_API_KEY_AGENT=${otk("UyghdHKabcdefGfMM")}\n`)).toBe(1);
  });

  it("allows the dummy key only inside docs/rogueproof-plan.md", () => {
    expect(scan(`a dummy file containing \`${tk("abcdef")}\`\n`, "docs/rogueproof-plan.md")).toBe(0);
    expect(scan(`a dummy file containing \`${tk("abcdef")}\`\n`, "docs/other.md")).toBe(1);
    expect(scan(`${tk("abcdef0123")}\n`, "docs/rogueproof-plan.md")).toBe(1);
  });

  it("lets FAKE fixture values and plain prose through", () => {
    expect(scan(`OTARI_API_KEY_AGENT=${tk("FAKE-fixture-0001")}\n`)).toBe(0);
    expect(scan("assert the log contains no `tk-` or `gw_` prefixed strings\n")).toBe(0);
    expect(scan("keys look like otk_v1_eu_... and are shown once\n")).toBe(0);
  });
});

describe("pre-commit hook", () => {
  it("is executable and runs gitleaks on staged changes", () => {
    const hook = join(ROOT, ".githooks", "pre-commit");
    expect(readFileSync(hook, "utf8")).toMatch(/gitleaks git --pre-commit --staged/);
    expect(execFileSync("sh", ["-c", `test -x "${hook}" && echo yes`], { encoding: "utf8" }).trim()).toBe("yes");
  });
});
