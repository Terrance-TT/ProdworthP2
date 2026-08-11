import { randomUUID } from "node:crypto";
import type { EffectivePack } from "../packs/merge.js";
import type { BusinessOverlay } from "../packs/overlay.js";
import type { RedlineFilter } from "../guardrails/redlines.js";
import type { State } from "../conversation/machine.js";
import type { Slot } from "../conversation/availability.js";

/**
 * Playground sessions are in-memory only — no accounts, no persistence.
 * A session is one visitor texting one generated receptionist.
 */

export interface TranscriptEntry {
  role: "customer" | "receptionist";
  text: string;
  xray?: XRay;
}

export interface XRay {
  /** Conversation state after this reply. */
  state: State;
  /** Trade-pack service ids retrieval matched for this message. */
  retrievedServiceIds: string[];
  /** Redline rule ids that fired on this exchange. */
  redlineHits: string[];
  /** Emergency script name when one fired verbatim. */
  emergencyScriptFired?: string;
  /** Extra context, e.g. the booking completion note. */
  note?: string;
}

export interface Session {
  id: string;
  createdAt: Date;
  sourceUrl: string;
  pack: EffectivePack;
  overlay: BusinessOverlay;
  filter: RedlineFilter;
  state: State;
  pickedSlot?: Slot;
  transcript: TranscriptEntry[];
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  create(init: Omit<Session, "id" | "createdAt" | "transcript">): Session {
    const session: Session = {
      ...init,
      id: randomUUID().slice(0, 8),
      createdAt: new Date(),
      transcript: [],
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }
}
