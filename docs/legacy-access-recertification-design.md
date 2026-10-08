# Legacy-application access recertification

> **Status: living design** — most of what is below the Roadmap heading is not built,
> but it is no longer *nothing*: Steps 0a, 0b, 3a and 6a have merged, and the
> normalisation library and the reconciliation engine now exist as described. Inflect
> still cannot see into a legacy application at all — there is no MCP client and no
> snapshot — so the pipeline has an engine and no input. The phases document's status
> table is the per-step authority; this banner only says that the heading no longer
> means "unbuilt". This document is the plan for reading legacy access tables through
> operator-hosted MCP servers and reconciling them against HR. The reconciliation
> engine is the critical path. The optional model step that follows it gets comparable
> detail, because in one of its modes it sends personal data to a third party.

Legacy applications are where access recertifications actually fail. SOC 2
CC6.2/CC6.3, NIS2 Art. 21(2)(i) and ISO/IEC 27001:2022 A.5.18 all ask the same
question — *does everyone who can get in still have a reason to?* — and the long tail
of in-house and vendor systems is where the honest answer is least known. Those
systems rarely speak SCIM, rarely store an email, and name people in whatever
convention their original developer picked: `jsmith`, `SMITH_J`, `john.smith2`,
`Smith, John (Contr.)`, `EMP10442`, or a Cyrillic display name.

The operator stands up **one MCP server per legacy application**. Inflect becomes an
**MCP client**: it reads each application's access table, keeps only the columns it
needs, reconciles every account against the HR roster, and puts the result in front
of a reviewer.

## Current state (true today)

### Recertification covers directories only

The connected access review (`src/app-layer/usecases/access-review-connected.ts`)
reads `ConnectedIdentityAccount`, the mirror that the identity sync writes for Okta,
Google Workspace, Microsoft Entra ID and Active Directory. Nothing else can be
recertified. The flow is also incomplete for the directories it does cover:

- **Connected decisions never render.** The review detail page renders only member
  decisions, so a connected campaign shows an empty table, and its Close button is
  enabled because zero decided equals zero total.
- **Closing produces no evidence.** The member flow writes a PDF with a content
  hash; the connected flow writes nothing an auditor can be handed.
- **Reminders and escalations ignore it.** They count member decisions only.
- **Duplicates merge silently.** Subjects are keyed `` `${a.provider}:${a.email}` ``
  under `skipDuplicates`, so two connections holding the same address collapse into
  one row.
- **The snapshot carries no HR context.** A reviewer is shown an account but not
  the employee it belongs to, their employment status or their manager — so the
  review cannot show that an account belongs to someone who has left.
- **The routes carry no permission key.** Creating and closing are gated by
  `assertCanAdmin` inside the usecase, which writes no `AUTHZ_DENIED` row on denial.

### Reconciliation is exact email, by design

`reconcileIdentityAccountLinks` (`src/app-layer/usecases/identity-account-link.ts`)
links a directory account to an employee on one rule: `emailKey()`
(`src/lib/identity/email-key.ts` — trim and lowercase) must match exactly one
employee's `workEmail`. Its header is explicit about why:

> EVERY AMBIGUITY RESOLVES TO NO LINK … It does not do fuzzy matching, name
> matching, or "closest match" scoring … An incorrect link, under JML, disables the
> wrong person's account — and does so with an audit trail asserting the offboarding
> succeeded. A missing link is a refusal that someone can see and fix. The two
> failure modes are not remotely symmetric, so every ambiguous case is resolved
> toward the visible one.

The method is recorded on every link as `IdentityLinkMethod`. Only `EMAIL_EXACT` is
ever written; `EXTERNAL_ID` and `MANUAL` are reserved and unused. Nothing in `src/`
reads the recorded method back.

**The rule is correct for directories and useless for legacy applications.** Every
example in the opening paragraph comes back `NO_EMPLOYEE`.

### The inputs a better matcher would need are thrown away

- **Names are flattened.** `Employee.fullName` is a single string. BambooHR supplies
  first and last name, OrangeHRM first, middle and last, Workday a legal and a
  preferred name; every one is joined into `fullName` and the parts are discarded.
- **Employee numbers are unreliable.** `Employee.externalId` falls back to
  `workEmail` when the HRIS has no employee number, so a value in that column does
  not prove a number exists. Nothing reads it.
- **`sAMAccountName` is fetched and dropped.** The Active Directory provider requests
  it and uses it only as a fallback for `email` and `displayName`.
  `identity-joiner-pass.ts` records that it is *"persisted NOWHERE."* UPN survives
  only as an `email` fallback.
- **An HR email change creates a new person.** `Employee` is unique on
  `(tenantId, workEmail)`, so an address change — a name change by marriage, for
  instance — upserts a new row, and the departure reconcile terminates the old one.

### Inflect is an MCP server, and since Step 1b also a client

The server half is unchanged. The client half is new and narrow:
`src/lib/mcp/client/` pulls a snapshot from a server speaking
`inflect-legacy-access/1` and refuses everything else.

It speaks exactly three methods — `initialize`, `notifications/initialized` and
`resources/read` — and `CLIENT_METHODS` exports that set so a test can assert the
request log against a closed list. It never calls a `tools/*` method, including when
a server advertises tools, which it is allowed to do.

Every request goes through `safeFetch` in an explicit branch, so the URL an operator
typed cannot reach a private address, a loopback, a link-local range, the metadata
endpoint, or a redirect. The client is registered in `SINKS` in
`tests/guards/ssrf-egress-coverage.test.ts`. The one unprotected path is an injected
`fetch` used by the tests, and a structural rule fails if any file under `src/`
supplies one.

Bodies are read through a byte-capped stream that aborts at the cap, never
`res.json()` — which has already allocated the whole body by the time a cap could be
checked. There are two independent deadlines, per-request and per-pull, because a
server that paginates slowly stays inside the first one forever.

`pullSnapshot` returns `{ manifest, rows, complete, reason }` and there is exactly
ONE `complete: true` in the module. A partial pull keeps the rows it read and says
so, which is what global rule 4 asks for: a truncated read is recorded with a named
reason and never reported as complete.

**What it does not do.** Nothing calls it yet — registering the `legacy-mcp` provider
is Step 1c and persisting a snapshot is Step 2a. So there is a contract, a reference
server, and a client, and no way to reach any of them from the product.


`src/lib/mcp/` implements the MCP wire format directly over streamable HTTP, without
`@modelcontextprotocol/sdk`, and exposes 14 tools and two resource kinds. There is no
client anywhere. `src/lib/mcp/loadable-tools.ts` says so — *"This product is an MCP
SERVER, not a client"* — and anticipates *"a future MCP CLIENT integration."*

Tool descriptions are already treated as attack surface: `src/lib/mcp/tool-manifest.ts`
and `src/lib/agentic/tool-manifest-store.ts` hash each description byte-for-byte and
drop any tool whose definition changes.

### Outbound requests to customer hosts are refused by default

`safeFetch` (`src/app-layer/automation/webhook-safety.ts`) resolves the host, refuses
any private, loopback, link-local, CGNAT, `.local` or `.internal` address, requires
`https:`, pins the connection to the vetted IP and refuses redirects. Its callers are
outbound webhooks and the SIEM audit stream. Integration providers otherwise use
`resilientFetch` plus per-vendor host allowlists. There is no relay or collector for
reaching private networks; Active Directory relies on the customer providing a path.

The repository has already refused one version of this feature.
`src/app-layer/integrations/allowed-host.ts` declines to treat a tenant-supplied
HTTPS base URL as customer infrastructure because it *"would hand any `admin.manage`
holder a fetch primitive aimed at an arbitrary https host."* Active Directory is
allowed an operator-supplied host only because it adds a connect-time address
assertion.

### Guards that do not yet exist

- **No single-write-seam guard for `IdentityAccountLink` or
  `ConnectedIdentityAccount`.** The rule is stated in `CLAUDE.md`; only `Employee`
  has a test enforcing it (`tests/guards/employee-status-single-write-seam.test.ts`).
- **`tests/guardrails/provider-fail-closed-coverage.test.ts` enumerates only check
  and HRIS providers.** A provider that only syncs is never checked.
- **`validateProviderConfig` passes an unclassified provider's `configJson` through
  unvalidated.**
- **Only one AI feature honours `aiResidency`.** Risk suggestions route to a local
  gateway under `LOCAL_ONLY`, pinned by `tests/guards/ai-residency-enforcement.test.ts`.
  Compliance posture, questionnaire autofill and vendor-document extraction do not.

### The reconciliation engine exists, and nothing calls it yet

`src/lib/identity/reconcile/engine.ts` (Step 3b) implements the five outcomes, the
four strong signals, the three vetoes and the re-keyed-person rule described under
*3. Reconciliation* below. It is a pure function: no Prisma import anywhere in its
transitive graph, and `now` is a parameter rather than a clock read, so re-running it
over an unchanged snapshot cannot produce a different answer.

What it does NOT have is an input. There is no MCP client (Step 1b) and no snapshot
model (Step 2a), so the only thing that calls `reconcile` today is its own test. The
engine is ahead of the pipe that will feed it, which was deliberate — the matcher is
the part where a mistake grants access, so it was worth building against a labelled
corpus before there was any live data to get wrong.

Two properties are worth knowing before extending it:

- **A link requires a signal that is strong by KIND, never a score.** Strength comes
  from a frozen table keyed on a closed union; a signal cannot declare itself strong.
  Step 4a's extension point (`CandidateScorer`) returns `SupportingSignal`, whose
  `kind` is narrowed to the non-strong union — so naming conventions and similarity
  *cannot* produce a `LINKED`, as a compile error rather than a convention. The
  exhaustive test runs all 127 non-empty subsets of the supporting kinds at a score
  of 10,000 each and asserts none links.
- **Precision is gated; recall is printed.** On the Step 3a corpus: 3 auto-links, 0
  false, and 14 of 27 exact outcomes. The 13 misses are the cases needing name
  matching, which is Step 4a. Gating recall would punish the engine for the correct
  response to a tightened precision rule, so the gate asserts no false link plus a
  floor — the three expected links individually — because a precision-only ratchet is
  passed trivially by an engine that links nothing.
### The decision-model client exists, and the external half is switched off

`src/app-layer/ai/identity-match/` (Step 6b) holds one wire codec for the System One
protocol and three providers: `JevDecisionProvider` (TypeSafe, hosted),
`LayaDecisionProvider` (open weights, our infrastructure) and a stub that answers
nothing. `getDecisionProvider` picks between them.

**The external path is unreachable today, behind two independent gates.** The effective
mode must be `EXTERNAL`, *and* `TYPESAFE_SUBPROCESSOR_ACTIVE` must be true — and it is
`false`. A tenant can set `legacyMatchAiMode = EXTERNAL` right now; that flag is what
makes the setting inert rather than a way to begin sending personal data before the
notice window closes. Activation is a reviewed change to a constant.

Residency is structural: the factory RETURNS before constructing anything external, and
`tests/guards/ai-residency-enforcement.test.ts` reads the source to check the ordering
and pins the constructor set, so a fourth provider fails CI until somebody classifies
it.

**No model may produce a verdict yet, and that is a property rather than an absence.**
A revision needs a committed evaluation record — raw answers to every case of the
adjudication corpus, the corpus digest, derived thresholds and canaries — and
`src/app-layer/ai/identity-match/evaluations/` is empty, because producing one needs a
live model. `tests/unit/identity-match-evaluation-records.test.ts` recomputes every
derived figure from the raw answers rather than trusting the stored ones.

One row of the table above was corrected by that verification: the Jev identifier is
`jev-1.13.0`, not `jev-1.13`.

### Every AI provider generates text

Seven call sites under `src/app-layer/ai/` reach a model over the network:
- compliance posture (Anthropic and OpenRouter);
- questionnaire autofill (OpenRouter);
- risk assessment (Anthropic, OpenRouter and a local OpenAI-compatible gateway);
- vendor-document extraction (OpenRouter).

Each one calls a text-generation endpoint — `/v1/messages` or `/v1/chat/completions` —
asks for JSON in the prompt, and parses JSON out of the reply.

- **Three bound the call with a timeout:** both compliance-posture providers at 15 s,
  and the risk-assessment Anthropic provider at 30 s.
- **Four set none:** the risk-assessment local and OpenRouter providers, the
  questionnaire provider and vendor-document extraction.
- **No code in `src/` calls a typed-decision API.**

`src/app-layer/ai/decision-log/index.ts` records AI calls in `AiDecisionLog`:
- `logAiDecision` stores a digest of the sanitised input rather than the input;
- `recordDecisionOutcome` moves every `PENDING` row sharing a `sessionRef` to
  `ACCEPTED`, `EDITED` or `REJECTED`. The move is one-way, and a database trigger
  enforces that. This is the human-oversight record for Article 14 of the EU AI Act.

## Roadmap (future direction)

### Decisions taken

| Question | Answer |
| --- | --- |
| Who builds the MCP servers | **The operator builds each one.** Inflect publishes a contract and servers conform to it. |
| May a model help reconcile names | **Per tenant: `OFF` / `LOCAL_ONLY` / `EXTERNAL`, default `OFF`.** In every mode the model decides quickly and a person confirms every link. |
| Which models | **`LOCAL_ONLY` → Laya** (Convai Innovations; open weights, run on our own infrastructure). **`EXTERNAL` → Jev** (TypeSafe AI; hosted in the US). Both answer typed questions with calibrated probabilities, and neither generates text. |

### Architecture: a separate snapshot subsystem

The path of least resistance is to make a legacy connection one more
`IdentitySyncProvider`, write its accounts into `ConnectedIdentityAccount`, and let
the existing chain carry them to a review. That path is rejected, for four reasons:

1. **`IdentityAccountLink` feeds the leaver pass, which disables accounts in
   customers' directories.** Probabilistic legacy matches must be structurally unable
   to reach that table, not merely unlikely to.
2. **Legacy applications often have no email.** With `provider:email` subject keys,
   every email-less account would collapse into a single review row.
3. **Recertification needs frozen snapshots.** `ConnectedIdentityAccount` is a live
   mirror that overwrites itself; evidence needs *on 1 October, this application had
   these 342 accounts.*
4. **The provider id would have to join six hand-copied lists,** and each one fails
   silently when missed.

Legacy access gets its own tables. It reuses `IntegrationConnection` for configuration
and encrypted secrets, `IntegrationExecution` for run records, `connection-lock.ts`,
`markAuthFailure`, the connection freshness gauge, and the resume-token shape of
`listAccounts` as the template for a paginated pull. It reads the directory tables
for bridging and never writes them.

### 1. Resources versus tools

**Version 1 uses MCP resources only.** In ascending order of weight:

- Resources are read-only by protocol semantics, so a pull cannot change the
  legacy application.
- A resource read is snapshot-shaped and addressable, which is what evidence needs.
- Column projection travels in the resource URI without any tool call.
- **Resources carry no model-facing instruction text. Tools do.** A tool's
  `description` is exactly the surface the repository already hashes and pins against
  poisoning, and a server run in front of a legacy application is not a trusted
  author. Resources remove that surface instead of defending it.

#### Contract `inflect-legacy-access/1`

```
inflect-access://manifest
  → { contract, app{name, owner}, snapshot{id, generatedAt, rowCount},
      columns[{name, type, nullable}], pages[uri…], layout: "wide" | "long" }

inflect-access://accounts/{n}?fields=COL_A,COL_B
  → { snapshotId, page, rows[{COL_A, COL_B}] }
```

- **JSON responses only; no server-sent events.** Possible because the operator
  builds to the contract, and it keeps the client small.
- **Every page carries `snapshotId`.** A mismatch between pages is a torn read: the
  pull fails and restarts from the manifest.
- **The client's `initialize` advertises no capabilities** — no sampling, roots or
  elicitation — so a server has no way to make Inflect do anything.
- **Tools are ignored,** even when a server advertises them.
- **A tool fallback is deferred to version 2,** and only for a server that genuinely
  cannot serve pages as resources. It would be exactly one allowlisted read tool,
  with its descriptor pinned through the existing tool-manifest machinery.
  `readOnlyHint` would be required but never trusted, and a changed descriptor would
  suspend the connection until an administrator re-approves it.

The client lives in `src/lib/mcp/client/` and reuses the types in
`src/lib/mcp/protocol.ts`. It is hand-written for the same reason the server is:
the contract is small, and a general-purpose client is built to answer
server-initiated requests that this one must refuse.

### 2. Too many columns

A legacy access table routinely carries forty columns — login name, three name
variants, cost centre, eight role slots, password expiry, the ID of whoever created
the row. Inflect keeps a minimal canonical schema and discards everything else at
the boundary.

**Canonical access schema:**

| Group | Fields |
| --- | --- |
| Identity | `accountKey` (required), `username`, `displayName`, `givenName`, `familyName`, `email`, `employeeNumber`, `department`, `title`, `managerRef` |
| Status | `status` (value-mapped), `lastLoginAt`, **`createdAt`** (it drives the temporal veto), `expiresAt` |
| Access | `entitlements[]`, `isPrivileged`, `accountType` |

- **Mapping is per connection,** stored and versioned in `configJson`. It follows the
  fail-closed pattern of `assertMappingComplete` in the ServiceNow provider: a
  mapping must name `accountKey` and at least one identity-bearing field, or the
  connection refuses to pull. This will be the first mapper in the codebase that is
  wired to a runtime and a UI; the existing mapper machinery has no call sites.
- **Suggestions come from Inflect; decisions come from a person.** Header names
  suggest a mapping, and value profiling corroborates it — the share of values that
  parse as email addresses or dates, high cardinality marking a key candidate, low
  cardinality marking a status candidate.
- **Status values are mapped, not just columns.** `A`/`I`, `Y`/`N`, `1`/`0` and
  `LOCKD` each map onto `ACTIVE`, `DISABLED`, `LOCKED`, `EXPIRED` or `UNKNOWN`.
- **Entitlement layout is declared.** Wide tables (`ROLE_1` … `ROLE_n`) are unpivoted;
  long tables (one row per role) are grouped by `accountKey`.
- **Projection happens at the source.** Once mapped, page reads request only the
  mapped columns through `?fields=`, so a sensitive column never leaves the legacy
  network. Columns returned anyway are dropped and the connection is flagged
  **`OVERSHARING`**.
- **Some columns are never requested.** A name matching
  `pass(word)?|pwd|hash|salt|secret|token|pin|ssn|egn|ЕГН|national.?id|iban|card` is
  excluded from mapping and from projection. `EGN` is the Bulgarian national
  identifier. AI Guard's secret patterns scan values as a backstop.
- **Schema drift halts the pull.** A change in the column-set fingerprint makes the
  pull refuse, recorded as `PARTIAL`, until an administrator re-confirms the mapping.
  It never silently maps a renamed column to the wrong field.

### 3. Reconciliation — the critical path

#### The asymmetry that sets every threshold

A **false link** certifies a leaver's live access as belonging to an active employee.
That is precisely the failure recertification exists to catch, and the review would
record it as caught. A **false non-link** costs a reviewer a few minutes. The existing
matcher resolves every ambiguity toward the visible failure, and this one inherits
that rule: each threshold below leans toward *suggest* and *unmatched*, and none
leans toward *link*.

#### Five outcomes

| Outcome | Meaning | Destination |
| --- | --- | --- |
| `LINKED` | Exactly one employee, on a strong basis, with no veto | The campaign, pre-resolved |
| `SUGGESTED` | The best candidate rests on medium or weak evidence, or leads the runner-up narrowly | Review queue |
| `AMBIGUOUS` | Two or more candidates tie on the strongest signal available | Review queue — **never pick** |
| `UNMATCHED` | No candidate clears the floor | Finding: orphan account |
| `NON_PERSON` | Service, shared, test or batch account | Owner attestation instead of an HR match |

`NON_PERSON` is decided **before** matching, from username patterns, the absence of
any name field and tenant-declared tags. A service account is therefore never fuzzily
matched to a human, and `svc_backup`, `admin` and `batch_user` do not bury the real
leavers in the orphan list.

#### Pipeline

```
 legacy snapshot ─┐
 HR roster ───────┼─► 0 normalise ─► 1 block ─► 2 score and veto ─► 3 decide ─► 4 remember
 directory (read) ┤                                                     │         (crosswalk)
 crosswalk ───────┘                              residue ─► 5 model (opt-in) ─► review queue only
```

**Stage 0 — Normalise both sides, keeping every raw value.**

- **Email.** `emailKey()` is reused unchanged, because the directory chain depends on
  it. On top of it: a tenant-declared list of equivalent domains (`company.com`,
  `company.bg`, `corp.local`) and removal of `+tag` suffixes.
- **Names.** NFKC first. **A non-Latin token is transliterated from its NFC form
  before anything else touches it**, and only then are diacritics folded — NFD with
  combining marks removed, the fold the joiner pass uses. The order is not a detail.
  `Й` is `И` plus a combining breve, so folding first turns `Йордан` into `Иордан`,
  transliterated `Iordan` instead of `Yordan`; `Николай` comes out `Nikolai` instead
  of `Nikolay`. `Last, First` is parsed as well as `First Last`, along with middle
  names, suffixes and honorifics. Parenthetical tags such as `(Contr.)`, `(EXT)` and
  `[ADMIN]` are **lifted into a field of their own**: they are signal, not name.
- **Not `normalizeForScan`.** AI Guard's normaliser folds *look-alikes* to catch
  disguised injection text: it maps Cyrillic `в` to `b` and `р` to `p`, and appends
  decoded base64. That is right for scanning and destroys a real name — `Иванов` would
  become `Иbaнob`. Only its zero-width and bidi stripping is reusable here.
- **Usernames.** Split on `.`, `_`, `-` and case changes; domain prefixes (`CORP\`)
  and UPN suffixes are separated out; a trailing disambiguator is split off
  (`john.smith2` → `john.smith` + `2`).
- **Employee numbers.** Prefixes and leading zeros are stripped (`EMP-010442` →
  `10442`).

**Stage 1 — Block candidates; never compare everything with everything.** A legacy
account is only compared with employees who share a key:

- the employee number;
- the email address, or its local part;
- a **directory bridge** — the legacy username equals the `sAMAccountName`, UPN
  prefix or `mailNickname` of a directory account already linked to an employee;
- a crosswalk row from a previous cycle;
- a username generated from a declared naming convention;
- a surname block over normalised and transliterated surnames, so similarity scoring
  only ever runs inside a plausible neighbourhood.

**Stage 2 — Score, with hard vetoes.** Signals are recorded as a new
`LegacyMatchMethod`, kept deliberately separate from the directory chain's
`IdentityLinkMethod`.

| Signal | Strength |
| --- | --- |
| `CONFIRMED_ALIAS` — confirmed by a person in an earlier cycle and revalidated every cycle | strong |
| `EMPLOYEE_NUMBER` — a real HR number, never the `workEmail` fallback | strong |
| `EMAIL_EXACT` — `emailKey` plus domain equivalence | strong |
| `DIRECTORY_BRIDGE` — inherits the `IdentityLinkMethod` of the directory link it crosses | strong |
| `NAMING_CONVENTION` — only when the generated username is **unique across the HR population** | medium |
| `NAME_SIMILARITY` — token-set comparison and Jaro-Winkler over normalised and transliterated forms | weak to medium |
| Agreement on department, title or manager | corroboration only |

**Vetoes override any score:**

- The two sides carry different employee numbers.
- The two sides carry different emails in the same domain.
- **The timeline is impossible:** a legacy account created after the candidate's
  `endDate` cannot be theirs.

The temporal veto exists for **username reuse**. Jane Smith joins two years after
John Smith leaves and is given `jsmith`; a matcher without the veto certifies John's
old entitlements as hers.

**Stage 3 — Decide.** `LINKED` requires a strong signal held by exactly one
candidate, no veto, and a consistent timeline.

- **Re-keyed person.** When the best candidate is `TERMINATED`, the engine looks for
  an `ACTIVE` employee with the same stable HR key (`hrisRecordId`, or a real employee
  number). If one exists, it is probably the same person after an email change. The
  account resolves **`SUGGESTED` — never `LINKED`** — with the active record
  pre-selected and the change of key shown. Without this rule every marriage-driven
  name change surfaces as a critical *leaver with live access*. Resolving it
  automatically would instead turn a strong signal onto a departed record into a
  certified active one, which is the expensive direction.
- **Rehires are a known edge.** `Employee` holds one employment window, so a rehire's
  account can trip the temporal veto. That produces a false non-link, the cheap
  direction, so it is recorded here rather than engineered around.
- **Freshness gates, modelled on `NO_FRESH_LINKS`:**
  - **Roster.** Reconciliation refuses with `NO_FRESH_ROSTER` unless the latest HRIS
    sync is `PASSED` within the freshness window. A truncated or stale roster would
    mass-produce false orphans and false leavers.
  - **Directory bridge.** Only links with a fresh `lastVerifiedAt` and a null
    `contradictedAt` are crossed — the predicate `findLeaverCandidates` applies. The
    username must match **exactly one** linked account across **all** of the
    tenant's directory connections, because `jsmith` can exist in two Active
    Directory domains. A `CORP\` qualifier is kept as a disambiguator rather than
    discarded.

**Stage 4 — Remember.** Two tables, with different lifetimes:

- **`LegacyAccountResolution`** holds one immutable result per account per snapshot:
  the evidence of what the engine concluded, and why, at that moment.
- **`LegacyIdentityAlias`** is the durable crosswalk `(connection, accountKey) →
  employee`. It is written only when a person confirms, and records the method, the
  reviewer, the time and the signals the reviewer was shown. The next cycle resolves
  that account deterministically as `CONFIRMED_ALIAS`.

Aliases are revalidated every cycle, and **a departure never suspends one.** If
`jsmith` is confirmed as John Smith and John leaves, the alias is still true, and the
account is now a *leaver with live access* — the finding the campaign exists to raise.
Suspending the alias would send the account back into the matching queue and hide that
finding. An alias is suspended only when the pairing itself becomes doubtful:

- the legacy account was recreated — its `createdAt` moved;
- its lifetime no longer fits the employment window;
- the HR record was re-keyed;
- the HR record disappeared.

After a few cycles only joiners, leavers and renames reach a person. **The crosswalk
is the durable asset this subsystem produces.**

#### Naming conventions are declared, not inferred

For each connection, the tenant declares the application's convention in a small
grammar: `{f}{last}` gives `jsmith`, `{LAST}_{F}` gives `SMITH_J`,
`{first}.{last}{n?}` gives `john.smith2`. Inflect generates the expected username for
every employee and indexes it. A generated username that is not unique across the HR
population — `jsmith` for both John and Jane — produces `AMBIGUOUS`, never a choice.
Inflect may *propose* a convention by profiling a snapshot against the roster; a
person adopts it.

#### Transliteration without guessing

The joiner pass refuses to derive an address from a non-Latin name *"rather than
being transliterated by guesswork"*. That is correct for the joiner, which **mints**
an identity the person will carry for years. Reconciliation only **proposes** a match
that a person confirms, and that difference keeps the two positions consistent:

- **Transliteration produces candidates only.** A match found through it is
  `SUGGESTED` at most, never `LINKED`.
- **Every plausible scheme is generated, and each candidate records which one.**
  Bulgarian's official Streamlined System gives `Щ → Sht` and `Ъ → A`; the generic
  scheme in `@sindresorhus/transliterate` gives `Щ → Shch`. *Щербанов* is therefore
  `Shterbanov` in one and `Shcherbanov` in the other — and the HR system and the
  legacy application were very likely filled in by different people.
- **`@sindresorhus/transliterate` is only a transitive dependency today,** through
  `@sindresorhus/slugify`, which nothing in `src/` imports. Using it means adding it
  as a direct dependency under the dependency-governance process.

#### Proving it works

- **A labelled corpus** of realistic mismatches: `Last, First` orderings, initials,
  numeric suffixes, domain aliases, Cyrillic names under both transliteration schemes,
  username reuse across a termination, a re-keyed email change, contractors and
  service accounts.
- **CI asserts auto-link precision of 100% on that corpus.** A rule change that
  produces a single false `LINKED` fails the build. This is the behavioural ratchet
  `docs/new-subsystem-checklist.md` requires alongside structural ones. It protects
  known cases against regression; it is not a claim about production data.
- **The production outcome metric is the reviewer override rate** — how often a
  person rejects what the engine suggested.

### Model adjudication — Jev external, Laya local (optional, per tenant)

The deterministic stages leave a residue: accounts that are `SUGGESTED` on medium or
weak evidence, and accounts that are `UNMATCHED`. A tenant that opts in gets a model's
verdict on every residue account **before the review queue opens**. The model decides
quickly, and a person still confirms every link. That is global rule 3 of the phases
document, and it follows from the cost asymmetry above.

**Both models are decision models, not chat models.** Jev and Laya are "System One"
models: they read a state (text or JSON) and answer typed questions with calibrated
probabilities in a single pass. They generate no text. For this job that beats a chat
model on every axis that matters:
- no text comes back, so there is no rationale to leak through and no JSON to parse;
- a `choice` answer can only be one of the options Inflect wrote;
- the probabilities make thresholds possible, once they are measured rather than
  trusted;
- a call takes tens to hundreds of milliseconds, fast enough to run inline.

#### What the vendors publish

Compiled in September 2026 from public descriptions. Step 6b of the phases document
re-verifies every row against the vendors' own references before any code relies on
it. Where a row differs, the reference wins and this table is corrected.

| | Jev — TypeSafe AI | Laya — Convai Innovations |
| --- | --- | --- |
| Delivery | Hosted API, generally available since 2026-09-20 | Open weights under Apache-2.0; no hosted API |
| Wire API | `POST /v1/systemone`, carrying `model`, `state` and a map of `questions` | The same. Laya servers expose `GET /v1/models` and `POST /v1/systemone`; most of them are community projects |
| Question types | `choice` — up to 255 described options, with a probability for each; `noul` — the probability that a statement is true; `score` — a level on a 2–10 scale | The same |
| Version and window | `jev-1.13`: 64k tokens per request, 32k of it for the state plus the longest question | `laya-multilingual`: mmBERT-base, 322M parameters, 1,024 tokens (about 768 for the state), 100+ languages. The English `laya` has 421M parameters and 512 tokens |
| Latency | 70–500 ms end to end (vendor figure); published p50 figures between about 145 and 275 ms | About 33 ms p50 on a T4 GPU (model card); no published CPU figure |
| Data | Hosted on the US West Coast. The DPA uses EU Standard Contractual Clauses, and the vendor is not certified under the EU-US Data Privacy Framework. It does not train on customer data, and offers zero data retention on request to enterprise accounts | Runs on infrastructure we operate; nothing leaves it |

Sources: the [TypeSafe API reference](https://docs.typesafe.ai/api) and the model card
for [`convaiinnovations/laya-multilingual`](https://huggingface.co/convaiinnovations/laya-multilingual).

#### One wire protocol, two endpoints

- **The mode picks the model.** `TenantSecuritySettings.legacyMatchAiMode` is `OFF`
  (the default), `LOCAL_ONLY` (Laya) or `EXTERNAL` (Jev).
  - The effective mode is the stricter of this setting and `aiResidency`.
  - Saving `LOCAL_ONLY` with no Laya deployed is refused, just as
    `aiResidency=LOCAL_ONLY` is refused without `aiLocalBaseUrl`
    (`src/app-layer/usecases/tenant-security-settings.ts:362-367`).
- **Inflect speaks one API** from `src/app-layer/ai/identity-match/`: one wire codec and
  three providers.
  - **Jev's** host is a code constant, so the external side is no fetch primitive.
  - **Laya's** base URL is deployment configuration that no tenant can set.
  - **The stub** answers nothing, so an unconfigured deployment produces no verdicts
    rather than invented ones.
- **Residency is structural.** The factory returns before constructing any external
  provider when the mode is `LOCAL_ONLY`, the shape
  `tests/guards/ai-residency-enforcement.test.ts` already pins for risk suggestions.
- **Both models are pinned:** `jev-1.13`, and `laya-multilingual` at a fixed revision.
  Multilingual, because legacy names arrive in Cyrillic and Latin and the English
  checkpoint's 512 tokens cannot hold an account plus five candidates.
- **Not the chat providers, and not in process.** Anthropic, OpenRouter and the
  OpenAI-compatible gateway are not offered for this surface. Laya runs as its own
  service, not inside Node through ONNX Runtime, which would add a native runtime and
  about a gigabyte of weights to the web and worker images.

#### The questions

- **One request per account**, so a hostile record can sway only its own verdict.
- **The state is allowlisted JSON.**
  - **The account:** username and its tokens, the neutralised display name, given and
    family names, the email local part, department, title, `accountType`, and the
    Stage 0 transliteration variants tagged by scheme.
  - **Up to five candidates labelled `A`–`E`:** their name parts, including middle and
    preferred names, with variants, department and title.
- **Never sent:** email domains, employee numbers, dates, employment status, managers,
  entitlements, privilege flags or unmapped columns. The vetoes, the re-keyed person
  rule and the timeline stay deterministic; the model judges identity and nothing else.
- **No anchoring.** Candidates are shuffled with a seed from the account id, and the
  engine's scores are withheld. Otherwise "the model agrees with the engine" could mean
  no more than "the model picked option A".
- **Two questions, one pass:**
  - `match`, a `choice` over `A`–`E` plus `NONE`;
  - `person`, a `noul`: *this account is used by one individual, not by a service or a
    shared, test or system function*.
- **Letters, not ids.** The mapping from letters to employees never leaves Inflect.

#### Verdicts

Inflect derives each verdict from three things: the model's probabilities, the engine's
result, and the thresholds in the model's evaluation record. **A verdict never changes
the engine's outcome;** it annotates the row and chooses its review lane. The first
matching row wins:

| Verdict | Condition | Lane |
| --- | --- | --- |
| `NOT_A_PERSON` | P(`person`) at or below the non-person threshold | Single review, proposing `NON_PERSON`, which still requires an owner |
| `NO_MATCH` | P(`NONE`) at or above the accept threshold | Single review on a `SUGGESTED` row; annotates the orphan finding on an `UNMATCHED` one |
| `AGREES` | The top option is the engine's suggestion, with P ≥ accept, a margin over the runner-up ≥ δ, and P(`person`) ≥ the person threshold | **Bulk ratification** |
| `PROPOSES` | The top option is another candidate, or the engine had none, clearing the same bars | Single review; confirming it records `AI_PROPOSED_CONFIRMED` |
| `UNSURE` | Anything else | The queue as it would be without a model |

**Agreement is not independence.** The engine and the model both lean on names, so
`AGREES` buys a faster review, never a link.
- Bulk ratification is still a person confirming each row, within the Step 4b cap, with
  the server re-checking every row.
- It admits only `AGREES` rows whose candidate is `ACTIVE`, with no veto, no privilege
  and no re-key, and which are outside the blind sample.

`AgentProposal` is not reused: its queue reviews proposals one at a time, and a first
recertification can leave hundreds of residue accounts. The governance is reused; the
queue is not.

#### Decided before the queue opens

Adjudication runs at the end of each reconciliation run, inside the job and never in an
HTTP request. The run's results are written first. The residue is then adjudicated, and
each verdict is stored as an immutable `LegacyMatchVerdict`, one per resolution per
model revision.

| | Jev | Laya |
| --- | --- | --- |
| Per-call timeout | 3 s | 2 s |
| Requests in flight | 8 | 4 |
| 500-account residue (arithmetic from published latencies, not a measurement) | About 20 s | About 5 s on a T4 GPU; measured on CPU when deployed |
| Run deadline | 120 s | 120 s |

- **An undecided account keeps a named reason** (a timeout, the deadline, a quarantine,
  drift, the kill switch; the phases document lists them all). It appears exactly as it
  would with the mode `OFF`. That is the fail-closed state, and it is still a queue a
  person can clear.
- **Cost is no constraint.** At the published price, a 500-account run on Jev costs
  under two cents.

#### Trust, but verify

None of the vendors' calibration or accuracy claims is relied on.

- **Evaluation records.** Each model revision has a committed record.
  - It holds the model's raw answer to every case of the synthetic adjudication corpus,
    the corpus hash, the thresholds and the canary cases.
  - CI recomputes every verdict and precision figure from those raw answers, and
    requires 100 % precision for `AGREES` at a minimum support.
  - A revision without a record produces no verdicts, so changing a model is a reviewed
    pull request.
- **A canary fingerprint.** Before each batch, fixed synthetic states must reproduce
  their recorded probabilities within 0.02, or the batch is refused. This catches a
  vendor update behind an unchanged model name, and a Laya server running the wrong
  checkpoint.
- **The blind sample — the production outcome metric.**
  - 5 % of `AGREES` rows are shown **without** the verdict and kept out of bulk
    ratification, and the reviewer's own decision is compared with the model's pick.
  - One disagreement closes the `AGREES` lane for that revision for the rest of the
    cycle, and raises an alert.
- **Human oversight is recorded.** Each verdict writes one `AiDecisionLog` row, keyed so
  that the reviewer's decision stamps exactly that row through `recordDecisionOutcome`.

#### Input safety and residency

- **Kept from the general agent controls:**
  - the provenance source `integration.legacy-mcp` (`THIRD_PARTY_INGESTED`);
  - fencing with `neutralizeUntrustedText`;
  - `guardUntrustedInput`, where a high-severity hit quarantines the account whatever
    `aiGuardMode` says;
  - a first-party `RegisteredAgent` at autonomy rung 2, with its kill switch and
    breaker.

  A display name written as an instruction cannot make a classifier act, but it can try
  to push a probability.
- **New, because the answer is typed:**
  - a strict response schema — an unknown option or field discards the answer;
  - answers computed on possibly truncated input are discarded;
  - logs carry only digests, ids and counts;
  - `local/no-raw-prompt-logging` is extended to this module through
    `eslint-rules/agentic-path.js`.

  That last change is a stated exception: `agentic-path.js` excludes
  `src/app-layer/ai/**` because generative providers legitimately handle the raw
  prompt, but this path ingests attacker-shaped data from operator-hosted servers.
- **No output scan.** `guardEgress` exists to scan generated text, and nothing but
  probabilities comes back.
- **Laya is not a sub-processor.** It runs on infrastructure we operate, or on the
  customer's own when they self-host. Its variables join `NON_SUBPROCESSOR_ALLOWLIST`
  in `tests/guardrails/sub-processor-coverage.test.ts`, beside `AI_LOCAL_*`.
- **TypeSafe is a new sub-processor.** `docs/sub-processor-change-policy.md` applies in
  order:
  1. an inventory pull request;
  2. legal review — Standard Contractual Clauses, no Data Privacy Framework
     certification, zero data retention in the signed DPA;
  3. **30 days' customer notice**;
  4. activation.

  The notice needs no code, so it starts on day one and its 30 days pass while the rest
  is built.
- **Activation is a reviewed diff.** A code constant, `TYPESAFE_SUBPROCESSOR_ACTIVE`,
  starts `false`. Until it flips, saving `EXTERNAL` is refused and no tenant data
  reaches Jev. Only the synthetic evaluation corpus is sent to it before then.
- **Changing the mode is audited.** It goes through `updateTenantSecurityConfig`, the
  settings row's existing write path, behind `admin.manage`. That function's
  `SECURITY_SETTINGS_UPDATED` event records only field names, because some fields are
  secrets. A mode change also redirects personal data, so it writes its own event
  naming the new mode, the processor and its region, none of which is secret.

### Recertification campaigns

- **Permission keys.** Creating, deciding and closing reviews get `requirePermission`
  keys, so a denial writes `AUTHZ_DENIED`. Confirming a reconciliation match gets a
  key of its own: asserting who an account belongs to is a consequential act.
- **One review flow, not a third.** A new scope, `LEGACY_APP`, reuses
  `AccessReviewConnectedDecision` with subject keys scoped to the connection. That
  also removes the silent merge for directories.
- **The connected flow gets finished for everyone.** Connected decisions render,
  closing produces an evidence PDF, reminders count connected decisions, truncation
  is reported, and each subject's snapshot carries HR context: employee, employment
  status, manager, reconciliation outcome and method.
- **Findings surfaced per account:**
  - a leaver with live access;
  - an orphan account;
  - unresolved ambiguity;
  - a dormant account;
  - privileged access;
  - a non-person account with no owner;
  - **several accounts resolving to one person** — `jsmith` and `john.smith` are not
    an ambiguity, but they are a finding;
  - **mover-suspect** — the department or manager changed since the last
    certification. A mover is unrepresentable in the JML chain by design; detecting
    one at review time adds no JML direction, because a review writes nothing to a
    directory.
- **Every pull writes a hash-chained audit event** carrying the snapshot's payload
  hash, so the evidence of *what the application reported, and when* is
  tamper-evident rather than merely stored.
- **Evidence is linked to controls:** SOC 2 CC6.2 and CC6.3, NIS2 Art. 21(2)(i), and
  ISO/IEC 27001:2022 A.5.16 and A.5.18.
- **Remediation becomes tasks,** as it does today, optionally raised as ServiceNow
  tickets. **Nothing is written back to the legacy application.**

### Security and reachability

- **Hosted Inflect reaches public HTTPS endpoints only, through `safeFetch`.** The MCP
  client becomes its third caller. `CONFIG_FIELD_RULES` classifies the endpoint field,
  so `redirectsStoredCredential` refuses a host change that would carry the stored
  credential somewhere new. This answers the `allowed-host.ts` objection the same way
  Active Directory does, from the opposite side: AD asserts a *private* address at
  connect time, and the MCP client asserts a *public* one. Operators expose their
  servers through a reverse proxy or tunnel, authenticated with a bearer token or
  mutual TLS.
- **Self-hosted Inflect may reach private addresses through a deployment-level CIDR
  allowlist** declared in `env.ts`. It is never tenant-configurable, and the metadata
  and loopback ranges stay refused inside it.
- **Credentials live in `secretEncrypted`.** That column holds a `v1:` envelope under
  the global key, which the key-rotation sweep does not re-encrypt. This is a
  pre-existing gap, recorded here and not addressed by this work.
- **Every pull is capped** per page and in total. Beyond a cap the pull is recorded
  as `PARTIAL` and is never treated as complete. The existing identity code states the
  rule: *"A PARTIAL READ MAY FAIL A CONTROL. IT MAY NEVER PASS ONE."*

### Phases

The reconciliation engine is a library over canonical records and the roster. It can
be built and proven against the corpus without a live MCP server, so the hardest part
starts on day one, in parallel with the plumbing.

**Each phase is broken into pull-request-sized steps in
`docs/legacy-access-recertification-phases.md`**, with a prompt for a fresh session
and a hardening checklist the pull request must satisfy. That document also shows
which steps depend on nothing new. Six can start immediately, including two that need
no legacy work at all: the access-review hardening, and the customer notice for
TypeSafe as a sub-processor, which needs no code.

```
Track A — the pipe     P1 Client and contract ──► P2 Mapping and ingestion ─┐
Track B — the core     P0 Prerequisites ──► P3 Deterministic ──► P4 Assisted and review ─┤
                                                                                        ├─► P5 Campaigns ─► P6 Model (opt-in)
```

| Phase | Scope | Exit criterion |
| --- | --- | --- |
| **P0 Prerequisites** | Single-write-seam guards for `IdentityAccountLink` and `ConnectedIdentityAccount`. Persist `samAccountName`, `userPrincipalName` and `mailNickname` through `identity-sync.ts`. Persist `givenName`, `familyName`, `middleName`, `preferredName` and a fallback-free `employeeNumber` through `hris-sync.ts`. Every change stays inside an existing write seam. | A second writer to either table fails CI. AD and Entra accounts carry `sAMAccountName` and UPN. |
| **P1 Pipe** | The contract and a reference server; `src/lib/mcp/client/`; a `legacy-mcp` provider registered in `bootstrap.ts` with live `validateConnection`; `CONFIG_FIELD_RULES` classification; the reachability rules above. | *Test connection* reads a real manifest and lists its columns. |
| **P2 Mapping and ingestion** | The canonical schema; the mapping UI with suggestions; status value maps; projection; the column denylist; drift detection; `LegacyAccessSnapshot` and `LegacyAccount`; a fail-closed pull recorded as an `IntegrationExecution`. | A mapped snapshot is stored with its payload hash, and no unmapped or denylisted column is stored. |
| **P3 Deterministic reconciliation** | Roster and bridge freshness gates; normalisation; blocking; strong signals; vetoes; the re-keyed person rule; the `NON_PERSON` classifier; `LegacyAccountResolution` results and the `LegacyIdentityAlias` crosswalk; the corpus and its precision ratchet. | No false `LINKED` on the corpus, and every real account receives exactly one outcome with a recorded method. |
| **P4 Assisted reconciliation and review** | Declared naming conventions with collision checks; similarity scoring; the review queue, explaining every signal and supporting bulk action; crosswalk revalidation; the confirm permission; the override-rate metric. | A second cycle resolves previously confirmed accounts with no human involvement. |
| **P5 Campaigns** | Permission keys; the `LEGACY_APP` scope; the connected-flow fixes; HR context; findings; evidence linked to controls. | A legacy recertification is opened, decided and closed, with its evidence attached to SOC 2 and NIS2 controls. |
| **P6 Model adjudication** | Everything under *Model adjudication* above: the TypeSafe sub-processor process, which starts on day one; Jev and Laya behind one wire API; evaluation records and the canary; verdicts, lanes and the blind sample; the Laya deployment. | A 500-account synthetic residue is adjudicated inside the run deadline on Laya. `LOCAL_ONLY` never constructs Jev. No verdict appears without a matching evaluation record. The model links no one. |

### Guardrails each phase trips

These fire by design. They belong in each phase's estimate, not its surprises.

- **New tenant tables (P2, P3):**
  - the RLS migration triple;
  - a two-tenant behavioural test for `tests/guardrails/tenant-isolation-forward-lock.test.ts`;
  - `tests/guardrails/schema-index-coverage.test.ts`, layers A, B and C;
  - a row in `docs/data-retention.md`;
  - `tests/guardrails/encryption-manifest-coverage.test.ts`, for reviewer notes and
    justifications.
- **The new provider (P1):**
  - `tests/guards/integration-bootstrap-runtime-wiring.test.ts`, whose provider list
    is an exact-equality match;
  - `tests/guards/integration-credential-placement.test.ts`;
  - `tests/guards/p3-integrations-hub.test.ts`. A new category renders nowhere until
    `CATEGORY_ORDER` on the hub page includes it;
  - `tests/guardrails/sub-processor-coverage.test.ts`. The operator's own server is
    not a sub-processor, so its entry has to say why;
  - `tests/guards/ssrf-egress-coverage.test.ts`, whose `SINKS` list is maintained by
    hand and would not notice a new caller unaided;
  - `tests/guardrails/provider-fail-closed-coverage.test.ts`, extended to enumerate the
    pull, since sync-only providers escape it today.
- **Scheduled jobs**, if a scheduled pull is added later: `JobPayloadMap`,
  `JOB_DEFAULTS`, `runtime-wiring-coverage`, `fan-out-bucket-matches-schedule` and the
  dispatcher's `EXEMPT_JOBS` entry. **Version 1 pulls on demand only.**
- **Model adjudication (P6):**
  - `tests/guards/ai-residency-enforcement.test.ts`, extended to the new factory. Its
    pinned constructor list fails until `JevDecisionProvider` is classified as
    external;
  - `tests/guardrails/sub-processor-coverage.test.ts`. `TYPESAFE_API_KEY` in
    `src/env.ts` needs the TypeSafe row, and the `LAYA_*` variables need allowlist
    entries with reasons;
  - the new-table set above, for `LegacyMatchVerdict`;
  - `tests/integration/prompt-injection-corpus.test.ts`, extended with legacy-field
    vectors;
  - `tests/guards/no-raw-prompt-logging.test.ts`, once `eslint-rules/agentic-path.js`
    names the new module.

### Explicitly deferred

- **Writing revocations back to legacy applications.** It needs an MCP tool, which
  reopens tool trust, and it would have to follow the JML ladder — `DISABLED`,
  `DRY_RUN`, `AUTOMATIC`, a dwell before widening, a blast-radius breaker and a write
  journal. Not before several read-only cycles have run.
- **A model that links on its own.** If it is ever built, it needs:
  - its own write-mode ladder — `DISABLED`, `DRY_RUN`, `AUTOMATIC`, with the seven-day
    dwell before leaving dry run;
  - a precision measured by the blind sample on the tenant's own confirmations, never
    the vendor's calibration claim;
  - an exclusion for re-keyed, terminated and privileged candidates, which always go to
    a person.
- A Laya endpoint supplied by a tenant. It would be a fetch primitive in a tenant
  administrator's hands; see *Security and reachability*.
- Fine-tuning Laya on the adjudication corpus. Its licence allows it, but only
  synthetic data may ever be used.
- A scheduled nightly pull, for drift and dormancy between campaigns.
- A first-party outbound relay for servers that cannot be exposed at all.
- Campaigns routed to each subject's manager with several reviewers; `AccessReview`
  holds a single `reviewerUserId` today.
- Pre-existing gaps recorded but out of scope: connection secrets under the global
  key; the missing `config-field-classification` guard; two email normalisers that
  bypass `emailKey`.
