import { z } from "zod";
import type { EffectivePack } from "../packs/merge.js";
import type { Slot } from "./availability.js";

/**
 * Per-state prompts. Every prompt carries a [STATE:xxx] tag (the stub LLM
 * keys off it) and is given ONLY the retrieved knowledge slice — never the
 * whole pack — so the model cannot parrot facts it wasn't shown.
 */

const COMMON_RULES = `Rules you must follow:
- You write short, plain SMS replies (1-2 sentences), the way a tradesperson texts.
- You may ONLY use facts listed below under "Known facts". If the answer is not there, set intent to "question_unanswerable".
- NEVER quote an exact or total price. You may repeat a published price ONLY when the facts mark it shareable, exactly as written.
- NEVER promise guarantees or warranties. NEVER give DIY repair instructions. NEVER diagnose the cause of a problem.
- NEVER state appointment times other than the ones explicitly offered to you.`;

export const GreetedOutputSchema = z.object({
  intent: z.enum([
    "book_job",
    "question_answerable",
    "question_unanswerable",
    "other",
  ]),
  service: z.string().nullable(),
  question: z.string().nullable(),
  draft_reply: z.string(),
});
export type GreetedOutput = z.infer<typeof GreetedOutputSchema>;

export function greetedPrompt(
  pack: EffectivePack,
  knowledgeSlice: string,
  inboundText: string
): string {
  return `[STATE:greeted]
You are the SMS receptionist for ${pack.businessName}, a ${pack.trade} business. A customer whose call was missed has texted in.

Known facts:
${knowledgeSlice || "(nothing relevant found in the knowledge pack)"}

${COMMON_RULES}

Customer text: """${inboundText}"""

Classify the customer's intent, name the service they want (exactly as listed under Known facts, or null), and draft a reply. If it's a job they want done, intent is "book_job". If you cannot answer from the facts, intent is "question_unanswerable".`;
}

export const QualifiedOutputSchema = z.object({
  picked_slot_label: z.string().nullable(),
  wants_booking: z.boolean(),
  draft_reply: z.string(),
});
export type QualifiedOutput = z.infer<typeof QualifiedOutputSchema>;

export function proposeTimesPrompt(
  pack: EffectivePack,
  slots: Slot[],
  inboundText: string
): string {
  return `[STATE:qualified]
You are the SMS receptionist for ${pack.businessName}. You offered the customer these appointment slots (the ONLY times that exist — you may never state any other time):
${slots.map((s, i) => `${i + 1}. "${s.label}"`).join("\n")}

${COMMON_RULES}

Customer text: """${inboundText}"""

If the customer picked or accepted a slot, set picked_slot_label to that slot's exact label string and wants_booking to true. Otherwise null/false and ask which works.`;
}

export function slotOfferDraft(slots: Slot[]): string {
  const list = slots.map((s, i) => `${i + 1}) ${s.label}`).join(", ");
  return `Here's what we have open: ${list}. Reply with 1, 2 or 3 and I'll get you booked.`;
}

export const TimeConfirmedOutputSchema = z.object({
  address: z.string(),
  draft_reply: z.string(),
});
export type TimeConfirmedOutput = z.infer<typeof TimeConfirmedOutputSchema>;

export function collectLocationPrompt(
  pack: EffectivePack,
  slot: Slot,
  inboundText: string
): string {
  return `[STATE:time_confirmed]
You are the SMS receptionist for ${pack.businessName}. The customer has an appointment pencilled in for ${slot.label} and was asked for the service address.

${COMMON_RULES}

Customer text: """${inboundText}"""

Extract the service address from their message and draft a short booking confirmation that mentions the appointment time.`;
}
