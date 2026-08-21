import { describe, it, expect } from "vitest";
import { SessionStore, type Session } from "../src/playground/session.js";

const init = {
  sourceUrl: "http://example.com",
  scrape: { ok: true, pagesFetched: 1, charsRead: 500 },
  pack: {} as Session["pack"],
  overlay: {} as Session["overlay"],
  filter: {} as Session["filter"],
  state: "greeted" as const,
};

describe("SessionStore", () => {
  it("creates and returns sessions", () => {
    const store = new SessionStore();
    const s = store.create(init);
    expect(s.id).toMatch(/^[0-9a-f]{8}$/);
    expect(store.get(s.id)).toBe(s);
    expect(store.get("nope")).toBeUndefined();
  });

  it("expires sessions after the TTL (lazy eviction on get)", () => {
    let t = 1_000_000;
    const store = new SessionStore({ ttlMs: 1_000, now: () => t });
    const s = store.create(init);
    expect(store.get(s.id)).toBe(s);
    t += 1_001;
    expect(store.get(s.id)).toBeUndefined();
  });

  it("evicts expired sessions on create", () => {
    let t = 0;
    const store = new SessionStore({ ttlMs: 1_000, now: () => t });
    const old = store.create(init);
    t += 5_000;
    store.create(init);
    expect(store.get(old.id)).toBeUndefined();
  });

  it("retries id generation until the id is unique", () => {
    const ids = ["deadbeef", "deadbeef", "cafebabe"];
    const store = new SessionStore({ idGenerator: () => ids.shift()! });
    const first = store.create(init);
    const second = store.create(init);
    expect(first.id).toBe("deadbeef");
    expect(second.id).toBe("cafebabe");
    expect(store.get("deadbeef")).toBe(first);
    expect(store.get("cafebabe")).toBe(second);
  });
});
