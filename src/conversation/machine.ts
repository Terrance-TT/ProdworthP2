import { z } from "zod";

/**
 * The deterministic conversation state machine. Pure — no I/O, no imports
 * beyond zod. The LLM only proposes intents; every transition is validated
 * here in code, so the model can never control the flow.
 */

export const STATES = [
  "greeted",
  "intent_classified",
  "qualified",
  "time_proposed",
  "time_confirmed",
  "location_collected",
  "booked",
  "handoff_to_owner",
] as const;

export const StateSchema = z.enum(STATES);
export type State = z.infer<typeof StateSchema>;

export const EVENTS = [
  "intent_understood", // greeted → intent_classified
  "qualification_passed", // intent_classified → qualified
  "times_proposed", // qualified → time_proposed
  "time_picked", // time_proposed → time_confirmed
  "location_given", // time_confirmed → location_collected
  "booking_made", // location_collected → booked
  "handoff", // any state → handoff_to_owner
] as const;

export const EventSchema = z.enum(EVENTS);
export type Event = z.infer<typeof EventSchema>;

/** The allowed transition table. Everything else throws. */
const TRANSITIONS: Readonly<Record<State, Readonly<Record<string, State>>>> = {
  greeted: {
    intent_understood: "intent_classified",
    handoff: "handoff_to_owner",
  },
  intent_classified: {
    qualification_passed: "qualified",
    handoff: "handoff_to_owner",
  },
  qualified: {
    times_proposed: "time_proposed",
    handoff: "handoff_to_owner",
  },
  time_proposed: {
    time_picked: "time_confirmed",
    handoff: "handoff_to_owner",
  },
  time_confirmed: {
    location_given: "location_collected",
    handoff: "handoff_to_owner",
  },
  location_collected: {
    booking_made: "booked",
    handoff: "handoff_to_owner",
  },
  booked: {
    handoff: "handoff_to_owner",
  },
  handoff_to_owner: {},
};

export function transition(state: State, event: Event): State {
  const next = TRANSITIONS[state][event];
  if (next === undefined) {
    throw new Error(
      `Invalid transition: cannot apply event "${event}" in state "${state}"`
    );
  }
  return next;
}

export function canTransition(state: State, event: Event): boolean {
  return TRANSITIONS[state][event] !== undefined;
}
