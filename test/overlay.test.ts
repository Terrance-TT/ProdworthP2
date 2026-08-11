import { describe, it, expect } from "vitest";
import { BusinessOverlaySchema } from "../src/packs/overlay.js";

const validPricingOverride = {
  tradeServiceId: "drain_cleaning",
  label: "Drain cleaning",
  priceText: "$150",
  shareable: true,
  evidence: { source: "website", quote: "Drain cleaning $150 flat." },
};

describe("BusinessOverlaySchema", () => {
  it("accepts a well-formed overlay", () => {
    const result = BusinessOverlaySchema.safeParse({
      businessName: "Maple & Sons Plumbing",
      servicesMentioned: [
        {
          text: "Drain cleaning",
          tradeServiceId: "drain_cleaning",
          evidence: { source: "website", quote: "We handle drain cleaning." },
        },
      ],
      pricingOverrides: [validPricingOverride],
      extraRedlines: [{ id: "no_phone_quotes", rule: "Never give firm quotes by text." }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects output without a business name", () => {
    expect(BusinessOverlaySchema.safeParse({}).success).toBe(false);
    expect(BusinessOverlaySchema.safeParse({ businessName: "" }).success).toBe(false);
  });

  it("rejects a pricing override with no evidence quote (no evidence, no field)", () => {
    const noQuote = {
      businessName: "X Plumbing",
      pricingOverrides: [
        { ...validPricingOverride, evidence: { source: "website", quote: "" } },
      ],
    };
    expect(BusinessOverlaySchema.safeParse(noQuote).success).toBe(false);

    const noEvidence = {
      businessName: "X Plumbing",
      pricingOverrides: [
        { tradeServiceId: null, label: "Service call", priceText: "$89", shareable: true },
      ],
    };
    expect(BusinessOverlaySchema.safeParse(noEvidence).success).toBe(false);
  });

  it("rejects an evidence source that is not website/owner_text", () => {
    const bad = {
      businessName: "X Plumbing",
      pricingOverrides: [
        {
          ...validPricingOverride,
          evidence: { source: "model_knowledge", quote: "Everyone knows drains cost $150." },
        },
      ],
    };
    expect(BusinessOverlaySchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a service mention without evidence", () => {
    const bad = {
      businessName: "X Plumbing",
      servicesMentioned: [{ text: "Drain cleaning", tradeServiceId: "drain_cleaning" }],
    };
    expect(BusinessOverlaySchema.safeParse(bad).success).toBe(false);
  });

  it("rejects wrong field types", () => {
    expect(
      BusinessOverlaySchema.safeParse({ businessName: 42 }).success
    ).toBe(false);
    expect(
      BusinessOverlaySchema.safeParse({
        businessName: "X Plumbing",
        extraRedlines: [{ id: "ok", rule: 5 }],
      }).success
    ).toBe(false);
  });
});
