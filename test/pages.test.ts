import { describe, it, expect } from "vitest";
import { chatPage } from "../src/web/pages.js";
import type { Session } from "../src/playground/session.js";

function fakeSession(id: string, overrides: Record<string, unknown> = {}): Session {
  return {
    id,
    sourceUrl: "https://joesplumbing.example",
    scrape: { ok: true, pagesFetched: 2, charsRead: 1200 },
    pack: { businessName: "Test Co", customServices: [] },
    overlay: { servicesMentioned: [], pricingOverrides: [], extraRedlines: [] },
    ...overrides,
  } as unknown as Session;
}

describe("chatPage inline <script> safety", () => {
  it("escapes </script> inside the greeting JSON", () => {
    const evil = "</script><script>alert(1)</script>";
    const html = chatPage(fakeSession("abc123"), evil);
    expect(html).not.toContain(evil);
    expect(html).toContain("\\u003c/script>");
  });

  it("escapes </script> inside the session id JSON", () => {
    const evilId = "x</script><script>alert(1)</script>";
    const html = chatPage(fakeSession(evilId), "hi");
    expect(html).not.toContain(evilId);
  });
});

describe("chatPage intake status", () => {
  it("shows a warning when the scrape failed, with the reason", () => {
    const html = chatPage(
      fakeSession("s1", {
        scrape: { ok: false, pagesFetched: 0, charsRead: 0, failureReason: "fetch_failed" },
      }),
      "hi"
    );
    expect(html).toContain("Couldn't read");
    expect(html).toContain("running on the owner's notes only");
  });

  it("warns when pages were read but had almost no text (JS-rendered site)", () => {
    const html = chatPage(
      fakeSession("s2", { scrape: { ok: true, pagesFetched: 1, charsRead: 40 } }),
      "hi"
    );
    expect(html).toContain("almost no readable text");
    expect(html).toContain("JavaScript");
  });

  it("shows a success note and the extracted facts", () => {
    const html = chatPage(
      fakeSession("s3", {
        pack: { businessName: "Joe's Plumbing", customServices: ["pool leaks"] },
        overlay: {
          servicesMentioned: [{}, {}],
          pricingOverrides: [
            { label: "service call", priceText: "$89", shareable: true },
          ],
          extraRedlines: [],
        },
      }),
      "hi"
    );
    expect(html).toContain("Read 2 page(s)");
    expect(html).toContain("Joe's Plumbing");
    expect(html).toContain("service call — $89");
    expect(html).toContain("pool leaks");
  });
});
