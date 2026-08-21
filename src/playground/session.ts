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
  /** How website intake went — shown on the chat page so a failed scrape is
      visible instead of silent. */
  scrape: {
    ok: boolean;
    pagesFetched: number;
    /** Characters of readable text extracted; ~0 on a JS-rendered site. */
    charsRead: number;
    failureReason?: "invalid_url" | "blocked_host" | "fetch_failed";
  };
  pack: EffectivePack;
  overlay: BusinessOverlay;
  filter: RedlineFilter;
  state: State;
  pickedSlot?: Slot;
  transcript: TranscriptEntry[];
}

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1_000; // 2 hours

export interface SessionStoreOptions {
  /** Sessions expire after this long; eviction is lazy (on get/create). */
  ttlMs?: number;
  /** Test hook: id source; collisions are retried until unique. */
  idGenerator?: () => string;
  /** Test hook: clock. */
  now?: () => number;
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly ttlMs: number;
  private readonly idGenerator: () => string;
  private readonly now: () => number;

  constructor(options: SessionStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.idGenerator = options.idGenerator ?? (() => randomUUID().slice(0, 8));
    this.now = options.now ?? Date.now;
  }

  create(init: Omit<Session, "id" | "createdAt" | "transcript">): Session {
    this.evictExpired();
    let id = this.idGenerator();
    while (this.sessions.has(id)) id = this.idGenerator();
    const session: Session = {
      ...init,
      id,
      createdAt: new Date(this.now()),
      transcript: [],
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (this.isExpired(session)) {
      this.sessions.delete(id);
      return undefined;
    }
    return session;
  }

  private isExpired(session: Session): boolean {
    return this.now() - session.createdAt.getTime() > this.ttlMs;
  }

  private evictExpired(): void {
    for (const [id, session] of this.sessions) {
      if (this.isExpired(session)) this.sessions.delete(id);
    }
  }
}
