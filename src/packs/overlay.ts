import { z } from "zod";

/**
 * The business overlay: everything the intake extractor learned about one
 * specific business from its website and the owner's free-text paragraphs.
 *
 * Hard rule: every extracted field carries evidence — a "website" quote or
 * "owner_text". No evidence, no field. A pricing override is only shareable
 * when the extractor found an actual published price, quote included.
 */

export const EvidenceSchema = z.object({
  source: z.enum(["website", "owner_text"]),
  /** The exact snippet the fact was extracted from. */
  quote: z.string().min(1).max(400),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const ServiceMentionSchema = z.object({
  /** The service as the site/owner described it. */
  text: z.string().min(1),
  /** Matched trade-pack service id, or null for a custom service. */
  tradeServiceId: z.string().min(1).nullable(),
  evidence: EvidenceSchema,
});

export const PricingOverrideSchema = z.object({
  /** Trade service this price applies to, or null for a general fee. */
  tradeServiceId: z.string().min(1).nullable(),
  /** What the price is for, in plain words ("service call", "drain cleaning"). */
  label: z.string().min(1),
  /** The price as published, e.g. "$89" or "$1,200-$1,800 installed". */
  priceText: z.string().min(1),
  /** May ONLY be true when the extractor found an actual published price —
      schema-enforced via the required evidence quote. */
  shareable: z.boolean(),
  evidence: EvidenceSchema,
});

export const BusinessOverlaySchema = z.object({
  businessName: z.string().min(1),
  tagline: z
    .object({ value: z.string().min(1), evidence: EvidenceSchema })
    .nullable()
    .optional(),
  servicesMentioned: z.array(ServiceMentionSchema).default([]),
  serviceArea: z
    .object({ value: z.string().min(1), evidence: EvidenceSchema })
    .nullable()
    .optional(),
  hours: z
    .object({ value: z.string().min(1), evidence: EvidenceSchema })
    .nullable()
    .optional(),
  toneNotes: z.string().nullable().optional(),
  pricingOverrides: z.array(PricingOverrideSchema).default([]),
  extraRedlines: z
    .array(z.object({ id: z.string().min(1), rule: z.string().min(1) }))
    .default([]),
  emergencyContactNote: z.string().nullable().optional(),
});

export type ServiceMention = z.infer<typeof ServiceMentionSchema>;
export type PricingOverride = z.infer<typeof PricingOverrideSchema>;
export type BusinessOverlay = z.infer<typeof BusinessOverlaySchema>;
