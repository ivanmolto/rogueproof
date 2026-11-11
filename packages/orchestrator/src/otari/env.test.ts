import { describe, expect, it } from "vitest";
import { ROLES, ROLE_ENV, readOtariEnv } from "./env.js";

const full = () => {
  const e: Record<string, string> = { OTARI_BASE_URL: "https://x.test/api/v1", MODEL_PROFILE: "rubric" };
  for (const r of ROLES) e[ROLE_ENV[r]] = `fake-${r}`;
  return e;
};

describe("readOtariEnv", () => {
  it("reads base URL, profile and a key per role", () => {
    const env = readOtariEnv(full());
    expect(env.profile).toBe("rubric");
    expect(Object.keys(env.keys).sort()).toEqual([...ROLES].sort());
  });
  it("defaults the profile to dev and rejects unknown profiles", () => {
    const e = full();
    delete e["MODEL_PROFILE"];
    expect(readOtariEnv(e).profile).toBe("dev");
    expect(() => readOtariEnv({ ...full(), MODEL_PROFILE: "golden" })).toThrow(/MODEL_PROFILE/);
  });
  it("reads the fallback-test key when it is set, and does not require it", () => {
    expect(readOtariEnv(full()).keys.fallback).toBeUndefined();
    const env = readOtariEnv({ ...full(), [ROLE_ENV.fallback]: "fake-fallback" });
    expect(env.keys.fallback).toBe("fake-fallback");
    expect((ROLES as readonly string[]).includes("fallback")).toBe(false);
  });
  it("names the missing variable without printing any value", () => {
    const e = full();
    delete e["OTARI_API_KEY_JUDGE"];
    expect(() => readOtariEnv(e)).toThrow(/OTARI_API_KEY_JUDGE/);
  });
});
