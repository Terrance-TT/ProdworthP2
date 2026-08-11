# ProdworthP2

Self-serve onboarding and AI playground for the **Prodworth receptionist platform** — an AI receptionist for home-services businesses that turns missed calls into booked appointments (missed call → SMS conversation → appointment on the calendar).

ProdworthP2 is where a new trade or business gets stood up: pick a trade pack, layer on business details, and test conversations against the receptionist before going live.

## Trade packs

The receptionist is only allowed to say things grounded in a **knowledge pack**, and deterministic guardrails check its output. A **trade pack** is the shared base layer for one trade — the services, dispatcher-style triage questions, emergency safety scripts, terminology translations, redlines, and FAQs that are true for *every* business in that trade. It contains no business-specific claims.

- `trade-packs/plumbing.yaml` — residential plumbing (first pack)
- `trade-packs/SCHEMA.md` — the format; follow it for HVAC, electrical, roofing, etc.

## Layering

```
trade base pack  ⊕  business overlay  →  effective pack
```

- **Trade base pack** (this repo): trade knowledge, national-market context, platform redlines.
- **Business overlay** (per business, at onboarding): their services, prices, service area, hours, policies. Overlay entries override base services by `id`; new entries append.
- **Redlines always union.** An overlay can add constraints but can never remove or weaken a trade-pack redline (no exact quotes, no diagnoses over text, emergency services first, etc.).
- Trade-pack price ranges are market context only (`shareable: false`) and are never quoted to customers; a business opts in by supplying its own shareable numbers.

## The playground app

A standalone, self-serve demo: paste a plumbing business's website (plus optional owner paragraphs), get a live SMS-style chat with "their" AI receptionist after a simulated missed call. No accounts, no telephony, no P1 integration.

```
npm install
npm start                    # http://localhost:3200
DEMO_STUB_LLM=1 npm start    # keyless deterministic demo (also serves /demo-site)
npm test                     # vitest: merger, overlay schema, engine loop
npm run typecheck
```

Live mode uses the Kimi API (Moonshot, OpenAI-compatible): set `KIMI_API_KEY` (or `OPENAI_API_KEY`); override with `OPENAI_BASE_URL` / `MODEL`.

### How the layering works in code

- `src/packs/tradePack.ts` — zod-validated loader for `trade-packs/*.yaml` (the shared base layer).
- `src/intake/scrape.ts` + `src/intake/extract.ts` — fetch + strip the site (10s timeout, ≤2 same-origin services/about/contact pages, ~8k chars), then build the **business overlay** (every field carries an evidence quote; stub mode uses a deterministic regex extractor that only lifts facts actually present).
- `src/packs/merge.ts` — pure merger: trade base ⊕ overlay → effective pack. Overlay wins on business facts; redlines always union; trade pricing stays non-shareable unless the overlay has an evidenced, published price.
- `src/conversation/` — deterministic state machine + engine (the LLM proposes intents only; slots come from a tiny availability helper and are exact-match validated). Every reply passes `src/guardrails/` — pattern redlines (no unpublished dollar figures, no guarantees, no diagnoses) and trigger redlines that force emergency scripts verbatim.
- Every AI reply carries an **x-ray** (`state`, `retrievedServiceIds`, `redlineHits`, `emergencyScriptFired?`) rendered in the chat page's "why did it say that?" panel.

See `demo-p2-transcript.txt` for a captured keyless run.
