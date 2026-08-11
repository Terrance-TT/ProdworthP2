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
  for (const s of pack.services) {
    if (!s.pricing.shareable || !s.pricing.shareableText) continue;
    for (const m of s.pricing.shareableText.matchAll(/\$\s*(\d[\d,]*(?:\.\d{2})?)/g)) {
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
    const pricePattern =
      allowed.length > 0
        ? `\\$(?!(?:${allowed.join("|")})(?!\\d))\\s?\\d[\\d,]*(\\.\\d{2})?`
        : `\\$\\s?\\d[\\d,]*(\\.\\d{2})?`;
    rules.push({
      id: "no_exact_quotes",
      description: desc("no_exact_quotes"),
      patterns: [pricePattern],
    });
  }

  if (has("no_guarantees_or_warranties")) {
    rules.push({
      id: "no_guarantees_or_warranties",
      description: desc("no_guarantees_or_warranties"),
      patterns: [
        "(?i)\\bguarantee\\b",
        "(?i)\\bwarrant(y|ies)\\b",
        "(?i)we promise",
      ],
    });
  }

  if (has("no_diagnosis_over_text")) {
    rules.push({
      id: "no_diagnosis_over_text",
      description: desc("no_diagnosis_over_text"),
      patterns: [
        "(?i)it'?s probably",
        "(?i)sounds like (a|an|the) ",
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

  // no_invented_scheduling is enforced by exact-match slot validation in the
  // engine, and emergency_services_first by the trigger rules below — both
  // deterministic, so they need no draft patterns here.

  // Emergency scripts: inbound keyword → the script, verbatim. This is what
  // forces "I smell gas" → the gas safety script no matter what the LLM said.
  for (const script of pack.emergencyScripts) {
    rules.push({
      id: `emergency:${script.name}`,
      description: `Emergency script: ${script.name}`,
      customerTriggers: script.trigger_keywords.map(escapeRegExp),
      mandatoryReply: script.customer_instructions.trim(),
    });
  }

  return rules;
}
