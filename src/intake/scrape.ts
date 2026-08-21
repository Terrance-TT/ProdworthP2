/**
 * Website intake for the playground: fetch the given URL, strip HTML to
 * plain text, and optionally crawl up to 2 same-origin links that look like
 * services/about/contact pages. Deliberately minimal — no headless browser,
 * no HTML parser dependency; careful regex stripping is enough for the
 * brochure sites this demo targets. JS-rendered sites ship their content in
 * embedded JSON (ld+json, __NEXT_DATA__), which we parse without executing
 * any JavaScript. Any failure degrades to empty text so intake can proceed
 * with the owner's paragraphs alone.
 */

export interface ScrapedSite {
  ok: boolean;
  finalUrl: string;
  /** Combined plain text, capped at MAX_TEXT_CHARS. */
  text: string;
  pagesFetched: number;
  /** Why the scrape failed, when ok is false. */
  failureReason?: "invalid_url" | "blocked_host" | "fetch_failed";
}

export interface ScrapeOptions {
  /**
   * Demo-only escape hatch: allow fetching loopback/private/reserved hosts so
   * the keyless local demo can paste http://localhost:3200/demo-site. Wired
   * to config.exposeDemoSite in server.ts — never enable for real intake.
   */
  allowPrivateHosts?: boolean;
  /** Test hook: fetch implementation override. */
  fetchImpl?: typeof fetch;
}

const FETCH_TIMEOUT_MS = 10_000;
const MAX_TEXT_CHARS = 8_000;
// Real brochure sites routinely ship 300KB–1MB of HTML (page builders,
// inline SVG, tracking scripts). 2MB bounds memory without rejecting
// ordinary pages — the 8k *text* cap still applies after stripping.
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_CRAWL_LINKS = 2;
const INTERESTING_PATH =
  /service|about|contact|what-we-do|our-work|pricing|plumbing/i;

/**
 * SSRF guard: true when the hostname is loopback, private, link-local, or
 * otherwise reserved. Such hosts must never be fetched from user input — a
 * "business website" is always a public host. (WHATWG URL parsing normalizes
 * numeric hosts, so "2130706433" arrives here as "127.0.0.1".)
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.includes(":")) return isPrivateIPv6(host);
  return isPrivateIPv4(host);
}

function isPrivateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return (
    a === 0 || // "this host"
    a === 10 || // RFC 1918
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local (cloud metadata)
    (a === 172 && b >= 16 && b <= 31) || // RFC 1918
    (a === 192 && (b === 0 || b === 168)) || // protocol assignments / RFC 1918
    (a === 198 && (b === 18 || b === 19 || b === 51)) || // benchmarking / TEST-NET-2
    (a === 203 && b === 0) || // TEST-NET-3
    a >= 224 // multicast + reserved
  );
}

function isPrivateIPv6(host: string): boolean {
  if (host.startsWith("::ffff:")) return isPrivateIPv4(host.slice(7));
  if (host === "::" || host === "::1") return true;
  return (
    /^fe[89ab]/.test(host) || // fe80::/10 link-local
    /^f[cd]/.test(host) || // fc00::/7 unique-local
    host.startsWith("2001:db8:") // documentation prefix
  );
}

export async function scrapeSite(
  url: string,
  options: ScrapeOptions = {}
): Promise<ScrapedSite> {
  const allowPrivateHosts = options.allowPrivateHosts ?? false;
  const fetchImpl = options.fetchImpl ?? fetch;
  const empty = (failureReason: ScrapedSite["failureReason"]): ScrapedSite => ({
    ok: false,
    finalUrl: url,
    text: "",
    pagesFetched: 0,
    ...(failureReason ? { failureReason } : {}),
  });
  let normalized: URL;
  // Owners paste scheme-less URLs ("joescplumbing.com"); assume https first.
  const hadScheme = /^https?:\/\//i.test(url);
  try {
    normalized = new URL(hadScheme ? url : `https://${url}`);
  } catch {
    return empty("invalid_url");
  }
  if (!allowPrivateHosts && isPrivateHost(normalized.hostname)) {
    return empty("blocked_host");
  }

  let text = "";
  let pagesFetched = 0;
  let finalUrl = normalized.toString();

  const fetchOpts = { allowPrivateHosts, fetchImpl };
  let main = await fetchPage(normalized.toString(), fetchOpts);
  // Scheme-less URL + https failed → retry once over plain http (e.g. the
  // local demo, or a small business site with no TLS).
  if (!main && !hadScheme) {
    const httpUrl = new URL(`http://${url}`);
    if (allowPrivateHosts || !isPrivateHost(httpUrl.hostname)) {
      main = await fetchPage(httpUrl.toString(), fetchOpts);
      if (main) normalized = httpUrl;
    }
  }
  if (!main) return empty("fetch_failed");
  pagesFetched++;
  finalUrl = main.finalUrl;
  text += pageText(main.html);

  // Crawl up to 2 same-origin links that look like services/about/contact.
  if (text.length < MAX_TEXT_CHARS) {
    const origin = new URL(finalUrl).origin;
    const links = extractLinks(main.html, finalUrl)
      .filter((l) => l.url.origin === origin)
      .filter((l) => INTERESTING_PATH.test(l.url.pathname) || INTERESTING_PATH.test(l.anchorText))
      .filter((l) => l.url.toString() !== finalUrl);
    const seen = new Set<string>();
    const picked: URL[] = [];
    for (const l of links) {
      const key = l.url.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push(l.url);
      if (picked.length >= MAX_CRAWL_LINKS) break;
    }
    for (const link of picked) {
      if (text.length >= MAX_TEXT_CHARS) break;
      const page = await fetchPage(link.toString(), fetchOpts);
      if (!page) continue;
      pagesFetched++;
      text += "\n\n" + pageText(page.html);
    }
  }

  return {
    ok: true,
    finalUrl,
    text: text.slice(0, MAX_TEXT_CHARS),
    pagesFetched,
  };
}

async function fetchPage(
  url: string,
  options: { allowPrivateHosts: boolean; fetchImpl: typeof fetch }
): Promise<{ html: string; finalUrl: string } | null> {
  try {
    const res = await options.fetchImpl(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "user-agent": "ProdworthP2-Playground/0.1 (+demo)" },
    });
    if (!res.ok) return null;
    // SSRF: redirects may land anywhere — re-validate the final URL's host.
    const finalUrl = res.url || url;
    if (!options.allowPrivateHosts) {
      try {
        if (isPrivateHost(new URL(finalUrl).hostname)) return null;
      } catch {
        return null;
      }
    }
    const type = res.headers.get("content-type") ?? "";
    if (type && !/text\/html|application\/xhtml/i.test(type)) return null;
    // Never buffer an unbounded body: reject on declared length, and cap the
    // streamed bytes otherwise. The AbortSignal timeout still applies.
    const declared = Number(res.headers.get("content-length") ?? NaN);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      await res.body?.cancel();
      return null;
    }
    const html = await readBodyCapped(res, MAX_BODY_BYTES);
    if (html === null) return null;
    return { html, finalUrl };
  } catch {
    return null;
  }
}

/** Read a response body with a hard byte cap; over the cap → null (degrade). */
async function readBodyCapped(
  res: Response,
  maxBytes: number
): Promise<string | null> {
  if (!res.body) {
    const text = await res.text();
    return Buffer.byteLength(text, "utf8") <= maxBytes ? text : null;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Regex HTML→text: drop script/style, tags become spaces, decode the
    common entities, collapse whitespace. */
export function stripHtml(html: string): string {
  let s = html;
  s = s.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/\n\s*\n+/g, "\n");
  return s.trim();
}

/** stripHtml must never reject intake — any failure degrades to empty text. */
function safeStrip(html: string): string {
  try {
    return stripHtml(html);
  } catch {
    return "";
  }
}

/** Text from one HTML page: content recovered from embedded JSON first
    (JS-rendered sites ship their content as data), then stripped markup. */
function pageText(html: string): string {
  const json = extractEmbeddedJsonText(html);
  const stripped = safeStrip(html);
  return json ? `${json}\n${stripped}` : stripped;
}

/**
 * JS-rendered sites (Next.js, Wix, …) embed page content in JSON script
 * tags — <script type="application/ld+json"> and <script id="__NEXT_DATA__">.
 * Parse them and keep human-meaningful strings. No JavaScript is executed.
 */
export function extractEmbeddedJsonText(html: string): string {
  const re =
    /<script[^>]*(?:type="application\/ld\+json"|id="__NEXT_DATA__")[^>]*>([\s\S]*?)<\/script>/gi;
  const strings: string[] = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      collectStrings(JSON.parse(m[1]!), strings);
    } catch {
      // not valid JSON — skip the blob
    }
  }
  return [...new Set(strings)].join("\n");
}

function collectStrings(value: unknown, out: string[]): void {
  if (out.length > 500) return; // bound work on pathological payloads
  if (typeof value === "string") {
    const s = value.trim();
    // Keep strings a human would read; drop URLs, asset paths, ids, hex.
    if (
      s.length >= 15 &&
      s.length <= 500 &&
      s.includes(" ") &&
      /[a-zA-Z]/.test(s) &&
      !/^https?:\/\//.test(s) &&
      !/[\w-]+\.(css|js|png|jpe?g|svg|webp|woff2?)(\?|$)/.test(s) &&
      !/^[0-9a-f]{16,}$/i.test(s)
    ) {
      out.push(s);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectStrings(v, out);
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const cp = Number(n);
      // fromCodePoint throws RangeError outside [0, 0x10FFFF] — drop those.
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    });
}

function extractLinks(
  html: string,
  baseUrl: string
): Array<{ url: URL; anchorText: string }> {
  const out: Array<{ url: URL; anchorText: string }> = [];
  const re = /<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const url = new URL(m[1]!, baseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      url.hash = "";
      out.push({ url, anchorText: stripHtml(m[2] ?? "") });
    } catch {
      // skip malformed hrefs
    }
  }
  return out;
}
