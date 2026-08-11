/**
 * Outbound redline filter. Deterministic regex/rule checks driven by the
 * merged knowledge pack — no LLM involvement. Every outbound message passes
 * through here before it is sent; a violation swaps in a safe fallback.
 *
 * Two kinds of rules:
 * - pattern rules: forbidden patterns in ANY outbound draft (exact prices
 *   that aren't published, guarantees, diagnoses, …).
 * - trigger rules: if the customer's inbound message matches, the ONLY
 *   permitted reply is the mandatory script (used for trade-pack emergency
 *   scripts, e.g. a suspected gas leak).
 */

export interface RedlineRule {
  id: string;
  description: string;
  /** Patterns forbidden in ANY outbound message. */
  patterns?: string[] | undefined;
  /** If the customer's inbound message matches one of these, the ONLY
      permitted reply is mandatoryReply. */
  customerTriggers?: string[] | undefined;
  mandatoryReply?: string | undefined;
}

export interface RedlineResult {
  allowed: boolean;
  /** Which rule was violated, if any. */
  violatedRuleId?: string;
  /** The message that must actually be sent (original if allowed). */
  safeBody: string;
  /** True when the reply was forcibly replaced (violation or emergency). */
  replaced: boolean;
}

export const SAFE_FALLBACK =
  "Sorry, I want to make sure you get accurate info — the owner will follow up with you directly.";

/** PCRE-style `(?i)` inline flags aren't valid JS — translate to RegExp flags. */
function compile(pattern: string): RegExp {
  let flags = "";
  let body = pattern;
  while (body.startsWith("(?i)") || body.startsWith("(?m)")) {
    if (body.startsWith("(?i)")) {
      flags += "i";
      body = body.slice(4);
    } else {
      flags += "m";
      body = body.slice(4);
    }
  }
  return new RegExp(body, flags);
}

/** Escape a string for literal use inside a RegExp. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class RedlineFilter {
  private readonly patternRules: Array<{
    id: string;
    regexes: RegExp[];
  }>;
  private readonly triggerRules: Array<{
    id: string;
    regexes: RegExp[];
    reply: string;
  }>;

  constructor(rules: RedlineRule[]) {
    this.patternRules = [];
    this.triggerRules = [];
    for (const rule of rules) {
      if (rule.customerTriggers && rule.mandatoryReply) {
        this.triggerRules.push({
          id: rule.id,
          regexes: rule.customerTriggers.map(compile),
          reply: rule.mandatoryReply,
        });
      }
      if (rule.patterns && rule.patterns.length > 0) {
        this.patternRules.push({
          id: rule.id,
          regexes: rule.patterns.map(compile),
        });
      }
    }
  }

  /**
   * If the customer's message triggers a mandatory script (e.g. gas smell),
   * that script is returned regardless of what was drafted. Otherwise the
   * draft is checked against every forbidden pattern.
   */
  check(draft: string, inboundText?: string): RedlineResult {
    if (inboundText !== undefined) {
      for (const rule of this.triggerRules) {
        if (rule.regexes.some((r) => r.test(inboundText))) {
          return {
            allowed: false,
            violatedRuleId: rule.id,
            safeBody: rule.reply,
            replaced: true,
          };
        }
      }
    }

    for (const rule of this.patternRules) {
      if (rule.regexes.some((r) => r.test(draft))) {
        return {
          allowed: false,
          violatedRuleId: rule.id,
          safeBody: SAFE_FALLBACK,
          replaced: true,
        };
      }
    }

    return { allowed: true, safeBody: draft, replaced: false };
  }
}
