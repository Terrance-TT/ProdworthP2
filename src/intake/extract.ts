import type { LlmClient } from "../llm/client.js";
import type { TradePack } from "../packs/tradePack.js";
import {
  BusinessOverlaySchema,
  type BusinessOverlay,
} from "../packs/overlay.js";

export interface ExtractInput {
  /** Plain text scraped from the business website (may be empty). */
  siteText: string;
  /** The owner's free-text paragraphs from the intake form (may be empty). */
  ownerText: string;
  /** The URL the owner pasted (used as a name fallback). */
  url: string;
}

/**
 * Builds the business overlay. Live mode: one structured-output LLM call,
 * zod-validated, evidence quotes required. Stub mode (or any LLM failure):
 * a deterministic heuristic extractor that only lifts facts actually present
 * in the text — regex-found names, published prices, service mentions — so
 * the whole demo runs keyless and the "no evidence, no field" rule still
 * holds.
 */
export async function extractOverlay(
  llm: LlmClient,
  tradePack: TradePack,
  input: ExtractInput
): Promise<BusinessOverlay> {
  if (llm.isLive) {
    try {
      return await llm.generateStructured(
        BusinessOverlaySchema,
        extractionPrompt(tradePack, input)
      );
    } catch {
      // Fall through to the deterministic extractor — a thin overlay beats
      // a failed intake, and every field still carries real evidence.
    }
  }
  return heuristicOverlay(tradePack, input);
}

function extractionPrompt(tradePack: TradePack, input: ExtractInput): string {
  const serviceList = tradePack.services
    .map((s) => `${s.id} (${s.name})`)
    .join(", ");
  return `[STATE:extract]
You are extracting a business profile for an AI receptionist demo. Output ONLY facts actually present in the text below — every field needs an evidence quote copied verbatim from the text. If a fact is not in the text, omit it (null / empty array). Never guess.

Known trade services (map mentions to these ids where possible; leave tradeServiceId null for services not in this list):
${serviceList}

Rules:
- businessName: the business's name as written.
- servicesMentioned: services the text says the business offers, each with its evidence quote.
- pricingOverrides: ONLY prices actually published in the text (e.g. "$89 service call"). shareable must be true for those; never invent a price.
- serviceArea / hours / tagline: only if stated in the text.
- extraRedlines: only rules the owner explicitly wrote (e.g. "we never give phone quotes"), as {id, rule}.
- evidence.source is "website" for site text, "owner_text" for the owner's paragraphs.

WEBSITE TEXT:
"""
${input.siteText || "(site unavailable)"}
"""

OWNER PARAGRAPHS:
"""
${input.ownerText || "(none provided)"}
"""`;
}

/* -------------------- deterministic stub-mode extractor -------------------- */

/** Pull a sentence-ish window around a match, for use as an evidence quote. */
function quoteWindow(text: string, index: number, length: number): string {
  let start = index;
  while (start > 0 && !/[\n.!?]/.test(text[start - 1]!)) start--;
  let end = index + length;
  const limit = Math.min(text.length, index + length + 160);
  while (end < limit && !/[\n.!?]/.test(text[end]!)) end++;
  return text
    .slice(start, Math.min(end, start + 280))
    .replace(/\s+/g, " ")
    .trim();
}

function findIn(
  siteText: string,
  ownerText: string,
  re: RegExp
): { match: RegExpExecArray; source: "website" | "owner_text" } | null {
  const fromSite = re.exec(siteText);
  if (fromSite) return { match: fromSite, source: "website" };
  const fromOwner = re.exec(ownerText);
  if (fromOwner) return { match: fromOwner, source: "owner_text" };
  return null;
}

const NAME_RE =
  /([A-Z][\w'.]*(?: [\w'&.-]+){0,4} (?:Plumbing|Plumbers|Rooter|Mechanical|Heating(?: & Air)?))/;
const OWNER_NAME_RE =
  /(?:called|name(?:d)? is|we are|we're)\s+([A-Z][\w'& .-]{2,40}?)(?:[.,\n]|$)/;
const AREA_RE = /[Ss]erving\s+([A-Z][A-Za-z ,&-]{2,60}?)(?:\s+since|\s+for\s+over|\.|, and|\n|$)/;
const HOURS_RE =
  /((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Weekdays|Open|7 days)[^\n.]{0,50}(?:\d\s?(?:am|pm|AM|PM)|24\/7))/;
const PRICE_RE =
  /\$\d[\d,]*(?:\.\d{2})?(?:\s*(?:–|-|to)\s*\$?\d[\d,]*(?:\.\d{2})?)?/g;

export function heuristicOverlay(
  tradePack: TradePack,
  input: ExtractInput
): BusinessOverlay {
  const { siteText, ownerText } = input;
  const combined = `${siteText}\n${ownerText}`;
  const combinedLower = combined.toLowerCase();

  // Business name.
  let businessName: string | undefined;
  const nameHit = findIn(siteText, ownerText, NAME_RE);
  if (nameHit) businessName = nameHit.match[1];
  if (!businessName) {
    const ownerHit = OWNER_NAME_RE.exec(ownerText);
    if (ownerHit) businessName = ownerHit[1];
  }
  if (!businessName) {
    try {
      // Prepend https:// like scrapeSite does — a bare "host:port/path"
      // otherwise parses with an empty hostname ("localhost:" as scheme).
      const host = new URL(
        /^https?:\/\//i.test(input.url) ? input.url : `https://${input.url}`
      ).hostname.replace(/^www\./, "");
      businessName =
        host.split(".")[0]!.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    } catch {
      // fall through to the default below
    }
    if (!businessName) businessName = "Your Business";
  }

  // Services mentioned, mapped to trade ids via name/synonym hits.
  const servicesMentioned: BusinessOverlay["servicesMentioned"] = [];
  for (const service of tradePack.services) {
    const needles = [service.name, ...service.synonyms].filter(
      (n) => n.length >= 4 && !n.includes("(")
    );
    for (const needle of needles) {
      const idx = combinedLower.indexOf(needle.toLowerCase());
      if (idx === -1) continue;
      const source: "website" | "owner_text" =
        idx < siteText.length ? "website" : "owner_text";
      servicesMentioned.push({
        text: service.name,
        tradeServiceId: service.id,
        evidence: {
          source,
          quote: quoteWindow(combined, idx, needle.length),
        },
      });
      break; // one mention per service is enough
    }
  }

  // Service area and hours.
  const areaHit = findIn(siteText, ownerText, AREA_RE);
  const hoursHit = findIn(siteText, ownerText, HOURS_RE);

  // Published prices → shareable overrides, each with its evidence quote.
  const pricingOverrides: BusinessOverlay["pricingOverrides"] = [];
  for (const m of combined.matchAll(PRICE_RE)) {
    const idx = m.index ?? 0;
    const quote = quoteWindow(combined, idx, m[0].length);
    const windowLower = quote.toLowerCase();
    const service = tradePack.services.find((s) =>
      [s.name, ...s.synonyms]
        .filter((n) => n.length >= 4 && !n.includes("("))
        .some((n) => windowLower.includes(n.toLowerCase()))
    );
    if (service) {
      pricingOverrides.push({
        tradeServiceId: service.id,
        label: service.name,
        priceText: m[0],
        shareable: true,
        evidence: {
          source: idx < siteText.length ? "website" : "owner_text",
          quote,
        },
      });
    } else if (/service call|trip|diagnostic|visit/i.test(quote)) {
      // A published service-call fee maps to the general diagnostic visit.
      const diagnostic = tradePack.services.find(
        (s) => s.id === "general_plumbing_diagnostic"
      );
      pricingOverrides.push({
        tradeServiceId: diagnostic?.id ?? null,
        label: "Service call",
        priceText: m[0],
        shareable: true,
        evidence: {
          source: idx < siteText.length ? "website" : "owner_text",
          quote,
        },
      });
    } else {
      pricingOverrides.push({
        tradeServiceId: null,
        label: "Published price",
        priceText: m[0],
        shareable: true,
        evidence: {
          source: idx < siteText.length ? "website" : "owner_text",
          quote,
        },
      });
    }
  }

  // Owner-stated rules: "Rule:" at a line start OR after a sentence boundary
  // becomes an extra redline — the landing-page placeholder and the demo both
  // use the mid-line form ("…east side. Rule: we never give firm quotes…").
  // \brule\b keeps substrings like "ruled:" from matching.
  const RULE_RE = /(?:^|[.!?]\s+)rule\b\s*:\s*(.+)$/i;
  const extraRedlines: BusinessOverlay["extraRedlines"] = [];
  for (const line of ownerText.split("\n")) {
    const ruleMatch = RULE_RE.exec(line);
    if (ruleMatch) {
      const rule = ruleMatch[1]!.trim();
      extraRedlines.push({
        id: `owner_rule_${extraRedlines.length + 1}`,
        rule,
      });
    }
  }

  return BusinessOverlaySchema.parse({
    businessName,
    servicesMentioned,
    ...(areaHit
      ? {
          serviceArea: {
            value: areaHit.match[1]!.trim(),
            evidence: {
              source: areaHit.source,
              quote: quoteWindow(
                areaHit.source === "website" ? siteText : ownerText,
                areaHit.match.index ?? 0,
                areaHit.match[0].length
              ),
            },
          },
        }
      : {}),
    ...(hoursHit
      ? {
          hours: {
            value: hoursHit.match[1]!.trim(),
            evidence: {
              source: hoursHit.source,
              quote: quoteWindow(
                hoursHit.source === "website" ? siteText : ownerText,
                hoursHit.match.index ?? 0,
                hoursHit.match[0].length
              ),
            },
          },
        }
      : {}),
    pricingOverrides,
    extraRedlines,
  });
}
