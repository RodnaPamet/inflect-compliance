# 2026-11-11 — Mastercard Agent Pay, Phase 0: access, the PCI line, the decisions

**Commit:** `feat(agentic): refuse card numbers as secrets in the harness contract (Agent Pay Phase 0)` on `wf/agent-pay-phase0`

Phase 0 of [`docs/ai-architecture/mastercard-agent-pay.md`](../ai-architecture/mastercard-agent-pay.md).
It records what Mastercard says a governance tool can reach (0.1), the three
owner decisions (0.2, 0.3, 0.5), the framework mapping Phase 3 files against
(0.4), and it lands the one piece of code Phase 0 owns: a card number is now
secret-shaped, so the harness contract refuses one like any other credential.

## Design

The PCI line is held by a refusal in code. `looksLikeSecret` in
`src/lib/agentic/harness-contract-rules.ts` now also asks
`containsCardNumber`, so every caller refuses a card number with no change of
its own:

- the harness contract's credential and endpoint references
  (`harness-contract.ts`, a Zod `refine`);
- the ingest's walk over every string of a verified report
  (`firstSecretShapedMember`, `SECRET_IN_REPORT: <path>`), which the reference
  scanner also runs before it signs (`packages/agent-harness-scanner/src/report.ts`);
- the IAM skills' evidence references (`iam-skill-outputs.ts`);
- the schema-issue describer, which falls back to the issue code when a Zod
  message would repeat one.

`firstSecretShapedMember` is now a thin call to `firstSecretShapedPath`, the
same walk over any JSON-shaped value. The walk also reads a NUMERIC member as
its digits, because a sixteen-digit PAN fits in a JSON number below 2^53.
Phase 1's spending-authority writer refuses its envelope through this walk, not
a copy, so the shapes stay one list.

A card number is a run of 13 to 19 digits that passes Luhn and whose first
digit is a payment-card major industry identifier (ISO/IEC 7812-1: 2 to 6),
written contiguously or grouped as cards are printed, with one separator kind
throughout (4-4-4-1..4, 4-4-4-1..4-1..3, and the 4-6-5 / 4-6-4 groupings of
American Express and Diners Club).

The value is read as tokens, maximal runs of ASCII letters and digits, and only
an all-digit token is a candidate or a group. Review found two defects in the
first cut, which bounded a run only by digits, `+` and `.`:

- **A hex digest was refused.** A decimal run between two hex letters was a
  candidate, and every report carries a `sha256:` manifest hash per tool; the
  review measured about 0.22% of random `sha256:` digests, 0.10% of SHA-1s and
  0.011% of UUIDs refused. A tool's hash is stable, so an unlucky one would have
  refused every scan of its estate. As tokens, a digest is one token with
  letters in it, and a population of 60,000 digests, SHA-1s and UUIDs (some of
  which hold exactly such a run) is refused nowhere. The cost: a PAN glued to a
  word (`card5555…`) is not found; one after `_`, `-`, `/`, `=` or a space is.
- **A printed card beside other numbers was missed.** The first cut refused a
  grouped candidate followed by a separator and a digit, so a card followed by
  its expiry or CVV, a second card, or an order number in front of it passed.
  Now each start and each grouping in a run of groups is tried. The cost: four
  space-separated 4-digit numbers that pass Luhn and start 2–6 are refused,
  and so may be an IBAN printed in groups, which is personal data (D-L1-1)
  with no place in a report either.

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/harness-contract-rules.ts` | `passesLuhn`, `containsCardNumber`; `looksLikeSecret` asks it |
| `src/lib/agentic/harness-contract.ts` | re-exports `containsCardNumber` beside the other rules |
| `src/lib/agentic/harness-findings.ts` | `firstSecretShapedPath`, the generic walk, numbers included; `firstSecretShapedMember` calls it |
| `tests/unit/agentic/card-numbers-are-refused-as-secrets.test.ts` | both directions, the report refusal, the generic walk |
| `docs/ai-architecture/mastercard-agent-pay.md` | Phase 0 sub-phases, decisions recorded as adopted, current state |

## Decisions

### The owner's decisions, recorded as adopted 2026-11-11

**Provenance.** These three were given to this workflow run as owner decisions
taken 2026-11-11, relayed by the coordinating session; no owner act is
recorded in this repository by this change. The master roadmap's decision
table (`docs/ai-architecture-roadmap.md`, "Decisions for the owner", rows
D-L1-8 to D-L1-10) is where the owner initials, and the coordinator owns that
file, so this change does not touch it. Until those rows read decided, the
child roadmap's boxes 0.2, 0.3 and 0.5 stay open and Phase 1 should not start
on the strength of this note alone. The code that holds D-L1-8 (below) is
right under the default too: the default for D-L1-8 is "adopt".

- **D-L1-8 — adopted.** Inflect never holds a payment credential, and its own
  agents never pay. No PAN, Agentic Token value, wallet key or payment
  credential of any kind is stored, processed or transmitted. Inflect records
  references and the envelope only. No funnel tool initiates a payment.
- **D-L1-9 — adopted.** Spending authority is a declared privilege on the
  register, reviewed by a second person (never the declarer, never the agent's
  owner) before activation. The envelope's fields:
  - `rail`: `AGENT_PAY_TOKEN`, `AP4M`, `OTHER`;
  - per-transaction limit and its currency (ISO 4217);
  - period budget and its period;
  - merchant scope: domains and merchant category codes;
  - expiry;
  - the consenting person, a member of the tenant;
  - the token requestor (the agent platform) and ITS token reference — the
    requestor's own identifier for the token, never the token value.
  No field may carry a credential: every value passes `firstSecretShapedPath`.
- **D-L1-10 — adopted.** Inflect reads and suspends at Mastercard only through
  a customer-owned connection on the external write ladder, read and suspend
  only, once API access exists. The trigger for Phase 4: written API access for
  at least one tenant's token requestor, plus a sandbox.

### 0.1 — What Mastercard offers a governance tool

**How this was read, and where access is gated.** From this session the
primary hosts did not resolve (`developer.mastercard.com` and
`www.mastercard.com` are outside the session's network allowlist), so no
Mastercard page was fetched. Every answer below comes from search results that
quote a NAMED primary page, and each row says which. Secondary sources are
marked as such. No conversation with Mastercard Developers has been held; that
is an owner act, and it is what turns the "not found" rows into answers.
Phase 0.1 therefore stays OPEN: what remains is to read these pages directly
and to put the open questions to Mastercard.

| Question | Answer | Source and basis |
| --- | --- | --- |
| Is there an Agent Pay API on Mastercard Developers? | Yes: a "Mastercard Agent Pay" product with a Quick Start Guide, API Basics, an API Reference (an OpenAPI spec, sandbox and production base URLs), the use cases Card Enrollment and Agentic Transaction Flow, and a Testing page. | [API Reference](https://developer.mastercard.com/mastercard-agent-pay/documentation/api-reference/), [Quick Start](https://developer.mastercard.com/mastercard-agent-pay/documentation/quick-start-guide/); search excerpts |
| Whose APIs are they? | The agent platform's, called the ACP (Agentic Commerce Provider). Card enrollment: the cardholder tokenizes a card, verifies identity and gets a reusable identity; the ACP **encrypts card data and calls the Cards API**. Then the Authentication API (a Mastercard-managed session) and the **Verifiable Intent Registration API**, through which the ACP registers the cardholder's intent. | [Card Enrollment](https://developer.mastercard.com/mastercard-agent-pay/documentation/use-cases/card-enrollment/), [Agentic Transaction Flow](https://developer.mastercard.com/mastercard-agent-pay/documentation/use-cases/agentic-transaction/), [Testing](https://developer.mastercard.com/mastercard-agent-pay/documentation/testing/); search excerpts |
| Token status | **Not found.** No endpoint for reading an agentic token's status surfaced. | — |
| Consent policy (Verifiable Intent) | The ACP **writes** it (registration). **No read** by a party other than the ACP was found. The Testing page covers registering an intent that exceeds delegated constraints, so the constraints are validated at registration. | Agentic Transaction Flow, Testing; search excerpts |
| Suspension | MDES Customer Service documents Token Life Cycle Management with a Token Suspend API (`/{id}/token/suspend`), framed for device-provisioned tokens and offered to issuers' customer service. **Whether it reaches an agentic token, and whether anyone but the issuer may call it, is not established.** Secondary sources say a cardholder revokes an agent's token in the issuer's app. | [Token Life Cycle Management](https://developer.mastercard.com/mdes-customer-service/documentation/use-cases/tokensuspend-use-case/); search excerpt. Revocation by cardholder: secondary (eco.com, stellagent.ai) |
| May a third party act for the token requestor? | **Not found.** Nothing public describes delegated access for a governance tool. This is the first question for Mastercard. | — |
| Agent Pay for Machines (AP4M) | Early access opened 2026-10-20: buyer- and seller-side APIs, a developer toolkit and a sandbox, built on x402 (an HTTP 402 answer; the merchant verifies the agent's signed payment voucher). A pilot, not commercially available; access by sign-up. **The early-access terms are not public.** | Mastercard press release (not fetched); [The Block](https://theblock.co/news/business/2026-10-20-mastercard-opens-early-access-to-ai-agent-payments-following-pilots-with-coinbase-base-and-cloudflare-421406), [Decrypt](https://decrypt.co/381373/mastercard-opens-up-ai-agent-payments-with-early-access-and-live-demo) (secondary) |
| Authentication scheme | OAuth 1.0a with the body-hash extension. A project's credentials are created with the OAuth 1.0a option, and **production access is requested from Mastercard** (the gate). The sibling Agent Suite for Merchants signs RSA-SHA256. | [API Basics](https://developer.mastercard.com/mastercard-agent-pay/documentation/api-basics/), Quick Start; search excerpts |
| Web Bot Auth tag | Agent Pay and Visa's Trusted Agent Protocol each add a tag to `Signature-Input` saying whether the agent is browsing or paying. A secondary source names them `agent-browser-auth` and `agent-payer-auth`; Cloudflare's own sample header shows `tag="web-bot-auth"`. **The exact Agent Pay values are not confirmed.** Signatures are RFC 9421, Ed25519. | [Cloudflare blog](https://blog.cloudflare.com/secure-agentic-commerce/) (read through search); tag values secondary ([ppc.land](https://ppc.land/cloudflare-partners-with-visa-and-mastercard-to-secure-ai-agent-shopping/)) |
| Key directory location | The verifier takes `keyid` from `Signature-Input` and fetches the key from the agent's public key directory, caching it. **Where Agent Pay's registered keys are published is not found.** Phase 2.4 must not assume a location. | Cloudflare blog (read through search) |

What the table settles for the roadmap, and what it does not:

- **The ACP role handles card data.** The documented enrollment has the agent
  platform encrypt card data and call the Cards API. That is the payer and
  platform role D-L1-8 declines; the governor role needs none of these APIs.
- **No governance read is documented.** Neither a token-status read nor a
  consent-policy read by a party other than the ACP was found. Phase 4 stays
  conditional, and its trigger (D-L1-10) is unchanged.
- **Phase 2 package names are not settled.** 2.1 adds Agent Pay and x402 client
  libraries to `FRAMEWORK_MARKERS` "by package names confirmed in 0.1". None was
  confirmed: Mastercard's API is OpenAPI-generated per client, so there may be
  no single package to recognise. x402 client packages are public and can be
  confirmed from their registries when Phase 2 starts.

### G2 — who Mastercard is to Inflect

Any later Mastercard call is the CUSTOMER's connection, made with the token
requestor's API credentials that the customer holds (D-L1-10), the way the
directory integrations are. Inflect does not become Mastercard's customer and
Mastercard does not become Inflect's sub-processor. Phase 2's key-directory
fetch reads a public document and sends no personal data, so it is not a
sub-processing either.

### 0.4 — Framework mapping for Phase 3

`AGENT_SPENDING_AUTHORITY_PER_AGENT` is filed against requirements the library
already holds:

| Library | Requirement | Why |
| --- | --- | --- |
| OWASP Agentic Top 10 | `ASI03` Identity and Privilege Abuse | spending authority is a privilege; the primary control |
| OWASP Agentic Top 10 | `ASI02` Tool Misuse and Exploitation | an undeclared payment capability found in code |
| EU AI Act | `Art.14` Human oversight | four eyes on every declaration and widening |
| SOC 2 | `CC6.1`, `CC6.2`, `CC6.3` | access granted, registered and changed under authorisation |
| DORA | `DORA.Art.9` Protection and prevention | for tenants that are financial entities |
| AIUC-1 | `B006` Prevent unauthorized AI agent actions | the envelope bounds what an agent may do |

`DORA.Art.28` (ICT third-party risk) was considered for the token requestor and
left out: the token requestor is the tenant's provider, and the per-agent
artefact evidences the agent's authority, not the tenant's vendor management.
**No PCI DSS library** (the default, adopted): Inflect is outside
cardholder-data scope and intends to stay there, and the PCI SSC's licence
makes the content a separate decision.

### The card-number shape

- **The first digit is restricted to 2 to 6.** About one digit run in ten
  passes Luhn. A millisecond timestamp, a Snowflake id and a microsecond clock
  all start with 1 today, so without the restriction one such id in ten in a
  report would be refused. The cost is MII 7, 8 and 9 (fleet cards, RuPay's 81
  and 82 range, national schemes), which no network Agent Pay or AP4M uses.
  Mastercard's own card ranges start with 2 or 5.
- **A run inside a longer run, after a `+`, or beside a decimal point is not a
  candidate**: a 21-digit GCP unique id, an E.164 phone number, an amount.
- **Grouping is the card's own.** A date range (`2026-11-11 2026-01-13` is
  sixteen digits that pass Luhn and start with 2) and a spaced phone number do
  not fall into 4-4-4 groups, so they pass.
- **It reports yes or no.** No caller can echo the number it found; the ingest
  names the member.
- **The existing register writer was not touched.** 0.2 asks for the shape on
  "every writer Phase 1 adds"; none exists yet. `RegisteredAgent`'s own writer
  stores names and descriptions a person types, and widening its refusals is a
  separate decision with its own tests.
