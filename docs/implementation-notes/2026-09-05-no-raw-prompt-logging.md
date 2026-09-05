# 2026-09-05 — the digest-only rule on the agentic path

**Commit:** `<pending>` feat(agentic): enforce digest-only logging on the agentic path

## Design

`src/app-layer/ai/decision-log/index.ts` stores a SHA-256 `inputDigest` and says
why in a comment — the row holds "a DIGEST of the sanitised input (never the raw
prompt/PII)". That discipline was real, and it bound exactly one module.

The AGENTIC path had no equivalent. It is also the path where it matters most:
the content arrives from a principal nobody vetted (an MCP client sends whatever
an LLM produced), and the product already treats it as sensitive —
`AgentProposal.payloadJson`, `WorkflowRun.contextJson` and
`WorkflowStep.inputJson`/`outputJson` are on the Epic B encryption manifest.
`AuditLog.detailsJson` is not: it is plaintext, hash-chained, and the one store
`docs/data-retention.md` promises never to erase by default. So a single
`detailsJson: { prompt }` moves unvetted third-party content from the encrypted
store into the permanent one, and there is no lever to pull afterwards.

The enforcement is an **ESLint rule**, `local/no-raw-prompt-logging`, plus a
guard that runs the same rule over the population git defines. Three parts:

```
eslint-rules/agentic-path.js       WHERE.  one glob list, two consumers
eslint-rules/rules/…               WHAT.   the AST rule + its census modes
tests/guards/no-raw-prompt-logging THE SWEEP + THE DENOMINATOR
```

**The rule.** At a recognised sink call (`logger.*`, `log`, `appendAuditEntry`,
`logEvent`, `streamAuditEvent`, `emitAutomationEvent`, `console.*`, Sentry's
capture pair) every value position is walked. A position is a violation when the
name at it reads as content and does not also read as a reduction of content —
`prompt` yes, `promptDigest` no; `args` yes, `argsLength` no; `input` yes,
`inputSchema` no. Object-literal KEYS are checked as well as values, which is
the half that survives a rename in the useful direction: `{ prompt: sha256(p) }`
is still reported, because the row tells its reader the field is the prompt.

**The census.** Two options, both off in `eslint.config.mjs` and both on in the
guard. `reportUnanalysable` reports each position the rule could not judge — an
object spread, a helper it cannot open, a value that is just a local identifier —
under its own messageId. `reportSinks` reports each sink it recognised. Together
they make the guard's clean result mean something: "zero violations" and "zero
sinks found" are the same output otherwise.

Measured over the swept path: **55 files, 39 sink calls in 13 of them, 0
raw-content violations, 84 un-analysable positions over 13 `file — kind` pairs.**
The sink count was cross-checked against a naive grep of the same population —
the AST census and the grep agree, so the sweep is not quietly skipping files.

**The opaque-identifier class, and why the first census was dishonest.** The
first version of this rule reported a hole for an object spread and for a helper
call, and NOTHING for the third case its own header named:
`const detail = prompt; logger.info('m', { detail })`. Not a violation, which is
correct — the rule does no data-flow analysis and cannot know. But not a hole
either, which is not correct: the whole renamed-variable class sat outside the
capped denominator, so `KNOWN_UNANALYSABLE` had one entry, `holes / sinks` was
0.026, and an unbounded class of leak was invisible while the guard reported a
clean sweep. Six planted shapes were silent — a renamed local, a destructured
rename, a renamed parameter, an array of renamed content, a `JSON.stringify` of
one, and one interpolated into the message string.

The fix is one clause, not an analysis: a value position that resolves to a plain
`Identifier` which is neither a content name nor a literal-in-disguise reports an
`identifier bound elsewhere` hole. Over the same unchanged tree the census went
**1 hole → 84**, and `holes / sinks` went **0.026 → 2.154**. Both pairs of
numbers describe the same code; only the second pair was honest.

## Files

| File | Role |
| --- | --- |
| `eslint-rules/agentic-path.js` | The scope. Live globs (each must match a real file) + anticipatory globs (must match nothing today, must point at a real directory). |
| `eslint-rules/rules/no-raw-prompt-logging.js` | The rule: sinks, content vocabulary, reducer vocabulary, the walk, the two census modes, and the header's account of what stays silent. |
| `eslint-rules/__tests__/no-raw-prompt-logging.test.ts` | RuleTester. A `valid` case per narrowing, plus the census cases — including the opaque-identifier class and the exemptions that keep its count honest. |
| `eslint.config.mjs` | Wires the rule at `error`, scoped to `AGENTIC_PATH_GLOBS`. |
| `eslint-rules/index.js` | Registers the rule on the `local` plugin. |
| `tests/guards/no-raw-prompt-logging.test.ts` | Runs the rule over the git-listed path; floors the sinks; pins the un-analysable `file — kind` set exactly; caps opacity per sink call; planted mutations for a raw prompt and for a renamed one. |
| `tests/guards/eslint-local-rules-wired.test.ts` | Its `LOCAL_RULES` list gains the new rule, so switching it off fails CI. |
| `eslint-rules/README.md` | The rule's entry, and why a shared scope module lives beside `rules/`. |

## Decisions

- **A rule, not a regex under `tests/guards/`.** The check is syntax, and the
  specific thing a regex gets wrong is everywhere in these files: the word
  `prompt` appears in the prose documenting them, in string literals, and in
  identifiers that are not values at a sink. `require-mcp-tool-authorization`
  needed a `stripComments()`-shaped workaround for exactly this and the rule
  file removed the need. It also needs cross-node reasoning — find the sink,
  then walk its arguments carrying a shielded/transparent state — which is more
  than a `no-restricted-syntax` selector can say, so `eslint-rules/README.md`'s
  test points at `rules/` rather than at the config.

- **…and a guard as well, because ESLint cannot report a denominator.** A lint
  rule's output is per-file violations; it has no way to say "I judged 39 call
  sites and could not read 84 positions in them". That number is part of the
  result, so the guard
  runs the same rule with the census options on and caps what it could not
  read. The guard is also the backstop for anyone who never runs `npm run lint`.
  The two are not duplicate implementations: there is one AST rule and the guard
  imports it.

- **The un-analysable set is pinned by exact equality, not a numeric cap.** A
  count tells you something got worse; the set tells you which file. It is
  stored without line numbers, because a line moves on every unrelated edit
  above it and a ratchet that reddens for that gets updated without being read.
  Drift allowance is zero in both directions, matching the assertion-reach
  ratchets: a closed hole loses its entry in the same diff, because the slack it
  would otherwise leave is exactly enough for the next one to land unnoticed.

- **…and the "set" was a multiset that only looked like one at n = 1.** The
  guard mapped one entry per FINDING. With a single spread on the path that is
  indistinguishable from a set, and it stayed indistinguishable right up until
  the population became 84 findings over 13 pairs. It is now deduped, and the
  cost is written down beside it: one MORE opaque identifier in a file already
  listed does not move that assertion. The per-sink ceiling is the cap that sees
  it, which is why there are two.

- **The ceiling is derived from two measured quantities, not chosen.** The old
  `holes / sinks < 0.1` meant "a small share". It cannot mean that any more: a
  hole is a POSITION and a sink is a CALL, so the numerator now scales with how
  many fields the path logs. The number is read as opaque value positions per
  sink call, and the ceiling is `(84 + 6) / 39` — the path today, plus the most
  opaque single call on it (`src/lib/mcp/auth.ts`, a six-field bag of locals).
  In words: the path may absorb one more sink call as opaque as its worst
  existing one before somebody has to look. Two fail; seven more opaque fields
  on the existing calls, with no new sink, fail.

- **A denominator was rejected because it made the number pass.** The rule could
  also census the NAMED positions it resolves — object keys and member-chain
  final properties — which gives `holes / positions = 0.099`, under the original
  0.1 ceiling, no ceiling change needed. That denominator is mostly object KEYS,
  and a key is not where a renamed value hides. Choosing it would have been
  picking the denominator that keeps the number green, which is the defect the
  cap exists to catch, one level up. Recorded here because the reasoning is the
  durable part.

- **What is still silent is written down in the rule header, not implied away.**
  Four classes report neither a violation nor a hole: a rename reached through a
  PROPERTY (`{ d: ctx.detail }` — counting it would make a hole of every `ctx.*`
  at every sink and the census would be mostly noise), a bare identifier BELOW
  the field-bag index (`logger.info(detail)` — the index cannot tell a message
  slot from a `db`/`ctx` plumbing slot without a second index per sink), and the
  `message` / `summary` vocabulary gaps, which are now at least COUNTED even
  though they are not flagged. The interpolated form IS counted: a template
  literal's expressions are holes wherever they sit, because their values are
  stringified into the emitted text.

- **The scope is a set of globs, and four of them match nothing on purpose.**
  Two other branches were adding agentic code while this landed. A scope written
  as the files that exist today would have covered none of theirs and gone green
  doing it. So `src/app-layer/jobs/agent-*.ts` and its three siblings are in the
  list before anything matches them, and the guard asserts the *directory* each
  points at is real — a typo'd anticipatory glob would otherwise sit there
  forever, matching nothing for a reason nobody intended.

- **`t/*/agent-proposals`, never `t/[tenantSlug]/agent-proposals`.** minimatch
  reads `[tenantSlug]` as a character class, so the literal route path matches a
  one-character directory segment and none of the real routes. The guard pins
  `src/app/api/t/[tenantSlug]/agent-proposals/route.ts` by name for this reason:
  a scope that silently matches nothing looks exactly like a clean sweep.

- **A member chain is judged by its FINAL property.** The first version judged
  every segment, which made `input.kind` — a four-value enum — read as raw
  input. Eleven of the fifteen first-run hits were that shape. A rule that flags
  an enum is a rule people learn to disable, and a disabled rule protects the
  path it was written for least of all. The final property is what the
  expression evaluates to, so `run.contextJson` is still caught and `ctx.role`
  is not.

- **One unjudgeable position reports one hole.** A helper call's arguments and an
  object spread's argument are walked (a prompt going IN is still reportable) but
  no longer add an opaque-identifier hole of their own: `buildFields(run)` is one
  thing the rule cannot judge, not two. A denominator inflated with noise says as
  little as one that drops what it cannot read — the same reasoning that gives
  `SINK_FUNCTIONS` a field-bag index, and that exempts `undefined` and the
  `JSON` / `Object` namespace objects from being read as opaque bindings.

- **`summary` is deliberately NOT content vocabulary, and that is a gap.**
  `WorkflowRun.summary` is an encrypted output artifact, so tainting the name
  would be defensible — but `detailsJson.summary` is the repo's own idiom for a
  human-readable one-liner and it appears at six clean sites on this path alone.
  Tainting it would have flagged the idiom rather than the leak. `run.summary`
  reaching a log line is therefore invisible to this rule. Recorded here rather
  than fixed, because the fix is a vocabulary change that has to be measured
  against the whole repo's `logEvent` idiom, not just this path.

- **`message` (singular) is not content vocabulary either.** `err.message` is at
  nearly every sink in the repo; `messages` is the LLM transcript. Only the
  plural counts. A prompt in a variable called `message` is invisible.

- **`logAiDecision` is not a sink.** It is the digesting seam itself — its
  `sanitizedInput` is hashed by `computeInputDigest` before it touches a column,
  so handing it raw content is the contract rather than a violation of it.

- **Client components are out of scope.** The invariant is about what gets
  PERSISTED. `src/app/t/**/agent-proposals` renders the proposal payload to the
  reviewing human, which is the product working, and a browser component writes
  no audit row.

## The one hole this found

`denyToolCall` in `src/lib/mcp/authorize.ts` takes
`extra?: Record<string, unknown>` and spreads it straight into the
`AUTHZ_DENIED` row's `detailsJson`. All eight call sites pass scalars today — a
capability name, a required autonomy level, a resource/action pair — so nothing
is leaking. But the TYPE permits anything, so `extra: { args }` on the MCP
denial path would put unvetted tool arguments into a permanent plaintext audit
row and no check in this repo would see it. It is one of the thirteen entries in
`KNOWN_UNANALYSABLE`, and the only one that is a defect rather than an accounting
fact — the other twelve are files logging ids, enums and `err` through names the
rule cannot resolve. Narrowing the parameter to a named union closes it and lets
that entry be deleted; that was left out of this diff because `authorize.ts` was
being edited concurrently on another branch.
