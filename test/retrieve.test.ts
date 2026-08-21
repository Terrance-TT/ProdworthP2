import { describe, it, expect } from "vitest";
import { loadTradePack } from "../src/packs/tradePack.js";
import { mergePacks } from "../src/packs/merge.js";
import type { BusinessOverlay } from "../src/packs/overlay.js";
import { retrieveSlice } from "../src/packs/retrieve.js";

const trade = loadTradePack("trade-packs/plumbing.yaml");

const overlay: BusinessOverlay = {
  businessName: "Test Plumbing",
  servicesMentioned: [],
  serviceArea: { value: "Dayton and nearby towns", evidence: { source: "website", quote: "Serving Dayton and nearby towns" } },
  pricingOverrides: [],
  extraRedlines: [],
};

const pack = mergePacks(trade, overlay);

describe("terminology map retrieval", () => {
  it("clarifies a sump pump query (annotation no longer blocks the entry)", () => {
    const slice = retrieveSlice(pack, "my sump pump stopped working");
    expect(slice.terminologyClarification).toContain("sewage ejector pump");
  });

  it("clarifies water filter and water treatment queries", () => {
    expect(
      retrieveSlice(pack, "I need a water filter").terminologyClarification
    ).toContain("softener");
    expect(
      retrieveSlice(pack, "do you do water treatment?").terminologyClarification
    ).toContain("softener");
  });

  it("strips parenthetical synonym annotations so 'boiler' matches cleanly", () => {
    const slice = retrieveSlice(pack, "my boiler is broken");
    expect(slice.services.map((s) => s.id)).toContain("water_heater_repair");
  });

  it("does not retrieve water-heater services via annotation words like 'common'", () => {
    const slice = retrieveSlice(pack, "is a running toilet a common problem?");
    const ids = slice.services.map((s) => s.id);
    expect(ids).not.toContain("water_heater_repair");
    expect(ids).not.toContain("water_heater_replacement");
  });
});

describe("service-area detection", () => {
  it("does not treat insurance-coverage questions as area questions", () => {
    expect(retrieveSlice(pack, "Does insurance cover this?").mentionsArea).toBe(false);
    expect(retrieveSlice(pack, "will my insurance cover the repair?").mentionsArea).toBe(false);
    expect(retrieveSlice(pack, "is this covered by insurance?").mentionsArea).toBe(false);
  });

  it("still recognizes genuine service-area questions", () => {
    expect(retrieveSlice(pack, "do you cover my area?").mentionsArea).toBe(true);
    expect(retrieveSlice(pack, "what areas do you cover?").mentionsArea).toBe(true);
    expect(retrieveSlice(pack, "do you service Dayton?").mentionsArea).toBe(true);
    expect(retrieveSlice(pack, "do you come to Xenia?").mentionsArea).toBe(true);
  });
});
