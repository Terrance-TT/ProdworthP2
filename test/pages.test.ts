import { describe, it, expect } from "vitest";
import { chatPage } from "../src/web/pages.js";
import type { Session } from "../src/playground/session.js";

function fakeSession(id: string): Session {
  return { id, pack: { businessName: "Test Co" } } as unknown as Session;
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
