import { describe, it, expect } from "vitest";
import { heuristicOverlay } from "../src/intake/extract.js";
import { loadTradePack } from "../src/packs/tradePack.js";

const trade = loadTradePack("trade-packs/plumbing.yaml");

describe("heuristicOverlay owner rules", () => {
  it("captures a mid-line 'Rule:' after a sentence boundary (landing-page placeholder)", () => {
    const overlay = heuristicOverlay(trade, {
      siteText: "",
      ownerText:
        "We mainly serve the east side. Rule: we never give firm quotes over text.",
      url: "http://example.com",
    });
    expect(overlay.extraRedlines).toEqual([
      { id: "owner_rule_1", rule: "we never give firm quotes over text." },
    ]);
  });

  it("captures the demo transcript's Bonus B phrasing", () => {
    const overlay = heuristicOverlay(trade, {
      siteText: "",
      ownerText:
        "We are Hartley Plumbing. Rule: we never quote exact totals by text.",
      url: "http://does-not-exist.invalid",
    });
    expect(overlay.extraRedlines).toEqual([
      { id: "owner_rule_1", rule: "we never quote exact totals by text." },
    ]);
  });

  it("still captures a line that starts with 'Rule:'", () => {
    const overlay = heuristicOverlay(trade, {
      siteText: "",
      ownerText: "Rule: no phone quotes",
      url: "http://example.com",
    });
    expect(overlay.extraRedlines).toEqual([
      { id: "owner_rule_1", rule: "no phone quotes" },
    ]);
  });

  it("does not match substrings like 'ruled:'", () => {
    const overlay = heuristicOverlay(trade, {
      siteText: "",
      ownerText: "We ruled: nothing here is a rule.",
      url: "http://example.com",
    });
    expect(overlay.extraRedlines).toEqual([]);
  });
});

describe("heuristicOverlay business-name fallback", () => {
  it("never returns an empty businessName for a scheme-less host:port URL", () => {
    const overlay = heuristicOverlay(trade, {
      siteText: "",
      ownerText: "",
      url: "localhost:3299/demo-site",
    });
    expect(overlay.businessName.length).toBeGreaterThan(0);
    expect(overlay.businessName).toBe("Localhost");
  });

  it("falls back to 'Your Business' when nothing is recoverable", () => {
    const overlay = heuristicOverlay(trade, {
      siteText: "",
      ownerText: "",
      url: "not a url at all",
    });
    expect(overlay.businessName).toBe("Your Business");
  });
});
