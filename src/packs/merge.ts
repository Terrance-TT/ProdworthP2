import type {
  EmergencyScript,
  TerminologyEntry,
  TradePack,
} from "./tradePack.js";
import type { BusinessOverlay } from "./overlay.js";

/**
 * The merger: trade base pack ⊕ business overlay → the effective pack the
 * engine consumes. Pure — no I/O.
 *
 * Layering rules (see trade-packs/SCHEMA.md):
 * - Overlay wins on business facts (name, area, hours) and on pricing where
 *   it supplies an evidenced price for a service — shareable or not.
 * - Trade-pack price ranges stay non-shareable no matter what; a service's
 *   price only becomes shareable via an overlay pricing override with a
 *   shareable flag (which the overlay schema only allows with an evidence
 *   quote of an actual published price).
 * - Redlines ALWAYS union: the trade pack's platform redlines are included
 *   verbatim and an overlay can only add more, never remove or weaken.
 */

export interface EffectivePricing {
  /** The customer-shareable price text. Only set when shareable. */
  shareableText?: string;
  shareable: boolean;
  /** Internal context for the LLM prompt — never quoted to customers. */
  internalNote: string;
}

export interface EffectiveService {
  id: string;
  name: string;
  description: string;
  synonyms: string[];
  qualificationQuestions: string[];
  urgency: "routine" | "soon" | "emergency";
  pricing: EffectivePricing;
  /** True when the overlay's site/owner text mentioned this service. */
  mentionedByBusiness: boolean;
}

export interface GeneralPrice {
  /** What the price is for, in plain words ("service call"). */
  label: string;
  /** The price as published, e.g. "$89". */
  priceText: string;
  /** Quotable only when true (evidenced published price). */
  shareable: boolean;
  /** The exact snippet the price was extracted from. */
  evidenceQuote: string;
}

export interface EffectivePack {
  trade: string;
  businessName: string;
  tagline?: string;
  serviceArea?: string;
  hours?: string;
  toneNotes?: string;
  emergencyContactNote?: string;
  services: EffectiveService[];
  /** Prices not tied to a trade-pack service (general fees, or overrides
      referencing an unknown service id). Never silently dropped. */
  generalPricing: GeneralPrice[];
  /** Custom services the business offers that don't map to the trade pack. */
  customServices: string[];
  emergencyScripts: EmergencyScript[];
  terminologyMap: TerminologyEntry[];
  redlines: Array<{ id: string; rule: string }>;
  faq: Array<{ q: string; a: string }>;
}

export function mergePacks(
  trade: TradePack,
  overlay: BusinessOverlay
): EffectivePack {
  const mentionedIds = new Set(
    overlay.servicesMentioned
      .map((m) => m.tradeServiceId)
      .filter((id): id is string => id !== null)
  );

  const services: EffectiveService[] = trade.services.map((s) => {
    // An evidenced overlay pricing override wins for this specific service
    // regardless of shareable (SCHEMA.md: "Overlay pricing replaces
    // pricing_guidance"). Shareable → the published price becomes quotable.
    // Non-shareable → it still replaces the trade guidance as an
    // internal-only note; it must not vanish, and must never be quoted.
    const override = overlay.pricingOverrides.find(
      (p) => p.tradeServiceId === s.id
    );
    const pricing: EffectivePricing = override
      ? override.shareable
        ? {
            shareable: true,
            shareableText: override.priceText,
            internalNote: `Published by the business: "${override.evidence.quote}" (${override.evidence.source}). ${s.pricing_guidance.note}`,
          }
        : {
            shareable: false,
            internalNote: `Business-provided price (never share): ${override.priceText}. Evidence: "${override.evidence.quote}" (${override.evidence.source}).`,
          }
      : {
          shareable: false,
          internalNote: `${s.pricing_guidance.range_usd ? `Internal market range (never share): ${s.pricing_guidance.range_usd}. ` : ""}${s.pricing_guidance.note}`,
        };
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      synonyms: s.synonyms,
      qualificationQuestions: s.qualification_questions,
      urgency: s.urgency,
      pricing,
      mentionedByBusiness: mentionedIds.has(s.id),
    };
  });

  // Custom services: mentioned by the business but not mappable to the pack.
  const tradeIds = new Set(trade.services.map((s) => s.id));
  const customServices = overlay.servicesMentioned
    .filter((m) => m.tradeServiceId === null || !tradeIds.has(m.tradeServiceId))
    .map((m) => m.text);

  // General fees: pricing overrides with no (or an unknown) trade service id.
  // They don't map to a service, but they must not vanish — shareable ones
  // (e.g. a published "$89 service call") are quotable, the rest are
  // internal-only context.
  const generalPricing: GeneralPrice[] = overlay.pricingOverrides
    .filter((p) => p.tradeServiceId === null || !tradeIds.has(p.tradeServiceId))
    .map((p) => ({
      label: p.label,
      priceText: p.priceText,
      shareable: p.shareable,
      evidenceQuote: p.evidence.quote,
    }));

  // Redlines union by id — trade pack first so an overlay entry with the
  // same id can never weaken a platform rule.
  const redlineById = new Map<string, { id: string; rule: string }>();
  for (const r of trade.redlines) redlineById.set(r.id, r);
  for (const r of overlay.extraRedlines) {
    if (!redlineById.has(r.id)) redlineById.set(r.id, r);
  }

  const pack: EffectivePack = {
    trade: trade.trade,
    businessName: overlay.businessName,
    services,
    customServices,
    generalPricing,
    emergencyScripts: trade.emergency_scripts,
    terminologyMap: trade.terminology_map,
    redlines: [...redlineById.values()],
    faq: trade.faq,
  };
  if (overlay.tagline) pack.tagline = overlay.tagline.value;
  if (overlay.serviceArea) pack.serviceArea = overlay.serviceArea.value;
  if (overlay.hours) pack.hours = overlay.hours.value;
  if (overlay.toneNotes) pack.toneNotes = overlay.toneNotes;
  if (overlay.emergencyContactNote)
    pack.emergencyContactNote = overlay.emergencyContactNote;
  return pack;
}
