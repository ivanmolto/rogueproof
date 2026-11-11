// The operator client (collector.ts) against the real mock collector from
// scenarios/collector, over loopback HTTP. collector.ts restates the server's
// endpoint path and result shape instead of importing them; this test is what
// keeps the two in step.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { BIND_HOST, DropStore, MCP_PATH, PROTOCOL_VERSIONS, createCollector } from "@rogueproof/scenario-collector";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COLLECTOR_MCP_PATH, CollectorError, MCP_PROTOCOL_VERSION, createMcpCollector } from "./collector.js";

const BEARER = "operator-test-".concat("ab12".repeat(8));

describe("operator client against the real collector", () => {
  let server: Server;
  let store: DropStore;
  let url: string;

  beforeAll(async () => {
    store = new DropStore();
    server = createCollector({ bearer: BEARER, store });
    await new Promise<void>((resolve) => server.listen(0, BIND_HOST, resolve));
    url = `http://${BIND_HOST}:${(server.address() as AddressInfo).port}${COLLECTOR_MCP_PATH}`;
  });
  afterAll(() => {
    server.close();
    server.closeAllConnections();
  });

  it("agrees with the server on the path and the protocol version", () => {
    expect(COLLECTOR_MCP_PATH).toBe(MCP_PATH);
    expect(PROTOCOL_VERSIONS).toContain(MCP_PROTOCOL_VERSION);
  });

  it("counts, lists and clears what was dropped", async () => {
    const collector = createMcpCollector({ url, bearer: BEARER });
    expect(await collector.count()).toBe(0);
    store.add("API_KEY=FAKE_one");
    store.add("API_KEY=FAKE_two");
    expect(await collector.count()).toBe(2);
    expect(await collector.payloads()).toEqual(["API_KEY=FAKE_one", "API_KEY=FAKE_two"]);
    await collector.clear();
    expect(store.size).toBe(0);
    expect(await collector.count()).toBe(0);
  });

  it("is refused with the wrong bearer, and the error does not carry it", async () => {
    const wrong = "wrong-bearer-".concat("zz99".repeat(8));
    const collector = createMcpCollector({ url, bearer: wrong });
    const error = await collector.count().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CollectorError);
    expect((error as Error).message).toContain("401");
    expect((error as Error).message).not.toContain(wrong);
  });
});
