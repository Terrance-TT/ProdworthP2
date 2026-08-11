# Trade Pack Schema

A trade pack is a YAML file containing the **shared, trade-level knowledge** for one home-services trade (plumbing, HVAC, electrical, roofing, …). It is the base layer every business in that trade gets; a per-business overlay merges on top to produce the effective pack the AI receptionist actually uses.

Two hard rules shape everything below:

1. **Trade packs contain trade knowledge only.** No business names, no claims about a specific company ("we're licensed", "we offer free estimates"), nothing a business would need to opt into.
2. **This is ground truth for a customer-facing system.** The LLM may only say things grounded in the pack, and guardrails check its output. A missing entry is acceptable; an unverified or wrong entry is a bug. If you can't verify a fact against a real source, leave it out.

## Top-level fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `trade` | string | yes | Lowercase trade identifier: `plumbing`, `hvac`, `electrical`, … |
| `version` | integer | yes | Bump on any content change. Overlays reference a base version. |
| `description` | string | yes | One paragraph: what the pack covers and its scope limits. |
| `services` | list | yes | 15–25 common residential jobs. See below. |
| `emergency_scripts` | list | yes | Safety scripts for life-safety and active-damage situations. |
| `terminology_map` | list | yes | Lay/confused customer terms → candidate service ids. |
| `redlines` | list | yes | Platform rules that can never be removed by an overlay. |
| `faq` | list | yes | Generic Q&A the AI can use when a business overlay is thin. |
| `sources` | list | yes | Every source actually consulted, with what it informed. |

## `services[]`

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | Snake_case, stable forever. Overlays and the terminology map reference these ids. Never reuse or rename an id. |
| `name` | string | yes | Human-readable job name. |
| `description` | string | yes | One or two sentences. Scope of the job, not marketing. |
| `synonyms` | list of strings | yes | Lay terms customers actually use, including common misnomers (e.g. "boiler" for water heater). These drive intent matching. |
| `qualification_questions` | list of strings | yes | 3–6 questions an experienced dispatcher would ask before booking. They must sort urgency, distinguish adjacent jobs (repair vs. replace), and flag safety issues. Written in plain texting English. |
| `typical_duration_hours` | string | yes | A range string, e.g. `"1-3"` or `"16-40 (2-5 days)"`. Used for scheduling expectations, not quoting. |
| `urgency` | enum | yes | `routine` (schedule at convenience), `soon` (next available, 24–48h), `emergency` (dispatch now). This is the *default* for the service; answers to qualification questions and emergency keywords can raise it. |
| `pricing_guidance` | object | yes | See below. |

### `services[].pricing_guidance`

| Field | Type | Required | Notes |
|---|---|---|---|
| `range_usd` | string | no | Broad **national** range, e.g. `"900-3,500 installed (national average, varies widely by region)"`. Always label it as a varying national average. Omit entirely if no reliable national data exists — do not guess. |
| `shareable` | boolean | yes | **Always `false` in a trade pack.** The ranges exist so the system understands the market; they are never quoted to customers. Businesses opt in with their own numbers in their overlay. |
| `note` | string | yes | What moves the price, data-quality caveats, or why no range is given. |

## `emergency_scripts[]`

The highest-stakes section. One entry per emergency scenario.

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | Scenario name, e.g. "Suspected gas leak". |
| `trigger_keywords` | list of strings | yes | Phrases that activate the script, matched case-insensitively against customer messages. Include misspellings and slang where realistic. |
| `customer_instructions` | string (block) | yes | **Immediate safety and damage-mitigation actions only**: evacuate, call 911, shut off the main valve, cut power at the breaker *only if safe to reach*. Never diagnostics ("it's probably…"), never repair or DIY instructions. Short sentences; this is read by a panicked person on a phone. |
| `book_emergency_visit` | boolean | yes | `false` when the correct first response is emergency services or a utility (gas leak = 911 first, not a booking). `true` when an emergency dispatch is the right next step after the safety steps. |

Authoring rules:

- Safety guidance must come from authoritative sources (utilities, fire departments, CPSC/NFPA/CDC/Red Cross) and be cited in `sources`.
- "Only if safe to reach / without stepping in water" qualifiers are mandatory wherever electrical shutoff is mentioned.
- Prohibitions ("never use an open flame") are allowed — they are safety information, not repair instructions.

## `terminology_map[]`

Maps confused lay terms to candidate services so the AI asks a clarifying question instead of guessing.

| Field | Type | Required | Notes |
|---|---|---|---|
| `customer_says` | string | yes | The phrase as a customer would type it. |
| `might_mean` | list of service ids | yes | One or more `services[].id` values. Must reference ids that exist in this pack. |
| `clarify_with` | string | yes | The exact clarifying question to ask. Short, friendly, texting tone. It should resolve *which* candidate service applies — or reveal the customer needs a different trade. |

## `redlines[]`

Behavioral constraints enforced by deterministic guardrails. **Redlines always union across layers**: a business overlay can add redlines but can never remove, weaken, or override a trade-pack redline.

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | Snake_case, stable. |
| `rule` | string | yes | One rule, stated as a "Never …" (or the positive equivalent). Must be machine-checkable in spirit — specific enough that a guardrail can be written against it. |

The standard platform set (see `plumbing.yaml` for canonical wording): no exact quotes, no diagnoses over text, no DIY repair instructions, no guarantees/warranties, no insurance-coverage claims, no licensing claims, no competitor disparagement, no invented scheduling, emergency services first for life-safety situations.

## `faq[]`

Generic questions the AI can answer even when the business overlay hasn't provided anything.

| Field | Type | Required | Notes |
|---|---|---|---|
| `q` | string | yes | The customer question. |
| `a` | string | yes | Neutral, non-committal phrasing. May state trade-general facts (e.g. water heater lifespans) but must **defer to the business** for anything business-specific (fees, hours, estimates): "I can check this company's policy for you." |

## `sources[]`

Honesty requirement. List **only what you actually consulted** while writing the pack — and everything you relied on.

| Field | Type | Required | Notes |
|---|---|---|---|
| `url` | string | yes | The page consulted. |
| `used_for` | string | yes | Which content it informed. If the data was thin (single regional source), say so here and in the relevant `note`. |

Preferred sources: trade publications, utility companies, government/safety bodies (CPSC, NFPA, CDC, Red Cross), established cost aggregators (HomeAdvisor, Angi, Homewyse, HomeGuide), manufacturer guidance, and major plumbing companies' dispatch/FAQ pages.

## Layering (informative)

```
trade base pack  ⊕  business overlay  →  effective pack
```

- Overlay services with matching `id` override the base entry; new ids append.
- `redlines` union; overlay can only add.
- Overlay pricing replaces `pricing_guidance` and may set `shareable: true`.
- Overlay may narrow `synonyms`/questions per business policy but cannot contradict emergency scripts.

The merge semantics are normative in the platform's loader documentation; this file defines the pack format itself.

## Validation checklist for new packs

- [ ] YAML parses cleanly.
- [ ] Every service has `synonyms`, ≥3 `qualification_questions`, `urgency`, and `pricing_guidance.shareable: false`.
- [ ] Every emergency script has `trigger_keywords`, safety-only instructions, and `book_emergency_visit`.
- [ ] Every `terminology_map[].might_mean` id exists in `services`.
- [ ] No price ranges presented as exact; all ranges labeled national/varying.
- [ ] `sources` lists everything consulted and nothing that wasn't.
