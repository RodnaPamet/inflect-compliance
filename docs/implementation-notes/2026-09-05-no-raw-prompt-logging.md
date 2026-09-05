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
object spread, a helper it cannot open, a variable declared elsewhere — under
its own messageId. `reportSinks` reports each sink it recognised. Together they
make the guard's clean result mean something: "zero violations" and "zero sinks
found" are the same output otherwise.

Measured when this landed: **46 files, 33 sink calls in 11 of them, 0 raw-content
violations, 1 un-analysable position.** The sink count was cross-checked against
a naive grep of the same population (32 grep-shaped calls plus one bare `log(`
the grep could not see) — the AST census and the grep agree exactly, so the
sweep is not quietly skipping files.

## Files

| File | Role |
| --- | --- |
| `eslint-rules/agentic-path.js` | The scope. Live globs (each must match a real file) + anticipatory globs (must match nothing today, must point at a real directory). |
| `eslint-rules/rules/no-raw-prompt-logging.js` | The rule: sinks, content vocabulary, reducer vocabulary, the walk, the two census modes. |
| `eslint-rules/__tests__/no-raw-prompt-logging.test.ts` | RuleTester. Ten `valid` cases, one per narrowing. |
| `eslint.config.mjs` | Wires the rule at `error`, scoped to `AGENTIC_PATH_GLOBS`. |
| `eslint-rules/index.js` | Registers the rule on the `local` plugin. |
| `tests/guards/no-raw-prompt-logging.test.ts` | Runs the rule over the git-listed path; floors the sinks; pins the un-analysable set exactly; four planted mutations. |
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
  rule's output is per-file violations; it has no way to say "I judged 33 call
  sites and could not read 1". That number is part of the result, so the guard
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
row and no check in this repo would see it. It is the single entry in
`KNOWN_UNANALYSABLE`. Narrowing the parameter to a named union closes it and
lets the entry be deleted; that was left out of this diff because
`authorize.ts` was being edited concurrently on another branch.
