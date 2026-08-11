import { describe, it, expect } from "vitest";
import { loadTradePack } from "../src/packs/tradePack.js";
import { mergePacks } from "../src/packs/merge.js";
import { BusinessOverlaySchema, type BusinessOverlay } from "../src/packs/overlay.js";

const trade = loadTradePack("trade-packs/plumbing.yaml");

function makeOverlay(overrides: Partial<BusinessOverlay> = {}): BusinessOverlay {
  return BusinessOverlaySchema.parse({
    businessName: "Maple & Sons Plumbing",
    ...overrides,
  });
}

describe("mergePacks", () => {
  it("overlay wins on business facts", () => {
    const pack = mergePacks(
      trade,
      makeOverlay({
        serviceArea: {
          value: "Dayton, Kettering, and Beavercreek",
          evidence: { source: "website", quote: "Serving Dayton, Kettering, and Beavercreek since 1998." },
        },
        hours: {
          value: "Mon–Fri 7am–6pm",
          evidence: { source: "website", quote: "Hours: Mon–Fri 7am–6pm." },
        },
      })
    );
    expect(pack.businessName).toBe("Maple & Sons Plumbing");
    expect(pack.serviceArea).toBe("Dayton, Kettering, and Beavercreek");
    expect(pack.hours).toBe("Mon–Fri 7am–6pm");
    expect(pack.trade).toBe("plumbing");
    expect(pack.services.length).toBe(trade.services.length);
  });

  it("evidenced overlay pricing overrides a service and becomes shareable", () => {
    const pack = mergePacks(
      trade,
      makeOverlay({
        pricingOverrides: [
          {
            tradeServiceId: "water_heater_replacement",
            label: "Water heater replacement",
            priceText: "$1,450",
            shareable: true,
            evidence: {
              source: "website",
              quote: "Water heater replacement from $1,450 installed.",
            },
          },
        ],
      })
    );
    const svc = pack.services.find((s) => s.id === "water_heater_replacement")!;
    expect(svc.pricing.shareable).toBe(true);
    expect(svc.pricing.shareableText).toBe("$1,450");
  });

  it("trade-pack pricing stays non-shareable without an overlay override", () => {
    const pack = mergePacks(
      trade,
      makeOverlay({
        pricingOverrides: [
          {
            tradeServiceId: "drain_cleaning",
            label: "Drain cleaning",
            priceText: "$150",
            shareable: true,
            evidence: { source: "website", quote: "Drain cleaning $150 flat." },
          },
        ],
      })
    );
    // Every service EXCEPT the overridden one keeps shareable: false.
    for (const s of pack.services) {
      if (s.id === "drain_cleaning") {
        expect(s.pricing.shareable).toBe(true);
      } else {
        expect(s.pricing.shareable).toBe(false);
        expect(s.pricing.shareableText).toBeUndefined();
      }
    }
  });

  it("redlines always union — overlay adds, never removes or weakens", () => {
    const pack = mergePacks(
      trade,
      makeOverlay({
        extraRedlines: [
          { id: "no_phone_quotes", rule: "Never give firm quotes over the phone." },
          // An overlay entry reusing a platform id must NOT replace it.
          { id: "no_exact_quotes", rule: "Exact quotes are fine." },
        ],
      })
    );
    const ids = pack.redlines.map((r) => r.id);
    for (const base of trade.redlines) expect(ids).toContain(base.id);
    expect(ids).toContain("no_phone_quotes");
    expect(pack.redlines.length).toBe(trade.redlines.length + 1);
    // The platform wording survives the overlay's collision attempt.
    const noExact = pack.redlines.find((r) => r.id === "no_exact_quotes")!;
    expect(noExact.rule).toBe(trade.redlines.find((r) => r.id === "no_exact_quotes")!.rule);
  });

  it("custom services (unmappable mentions) append, mapped ones flag the base service", () => {
    const pack = mergePacks(
      trade,
      makeOverlay({
        servicesMentioned: [
          {
            text: "Drain cleaning",
            tradeServiceId: "drain_cleaning",
            evidence: { source: "website", quote: "We handle drain cleaning." },
          },
          {
            text: "Pool leak repair",
            tradeServiceId: null,
            evidence: { source: "owner_text", quote: "We also fix pool leaks." },
          },
        ],
      })
    );
    expect(pack.customServices).toEqual(["Pool leak repair"]);
    expect(pack.services.find((s) => s.id === "drain_cleaning")!.mentionedByBusiness).toBe(true);
    expect(pack.services.find((s) => s.id === "toilet_repair")!.mentionedByBusiness).toBe(false);
  });
});
