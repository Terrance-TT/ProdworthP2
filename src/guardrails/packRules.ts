import type { EffectivePack } from "../packs/merge.js";
import { escapeRegExp, type RedlineRule } from "./redlines.js";

/**
 * Builds the deterministic RedlineRule set the filter enforces from the
 * merged pack. The pack's redlines are prose; this module turns the
 * machine-checkable ones into regex rules, and turns every emergency script
 * into a trigger rule (inbound keyword → mandatory verbatim reply).
 */

/** Dollar figures found in the pack's shareable, published prices. */
function shareableFigures(pack: EffectivePack): string[] {
  const figures: string[] = [];
  const texts = [
    ...pack.services
      .filter((s) => s.pricing.shareable && s.pricing.shareableText)
      .map((s) => s.pricing.shareableText!),
    ...pack.generalPricing.filter((g) => g.shareable).map((g) => g.priceText),
  ];
  for (const text of texts) {
    for (const m of text.matchAll(/\$\s*(\d[\d,]*(?:\.\d{2})?)/g)) {
      figures.push(m[1]!);
    }
  }
  return [...new Set(figures)];
}

export function buildPackRules(pack: EffectivePack): RedlineRule[] {
  const rules: RedlineRule[] = [];
  const has = (id: string) => pack.redlines.some((r) => r.id === id);
  const desc = (id: string) =>
    pack.redlines.find((r) => r.id === id)?.rule ?? id;

  // no_exact_quotes: any dollar figure that is NOT one of the business's
  // published shareable figures is forbidden in outbound text. (A published
  // figure may only ever be repeated verbatim by deterministic templates.)
  if (has("no_exact_quotes")) {
    const allowed = shareableFigures(pack).map(escapeRegExp);
    // An allowed figure only stays allowed when it stands alone — "$89.99"
    // or "$890" must not slip through on the back of a published "$89"
    // (a sentence-final period like "$89." is fine; a decimal digit isn't).
    const allowedLookahead =
      allowed.length > 0 ? `(?!(?:${allowed.join("|")})(?!\\d|\\.\\d))` : "";
    rules.push({
      id: "no_exact_quotes",
      description: desc("no_exact_quotes"),
      patterns: [
        `\\$\\s*${allowedLookahead}\\d[\\d,]*(\\.\\d{2})?`,
        `(?i)\\b${allowedLookahead}\\d[\\d,]*(\\.\\d{2})?\\s?(dollars|usd)\\b`,
      ],
    });
  }

  if (has("no_guarantees_or_warranties")) {
    rules.push({
      id: "no_guarantees_or_warranties",
      description: desc("no_guarantees_or_warranties"),
      patterns: [
        "(?i)\\bguarantee(d|s|ing)?\\b",
        "(?i)\\bwarrant(y|ies|ied|ying)\\b",
        "(?i)we promise",
      ],
    });
  }

  if (has("no_diagnosis_over_text")) {
    rules.push({
      id: "no_diagnosis_over_text",
      description: desc("no_diagnosis_over_text"),
      patterns: [
        "(?i)\\bit('?s| is) probably\\b",
        "(?i)\\bsounds like\\b",
        "(?i)that means your",
        "(?i)the problem is (probably|likely)",
      ],
    });
  }

  if (has("no_diy_repair_instructions")) {
    rules.push({
      id: "no_diy_repair_instructions",
      description: desc("no_diy_repair_instructions"),
      patterns: [
        "(?i)here'?s how to (fix|repair|unclog|thaw)",
        "(?i)you can (fix|repair|replace|unclog|thaw) it yourself",
      ],
    });
  }

  if (has("no_insurance_claims")) {
    rules.push({
      id: "no_insurance_claims",
      description: desc("no_insurance_claims"),
      patterns: [
        "(?i)insurance (will|won'?t|would|wouldn'?t) cover",
        "(?i)covered by (your )?insurance",
      ],
    });
  }

  if (has("no_licensing_claims")) {
    rules.push({
      id: "no_licensing_claims",
      description: desc("no_licensing_claims"),
      patterns: [
        "(?i)we'?re (fully )?(licensed|insured|bonded)",
        "(?i)licensed and insured",
        "(?i)license (number|#)",
      ],
    });
  }

  // no_invented_scheduling: the engine enforces this on LLM-controlled text
  // (draft replies, extracted addresses) via violatesLlmRule() BEFORE
  // composing the outbound message. It is llmOnly because the engine's own
  // deterministic slot offers ("Wed 8:00 AM") legitimately contain days and
  // times — running these patterns on the composed message would block them.
  if (has("no_invented_scheduling")) {
    rules.push({
      id: "no_invented_scheduling",
      description: desc("no_invented_scheduling"),
      llmOnly: true,
      patterns: [
        "(?i)\\b(mon|tues?|wed(nes)?|thurs?|fri|sat(ur)?|sun)(day)?\\b",
        "(?i)\\b\\d{1,2}(:\\d{2})?\\s?(am|pm)\\b",
        "(?i)\\b\\d{1,2}(:\\d{2})?\\s?o'?clock\\b",
        "(?i)\\b(tomorrow|tonight|this (morning|afternoon|evening))\\b",
        "(?i)\\bright away\\b",
        "(?i)\\b(as soon as possible|asap)\\b",
      ],
    });
  }

  // emergency_services_first is enforced by the trigger rules below —
  // deterministic, so it needs no draft patterns here.

  // Emergency scripts: inbound keyword → the script, verbatim. This is what
  // forces "I smell gas" → the gas safety script no matter what the LLM said.
  // Keywords match case-insensitively (per SCHEMA.md).
  for (const script of pack.emergencyScripts) {
    rules.push({
      id: `emergency:${script.name}`,
      description: `Emergency script: ${script.name}`,
      customerTriggers: script.trigger_keywords.map(
        (k) => `(?i)${escapeRegExp(k)}`
      ),
      mandatoryReply: script.customer_instructions.trim(),
    });
  }

  return rules;
}
