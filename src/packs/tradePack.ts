import { readFileSync } from "node:fs";
import YAML from "yaml";
import { z } from "zod";

/**
 * Zod schema for a trade pack YAML file (see trade-packs/SCHEMA.md). This is
 * the shared base layer: trade knowledge only, no business-specific claims.
 * All pricing_guidance is market context with shareable: false.
 */

export const TradeServiceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  synonyms: z.array(z.string()).default([]),
  qualification_questions: z.array(z.string()).min(1),
  typical_duration_hours: z.string(),
  urgency: z.enum(["routine", "soon", "emergency"]),
  pricing_guidance: z.object({
    range_usd: z.string().optional(),
    shareable: z.literal(false), // always false in a trade pack
    note: z.string(),
  }),
});

export const EmergencyScriptSchema = z.object({
  name: z.string().min(1),
  trigger_keywords: z.array(z.string()).min(1),
  customer_instructions: z.string().min(1),
  book_emergency_visit: z.boolean(),
});

export const TerminologyEntrySchema = z.object({
  customer_says: z.string(),
  might_mean: z.array(z.string()).min(1),
  clarify_with: z.string(),
});

export const TradeRedlineSchema = z.object({
  id: z.string().min(1),
  rule: z.string().min(1),
});

export const TradePackSchema = z.object({
  trade: z.string().min(1),
  version: z.number().int(),
  description: z.string(),
  services: z.array(TradeServiceSchema).min(1),
  emergency_scripts: z.array(EmergencyScriptSchema).min(1),
  terminology_map: z.array(TerminologyEntrySchema).default([]),
  redlines: z.array(TradeRedlineSchema).min(1),
  faq: z.array(z.object({ q: z.string(), a: z.string() })).default([]),
  sources: z
    .array(z.object({ url: z.string(), used_for: z.string() }))
    .default([]),
});

export type TradeService = z.infer<typeof TradeServiceSchema>;
export type EmergencyScript = z.infer<typeof EmergencyScriptSchema>;
export type TerminologyEntry = z.infer<typeof TerminologyEntrySchema>;
export type TradePack = z.infer<typeof TradePackSchema>;

export function loadTradePack(path: string): TradePack {
  const raw = YAML.parse(readFileSync(path, "utf8"));
  const parsed = TradePackSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid trade pack at ${path}: ${parsed.error.message}`);
  }
  // Cross-check: every terminology_map id must reference a real service.
  const ids = new Set(parsed.data.services.map((s) => s.id));
  for (const entry of parsed.data.terminology_map) {
    for (const id of entry.might_mean) {
      if (!ids.has(id)) {
        throw new Error(
          `Trade pack at ${path}: terminology_map entry "${entry.customer_says}" references unknown service id "${id}"`
        );
      }
    }
  }
  return parsed.data;
}
