import { describe, it, expect } from "vitest";
import { loadTradePack } from "../src/packs/tradePack.js";
import { mergePacks } from "../src/packs/merge.js";
import type { BusinessOverlay } from "../src/packs/overlay.js";
import { RedlineFilter, SAFE_FALLBACK } from "../src/guardrails/redlines.js";
import { buildPackRules } from "../src/guardrails/packRules.js";

const trade = loadTradePack("trade-packs/plumbing.yaml");

/** A minimal overlay; two evidenced, shareable published prices. */
const overlay: BusinessOverlay = {
  businessName: "Test Plumbing",
  servicesMentioned: [],
  pricingOverrides: [
    {
      tradeServiceId: "water_heater_replacement",
      label: "water heater replacement",
      priceText: "$1,450 installed",
      shareable: true,
      evidence: { source: "website", quote: "Water heaters from $1,450 installed" },
    },
    {
      tradeServiceId: "toilet_repair",
      label: "service call",
      priceText: "$89",
      shareable: true,
      evidence: { source: "website", quote: "Service calls just $89" },
    },
  ],
  extraRedlines: [],
};

const filter = new RedlineFilter(buildPackRules(mergePacks(trade, overlay)));

describe("emergency trigger rules", () => {
  it("fires emergency scripts case-insensitively", () => {
    expect(filter.check("", "I Smell Gas").violatedRuleId).toBe(
      "emergency:Suspected gas leak"
    );
    expect(filter.check("", "BURST PIPE in basement").violatedRuleId).toBe(
      "emergency:Burst pipe or active flooding"
    );
    expect(filter.check("", "i smell gas").violatedRuleId).toBe(
      "emergency:Suspected gas leak"
    );
  });

  it("returns the mandatory script verbatim as the safe body", () => {
    const script = trade.emergency_scripts.find(
      (s) => s.name === "Suspected gas leak"
    )!;
    const result = filter.check("anything the LLM drafted", "I SMELL GAS");
    expect(result.safeBody).toBe(script.customer_instructions.trim());
    expect(result.replaced).toBe(true);
  });

  it("does not hijack routine messages with over-broad keywords", () => {
    expect(filter.check("", "I have no water pressure in the kitchen").replaced).toBe(false);
    expect(filter.check("", "my toilet won't stop running").replaced).toBe(false);
    expect(filter.check("", "I have no hot water in the shower").replaced).toBe(false);
    expect(filter.check("", "my toilet tank is leaking").replaced).toBe(false);
  });

  it("still fires on unambiguous emergency phrasing, in any case", () => {
    expect(filter.check("", "There's NO WATER AT ALL in my house").violatedRuleId).toBe(
      "emergency:No water in the whole home"
    );
    expect(filter.check("", "WATER COMPLETELY OFF since this morning").violatedRuleId).toBe(
      "emergency:No water in the whole home"
    );
    expect(filter.check("", "My TOILET IS OVERFLOWING").violatedRuleId).toBe(
      "emergency:Toilet overflowing"
    );
    expect(filter.check("", "water coming out of the toilet onto the floor").violatedRuleId).toBe(
      "emergency:Toilet overflowing"
    );
    expect(filter.check("", "my WATER HEATER BURST last night").violatedRuleId).toBe(
      "emergency:Water heater leaking"
    );
  });
});

describe("no_guarantees_or_warranties", () => {
  it("replaces guarantee/warranty phrasing, including inflections", () => {
    for (const draft of [
      "Your satisfaction is guaranteed!",
      "We're guaranteeing on-time arrival.",
      "All our work is guaranteed.",
      "The repair comes with a full warranty.",
    ]) {
      const result = filter.check(draft);
      expect(result.allowed).toBe(false);
      expect(result.violatedRuleId).toBe("no_guarantees_or_warranties");
      expect(result.safeBody).toBe(SAFE_FALLBACK);
    }
  });

  it("allows benign messages", () => {
    expect(filter.check("The tech will take a look on-site.").allowed).toBe(true);
  });
});

describe("no_exact_quotes", () => {
  it("replaces non-published figures in any phrasing", () => {
    for (const draft of [
      "That'll be $450 for the job.",
      "That'll be $  100 for the visit.",
      "That'll be 450 dollars for the visit.",
      "It's about 200 USD for the part.",
      "It's $89.99 for the part.", // published $89 must not shield a decimal variant
    ]) {
      const result = filter.check(draft);
      expect(result.allowed).toBe(false);
      expect(result.violatedRuleId).toBe("no_exact_quotes");
      expect(result.safeBody).toBe(SAFE_FALLBACK);
    }
  });

  it("allows published shareable figures repeated verbatim, and bare numbers", () => {
    expect(
      filter.check("The published price is $1,450 installed.").allowed
    ).toBe(true);
    expect(filter.check("The service call is $89.").allowed).toBe(true);
    expect(filter.check("Call us at 555-123-4567.").allowed).toBe(true);
    expect(filter.check("We can bring 2 gallons of cleaner.").allowed).toBe(true);
  });
});

describe("no_diagnosis_over_text", () => {
  it("replaces diagnosis phrasing, including article-less and expanded forms", () => {
    for (const draft of [
      "Sounds like tree roots in the line.",
      "It sounds like a bad flapper.",
      "It is probably the anode rod.",
      "It's probably the fill valve.",
    ]) {
      const result = filter.check(draft);
      expect(result.allowed).toBe(false);
      expect(result.violatedRuleId).toBe("no_diagnosis_over_text");
      expect(result.safeBody).toBe(SAFE_FALLBACK);
    }
  });

  it("allows benign messages", () => {
    expect(filter.check("The tech will diagnose it on-site.").allowed).toBe(true);
  });
});

describe("no_invented_scheduling", () => {
  it("is enforced on LLM-controlled text via violatesLlmRule", () => {
    expect(
      filter.violatesLlmRule("We can do Sunday at 3am.", "no_invented_scheduling")
    ).toBe(true);
    expect(
      filter.violatesLlmRule("Someone can come tomorrow morning.", "no_invented_scheduling")
    ).toBe(true);
    expect(
      filter.violatesLlmRule("455 Maple Ave, Dayton", "no_invented_scheduling")
    ).toBe(false);
  });

  it("never blocks the engine's own deterministic slot offers", () => {
    // llmOnly rules are not part of the full outbound check — the composed
    // message legitimately contains days and times.
    const slotOffer =
      "Here's what we have open: 1) Wed 8:00 AM, 2) Wed 11:00 AM, 3) Wed 2:00 PM.";
    expect(filter.check(slotOffer).allowed).toBe(true);
    expect(
      filter.check("Great, you're pencilled in for Wed 8:00 AM. What's the service address?")
        .allowed
    ).toBe(true);
    expect(filter.check("We can do Sunday at 3am.").allowed).toBe(true);
  });
});

describe("general pricing (null-id overrides)", () => {
  const generalFilter = new RedlineFilter(
    buildPackRules(
      mergePacks(trade, {
        businessName: "Test Plumbing",
        servicesMentioned: [],
        pricingOverrides: [
          {
            tradeServiceId: null,
            label: "service call",
            priceText: "$89",
            shareable: true,
            evidence: { source: "website", quote: "Service calls just $89" },
          },
        ],
        extraRedlines: [],
      })
    )
  );

  it("a published general fee is quotable; other figures still blocked", () => {
    expect(
      generalFilter.check("Our service call is $89, published on our site.").allowed
    ).toBe(true);
    expect(generalFilter.check("That'll be $120 total.").violatedRuleId).toBe(
      "no_exact_quotes"
    );
  });
});
