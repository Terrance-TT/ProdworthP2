import OpenAI from "openai";
import { z } from "zod";
import type { AppConfig } from "../config.js";

/**
 * OpenAI-compatible LLM client. The model is a perception and phrasing layer
 * ONLY: every call goes through generateStructured(), which forces JSON
 * output validated by a zod schema, with one retry that feeds the validation
 * error back to the model. If validation still fails, it throws — callers
 * must fall back to a safe deterministic message.
 *
 * DEMO_STUB_LLM=1 (stubMode) returns deterministic canned outputs keyed off
 * the [STATE:...] tag and the [RETRIEVED_SERVICES:...] / [FAQ_SNIPPET:...]
 * tags that prompts embed, so tests and the scripted demo run fully without
 * an API key. (Extraction stubbing lives in intake/extract.ts.)
 */
export class LlmClient {
  private readonly openai: OpenAI | null;
  private readonly model: string;
  private readonly stubMode: boolean;

  constructor(config: AppConfig["llm"]) {
    this.model = config.model;
    this.stubMode = config.stubMode;
    this.openai =
      !config.stubMode && config.apiKey
        ? new OpenAI({
            apiKey: config.apiKey,
            ...(config.baseURL ? { baseURL: config.baseURL } : {}),
          })
        : null;
  }

  get isLive(): boolean {
    return this.openai !== null;
  }

  async generateStructured<T extends z.ZodTypeAny>(
    schema: T,
    prompt: string
  ): Promise<z.infer<T>> {
    if (this.stubMode || this.openai === null) {
      return schema.parse(stubCompletion(prompt));
    }

    const jsonSchema = zodToJsonSchemaHint(schema);
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      {
        role: "system",
        content:
          "You output ONLY valid JSON matching this shape: " + jsonSchema,
      },
      { role: "user", content: prompt },
    ];

    for (let attempt = 0; attempt < 2; attempt++) {
      const completion = await this.openai.chat.completions.create({
        model: this.model,
        messages,
        response_format: { type: "json_object" },
        temperature: 0.2,
      });
      const raw = completion.choices[0]?.message?.content ?? "";
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw);
      } catch {
        parsedJson = undefined;
      }
      const result = schema.safeParse(parsedJson);
      if (result.success) return result.data;
      // One retry: feed the validation error back to the model.
      messages.push(
        { role: "assistant", content: raw },
        {
          role: "user",
          content: `Your JSON failed validation: ${result.error.message}. Return corrected JSON only.`,
        }
      );
    }
    throw new Error("LLM structured output failed validation after retry");
  }
}

/** Minimal human-readable shape hint derived from a zod object schema. */
function zodToJsonSchemaHint(schema: z.ZodTypeAny): string {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const fields = Object.entries(shape).map(([k, v]) => {
      let type = "string";
      if (v instanceof z.ZodNumber) type = "number";
      else if (v instanceof z.ZodBoolean) type = "boolean";
      else if (v instanceof z.ZodArray) type = "array";
      else if (v instanceof z.ZodEnum) type = v.options.join("|");
      else if (v instanceof z.ZodNullable || v instanceof z.ZodOptional) {
        const inner = v.unwrap() as z.ZodTypeAny;
        type =
          inner instanceof z.ZodEnum
            ? `${inner.options.join("|")} or null`
            : "string or null";
      }
      return `"${k}": ${type}`;
    });
    return `{ ${fields.join(", ")} }`;
  }
  return "a JSON value";
}

/* ------------------------- deterministic stub ------------------------- */

/**
 * Canned structured outputs keyed off the [STATE:xxx] tag that prompts.ts
 * embeds in every prompt. Deterministic: same conversation state + same
 * inbound text → same output. This is what makes the demo and tests run
 * without an API key.
 */
function stubCompletion(prompt: string): unknown {
  const state = /\[STATE:([a-z_]+)\]/.exec(prompt)?.[1] ?? "";
  const inbound = /Customer text: """([\s\S]*?)"""/.exec(prompt)?.[1] ?? "";
  const lower = inbound.toLowerCase();

  switch (state) {
    case "greeted": {
      // Grounded in the retrieval tags embedded in the prompt — the stub
      // never invents services the engine didn't retrieve.
      const servicesTag = /\[RETRIEVED_SERVICES:([^\]]*)\]/.exec(prompt)?.[1] ?? "";
      const services = servicesTag
        .split(";")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map((entry) => {
          const [id = "", name = ""] = entry.split("|");
          return { id, name };
        });
      const faqSnippet = /\[FAQ_SNIPPET:([^\]]*)\]/.exec(prompt)?.[1]?.trim();

      // Price fishing: never quote a number, defer to an on-site quote.
      if (/exact|total|how much|cost|price|charge|quote/.test(lower)) {
        return {
          intent: "question_answerable",
          service: null,
          question: inbound,
          draft_reply:
            "Every job's a little different, so the tech quotes the work on-site before anything starts — I can't give a firm number over text. Want me to get you on the schedule for a visit?",
        };
      }

      // Area / hours questions: answer from the slice when retrieval surfaced
      // the business's facts (formatSlice embeds them as labeled lines).
      const areaLine = /^Service area: (.+)\.$/m.exec(prompt)?.[1];
      if (areaLine && /where|based|located|area|cover|serve|come to|travel/.test(lower)) {
        return {
          intent: "question_answerable",
          service: null,
          question: inbound,
          draft_reply: `We serve ${areaLine}. Can I get you on the schedule?`,
        };
      }
      const hoursLine = /^Hours: (.+)\.$/m.exec(prompt)?.[1];
      if (hoursLine && /hour|open|close|weekend|when/.test(lower)) {
        return {
          intent: "question_answerable",
          service: null,
          question: inbound,
          draft_reply: `Our hours are ${hoursLine}. Want me to get you booked?`,
        };
      }

      // Generic booking intent with no service named ("can I schedule an
      // appointment") — book it; the engine resolves the fallback service.
      if (
        /schedul|appoint|book|come (out|over)|someone (out|over)|send (someone|a tech|a plumber)/.test(
          lower
        )
      ) {
        return {
          intent: "book_job",
          service: services.length > 0 ? services[0]!.name : null,
          question: null,
          draft_reply: "",
        };
      }

      // A question squarely about the business's services.
      if (/^(do|can|are) (you|we)\b/.test(lower) && services.length > 0) {
        const s = services[0]!;
        return {
          intent: "question_answerable",
          service: s.name,
          question: inbound,
          draft_reply: `Yes — ${s.name.toLowerCase()} is something we handle. Want me to get you on the schedule?`,
        };
      }

      // Generic question with a matched trade-pack FAQ: answer from the pack.
      if (faqSnippet && services.length === 0) {
        return {
          intent: "question_answerable",
          service: null,
          question: inbound,
          draft_reply: faqSnippet,
        };
      }

      // A problem statement or booking ask about a retrieved service.
      if (services.length > 0) {
        return {
          intent: "book_job",
          service: services[0]!.name,
          question: null,
          draft_reply: "",
        };
      }

      return {
        intent: "question_unanswerable",
        service: null,
        question: inbound,
        draft_reply:
          "Good question — I'll have the owner get back to you on that one.",
      };
    }

    case "qualified": {
      // Pick one of the offered slot labels, or ask for something else.
      const slotLabels = [...prompt.matchAll(/^\d+\.\s*"([^"]+)"/gm)].map(
        (m) => m[1]!
      );
      const wantsTime =
        /^(option )?[123]$|first|second|third|works|book|yes|ok|sure|am|pm|monday|tuesday|wednesday|thursday|friday/.test(
          lower.trim()
        );
      if (wantsTime && slotLabels.length > 0) {
        const idx = /2|second/.test(lower)
          ? 1
          : /3|third/.test(lower)
            ? 2
            : 0;
        const picked = slotLabels[Math.min(idx, slotLabels.length - 1)]!;
        return {
          picked_slot_label: picked,
          wants_booking: true,
          draft_reply: `Locked in for ${picked}. Just need your address and you're on the books.`,
        };
      }
      return {
        picked_slot_label: null,
        wants_booking: false,
        draft_reply:
          "No problem — if none of those work, just tell me a day that does and I'll check the schedule.",
      };
    }

    case "time_confirmed": {
      // Treat the whole inbound as the address.
      return {
        address: inbound.trim(),
        draft_reply:
          "You're all set — we'll see you then. We'll text you when we're on the way.",
      };
    }

    case "fallback":
      return {
        draft_reply:
          "Thanks for reaching out — someone from the team will follow up shortly.",
      };

    default:
      return {
        draft_reply:
          "Thanks for your message — the team will get back to you shortly.",
      };
  }
}
