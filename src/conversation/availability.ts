/**
 * Tiny built-in availability helper for the playground. Deterministic — the
 * ONLY source of proposed times. The LLM can never invent availability; it
 * may only pick from these labels, and the engine validates exact matches.
 *
 * In the real product this is the business's actual calendar. Here it's a
 * fixed pattern: weekdays at 8 AM, 11 AM, and 2 PM, starting tomorrow.
 */

export interface Slot {
  /** Human label, e.g. "Tue 8:00 AM". This is the exact-match key. */
  label: string;
  start: Date;
}

const SLOT_HOURS = [8, 11, 14];
const DAY_FMT = new Intl.DateTimeFormat("en-US", { weekday: "short" });

export function getAvailability(from: Date, count: number): Slot[] {
  const slots: Slot[] = [];
  const day = new Date(from.getTime());
  day.setDate(day.getDate() + 1); // earliest slot is tomorrow
  day.setHours(0, 0, 0, 0);

  let guard = 0;
  while (slots.length < count && guard++ < 30) {
    const dow = day.getDay();
    if (dow >= 1 && dow <= 5) {
      // Monday–Friday only
      for (const hour of SLOT_HOURS) {
        if (slots.length >= count) break;
        const start = new Date(day.getTime());
        start.setHours(hour, 0, 0, 0);
        const ampm = hour < 12 ? "AM" : "PM";
        const h12 = hour % 12 === 0 ? 12 : hour % 12;
        slots.push({
          label: `${DAY_FMT.format(start)} ${h12}:00 ${ampm}`,
          start,
        });
      }
    }
    day.setDate(day.getDate() + 1);
  }
  return slots;
}
