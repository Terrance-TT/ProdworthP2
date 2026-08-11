/**
 * Website intake for the playground: fetch the given URL, strip HTML to
 * plain text, and optionally crawl up to 2 same-origin links that look like
 * services/about/contact pages. Deliberately minimal — no headless browser,
 * no HTML parser dependency; careful regex stripping is enough for the
 * brochure sites this demo targets. Any failure degrades to empty text so
 * intake can proceed with the owner's paragraphs alone.
 */

export interface ScrapedSite {
  ok: boolean;
  finalUrl: string;
  /** Combined plain text, capped at MAX_TEXT_CHARS. */
  text: string;
  pagesFetched: number;
}

const FETCH_TIMEOUT_MS = 10_000;
const MAX_TEXT_CHARS = 8_000;
const MAX_CRAWL_LINKS = 2;
const INTERESTING_PATH =
  /service|about|contact|what-we-do|our-work|pricing|plumbing/i;

export async function scrapeSite(url: string): Promise<ScrapedSite> {
  const empty: ScrapedSite = { ok: false, finalUrl: url, text: "", pagesFetched: 0 };
  let normalized: URL;
  try {
    normalized = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  } catch {
    return empty;
  }

  let text = "";
  let pagesFetched = 0;
  let finalUrl = normalized.toString();

  const main = await fetchPage(normalized.toString());
  if (!main) return empty;
  pagesFetched++;
  finalUrl = main.finalUrl;
  text += stripHtml(main.html);

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
      const page = await fetchPage(link.toString());
      if (!page) continue;
      pagesFetched++;
      text += "\n\n" + stripHtml(page.html);
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
  url: string
): Promise<{ html: string; finalUrl: string } | null> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "user-agent": "ProdworthP2-Playground/0.1 (+demo)" },
    });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (type && !/text\/html|application\/xhtml/i.test(type)) return null;
    const html = await res.text();
    return { html, finalUrl: res.url || url };
  } catch {
    return null;
  }
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

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
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
