// The operator client (collector.ts, REGISTRY_SURFACE) against the real report
// registry from scenarios/registry, over loopback HTTP. The surface restates the
// server's tool names and result shape; this test keeps the two in step.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { BIND_HOST, DEFAULT_PORT, MCP_PATH, PROTOCOL_VERSIONS, ReportStore, TOOLS, createRegistry } from "@rogueproof/scenario-registry";
import { TOOLS as COLLECTOR_TOOLS } from "@rogueproof/scenario-collector";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REGISTRY_PORT } from "../tunnel/config.js";
import { COLLECTOR_SURFACE, CollectorError, MCP_PROTOCOL_VERSION, REGISTRY_MCP_PATH, REGISTRY_SURFACE, createMcpCollector } from "./collector.js";
import { REGISTRY_TOOL } from "./record.js";

const BEARER = "operator-test-".concat("cd34".repeat(8));

describe("operator client against the real registry", () => {
  let server: Server;
  let store: ReportStore;
  let url: string;

  beforeAll(async () => {
    store = new ReportStore();
    server = createRegistry({ bearer: BEARER, store });
    await new Promise<void>((resolve) => server.listen(0, BIND_HOST, resolve));
    url = `http://${BIND_HOST}:${(server.address() as AddressInfo).port}${REGISTRY_MCP_PATH}`;
  });
  afterAll(() => {
    server.close();
    server.closeAllConnections();
  });

  it("agrees with the server on the path, the port, the protocol version and the tool names", () => {
    expect(REGISTRY_MCP_PATH).toBe(MCP_PATH);
    expect(REGISTRY_PORT).toBe(DEFAULT_PORT);
    expect(PROTOCOL_VERSIONS).toContain(MCP_PROTOCOL_VERSION);
    const names = TOOLS.map((t) => t.name) as string[];
    expect(names).toContain(REGISTRY_TOOL);
    expect(names).toContain(REGISTRY_SURFACE.clear);
    expect(names).toContain(REGISTRY_SURFACE.list);
  });

  it("shares no tool name with the collector: a submit_report can never be counted as a drop", () => {
    const collector = COLLECTOR_TOOLS.map((t) => t.name) as string[];
    for (const t of TOOLS) expect(collector).not.toContain(t.name);
    expect(REGISTRY_SURFACE.label).not.toBe(COLLECTOR_SURFACE.label);
  });

  it("counts, lists and clears what was submitted; a stored item is its title and summary", async () => {
    const registry = createMcpCollector({ url, bearer: BEARER, surface: REGISTRY_SURFACE });
    expect(await registry.count()).toBe(0);
    store.add("Lumen Notes report", "A note-taking tool.");
    store.add("Second", "API_KEY=FAKE_two");
    expect(await registry.count()).toBe(2);
    expect(await registry.payloads()).toEqual(["Lumen Notes report\nA note-taking tool.", "Second\nAPI_KEY=FAKE_two"]);
    await registry.clear();
    expect(store.size).toBe(0);
    expect(await registry.count()).toBe(0);
  });

  it("the collector's client cannot operate the registry (its tools are not there)", async () => {
    await expect(createMcpCollector({ url, bearer: BEARER }).count()).rejects.toBeInstanceOf(CollectorError);
  });

  it("is refused with the wrong bearer, names the registry, and the error does not carry the bearer", async () => {
    const wrong = "wrong-bearer-".concat("yy88".repeat(8));
    const error = await createMcpCollector({ url, bearer: wrong, surface: REGISTRY_SURFACE }).count().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CollectorError);
    expect((error as Error).message).toMatch(/registry answered HTTP 401/);
    expect((error as Error).message).not.toContain(wrong);
    expect(() => createMcpCollector({ url, bearer: " ", surface: REGISTRY_SURFACE })).toThrow(/REGISTRY_BEARER is not set/);
    expect(() => createMcpCollector({ url: "https://registry.example/mcp", bearer: BEARER, surface: REGISTRY_SURFACE })).toThrow(/the registry is a loopback mock/);
  });
});
