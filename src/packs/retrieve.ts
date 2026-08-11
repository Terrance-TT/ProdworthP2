import type { EffectivePack, EffectiveService } from "./merge.js";

/**
 * Keyword-based retrieval over the merged pack: returns only the slice
 * relevant to the customer's message. The LLM receives this slice and
 * nothing else, so it cannot parrot facts it was never shown.
 */

export interface KnowledgeSlice {
  /** Services relevant to the message, most specific first. */
  services: EffectiveService[];
  /** A matched trade-pack FAQ answer, if any. */
  faqAnswer?: { q: string; a: string };
  /** A terminology-map clarification for a confused lay term, if any. */
  terminologyClarification?: string;
  mentionsArea: boolean;
  mentionsHours: boolean;
}

function words(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
}

export function retrieveSlice(
  pack: EffectivePack,
  question: string
): KnowledgeSlice {
  const q = question.toLowerCase();

  // Score each service by keyword hits across name, synonyms, id, description.
  // Word matching is bidirectional (q word ⊇ haystack word or vice versa) so
  // "replaced" still matches "replace", "installed" matches "install".
  const qWords = words(q).filter((w) => w.length >= 4);
  const scored = pack.services
    .map((s) => {
      const haystack =
        `${s.id} ${s.name} ${s.synonyms.join(" ")} ${s.description}`.toLowerCase();
      const hWords = new Set(words(haystack).filter((w) => w.length >= 4));
      let score = 0;
      for (const w of qWords) {
        if (haystack.includes(w)) score++;
        else {
          for (const h of hWords) {
            if (w.includes(h) || h.includes(w)) {
              score++;
              break;
            }
          }
        }
      }
      // Exact synonym phrase match is a strong signal.
      for (const syn of s.synonyms) {
        if (syn.length >= 4 && q.includes(syn.toLowerCase())) score += 3;
      }
      if (q.includes(s.name.toLowerCase())) score += 3;
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  const services = scored.slice(0, 4).map((x) => x.s);

  // Best FAQ match by shared content words.
  let faqAnswer: KnowledgeSlice["faqAnswer"];
  let bestFaqScore = 0;
  for (const f of pack.faq) {
    const qWords = new Set(words(f.q));
    let score = 0;
    for (const w of words(q)) if (qWords.has(w)) score++;
    if (score > bestFaqScore && score >= 3) {
      bestFaqScore = score;
      faqAnswer = f;
    }
  }

  // Terminology map: first entry whose lay phrase appears in the message.
  let terminologyClarification: string | undefined;
  for (const entry of pack.terminologyMap) {
    const phrase = entry.customer_says.toLowerCase();
    if (phrase.length >= 4 && q.includes(phrase)) {
      terminologyClarification = entry.clarify_with;
      break;
    }
  }

  const mentionsArea =
    /area|cover|service (in|to)|town|city|come to|do you (go|travel)/.test(q) ||
    (pack.serviceArea !== undefined &&
      pack.serviceArea
        .toLowerCase()
        .split(/[^a-z]+/)
        .filter((w) => w.length >= 4)
        .some((t) => q.includes(t)));
  const mentionsHours =
    /hour|open|close|when are you|weekend|saturday|sunday/.test(q);

  const slice: KnowledgeSlice = { services, mentionsArea, mentionsHours };
  if (faqAnswer) slice.faqAnswer = faqAnswer;
  if (terminologyClarification)
    slice.terminologyClarification = terminologyClarification;
  return slice;
}

/** Renders a retrieved slice as prompt context for the LLM. The
    [RETRIEVED_SERVICES:...] / [FAQ_SNIPPET:...] tags are also what the stub
    LLM keys off in DEMO_STUB_LLM mode. */
export function formatSlice(
  pack: EffectivePack,
  slice: KnowledgeSlice
): string {
  const lines: string[] = [];
  lines.push(
    `[RETRIEVED_SERVICES:${slice.services.map((s) => `${s.id}|${s.name}`).join(";")}]`
  );
  if (slice.services.length > 0) {
    lines.push("Relevant services:");
    for (const s of slice.services) {
      lines.push(`- ${s.name}: ${s.description}`);
      lines.push(
        `  Price: ${
          s.pricing.shareable && s.pricing.shareableText
            ? `${s.pricing.shareableText} — published by the business; you may share it exactly as written, never as an exact total for their job`
            : "NOT shareable — say the tech quotes on-site before work starts; never state any number"
        }`
      );
      lines.push(
        `  Dispatcher questions you may ask: ${s.qualificationQuestions.slice(0, 3).join(" / ")}`
      );
    }
  }
  if (slice.faqAnswer) {
    lines.push(`[FAQ_SNIPPET:${slice.faqAnswer.a.replace(/\s+/g, " ")}]`);
    lines.push(`Related FAQ answer (from the trade pack): ${slice.faqAnswer.a}`);
  }
  if (slice.terminologyClarification) {
    lines.push(
      `Ask this clarifying question before booking: ${slice.terminologyClarification}`
    );
  }
  if (slice.mentionsArea && pack.serviceArea) {
    lines.push(`Service area: ${pack.serviceArea}.`);
  }
  if (slice.mentionsHours && pack.hours) {
    lines.push(`Hours: ${pack.hours}.`);
  }
  if (pack.customServices.length > 0) {
    lines.push(`Also offered by this business: ${pack.customServices.join(", ")}.`);
  }
  return lines.join("\n");
}

/** The fixed message used whenever the AI cannot answer from the pack. */
export function ownerHandoffMessage(pack: EffectivePack): string {
  return `Good question — I don't want to guess, so the owner of ${pack.businessName} will text you back directly to sort that out.`;
}
