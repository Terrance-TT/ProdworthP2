import { describe, it, expect } from "vitest";
import type { AddressInfo } from "node:net";
import { buildServer } from "../src/server.js";
import { loadTradePack } from "../src/packs/tradePack.js";
import { mergePacks } from "../src/packs/merge.js";
import { BusinessOverlaySchema } from "../src/packs/overlay.js";
import { RedlineFilter } from "../src/guardrails/redlines.js";
import { buildPackRules } from "../src/guardrails/packRules.js";

const STUB_ENV = {
  DEMO_STUB_LLM: "1",
  TRADE_PACKS_DIR: "trade-packs",
} as NodeJS.ProcessEnv;

type App = ReturnType<typeof buildServer>["app"];

async function createSession(
  app: App,
  paragraphs: string,
  url = "http://127.0.0.1:1/"
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/playground/create",
    headers: { "content-type": "application/json" },
    payload: { url, trade: "plumbing", paragraphs },
  });
  expect(res.statusCode).toBe(303);
  return (res.headers.location as string).split("/").pop()!;
}

describe("buildServer", () => {
  it("serializes concurrent messages to one session (both get 200)", async () => {
    const { app } = buildServer(STUB_ENV);
    const id = await createSession(app, "We are Hartley Plumbing.");
    const [r1, r2] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/playground/${id}/message`,
        headers: { "content-type": "application/json" },
        payload: { text: "My kitchen sink is clogged, can someone come out?" },
      }),
      app.inject({
        method: "POST",
        url: `/playground/${id}/message`,
        headers: { "content-type": "application/json" },
        payload: { text: "Do you guys do gas line work?" },
      }),
    ]);
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
  });

  it("passes the greeting through the session's redline filter", async () => {
    const { app, sessions } = buildServer(STUB_ENV);
    const trade = loadTradePack("trade-packs/plumbing.yaml");
    const overlay = BusinessOverlaySchema.parse({
      businessName: "Joe's $49 Plumbing",
    });
    const pack = mergePacks(trade, overlay);
    const filter = new RedlineFilter(buildPackRules(pack));
    const session = sessions.create({
      sourceUrl: "http://example.com",
      pack,
      overlay,
      filter,
      state: "greeted",
    });
    const res = await app.inject({
      method: "GET",
      url: `/playground/${session.id}`,
    });
    expect(res.statusCode).toBe(200);
    // Unfiltered, the greeting would read "Hi, this is Joe's $49 Plumbing —
    // sorry we missed your call…" — an unpublished dollar figure.
    expect(res.body).not.toContain("sorry we missed your call");
    expect(res.body).toContain("the owner will follow up");
  });

  it("demo stub mode allows fetching the local demo site (demo-only SSRF opt-out)", async () => {
    const { app, sessions } = buildServer(STUB_ENV);
    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const { port } = app.server.address() as AddressInfo;
      const id = await createSession(
        app,
        "",
        `http://127.0.0.1:${port}/demo-site`
      );
      expect(sessions.get(id)?.pack.businessName).toBe(
        "Maple & Sons Plumbing"
      );
    } finally {
      await app.close();
    }
  });

  it("blocks private hosts when the demo site is not exposed", async () => {
    const { app, sessions } = buildServer({
      TRADE_PACKS_DIR: "trade-packs",
    } as NodeJS.ProcessEnv);
    const id = await createSession(app, "", "http://127.0.0.1:1/demo-site");
    // The scrape was refused before any fetch → hostname-derived fallback name.
    expect(sessions.get(id)?.pack.businessName).not.toBe(
      "Maple & Sons Plumbing"
    );
  });
});
