import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { loadTradePack } from "../src/packs/tradePack.js";
import { mergePacks } from "../src/packs/merge.js";
import { heuristicOverlay } from "../src/intake/extract.js";
import { stripHtml } from "../src/intake/scrape.js";
import { RedlineFilter, SAFE_FALLBACK } from "../src/guardrails/redlines.js";
import { buildPackRules } from "../src/guardrails/packRules.js";
import { LlmClient } from "../src/llm/client.js";
import {
  PlaygroundEngine,
  type LlmLike,
} from "../src/conversation/engine.js";
import { SessionStore, type Session } from "../src/playground/session.js";

const trade = loadTradePack("trade-packs/plumbing.yaml");
const fixtureSiteText = stripHtml(
  readFileSync("test/fixtures/fake-plumber-site.html", "utf8")
);

const stubLlm = new LlmClient({
  model: "kimi-k2.6",
  stubMode: true,
  apiKey: undefined,
  baseURL: undefined,
});

/** A session built exactly the way stub-mode intake builds it: the fake
    site scraped + heuristically extracted, merged over the plumbing pack. */
function makeSession(): Session {
  const overlay = heuristicOverlay(trade, {
    siteText: fixtureSiteText,
    ownerText: "",
    url: "http://localhost:3200/demo-site",
  });
  const pack = mergePacks(trade, overlay);
  const filter = new RedlineFilter(buildPackRules(pack));
  return new SessionStore().create({
    sourceUrl: "http://localhost:3200/demo-site",
    pack,
    overlay,
    filter,
    state: "greeted",
  });
}

function makeEngine(llm: LlmLike = stubLlm): PlaygroundEngine {
  return new PlaygroundEngine({ llm, now: () => new Date("2026-08-11T10:00:00") });
}

describe("stub intake extraction (fixture site)", () => {
  it("extracts only evidenced facts from the fixture", () => {
    const overlay = heuristicOverlay(trade, {
      siteText: fixtureSiteText,
      ownerText: "",
      url: "http://localhost:3200/demo-site",
    });
    expect(overlay.businessName).toBe("Maple & Sons Plumbing");
    expect(overlay.serviceArea?.value).toContain("Dayton");
    expect(overlay.hours?.value).toContain("Mon");
    // The published $1,450 water heater price is found and shareable;
    // nothing was said about toilets, so no toilet price exists.
    const whPrice = overlay.pricingOverrides.find(
      (p) => p.tradeServiceId === "water_heater_replacement"
    );
    expect(whPrice?.priceText).toBe("$1,450");
    expect(whPrice?.shareable).toBe(true);
    expect(whPrice?.evidence.quote).toContain("$1,450");
    expect(
      overlay.pricingOverrides.some((p) => p.tradeServiceId === "toilet_repair")
    ).toBe(false);
  });
});

describe("engine loop with stubbed LLM", () => {
  it("greets as the business after the simulated missed call", () => {
    const session = makeSession();
    expect(makeEngine().greeting(session.pack)).toBe(
      "Hi, this is Maple & Sons Plumbing — sorry we missed your call. What can we help you with today?"
    );
  });

  it("answers a trade question the thin site never mentioned, from the trade pack", async () => {
    const session = makeSession();
    // The fixture says nothing about gas lines.
    expect(fixtureSiteText.toLowerCase()).not.toContain("gas line");
    const { reply, xray } = await makeEngine().handleMessage(
      session,
      "Do you guys do gas line work?"
    );
    expect(xray.retrievedServiceIds).toContain("gas_line_service");
    expect(reply.toLowerCase()).toContain("gas line");
    expect(session.state).toBe("greeted"); // question answered, no state change
  });

  it("fires the gas emergency script verbatim on trigger keywords", async () => {
    const session = makeSession();
    const { reply, xray } = await makeEngine().handleMessage(
      session,
      "I smell gas in my basement"
    );
    const script = trade.emergency_scripts.find(
      (s) => s.name === "Suspected gas leak"
    )!;
    expect(reply).toBe(script.customer_instructions.trim());
    expect(xray.emergencyScriptFired).toBe("Suspected gas leak");
  });

  it("fires emergency scripts on capitalized trigger phrases", async () => {
    const session = makeSession();
    const { reply, xray } = await makeEngine().handleMessage(
      session,
      "I Smell Gas in my Basement"
    );
    const script = trade.emergency_scripts.find(
      (s) => s.name === "Suspected gas leak"
    )!;
    expect(reply).toBe(script.customer_instructions.trim());
    expect(xray.emergencyScriptFired).toBe("Suspected gas leak");
  });

  it("does not fire emergency scripts on routine look-alike phrases", async () => {
    const engine = makeEngine();
    for (const text of [
      "I have no water pressure in the kitchen",
      "my toilet won't stop running",
      "I have no hot water in the shower",
    ]) {
      const session = makeSession();
      const { xray } = await engine.handleMessage(session, text);
      expect(xray.emergencyScriptFired).toBeUndefined();
    }
  });

  it("never gives an exact total when price fishing", async () => {
    const session = makeSession();
    const { reply } = await makeEngine().handleMessage(
      session,
      "So what's the exact total for the drain job?"
    );
    expect(reply).not.toMatch(/\$\s?\d/);
    expect(reply.toLowerCase()).toMatch(/on-site|visit|schedule/);
  });

  it("shares a published price only when the overlay evidenced one", async () => {
    const session = makeSession();
    const { reply } = await makeEngine().handleMessage(
      session,
      "I need my water heater replaced, can you come out?"
    );
    // The fixture published "$1,450 installed" for water heater replacement.
    expect(reply).toContain("$1,450");
  });

  it("runs the full booking flow: slots → pick → address → booked", async () => {
    const engine = makeEngine();
    const session = makeSession();

    const r1 = await engine.handleMessage(
      session,
      "My kitchen sink is clogged, can someone come out?"
    );
    expect(r1.reply.toLowerCase()).toContain("drain cleaning");
    expect(r1.reply).toMatch(/1\).+2\).+3\)/);
    expect(session.state).toBe("time_proposed");

    const r2 = await engine.handleMessage(session, "2");
    expect(r2.reply).toContain("pencilled in");
    expect(r2.reply).toContain("address");
    expect(session.state).toBe("time_confirmed");

    const r3 = await engine.handleMessage(session, "455 Maple Ave, Dayton");
    expect(r3.reply).toContain("You're booked");
    expect(r3.reply).toContain("455 Maple Ave");
    expect(session.state).toBe("booked");
    expect(r3.xray.note).toContain("calendar");
  });

  it("refuses a slot the availability helper never offered (exact-match)", async () => {
    // A lying LLM that always claims the customer picked a made-up time.
    const lyingLlm: LlmLike = {
      isLive: true,
      async generateStructured<T extends z.ZodTypeAny>(schema: T): Promise<z.infer<T>> {
        return schema.parse({
          picked_slot_label: "Sun 3:00 AM",
          wants_booking: true,
          draft_reply: "Sure, Sunday at 3am works!",
        });
      },
    };
    const engine = makeEngine(lyingLlm);
    const session = makeSession();
    session.state = "time_proposed";

    const { reply } = await engine.handleMessage(session, "sunday at 3am?");
    expect(reply).toContain("isn't available");
    expect(reply).not.toContain("Sun 3:00 AM");
    expect(session.state).toBe("time_proposed");
  });

  it("replaces an LLM draft that invents a time in its free text", async () => {
    // The slot fields are honest here, but the draft free text lies.
    const lyingLlm: LlmLike = {
      isLive: true,
      async generateStructured<T extends z.ZodTypeAny>(schema: T): Promise<z.infer<T>> {
        return schema.parse({
          picked_slot_label: null,
          wants_booking: false,
          draft_reply: "We can do Sunday at 3am if that works for you.",
        });
      },
    };
    const engine = makeEngine(lyingLlm);
    const session = makeSession();
    session.state = "time_proposed";

    const { reply, xray } = await engine.handleMessage(
      session,
      "how about sunday at 3am?"
    );
    expect(reply).toBe(SAFE_FALLBACK);
    expect(reply).not.toContain("Sunday");
    expect(xray.redlineHits).toContain("no_invented_scheduling");
    expect(session.state).toBe("time_proposed");
  });

  it("replaces an answerable-question draft that invents times", async () => {
    const lyingLlm: LlmLike = {
      isLive: true,
      async generateStructured<T extends z.ZodTypeAny>(schema: T): Promise<z.infer<T>> {
        return schema.parse({
          intent: "question_answerable",
          service: null,
          question: "what are your hours?",
          draft_reply: "We're open Sunday at 3am — come by then.",
        });
      },
    };
    const engine = makeEngine(lyingLlm);
    const session = makeSession();

    const { reply, xray } = await engine.handleMessage(
      session,
      "what are your hours?"
    );
    expect(reply).toBe(SAFE_FALLBACK);
    expect(reply).not.toContain("Sunday");
    expect(xray.redlineHits).toContain("no_invented_scheduling");
    expect(session.state).toBe("greeted");
  });

  it("re-asks when the extracted address smuggles an invented time", async () => {
    const lyingLlm: LlmLike = {
      isLive: true,
      async generateStructured<T extends z.ZodTypeAny>(schema: T): Promise<z.infer<T>> {
        return schema.parse({
          address: "455 Maple Ave — I'll be there Tuesday 9am",
          draft_reply: "see you then",
        });
      },
    };
    const engine = makeEngine(lyingLlm);
    const session = makeSession();
    session.state = "time_confirmed";
    session.pickedSlot = {
      label: "Wed 8:00 AM",
      start: new Date("2026-08-12T08:00:00"),
    };

    const { reply, xray } = await engine.handleMessage(session, "455 Maple Ave");
    expect(reply).toContain("address");
    expect(reply).not.toContain("Tuesday");
    expect(reply).not.toContain("You're booked");
    expect(xray.redlineHits).toContain("no_invented_scheduling");
    expect(session.state).toBe("time_confirmed");
  });

  it("falls back to a deterministic owner handoff when the LLM fails", async () => {
    const deadLlm: LlmLike = {
      isLive: true,
      async generateStructured(): Promise<never> {
        throw new Error("LLM structured output failed validation after retry");
      },
    };
    const engine = makeEngine(deadLlm);
    const session = makeSession();
    const { reply } = await engine.handleMessage(session, "my drain is clogged");
    expect(reply).toContain("owner");
    expect(session.state).toBe("handoff_to_owner");
  });
});
