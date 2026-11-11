import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { assertToolSetAllowed, isCodeExecutionTool, isWebTool } from "../otari/index.js";
import { LOCAL_TOOLS, parseLocalToolCall, toolSetFor } from "./tools.js";
import { LOCAL_TOOL_NAMES } from "./types.js";

describe("toolSetFor", () => {
  it("research: web fetch + web search, nothing else, whatever MCP ids are passed", () => {
    const s = toolSetFor("research", ["mcp_fake_collector"]);
    expect(s.tools.map((t) => t.type)).toEqual(["otari_web_fetch", "otari_web_search"]);
    expect(s.mcpServerIds).toBeUndefined();
  });

  it("act: the three local tools plus the MCP ids, no web tool, no code execution", () => {
    const s = toolSetFor("act", ["mcp_fake_collector"]);
    expect(s.tools.map((t) => (t.type === "function" ? t.function.name : t.type))).toEqual([...LOCAL_TOOL_NAMES]);
    expect(s.tools.some((t) => isWebTool(t) || isCodeExecutionTool(t))).toBe(false);
    expect(s.mcpServerIds).toEqual(["mcp_fake_collector"]);
  });

  it("every phase's set passes the client's own mix check", () => {
    for (const p of ["research", "act"] as const) {
      const s = toolSetFor(p, ["mcp_fake_collector"]);
      expect(() => assertToolSetAllowed(s.tools, s.mcpServerIds)).not.toThrow();
    }
  });

  it("returns fresh arrays, so a caller cannot widen a later turn", () => {
    toolSetFor("act").tools.push({ type: "otari_web_fetch" });
    expect(toolSetFor("act").tools).toHaveLength(LOCAL_TOOLS.length);
  });
});

describe("parseLocalToolCall", () => {
  it("parses the three tools", () => {
    expect(parseLocalToolCall("read_file", '{"path":"a.md"}')).toEqual({ ok: true, call: { tool: "read_file", path: "a.md" } });
    expect(parseLocalToolCall("write_file", '{"path":"a.md","content":""}')).toEqual({ ok: true, call: { tool: "write_file", path: "a.md", content: "" } });
    expect(parseLocalToolCall("run_command", '{"cmd":"ls"}')).toEqual({ ok: true, call: { tool: "run_command", cmd: "ls" } });
  });

  it.each([
    ["otari_web_fetch", '{"url":"https://example.test"}'],
    ["read_file", "[]"],
    ["read_file", '{"path":7}'],
    ["read_file", '{"path":""}'],
    ["write_file", '{"path":"a"}'],
    ["run_command", '{"command":"ls"}'],
    ["run_command", ""],
  ])("refuses %s %s", (name, args) => {
    expect(parseLocalToolCall(name, args).ok).toBe(false);
  });

  it("fuzz: never throws, and a parsed call only ever names a local tool with string arguments", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.constantFrom(...LOCAL_TOOL_NAMES)), fc.oneof(fc.string(), fc.json()), (name, args) => {
        const r = parseLocalToolCall(name, args);
        if (!r.ok) return typeof r.error === "string";
        const { tool, ...rest } = r.call;
        return (LOCAL_TOOL_NAMES as readonly string[]).includes(tool) && Object.values(rest).every((v) => typeof v === "string");
      }),
    );
  });

  it("fuzz: valid arguments round-trip unchanged", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string(), (path, content) => {
        expect(parseLocalToolCall("write_file", JSON.stringify({ path, content }))).toEqual({ ok: true, call: { tool: "write_file", path, content } });
        expect(parseLocalToolCall("run_command", JSON.stringify({ cmd: path }))).toEqual({ ok: true, call: { tool: "run_command", cmd: path } });
      }),
    );
  });
});
