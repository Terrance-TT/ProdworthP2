import { describe, it, expect, vi } from "vitest";
import {
  scrapeSite,
  stripHtml,
  isPrivateHost,
} from "../src/intake/scrape.js";

const HEADERS = { "content-type": "text/html" };

function fakeFetch(res: Response): typeof fetch {
  return (() => Promise.resolve(res)) as unknown as typeof fetch;
}

describe("isPrivateHost", () => {
  it("blocks loopback, RFC-1918, link-local, and localhost-style hosts", () => {
    for (const h of [
      "127.0.0.1",
      "169.254.169.254",
      "192.168.1.20",
      "10.1.2.3",
      "172.16.0.9",
      "localhost",
      "app.localhost",
      "0.0.0.0",
      "::1",
      "fe80::1",
      "fd12::3456",
    ]) {
      expect(isPrivateHost(h), h).toBe(true);
    }
  });

  it("allows public hostnames and IPs", () => {
    expect(isPrivateHost("example.com")).toBe(false);
    expect(isPrivateHost("93.184.216.34")).toBe(false);
    expect(isPrivateHost("8.8.8.8")).toBe(false);
  });
});

describe("scrapeSite SSRF guard", () => {
  it("refuses private hosts without fetching", async () => {
    const fetchImpl = vi.fn();
    const res = await scrapeSite("http://127.0.0.1:3200/demo-site", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.ok).toBe(false);
    expect(res.text).toBe("");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allows private hosts only with the explicit demo opt-out", async () => {
    const res = await scrapeSite("http://127.0.0.1:3200/demo-site", {
      allowPrivateHosts: true,
      fetchImpl: fakeFetch(
        new Response("<html><body>Maple &amp; Sons Plumbing</body></html>", {
          headers: HEADERS,
        })
      ),
    });
    expect(res.ok).toBe(true);
    expect(res.text).toContain("Maple & Sons Plumbing");
  });

  it("rejects a public URL that redirects to a private host", async () => {
    const redirected = {
      ok: true,
      url: "http://169.254.169.254/latest/meta-data",
      headers: new Headers(HEADERS),
      body: null,
      text: () => Promise.resolve("<html><body>metadata</body></html>"),
    } as unknown as Response;
    const res = await scrapeSite("http://example.com", {
      fetchImpl: fakeFetch(redirected),
    });
    expect(res.ok).toBe(false);
    expect(res.text).toBe("");
  });
});

describe("scrapeSite response body cap", () => {
  it("rejects when declared content-length exceeds the cap", async () => {
    const res = new Response("<html><body>hi</body></html>", {
      headers: { ...HEADERS, "content-length": String(3 * 1024 * 1024) },
    });
    const out = await scrapeSite("http://example.com", {
      fetchImpl: fakeFetch(res),
    });
    expect(out.ok).toBe(false);
    expect(out.text).toBe("");
  });

  it("rejects when streamed bytes exceed the cap", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 40; i++) {
          controller.enqueue(new Uint8Array(64 * 1024).fill(97));
        }
        controller.close();
      },
    });
    const res = new Response(stream, { headers: HEADERS });
    const out = await scrapeSite("http://example.com", {
      fetchImpl: fakeFetch(res),
    });
    expect(out.ok).toBe(false);
  });

  it("accepts a normal-sized page", async () => {
    const res = new Response(
      "<html><body>Hartley Plumbing serving Dayton.</body></html>",
      { headers: HEADERS }
    );
    const out = await scrapeSite("http://example.com", {
      fetchImpl: fakeFetch(res),
    });
    expect(out.ok).toBe(true);
    expect(out.text).toContain("Hartley Plumbing");
  });
});

describe("stripHtml entity decoding", () => {
  it("does not throw on out-of-range numeric entities", () => {
    expect(() => stripHtml("<p>&#1114112;</p>")).not.toThrow();
    expect(() => stripHtml("<p>&#99999999999;</p>")).not.toThrow();
    expect(stripHtml("<p>&#99999999999;</p>")).toBe("");
  });

  it("still decodes valid numeric entities", () => {
    expect(stripHtml("<p>caf&#233;</p>")).toBe("café");
  });

  it("a page with hostile entities degrades to text instead of rejecting intake", async () => {
    const res = new Response(
      "<html><body>&#99999999999; Hartley Plumbing</body></html>",
      { headers: HEADERS }
    );
    const out = await scrapeSite("http://example.com", {
      fetchImpl: fakeFetch(res),
    });
    expect(out.ok).toBe(true);
    expect(out.text).toContain("Hartley Plumbing");
  });
});

describe("scrapeSite http fallback and failure reasons", () => {
  const PAGE = new Response("<html><body>Joe's Plumbing — serving Dayton</body></html>", {
    status: 200,
    headers: HEADERS,
  });

  it("retries scheme-less URLs over http when https fails", async () => {
    const fetchImpl = vi.fn((url: string) =>
      url.startsWith("https://")
        ? Promise.reject(new Error("ECONNREFUSED"))
        : Promise.resolve(PAGE.clone())
    );
    const site = await scrapeSite("joesplumbing.example", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(site.ok).toBe(true);
    expect(site.finalUrl).toMatch(/^http:\/\//);
    expect(site.text).toContain("Joe's Plumbing");
  });

  it("does NOT retry over http when the scheme was explicit", async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error("ECONNREFUSED")));
    const site = await scrapeSite("https://joesplumbing.example", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(site.ok).toBe(false);
    expect(site.failureReason).toBe("fetch_failed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports invalid_url and blocked_host reasons", async () => {
    expect((await scrapeSite("http://")).failureReason).toBe("invalid_url");
    expect((await scrapeSite("http://192.168.1.1")).failureReason).toBe("blocked_host");
  });
});
