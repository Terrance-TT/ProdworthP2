import type { z } from "zod";
import {
  retrieveSlice,
  formatSlice,
  ownerHandoffMessage,
  type KnowledgeSlice,
} from "../packs/retrieve.js";
import type { EffectivePack, EffectiveService } from "../packs/merge.js";
import { transition, type State } from "./machine.js";
import { getAvailability, type Slot } from "./availability.js";
import {
  GreetedOutputSchema,
  QualifiedOutputSchema,
  TimeConfirmedOutputSchema,
  greetedPrompt,
  proposeTimesPrompt,
  slotOfferDraft,
  collectLocationPrompt,
} from "./prompts.js";
import { SAFE_FALLBACK } from "../guardrails/redlines.js";
import type { Session, XRay } from "../playground/session.js";

const SLOT_COUNT = 3;

export interface EngineReply {
  reply: string;
  xray: XRay;
}

/** Structural interface — LlmClient satisfies this, tests inject fakes. */
export interface LlmLike {
  readonly isLive: boolean;
  generateStructured<T extends z.ZodTypeAny>(
    schema: T,
    prompt: string
  ): Promise<z.infer<T>>;
}

export interface EngineDeps {
  llm: LlmLike;
  now?: () => Date;
}

/**
 * Orchestrates one inbound text for one playground session: emergency check →
 * retrieval → LLM intent → deterministic transition → draft → redline filter.
 * The LLM never controls flow, never invents facts, and never states a time
 * that didn't come from the availability helper. Any LLM failure degrades to
 * a deterministic owner-handoff message.
 */
export class PlaygroundEngine {
  constructor(private readonly deps: EngineDeps) {}

  private get now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /** The receptionist's opening text after the simulated missed call. */
  greeting(pack: EffectivePack): string {
    return `Hi, this is ${pack.businessName} — sorry we missed your call. What can we help you with today?`;
  }

  async handleMessage(session: Session, text: string): Promise<EngineReply> {
    const pack = session.pack;
    session.transcript.push({ role: "customer", text });

    const xray: XRay = {
      state: session.state,
      retrievedServiceIds: [],
      redlineHits: [],
    };

    // 1. Emergency scripts fire deterministically, before any LLM call:
    //    the verbatim pack script is the ONLY permitted reply.
    const forced = session.filter.check("", text);
    if (forced.violatedRuleId?.startsWith("emergency:")) {
      const scriptName = forced.violatedRuleId.slice("emergency:".length);
      const script = pack.emergencyScripts.find((s) => s.name === scriptName);
      let reply = forced.safeBody;
      if (script?.book_emergency_visit) {
        reply +=
          "\n\nOnce you're safe, I can get someone out to you — just say the word.";
      }
      xray.redlineHits.push(forced.violatedRuleId);
      xray.emergencyScriptFired = scriptName;
      xray.state = session.state;
      session.transcript.push({ role: "receptionist", text: reply, xray });
      return { reply, xray };
    }

    // 2. Keyword retrieval over the merged pack (also feeds the x-ray).
    const slice = retrieveSlice(pack, text);
    xray.retrievedServiceIds = slice.services.map((s) => s.id);

    // 3. State dispatch.
    let draft: string;
    switch (session.state) {
      case "greeted":
        draft = await this.onGreeted(session, slice, text, xray);
        break;
      case "intent_classified":
      case "qualified":
      case "time_proposed":
        draft = await this.onTimeProposed(session, text, xray);
        break;
      case "time_confirmed":
        draft = await this.onTimeConfirmed(session, text, xray);
        break;
      case "location_collected":
      case "booked":
        draft = this.onBooked(session);
        break;
      case "handoff_to_owner":
        draft = ownerHandoffMessage(pack);
        break;
    }

    // 4. The redline filter is the last thing every outbound message
    //    passes through.
    const result = session.filter.check(draft, text);
    if (result.replaced && result.violatedRuleId) {
      xray.redlineHits.push(result.violatedRuleId);
    }
    const reply = result.safeBody;
    xray.state = session.state;
    session.transcript.push({ role: "receptionist", text: reply, xray });
    return { reply, xray };
  }

  /* ------------------------------ states ------------------------------ */

  private async onGreeted(
    session: Session,
    slice: KnowledgeSlice,
    text: string,
    xray: XRay
  ): Promise<string> {
    const { llm } = this.deps;
    const pack = session.pack;

    let out;
    try {
      out = await llm.generateStructured(
        GreetedOutputSchema,
        greetedPrompt(pack, formatSlice(pack, slice), text)
      );
    } catch {
      return this.handoff(session);
    }

    if (out.intent === "question_unanswerable" || out.intent === "other") {
      return this.handoff(session);
    }

    if (out.intent === "book_job") {
      // The model may only name a service the pack actually has; retrieval
      // is the fallback source of truth, then the general diagnostic visit.
      const known = this.resolveService(pack, out.service, slice);
      if (!known) return this.handoff(session);

      // greeted → intent_classified → qualified → time_proposed, in code.
      let state = transition(session.state, "intent_understood");
      state = transition(state, "qualification_passed");
      const slots = getAvailability(this.now, SLOT_COUNT);
      state = transition(state, "times_proposed");
      session.state = state;

      const priceNote =
        known.pricing.shareable && known.pricing.shareableText
          ? ` Published price for that: ${known.pricing.shareableText}.`
          : "";
      return `We can help with ${known.name.toLowerCase()}.${priceNote} ${slotOfferDraft(slots)}`;
    }

    // question_answerable: allowed only when retrieval actually surfaced
    // something — the model is never allowed to improvise facts.
    const hasFacts =
      slice.services.length > 0 ||
      slice.faqAnswer !== undefined ||
      (slice.mentionsArea && pack.serviceArea !== undefined) ||
      (slice.mentionsHours && pack.hours !== undefined);
    if (!hasFacts) return this.handoff(session);
    // The model may not invent times in its free text either — check the
    // draft itself, not just the structured slot field.
    if (this.violatesScheduling(session, out.draft_reply)) {
      xray.redlineHits.push("no_invented_scheduling");
      return SAFE_FALLBACK;
    }
    return out.draft_reply;
  }

  private async onTimeProposed(
    session: Session,
    text: string,
    xray: XRay
  ): Promise<string> {
    const { llm } = this.deps;
    const pack = session.pack;

    // Availability is recomputed, never remembered from an LLM utterance.
    const slots = getAvailability(this.now, SLOT_COUNT);
    let out;
    try {
      out = await llm.generateStructured(
        QualifiedOutputSchema,
        proposeTimesPrompt(pack, slots, text)
      );
    } catch {
      return this.handoff(session);
    }

    if (out.wants_booking && out.picked_slot_label) {
      // Hard validation: the picked time must be one we actually offered.
      const slot: Slot | undefined = slots.find(
        (s) => s.label === out.picked_slot_label
      );
      if (!slot) {
        // The model tried to invent a time — refuse and re-offer real slots.
        return `Sorry, that time isn't available. ${slotOfferDraft(slots)}`;
      }
      session.pickedSlot = slot;
      // Walk the machine from wherever the conversation actually is to
      // time_confirmed — every hop validated, none skippable.
      let state = session.state;
      if (state === "intent_classified")
        state = transition(state, "qualification_passed");
      if (state === "qualified") state = transition(state, "times_proposed");
      state = transition(state, "time_picked");
      session.state = state;
      return `Great, you're pencilled in for ${slot.label}. What's the service address?`;
    }

    // The draft is LLM free text: an invented time here would ride alongside
    // the real slot offer, so check it before composing.
    if (this.violatesScheduling(session, out.draft_reply)) {
      xray.redlineHits.push("no_invented_scheduling");
      return SAFE_FALLBACK;
    }
    return `${out.draft_reply} ${slotOfferDraft(slots)}`;
  }

  private async onTimeConfirmed(
    session: Session,
    text: string,
    xray: XRay
  ): Promise<string> {
    const { llm } = this.deps;
    const pack = session.pack;
    const slot = session.pickedSlot;
    if (!slot) return this.handoff(session);

    let out;
    try {
      out = await llm.generateStructured(
        TimeConfirmedOutputSchema,
        collectLocationPrompt(pack, slot, text)
      );
    } catch {
      return this.handoff(session);
    }

    if (!out.address || out.address.trim().length < 5) {
      return "Sorry, I didn't catch an address there — what's the street address for the visit?";
    }

    // An "address" is model-extracted text — a model can smuggle an invented
    // arrival time into it. Refuse and re-ask rather than booking it in.
    if (this.violatesScheduling(session, out.address)) {
      xray.redlineHits.push("no_invented_scheduling");
      return "Sorry, I need just the street address — what's the address for the visit?";
    }

    // time_confirmed → location_collected → booked, in code.
    let state = transition(session.state, "location_given");
    state = transition(state, "booking_made");
    session.state = state;

    xray.note =
      "In the real product, this appointment now lands on the business's calendar and dashboard.";
    return `You're booked — ${slot.label} at ${out.address.trim()}. We'll text you when we're on the way. Thanks for choosing ${pack.businessName}.`;
  }

  private onBooked(session: Session): string {
    const when = session.pickedSlot?.label ?? "your appointment";
    return `You're all set for ${when}. If anything changes, just text this number.`;
  }

  /* ----------------------------- helpers ------------------------------ */

  /**
   * Checks LLM-controlled text (draft replies, extracted addresses) against
   * the pack's no_invented_scheduling rule. Deterministic engine text (slot
   * offers, confirmations) is never checked — it only states times that came
   * from the availability helper.
   */
  private violatesScheduling(session: Session, text: string): boolean {
    // The business's published hours legitimately contain times ("Mon–Fri
    // 7am–6pm") — repeating pack facts verbatim is not inventing an
    // appointment. Exempt the exact known string before checking.
    const hours = session.pack.hours;
    const scrubbed = hours ? text.replace(hours, "") : text;
    return session.filter.violatesLlmRule(scrubbed, "no_invented_scheduling");
  }

  private resolveService(
    pack: EffectivePack,
    named: string | null,
    slice: KnowledgeSlice
  ): EffectiveService | undefined {
    if (named) {
      const n = named.toLowerCase();
      const match = pack.services.find(
        (s) => s.name.toLowerCase() === n || s.id.toLowerCase() === n
      );
      if (match) return match;
    }
    if (slice.services.length > 0) return slice.services[0];
    // A booking ask we couldn't map: the general diagnostic visit is the
    // correct, honest outcome — never guess at a specific service.
    return pack.services.find((s) => s.id === "general_plumbing_diagnostic");
  }

  private handoff(session: Session): string {
    session.state = transition(session.state, "handoff");
    return ownerHandoffMessage(session.pack);
  }
}
