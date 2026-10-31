/**
 * On the agentic path, nothing logs the prompt.
 *
 * `src/app-layer/ai/decision-log/index.ts` keeps this discipline for the
 * AI-FEATURE path and says so in a comment: the row holds "a DIGEST of the
 * sanitised input (never the raw prompt/PII)". A comment binds the module that
 * carries it. The AGENTIC path — the MCP server, the workflow engine, the
 * propose-not-commit queue — had no equivalent, and it is the path where the
 * content arrives from a principal nobody vetted.
 *
 * The stake is asymmetric. `AgentProposal.payloadJson`, `WorkflowRun.contextJson`
 * and `WorkflowStep.inputJson`/`outputJson` are ENCRYPTED at rest precisely
 * because of what they hold. `AuditLog.detailsJson` is plaintext, hash-chained,
 * and the one store `docs/data-retention.md` promises never to erase by default.
 * A single `detailsJson: { prompt }` moves the content from the first into the
 * second, and there is no lever to pull afterwards.
 *
 * ── What this file is, and what it is not ────────────────────────────
 *
 * The ENFORCEMENT is `local/no-raw-prompt-logging`, an AST rule, because the
 * check is syntax and a regex over these files cannot tell the word `prompt` in
 * a doc comment from a value at a sink. Its own narrowings are proved by
 * `eslint-rules/__tests__/no-raw-prompt-logging.test.ts`; that it is WIRED at
 * `error` is owned by `tests/guards/eslint-local-rules-wired.test.ts`.
 *
 * This file is the part ESLint cannot do from inside one file:
 *
 *   1. Run that rule over the population **git** defines, so a new agentic file
 *      fails here even for somebody who never runs `npm run lint`.
 *   2. Report the DENOMINATOR. "Zero violations" and "zero sink calls found"
 *      are the same output, and only one of them means anything — so the sinks
 *      the rule recognised are counted and floored.
 *   3. Cap what the rule CANNOT judge. A name check has holes — an object
 *      spread, a helper it cannot open, and (by far the largest class) a value
 *      that is just a local identifier the rule cannot resolve. The rule
 *      reports each under its own messageId and this file caps them two ways,
 *      because neither cap alone is enough:
 *
 *        - the exact SET of `<file> — <kind>` pairs, which reddens when a new
 *          FILE or a new KIND of hole appears. It does NOT see one more opaque
 *          identifier inside a file already listed — twelve of the thirteen
 *          entries are that kind, so most of the population is invisible to it.
 *        - the opacity PER SINK CALL, which is the number that moves when an
 *          existing field bag grows.
 *
 *      A detector that silently drops what it cannot parse reports full
 *      coverage of the subset it understands.
 *   4. Prove the detector fires, so a clean sweep is not a rule that reports
 *      nothing at all — and prove the biggest hole class is COUNTED rather
 *      than silently passed, which is what it was until 2026-09-05.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { Linter } from 'eslint';

import { repoRelativeFiles, repoRelative, REPO_ROOT } from '../helpers/repo-files';

// `require`, not `import`: under ts-jest's CommonJS output an ESM default
// import of a CJS parser yields the interop wrapper rather than the parser
// object, and a flat config silently falls back to espree — which cannot read a
// type annotation, so every TypeScript file would "lint clean".
const tsParser = require('@typescript-eslint/parser');
const rule = require('../../eslint-rules/rules/no-raw-prompt-logging');
// The SAME module `eslint.config.mjs` scopes the rule with. One definition, so
// the lint scope and the swept population cannot drift apart — a scope that
// disagrees with itself reports full coverage of whichever half is smaller.
const {
    AGENTIC_PATH_GLOBS_LIVE,
    AGENTIC_PATH_GLOBS_ANTICIPATORY,
    matchesAgenticPath,
} = require('../../eslint-rules/agentic-path');

const RULE_ID = 'no-raw-prompt-logging';
const linter = new Linter();

interface Finding {
    file: string;
    line: number;
    messageId: string;
    message: string;
}

/**
 * Run the rule over one file's source in CENSUS mode.
 *
 * A PARSE FAILURE THROWS rather than returning zero findings. The default
 * espree parser cannot read a type annotation, so without this a TypeScript
 * file would come back clean by failing to be read at all — the silent-skip
 * shape this guard exists to refuse.
 */
function lint(source: string, filename: string): Finding[] {
    const messages = linter.verify(
        source,
        [
            {
                files: ['**/*.ts'],
                plugins: { local: { rules: { [RULE_ID]: rule } } },
                languageOptions: {
                    parser: tsParser,
                    ecmaVersion: 2022,
                    sourceType: 'module',
                },
                rules: {
                    [`local/${RULE_ID}`]: [
                        'error',
                        { reportUnanalysable: true, reportSinks: true },
                    ],
                },
            },
        ],
        filename,
    );
    const fatal = messages.filter((m) => m.fatal);
    if (fatal.length > 0) {
        throw new Error(
            `${repoRelative(filename)} did not parse, so it was never checked: ${fatal
                .map((m) => `${m.line}: ${m.message}`)
                .join('; ')}`,
        );
    }
    return messages.map((m) => ({
        file: filename,
        line: m.line,
        messageId: String(m.messageId),
        message: m.message,
    }));
}

/** The swept population: what git lists, narrowed by the shared path module. */
const AGENTIC_FILES: readonly string[] = repoRelativeFiles().filter((rel) =>
    matchesAgenticPath(rel),
);

const FINDINGS: readonly Finding[] = AGENTIC_FILES.flatMap((rel) => {
    const abs = path.join(REPO_ROOT, rel);
    return lint(readFileSync(abs, 'utf8'), abs);
});

const byId = (id: string) => FINDINGS.filter((f) => f.messageId === id);

/**
 * The positions the rule could not judge, as `<file> — <kind>`.
 *
 * NO LINE NUMBERS: a hole's line moves on every unrelated edit above it, and a
 * ratchet that reddens for that teaches people to update it without reading it.
 *
 * TWO KINDS, and the big one arrived on 2026-09-05.
 *
 * `identifier bound elsewhere` — a value at a sink that is a plain local:
 * `reason`, `cardId`, `err`, `where`. The rule does no data-flow analysis, so it
 * cannot tell `const detail = reason` from `const detail = prompt`, and until
 * this class was counted it reported NOTHING for either. That silence covered
 * the easiest way to write the leak — it is the first hole the rule's own header
 * names — while the ratio below sat at 0.026 and the set below had one entry.
 * The entries are not defects to fix one by one; every one of them is a sink
 * logging an id, an enum or an `err`. They are here because the honest
 * denominator includes them, and because a rule that cannot see this class must
 * say how much of the path the class covers.
 *
 * `spread of an object whose keys are not in the source` — one entry, and a real
 * finding. `denyToolCall` in `src/lib/mcp/authorize.ts` takes
 * `extra?: Record<string, unknown>` and spreads it straight into the
 * `AUTHZ_DENIED` row's `detailsJson`. Every one of its eight call sites passes
 * scalars — a capability name, a required autonomy level, a resource/action
 * pair — but the TYPE permits anything, so `extra: { args }` on the MCP denial
 * path would put unvetted tool arguments in a permanent plaintext audit row and
 * no check in this repo would see it. Narrowing that parameter to a named union
 * closes the hole and lets that entry be deleted.
 *
 * ADDING AN ENTRY is a decision, not a formality: say in the same diff why the
 * fields cannot be named at the sink. A new file appearing here with
 * `identifier bound elsewhere` is ordinary — it means somebody added logging to
 * the agentic path. A new file appearing with a SPREAD or a HELPER kind is not:
 * that is a field bag whose names never reach the source, and the fix is to
 * name them at the sink.
 */
const KNOWN_UNANALYSABLE: readonly string[] = [
    'src/app-layer/jobs/agent-proposal-expiry.ts — identifier bound elsewhere',
    'src/app-layer/jobs/agent-invoke-dispatch.ts — identifier bound elsewhere',
    'src/app-layer/jobs/agent-proposal-sample-audit.ts — identifier bound elsewhere',
    'src/app-layer/usecases/agent-policy-card.ts — identifier bound elsewhere',
    'src/app-layer/usecases/agent-proposal-sample-audit.ts — identifier bound elsewhere',
    'src/app-layer/usecases/agent-proposals.ts — identifier bound elsewhere',
    'src/app-layer/usecases/agent-registry.ts — identifier bound elsewhere',
    // AGENTIC UI 4/4 (#2467). The pack export's audit row NAMES every field at
    // the sink — `summary`, `documentBytes`, `retentionDays` — and the rule's
    // hole is about their VALUES being local bindings, not about a field bag.
    // The one HELPER-kind hole this file first produced was removed rather than
    // registered, by hoisting the byte count to a const: that kind means "names
    // that never reach the source", which was not true here, and registering a
    // misdescribed hole is worse than having none.
    'src/app-layer/usecases/agent-governance-pack-export.ts — identifier bound elsewhere',
    // The review attribution capture (#3728). Two holes, both the run id passed
    // in as a parameter, in its two log lines: "no suggestion recorded" with the
    // outcome, and "capture failed" with `err.name`. This file reads the model's
    // answer, so what is NOT at its sinks matters most. Neither log line nor its
    // audit row carries the answer, the contract's issues (they quote the
    // answer), an evidence pointer or the suggested person: only a run id, a
    // tenant id, a closed outcome code, a status, a grade and counts.
    'src/app-layer/usecases/agent-harness-attribution.ts — identifier bound elsewhere',
    'src/app-layer/usecases/agent-risk-assessment.ts — identifier bound elsewhere',
    'src/app-layer/usecases/agent-tool-exposure.ts — identifier bound elsewhere',
    // The execution walk moved out of `workflow-runs.ts` into the static
    // driver, and its log sinks went with it. Both files appear because both
    // still log: the usecase for run lifecycle, the driver for each step.
    'src/lib/agentic/drivers/static-driver.ts — identifier bound elsewhere',
    'src/lib/agentic/run-concurrency-policy.ts — identifier bound elsewhere',
    // #3473 — the same shape as every other policy module in this family: the
    // log line names `tenantId` and `requestId`, which the rule cannot follow
    // to their bindings. REGISTERED rather than reworded, because that is this
    // guard's own design — "what the rule could NOT judge is counted, not
    // hidden" — and because the alternative would be inlining a tenant id to
    // satisfy a static analyser.
    //
    // Only ONE entry, deliberately. The first draft of that module also used a
    // conditional spread for `requestId` and earned a second hole ("spread of
    // an object whose keys are not in the source"); the spread was removed
    // instead, matching the sibling above. A hole that can be closed should be.
    'src/lib/agentic/subagent-fanout-policy.ts — identifier bound elsewhere',
    'src/lib/agentic/open-run-streams.ts — identifier bound elsewhere',
    'src/lib/agentic/openshell/executor.ts — identifier bound elsewhere',
    'src/lib/agentic/openshell/kill-drill.ts — identifier bound elsewhere',
    'src/app-layer/usecases/workflow-runs.ts — identifier bound elsewhere',
    // RELOCATION, not a new hole. `haltRunAtCap` was extracted from the static
    // driver into the shared settlement module when a second engine arrived —
    // the same audit sink, the same six structural fields (a cap kind, two
    // integers, a source, and how much work stopped), in a new file. The
    // driver keeps its own entry because other sinks stayed behind.
    'src/lib/agentic/drivers/run-settlement.ts — identifier bound elsewhere',
    // The worker's entry point for a queued run. Two log lines, and every
    // value at both is an id (tenantId, runId), a closed-union status, or a
    // refusal REASON drawn from a fixed set — never model input or output.
    // The run's reasoning never passes through this module: it reports what
    // the usecase decided and returns.
    'src/app-layer/jobs/agent-run-execute.ts — identifier bound elsewhere',
    // ── THE FLUE ENGINE'S THREE SINKS ───────────────────────────────────────
    //
    // The kind to read carefully here is `runtime-start.ts`'s: a HELPER kind
    // normally means a field bag whose names never reach the source, which is
    // the shape worth refusing. It is not that. The helper is
    // `providers.map((p) => p.id)` — a list of the two provider IDS this
    // deployment registered, which is the one fact that boot line exists to
    // report. Hoisting it to a const would only move it into the `identifier
    // bound elsewhere` class without making anything more visible, and the
    // note above `agent-governance-pack-export.ts` is explicit that
    // registering a MISDESCRIBED hole is worse than having none.
    //
    // What cannot be shown structurally, and is true of all three: none of
    // these modules logs model input or output. The driver's warn line carries
    // ids, a workflow key, a residency and a model SPECIFIER — which names a
    // provider and a model, never a credential and never the prompt. The
    // dispatch line carries ids and two COUNTS. The reply text is deliberately
    // absent from both the log and the step ledger: agent output becomes an
    // `AgentProposal` if it becomes anything, and that row is guarded and
    // reviewable where a log line is neither.
    'src/lib/agentic/flue/driver.ts — identifier bound elsewhere',
    'src/lib/agentic/flue/execute.ts — identifier bound elsewhere',
    // RELOCATION, not a new hole — the same reading as `run-settlement.ts` and
    // `step-recorder.ts` above. `recordModelDecision` was extracted from
    // `execute.ts` so a CJS suite could load and RUN it (the Art 14 join key it
    // writes had to be provable against a real row, and no test can import a
    // module that statically imports `@flue/runtime`). Its one `logger.error`
    // moved with it unchanged: a tenant id, a workflow key and an
    // `err.message`. `execute.ts` keeps its own entry because its dispatch log
    // line stayed behind, and `MEASURED_HOLES` does not shift — which is what a
    // pure move looks like here.
    'src/lib/agentic/flue/model-decision.ts — identifier bound elsewhere',
    'src/lib/agentic/flue/runtime-start.ts — call to a helper this rule cannot open',
    'src/lib/agentic/agent-authority.ts — identifier bound elsewhere',
    // The REST gate for an agent-bound key (#4481): one denial row and one
    // audit-failure warn. Every value is an id, a closed reason, a kill scope,
    // a register status, or the request's method and path. No prompt reaches it.
    'src/lib/agentic/agent-key-rest-gate.ts — identifier bound elsewhere',
    // The tenant's driver toggle: one audit row and one log line, both written
    // when an OWNER changes which engine executes this tenant's agentic runs.
    // Every value at both sinks is an id (`tenantId`), a member of the closed
    // two-value `AgentDriverMode` union (`from`, `to`), or a boolean naming the
    // state of the OTHER key in the gate (`envEnabled`, `implemented`). No
    // prompt, no model output and no credential can reach either: this usecase
    // never sees a run — it writes a column and returns.
    'src/app-layer/usecases/agent-driver-setting.ts — identifier bound elsewhere',
    // The driver gate's two fallback log lines. Every value at both sinks is an
    // id (`tenantId`, `requestId`), a workflow key, or a member of a closed
    // union (`driver`, `reason`) — plus one `err.message`. The rule does no
    // data-flow analysis, so a plain local named `tenantId` is indistinguishable
    // to it from one named `prompt`; that is the whole `identifier bound
    // elsewhere` class. The fields ARE named at the sink. What cannot be shown
    // structurally is that no prompt-shaped value exists in that module to
    // name — it holds no model call, no transcript and no tool arguments.
    'src/lib/agentic/agent-driver-policy.ts — identifier bound elsewhere',
    // The step recorder, extracted from `static-driver.ts` so a second driver
    // writes steps through the same seam. The holes MOVED file rather than
    // appeared: `recordStep`'s audit row is unchanged, and `MEASURED_HOLES`
    // does not shift — which is what a pure move should look like here, and
    // why this entry is a new PAIR with no new number beside it.
    'src/lib/agentic/drivers/step-recorder.ts — identifier bound elsewhere',
    // The monthly budget's two fallback/refusal log lines. Every value at both
    // sinks is an id (`tenantId`, `requestId`), an integer token count, or one
    // `err.message`. The module holds no model call, no transcript and no tool
    // arguments, so there is no prompt-shaped value in scope for it to name —
    // which is the part that cannot be shown structurally, hence the entry.
    // The SIGTERM drain's two log lines. Every value at both sinks is a run id,
    // an integer count, a boolean or one `err.message`. The module holds no
    // model call, no transcript and no tool arguments — there is no
    // prompt-shaped value in scope for it to name, which is the half that
    // cannot be shown structurally.
    'src/lib/agentic/in-flight-runs.ts — identifier bound elsewhere',
    'src/lib/agentic/monthly-budget-policy.ts — identifier bound elsewhere',
    'src/lib/agentic/agent-registration-gate.ts — identifier bound elsewhere',
    'src/lib/agentic/policy-card-store.ts — identifier bound elsewhere',
    'src/lib/mcp/auth.ts — identifier bound elsewhere',
    'src/lib/mcp/authorize.ts — identifier bound elsewhere',
    'src/lib/mcp/authorize.ts — spread of an object whose keys are not in the source',
    'src/lib/mcp/tools/registry.ts — identifier bound elsewhere',
    // ASI04 tool-supply-chain sinks. Both files were read line by line: neither
    // carries a prompt, a description, a payload or captured output — the
    // opaque values are a tenant id, a tool NAME, byte counts and an outcome
    // code. They are holes because the rule counts a bare identifier at a value
    // position, which is the class this guard deliberately started counting
    // rather than pretending it could see through. Naming them differently
    // would not make them readable; it would only make the code worse.
    // ASI08/ASI10 kill-switch sinks. Both files were read line by line: neither
    // carries a prompt, a tool argument, a workflow context or a proposal
    // payload. The opaque values are a tenant id, a job-run id, a kill-switch
    // id, a derived scope name ('AGENT' | 'TENANT'), an actor id and an
    // `err.message` — all bound to locals one or two lines above their sink,
    // which is the class this guard counts rather than pretends to see through.
    // Naming them differently would not make them readable; it would only make
    // the code worse. Note what is deliberately NOT here: a HELPER or SPREAD
    // kind. `killScopeOf(...)` was inline at both audit sinks and produced one;
    // it is now bound to a `const scope` first, which is the fix this list's own
    // header prescribes rather than an entry.
    'src/app-layer/jobs/agent-kill-switch-drill.ts — identifier bound elsewhere',
    'src/app-layer/usecases/agent-kill-switch.ts — identifier bound elsewhere',
    'src/lib/agentic/bounded-exec.ts — identifier bound elsewhere',
    'src/lib/agentic/tool-manifest-store.ts — call to a helper this rule cannot open',
    'src/lib/agentic/tool-manifest-store.ts — identifier bound elsewhere',
    // The Tool Runner engine (Step 2b, #4149). Read line by line: the one
    // opaque value in each is the run id, beside field names written at the
    // sink. The engine logs no prompt, no tool argument and no model text; the
    // model's text reaches only the decision row's bounded, sanitised summary.
    'src/lib/agentic/tool-runner/driver.ts — identifier bound elsewhere',
    'src/lib/agentic/tool-runner/execute.ts — identifier bound elsewhere',
    // ASI08/ASI10 behavioural circuit breaker. Both files were read line by
    // line: neither carries a prompt, a proposal payload, a rationale or any
    // captured tool output. The opaque values are a tenant id, an agent id, a
    // tool NAME, a close-reason code from `BREAKER_CLOSE_REASONS` and a boolean.
    // They are holes because the rule counts a bare identifier at a value
    // position, which is the class this guard deliberately started counting
    // rather than pretending it could see through. Two fields that WOULD have
    // been holes were removed instead of renamed — the capability class (a tool
    // name implies it) and a repeat of the agent id inside a summary string
    // (`entityId` already carries it); renaming the rest would not make them
    // readable, only the code worse.
    'src/app-layer/usecases/agent-circuit-breaker.ts — identifier bound elsewhere',
    'src/lib/agentic/circuit-breaker-store.ts — identifier bound elsewhere',
    // RELOCATION BROUGHT IT INTO SCOPE, rather than new logging (#3323). The
    // grant endpoint moved from `src/app/api/t/<slug>/admin/mcp/entra-grant` to
    // `src/app/api/mcp/entra-grant` because the first path's EDGE contract
    // admits only a session cookie or an `iflk_` key, and our own dispatch
    // holds neither. `src/app/api/mcp/**` is a LIVE agentic glob and the old
    // path matched none, so this file's logging is newly MEASURED, not newly
    // written — the move is the forcing function working as intended.
    //
    // The one hole is `detail: err instanceof Error ? err.message : String(err)`
    // in the catch around `appendAuditEntryOrQueue`. It cannot be named at the
    // sink: a literal would say nothing, and any expression over `err` is this
    // class by construction. The other two fields beside it, `tenantId` and
    // `reason`, ARE named, and `reason` is a member of the closed seven-case
    // `GrantAuthRefusal` union.
    //
    // What cannot be shown structurally: nothing prompt-shaped exists in that
    // module to name. The thrown value comes from OUR audit writer, not from a
    // caller — the route authenticates before it parses a body, so a refused
    // request's payload is never read, let alone logged. The presented
    // credential is excluded deliberately and by test: not the secret, and not
    // its length.
    'src/app/api/mcp/entra-grant/route.ts — identifier bound elsewhere',
    'src/app/api/t/[tenantSlug]/agent-runs/[id]/stream/route.ts — identifier bound elsewhere',
];
/**
 * Floor on the sink calls the sweep recognised. Measured at 33 across 11 files
 * when this landed; floored a little below so an ordinary refactor does not
 * redden CI, but high enough that a sweep which stopped finding sinks — a
 * renamed logger, a moved audit writer, a `files` glob that matches nothing —
 * cannot pass as a clean result.
 */
const SINK_FLOOR = 30;

/**
 * The ceiling on opacity, and where the number comes from.
 *
 * This used to read `holes / sinks < 0.1` and it meant "a small share". It no
 * longer means that, because the quantity changed underneath it: a hole is a
 * POSITION, not a call, and since the opaque-identifier class started being
 * counted the numerator scales with how many FIELDS the path logs rather than
 * with how many calls it makes. Measured, the ratio went 0.026 → 2.154 over an
 * unchanged tree — the leaks it can now see were always there, the rule was
 * silent about them.
 *
 * So the number is read as OPAQUE VALUE POSITIONS PER RECOGNISED SINK CALL, and
 * the ceiling is derived from two measured quantities rather than picked:
 *
 *   MEASURED_HOLES / MEASURED_SINKS         the path today, 113 / 51 = 2.216
 *   MOST_OPAQUE_SINGLE_CALL                 the worst single call on it, 6
 *
 * The ceiling is `(113 + 6) / 51`. In words: the path may absorb ONE more sink
 *   MEASURED_HOLES / MEASURED_SINKS         the path today, 99 / 51 = 1.941
 *   MOST_OPAQUE_SINGLE_CALL                 the worst single call on it, 6
 *
 * The ceiling is `(99 + 6) / 51`. In words: the path may absorb ONE more sink
 *   MEASURED_HOLES / MEASURED_SINKS         the path today, 99 / 46 = 2.152
 *   MOST_OPAQUE_SINGLE_CALL                 the worst single call on it, 6
 *
 * The ceiling is `(99 + 6) / 46`. In words: the path may absorb ONE more sink
 *   MEASURED_HOLES / MEASURED_SINKS         the path today, 108 / 48 = 2.25
 *   MOST_OPAQUE_SINGLE_CALL                 the worst single call on it, 6
 *
 * The ceiling is `(108 + 6) / 48`. In words: the path may absorb ONE more sink
 *   MEASURED_HOLES / MEASURED_SINKS         the path today, 106 / 59 = 1.797
 *   MOST_OPAQUE_SINGLE_CALL                 the worst single call on it, 6
 *
 * The ceiling is `(106 + 6) / 59`. In words: the path may absorb ONE more sink
 * call as opaque as the most opaque one it already has before somebody has to
 * look. Two such calls fail. Seven more opaque fields on the EXISTING calls,
 * with no new sink, fail. That is the sensitivity this cap is for — it moves
 * when a field bag grows, which is the thing the exact set above cannot see.
 *
 * RE-MEASURED 2026-09-06, when the ASI08 failure-isolation work added the first
 * `src/app-layer/jobs/agent-*.ts` file — the anticipatory glob doing exactly
 * what it was written for. Sinks went 45 → 51 and holes 97 → 99, and note the
 * direction that combination moves the ceiling: 2.156 → 1.941 for the observed
 * ratio and 2.289 → 2.059 for the cap. Six new sink calls with two new opaque
 * positions between them TIGHTENS the budget rather than buying headroom, which
 * is the arithmetic working. The two new holes are both in
 * `workflow-runs.ts` (`entityId: runId`, `stepSeq: seq` on the isolated-failure
 * audit row) — a file already listed below, so the SET does not move. The new
 * job contributes ZERO: its log lines spell `component` out as a literal and
 * its audit row passes a timestamp rather than an inline subtraction, both
 * changed deliberately so the rule can read them.
 *
 * A rejected alternative, recorded because the reasoning matters more than the
 * number: the rule could also census the NAMED POSITIONS it resolves (object
 * keys, member-chain final properties), which gives `holes / positions = 0.099`
 * — under the old 0.1 ceiling, no change required. That denominator is mostly
 * object KEYS, and keys are not where a renamed value hides. Picking it would
 * have been choosing the denominator that keeps the number green, which is the
 * defect this cap exists to catch, one level up.
 */
// 2026-09-06 (ASI08 run caps): +2 holes, +1 sink. `haltRunAtCap` in
// `workflow-runs.ts` writes the `WORKFLOW_RUN_CAP_HALTED` row, and its two
// opaque positions are `entityId: runId` — which every audit call in that file
// already carries — and `stepsNotRun`, an integer count of steps that did not
// execute. Every other field on that row is a member access the rule resolves
// (`halt.kind`, `halt.limit`, `halt.source`, `halt.used`, `halt.refused`), so
// the bag is named at the sink rather than spread. Neither opaque value is
// content, and neither can become content: one is a cuid, the other is derived
// from `def.steps.length`.
// Re-MEASURED 2026-09-06, when the behavioural circuit breaker added its three
// sink calls: 97 / 45 became 108 / 48. Both numbers come from running this
// sweep with the constants zeroed so the failure message prints the real
// counts — never from picking a pair that happens to pass.
/** `src/lib/mcp/auth.ts` — a six-field `detailsJson` bag built out of locals. */
// MEASURED on the merged tree, not carried from any one lane. Four lanes each
// measured this ratchet against a tree that did not contain the other three —
// their numbers were 113/51, 99/46 and 108/48, all correct where they were taken
// and all wrong here. Taking any one of them would have produced a green ratchet
// describing a codebase that does not exist, which is the failure this ratchet is
// for. Re-derived by zeroing both and reading the failure message.
// Re-MEASURED 2026-09-20, when the agent driver seam added its two log calls:
// 143 / 78 became 146 / 83. Taken the prescribed way — both constants floated
// and the failure message read — never by picking a pair that passes.
//
// The sinks figure moved further than this change did, and the gap is worth
// recording rather than quietly absorbing: measured on an UNMODIFIED main the
// real sink count was already 81, three above the stored 78. `sinkSeen` is a
// FLOOR, so the slack was invisible — three sinks had been added by earlier
// work without the constant following, and nothing failed, because a floor only
// notices a fall. This diff contributes +2 (the two `logger.warn` calls in
// `agent-driver-policy.ts`) and the constant is set to the measured 83 rather
// than to 80, closing the inherited slack in the same move.
// Re-MEASURED 2026-09-21 for the monthly-budget policy's two log calls:
// 146 / 83 became 147 / 85. Floated both and read the failure message, as the
// note above requires. Unlike the previous re-measure, the whole delta is
// accounted for by this diff — the +2 sinks are exactly the two `logger.warn`
// calls in `monthly-budget-policy.ts`, with no inherited slack to absorb.
// Re-MEASURED 2026-09-21 for the SIGTERM run-drain: 147 / 85 became 150 / 87.
// Floated both constants and read the failure message, as the note above
// requires — and taken AFTER merging main, because #2706 had already moved
// these numbers and measuring against the pre-merge branch would have pinned a
// baseline that does not exist on either tree.
//
// The whole delta is `src/lib/agentic/in-flight-runs.ts`. This diff adds a
// THIRD log call, the `.catch` in `src/lib/observability/shutdown.ts`, and it
// is correctly absent from both counts: the swept population is
// `matchesAgenticPath`, which observability is not part of. That is also why
// only one new file/kind pair appears below.
// Re-MEASURED 2026-09-21 for the run-engine record: 150 / 87 became 154 / 87.
// SINKS DID NOT MOVE, and that is the shape of this diff — it adds fields to
// two `appendAuditEntry` calls that were already swept, rather than a new call.
//
// The whole delta is `src/app-layer/usecases/workflow-runs.ts`, measured per
// file rather than inferred from the total: 4 holes before, 8 after, with the
// other files unchanged. The start row's driver fields go from two to four,
// and the resume row goes from a bare `{ category: 'access' }` literal — which
// is analysable, and is why it contributed nothing before — to four bound
// identifiers.
//
// All eight are `identifier bound elsewhere`, so no new file/kind pair appears
// below. Every value is a closed `'static' | 'flue'` union or the nullable
// reason string beside it; none can carry prompt text, and the rule cannot
// know that, which is exactly what being counted here means. The calls are
// bound to locals rather than spelled at the sink — `requestedDriver(def)`
// inline added a FIFTH kind, "call to a helper this rule cannot open", and
// that one is a new pair rather than a bigger number.
// Re-MEASURED 2026-09-21 for the guard-block breaker latch: 150 / 87 became
// 152 / 88. Floated both and read the printed counts, as the note above
// requires. The +1 sink is `latchOnGuardBlock`'s single `logger.warn`; the +2
// holes are its two value positions (`tenantId`, `agentId`) plus the
// `err.message` arm, in a file already listed below.
// Re-MEASURED 2026-09-21 a THIRD time, on the merge of this branch with the
// main that #2726 had just landed on: 154 / 87 became 156 / 88.
//
// Both notes above are kept because both deltas are real and neither explains
// the other -- #2726's four holes are the driver fields on two audit rows,
// this branch's two are `latchOnGuardBlock`'s new sink. The number here is the
// UNION, and it was measured rather than added up: each branch was green
// against 150, so arithmetic alone would have justified 152 or 154 depending
// on merge order, and both would have been wrong on the tree that actually
// results. A ceiling one lower than the tree it guards is a red build; one
// higher is headroom the next regression spends.
//
// The union was also measured ahead of time on main + #2723 + #2726 + this
// branch, which reported the same 156 / 88 -- so #2723 contributes nothing,
// and the number does not depend on which of the two lands first.
// Re-MEASURED 2026-09-22 for the agent-proposal BULK REJECT: 159 / 91 became
// 160 / 92. ONE new sink — `bulkRejectAgentProposals`' rejection audit row —
// and ONE hole in it, the proposal id, which is a local binding from the map
// over the accepted ids and so reads as `identifier bound elsewhere`. Nothing
// in that row carries proposal CONTENT: the entry names the entity, the actor
// and the category, exactly as the single-proposal rejection beside it does.
// Both numbers were read off the failing assertions rather than added to the
// previous pair, and note the direction — a sink arriving with one hole
// TIGHTENS `HOLES_PER_SINK_CEILING` (1.8132 → 1.8043), which is what the
// denominator is in the formula for.
// And re-measured AGAIN on the union with `agent-run-execute` (point 10): the
// worker's entry point adds one sink of its own. Neither number was carried
// over from either branch — both were read off the failing assertions on the
// MERGED tree, because two branches each raising a shared budget is precisely
// how a ceiling ends up describing a tree nobody built.
// Re-MEASURED 2026-09-22 for the Art 12 decision row (point 4b): 164 / 94
// became 165 / 95. ONE new sink — `recordModelDecision`'s catch-site
// `logger.error` — and ONE hole in it, the `err instanceof Error ? err.message
// : String(err)` ternary, which is the idiom every sibling catch in
// `src/lib/agentic/` already uses (`agent-authority.ts:277`,
// `circuit-breaker-store.ts:186`, `agent-registration-gate.ts:379`). The other
// three fields resolve. Nothing in that line carries model CONTENT: the
// prompt and the reply go to the row the call FAILED to write, and what the
// log keeps is the tenant, the workflow key and the failure reason.
// Read off the failing assertions on this branch merged with main, not added
// to the previous pair. Note the direction — a sink arriving with one hole
// TIGHTENS `HOLES_PER_SINK_CEILING` (1.8085 → 1.8), which is what the
// denominator is in the formula for.
// Re-MEASURED 2026-09-23 for the Flue GUARD SETTLE ARMS (points 4c + 4d/4f):
// 165 / 95 became 169 / 96. ONE new sink — `haltRunAtGuard`'s audit row — and
// FOUR holes in it: the settle message, the verdict, the rule-id array and the
// run id, every one a value bound to a local before the call. The message is
// built from rule IDS and never from the content that tripped them, which is
// the whole reason a guard-halt row is safe to write at all: the text the
// scanner matched is the thing the guard exists to contain.
//
// Re-MEASURED 2026-09-23 for the Flue GUARD SETTLE ARMS (points 4c + 4d/4f):
// 165 / 95 became 169 / 96. ONE new sink — `haltRunAtGuard`'s audit row — and
// FOUR holes in it: the settle message, the verdict, the rule-id array and the
// run id, every one a value bound to a local before the call. The message is
// built from rule IDS and never from the content that tripped them, which is
// the whole reason a guard-halt row is safe to write at all.
//
// AND A MEASUREMENT TRAP, recorded because it cost a wrong number that LOOKED
// right. Taken mid-merge — after resolving the conflict with #2777, before
// committing it — this pair reads 173 / 100. The population comes from
// `repoFiles()`, which is `git ls-files --cached`, and during an uncommitted
// merge that lists a conflicted path ONCE PER STAGE. `execute.ts` was scanned
// twice, contributing its own four sinks and four holes a second time: 96 + 4
// and 169 + 4, an exact fit, which is what makes the wrong figure plausible
// rather than obviously broken. MEASURE ON A COMMITTED TREE.
//
// The `MEASURED_HOLES`-is-a-CEILING caution still applies to #2780, which is
// open and moves this pair independently: a figure measured for a tree that
// does not exist yet is an evicted green run in the merge queue rather than a
// red branch.
// Re-MEASURED 2026-09-23 for the agentic driver TOGGLE (point 1d): 165 / 95
// became 169 / 97. TWO new sinks — the mode-change audit row and the one log
// line beside it — and FOUR holes across them, every one a value bound to a
// local before the call (`before.mode`, `next`, `before.envEnabled`,
// `ctx.tenantId`). Nothing at either sink can carry content: this usecase
// writes a column and returns, and never sees a run, a prompt or a reply.
//
// Two sinks carrying four holes LOOSENS `HOLES_PER_SINK_CEILING` (1.8 ->
// 1.8041) — the one direction this pair is not supposed to move, so it is
// spelled out rather than left to arithmetic: four holes for two sinks is
// worse than this subsystem's average, and the entry above names exactly which
// four so the next reader can judge whether they are the harmless kind.
//
// MEASURED ON THE MERGED TREE, after #2776 landed and its 165 / 95 became this
// branch's base — not added to it. The distinction has teeth because
// `MEASURED_SINKS` is a FLOOR: a number declared for a tree that does not yet
// exist passes nothing and fails in the merge queue, where the cost is an
// evicted green run rather than a red branch. The figures above happen to
// equal 165/95 + 4/2, and that is a fact discovered afterwards rather than the
// way they were obtained.
// RE-MEASURED after #2780 landed and this branch merged main: 169 / 96 became
// 173 / 98. #2780 brought the agentic driver toggle's two sinks and four holes;
// this branch brings `haltRunAtGuard`'s one sink and four holes. Neither branch
// could have declared this pair on its own, which is the whole reason it is
// re-measured at the merge rather than carried across it.
//
// MEASURED ON A COMMITTED TREE, with `git status` clean and zero unmerged
// paths. Taken mid-merge this same pair reads four higher, because the
// population is `git ls-files --cached` and that lists a conflicted path ONCE
// PER STAGE — the conflicted file's own findings counted twice. The inflated
// figure fits plausibly and passes its own single-file run, which is what makes
// it dangerous; it fails only the full sweep, after the commit.
// Re-MEASURED 2026-09-23 for FLUE PER-TURN ACCOUNTING: 173 / 98 became
// 174 / 99. ONE new sink and ONE new hole, both in the same `logger.warn` —
// the fail-safe that fires when a settled response reported tokens but the
// event stream carried no per-call usage. The hole is its shorthand `runId`
// field (`identifier bound elsewhere`), the same hole the `flue-driver:
// dispatching` line beside it already has; the other three fields are a
// literal, `def.key` and `usage.totalTokens`, none of which can carry content.
//
// One hole for one sink is BETTER than this subsystem's average, so
// `HOLES_PER_SINK_CEILING` tightens with it: (173+6)/98 = 1.8265 becomes
// (174+6)/99 = 1.8182. That is the direction this pair is supposed to move.
//
// The per-call accounting itself adds NO sink. It reads `response.usage` off
// the runtime's turn events — four numbers — and the rows it writes go through
// `recordModelDecision`, which was already counted.
//
// MEASURED ON A TREE WITH ZERO UNMERGED PATHS (`git status --porcelain` showing
// only ordinary ` M` / `??` entries). The population is `git ls-files --cached
// --others`, which lists a CONFLICTED path once per merge stage; measured
// mid-merge this pair reads high by exactly the conflicted file's own findings,
// which fits plausibly and passes a single-file run. The figure above was cross-
// checked by linting `origin/main`'s `execute.ts` and this branch's separately:
// 2/2 against 3/3, which is the whole difference between 173/98 and 174/99.
// 174 → 176: KILL SWITCH STOPS THE MODEL CALL. `haltRunAtKill` is a new
// settlement arm and a new audit sink, and two of its `detailsJson` values are
// `identifier bound elsewhere` — `kill.scope` and `kill.switchId`, both fields
// of the verdict row the switch read, beside field names that ARE in the
// source. That file and that kind are already in KNOWN_UNANALYSABLE, so the
// PAIR list is unchanged and only the count moves.
//
// Nothing in that row carries prompt content, and the message deliberately
// does not echo the reason text an administrator typed — that is the same rule
// `assertNotKilled` follows at the tool boundary, for the same reason: the
// caller being told about the refusal is the thing that was just stopped.
// 176 -> 177: A RUN THAT COULD REACH NOTHING NAMES ITS GAP. `executeFlueRun`
// now writes `errorMessage: EMPTY_TOOLSET_MESSAGE` onto the COMPLETED run when
// the agent held no tool grants, so the row says what could not happen instead
// of reading as a clean success. One hole, `identifier bound elsewhere`, in
// `flue/execute.ts` — a file and kind already in KNOWN_UNANALYSABLE, so the
// PAIR list is unchanged and only the count moves.
//
// The identifier is a module-level CONSTANT this file cannot fold, not a
// value from the run: it is fixed prose naming the misconfiguration and its
// remedy, and it is the same text for every tenant and every run. It cannot
// carry prompt content because it never reads any — the message is written
// before `settleTurns` and does not touch `reply`, `message` or any tool
// result. Kept as a named constant rather than inlined at the sink (which
// would drain the hole) because the text is operator-facing copy that a test
// should be able to assert on by name, and a three-line literal spread inside
// an `updateRun` call is harder to read than the hole is expensive.
// 177 -> 178: THE GRANT ENDPOINT MOVED INTO THE AGENTIC GLOB (#3323). One hole,
// `identifier bound elsewhere`, in a file that is new to this POPULATION rather
// than new to the repo — see its entry in KNOWN_UNANALYSABLE for why the path
// had to change and why the `err.message` beside two named fields cannot be
// drained. Measured, not projected: 178 is this branch's live count.
// 178 -> 186: AN AUTOMATION RULE MAY INVOKE AN AGENT (#3471). TWO sinks in one
// new file, eight holes, every one `identifier bound elsewhere` and every one a
// shorthand property whose VALUE is a local binding the rule cannot fold —
// `tenantId`, `agentId`, `workflowKey`, `depth`, `runId`, and the refusal.
//
// Already DRAINED once before being recorded. The first draft wrote a
// `logger.warn` per refusal branch: four sinks, fourteen holes, and the same
// three identifiers re-counted at each. Routing every refusal through one call
// with the cause as a FIELD took it to two sinks and eight holes without
// hiding anything — the ratio moved the right way (14/4 -> 8/2 locally, and
// 192/113 -> 186/111 across the population).
//
// What remains cannot be drained by inlining. `refusal` is a closed union of
// seven operator actions, `depth` and `runId` are integers and a cuid, and the
// two ids are the row keys an operator greps by. None of them reads a prompt:
// the dispatcher never touches `payload.data` except through `projectInput`,
// whose output goes to `startWorkflowRun` and never to a log line.
// 186 is this branch's live count, measured on a tree with no unmerged paths.
// 186 -> 189: THE CONCURRENT-RUN CAP (#3484). Three holes across four new
// sinks in one file — an `err.message` on the settings read, and the audit
// row's `previousCap` / `cap`, both integers.
//
// The two refusal warns contribute NO hole at all, which is worth stating
// because it is the shape this file keeps asking for: every field at those
// sinks is either a literal or `verdict.cap` / `verdict.inFlight`, a member
// expression the rule resolves. The audit row's two are locals, and they are
// the integers an incident review reads to tell a tightening from a widening.
//
// Nothing here reads a prompt: the cap counts rows by status and never opens
// one. 189 is this branch's live count, measured on a tree with no unmerged
// paths.
// 186 -> 191: RUN REPLAY, AND THE GLOB IT REVEALED (#3472). Five holes across
// two new sinks, plus the widening that brought a third into scope.
//
// THE POPULATION GREW ON PURPOSE. `AGENTIC_PATH_GLOBS_LIVE` covered
// `api/t/*/agent-proposals/**` from the start and `api/t/*/agent-runs/**`
// never — yet `GET /agent-runs/:id` serves the run WITH every step, the rows
// carrying `inputJson` and `outputJson`, the two columns encrypted at rest
// precisely because of what they hold. So an agentic route a prompt could
// reach a log line through sat outside the one rule that looks for that.
// Widening it added 7 files and, measured, ZERO holes from the four routes
// that already existed — they contain no sink at all. The point is the next
// log line somebody writes there, not a number today.
//
// The five that are mine: the shutdown stage's two sinks in
// `open-run-streams.ts` (an `err.message` beside a literal, and `closed` +
// `failed`, both integers this file counts) and the stream route's one (a
// `runId` cuid and an `err.message`). None of them reads a prompt: the tail
// never touches `inputJson` except to hand the whole projected row to the
// wire, and the catch logs the error, not the row.
// 189/191 -> 194: BOTH OF THE ABOVE, ON THE UNION. #3472 and #3484 each
// raised this floor to its own branch's live count and each was right alone —
// 191 and 189 — and neither number is right for the tree that holds both.
// That is the shape a shared ratchet fails in: two separately-green PRs redden
// the combination, and the number has to be RE-MEASURED on the merge rather
// than picked from the two.
//
// 194 = 186 (the base both branched from) + 5 (#3472) + 3 (#3484), and it is
// the MEASURED live count on this merged tree, not that arithmetic — the sum
// is shown only because it reconciles.
//
// 194 -> 198: THE SUBAGENT FAN-OUT CAP (#3473). Four holes in ONE new sink —
// the settings-read `logger.warn` in `subagent-fanout-policy.ts`, which falls
// back to the product default when `TenantSecuritySettings` cannot be read.
// All four are `identifier bound elsewhere`: `tenantId` and `requestId` are
// parameters, `cap` is an imported constant, and `error` is the family's
// `err instanceof Error ? err.message : String(err)`. The sibling
// `run-concurrency-policy.ts` contributes an identically-shaped sink, counted
// among #3484's four.
//
// Nothing in it can carry a prompt: the function reads one integer column and
// logs the failure to read it. There is no model output in its scope.
//
// SAID PLAINLY BECAUSE THE RATIO MOVED THE WRONG WAY. +4 holes against +1 sink
// LOOSENS `HOLES_PER_SINK_CEILING`, and the note under `MEASURED_SINKS` says in
// as many words that this pair is meant to move the other way. Accepted here
// rather than engineered around, for one reason: the alternative is contorting
// a log line — dropping the `cap` field an operator needs, or inlining a
// tenant id to satisfy a static analyser — to improve a number ABOUT
// analysability. That makes the metric better and the logging worse, which is
// the failure this metric exists to detect, pointed inward.
//
// One hole WAS closed rather than registered: the first draft used
// `...(requestId ? { requestId } : {})` and earned a second kind of hole
// ("spread of an object whose keys are not in the source"). The spread went,
// matching the sibling. A hole that can be closed should be; these four
// cannot, without making the log worse.
//
// 198 -> 200: THE REVIEW ATTRIBUTION CAPTURE (#3728). Two holes, both `runId`, a
// parameter, at the capture's two log lines, against three new sinks (two log
// lines and one audit row). The run id is the one field an operator needs to
// find the run whose answer was or was not stored. Wrapping it to satisfy the
// analyser would make the metric better and the logging no better. The
// outcome, the tenant id and `err.name` are already member expressions or
// literals, and the audit row names every field at the sink.
//
// 200 -> 202: THE MONTHLY TOKEN BUDGET'S SETTER (#3777). Two holes, `previous`
// and `budget`, the two numbers its audit row records, against one new sink:
// the same shape as `setConcurrencyCap`'s `previousCap` / `cap` beside it. A
// budget is a token count read from one integer column and passed in as a
// number; "from what to what" is the whole point of the row.
// 202 -> 206: THE OPENSHELL BACKEND'S TWO LOG SINKS (4.2, #3962). Both sit in
// `openshell/executor.ts`, and all four holes are `identifier bound elsewhere`
// — which the docblock above calls ORDINARY for a new file, as distinct from a
// SPREAD or HELPER kind. That distinction holds here: every field NAME is
// written at the sink; only the values are identifiers the rule cannot open.
//
// The four, so the entry can be audited rather than trusted: `sandboxId` twice
// (a function parameter), `outcome` (a destructured deletion enum), and an
// error-message expression. None is prompt-derived — a sandbox id and a
// deletion outcome are not model input — and the sink carrying them exists to
// make a leaked sandbox findable.
//
// This LOOSENS `HOLES_PER_SINK_CEILING`: (202+6)/111 = 1.8739 becomes
// (206+6)/113 = 1.8761. Stated plainly because this file's convention is that a
// loosening carries its reason. Two sinks at two holes each is just above the
// existing average, and the alternative was to log nothing when a sandbox may
// have leaked.
// 206 -> 209: THE KILL-SWITCH DRILL'S SANDBOX ARM (5.4, #3974). ONE sink, in
// `openshell/kill-drill.ts`, carrying three values the rule cannot open:
// `sandboxId` (a local assigned from the create call), `reportedOutcome` (a
// local holding the deletion enum) and an error-message expression. The field
// NAMES are all written at the sink; this is the ORDINARY kind the docblock
// distinguishes from a SPREAD or a HELPER, and it is the same shape as the
// `executor.ts` entry directly above it in the list.
//
// None is prompt-derived: a sandbox id and a deletion outcome are not model
// input. The sink exists for the one case worth logging loudly — a gateway that
// reported a deletion while the sandbox stayed present, which is the failure the
// whole arm exists to catch, and a drill that found it and said nothing would be
// the defect it is testing for.
//
// This LOOSENS `HOLES_PER_SINK_CEILING`: (206+6)/113 = 1.8761 becomes
// (209+6)/114 = 1.8860. Stated plainly because this file's convention is that a
// loosening carries its reason. Three holes on one sink is above the running
// average, and the alternative was to log nothing when a sandbox may have
// leaked — the same trade the entry above records.
// 209 -> 212: THE TOOL RUNNER ENGINE (Step 2b, #4149). Three holes, each the
// run id, on three of its four sinks (the start warn, the kill-switch read
// warn, the dispatch info; the decision-row error has none). The error fields
// were written as `err.message` with a literal fallback rather than
// `String(err)`, which is what kept two more holes out.
// 212 -> 215: THE REST GATE FOR AN AGENT-BOUND KEY (#4481). Three holes, all in
// its denial row: the refusal reason, the agent's status, and the surface it was
// refused at, each a parameter. None is prompt-derived.

// COMPOSED, not picked: 215 -> 216, with MEASURED_SINKS 124 -> 125 in the
// same diff. #4481 and #3744 each raised 212/122 on their own branch, so
// neither side's own figure is right on the combined tree — this is main's
// current value plus this diff's own delta, the arithmetic that stays correct
// whichever lands first.
//
// #3744 contributes ONE hole and ONE sink: a reply-claim `logger.warn` in
// `flue/execute.ts`, a file already registered `identifier bound elsewhere`,
// carrying a component literal, `ctx.tenantId`, `runId` and the error's NAME.
// Not its message — that catch covers `guardUntrustedInput`, which is handed
// the peer's reply body, so a throw from its own write could have carried the
// scanned text into a log line.
//
// Still TIGHTENS `HOLES_PER_SINK_CEILING`: (215+6)/124 = 1.7823 becomes
// (216+6)/125 = 1.7760, because the sink is counted alongside the hole.
// 216 → 217: OPENSHELL 5.1 (#3971). One hole in a sink already listed — the
// executor's `logger.error` for a lifecycle decision that could not be
// recorded. Its fields were NARROWED first, from a spread of the whole
// `SandboxDecision` to named scalars, which closed one of the two this change
// first opened; what remains is the pair of computed expressions the rule
// cannot follow, `'sandboxId' in decision ? … : null` and the usual
// `e instanceof Error ? e.message : String(e)`.
//
// Nothing at that sink can carry a prompt, and the type is what says so:
// `SandboxDecision` is a closed union of a kind, a sandbox id, a closed refusal
// reason, the gateway's deletion outcome and a boolean. There is no free-text
// member to leak, and adding one would have to pass the exhaustiveness
// assertions in `openshell-audit-bridge.ts` first.
//
// Still tightens HOLES_PER_SINK_CEILING, since the sink is counted beside the
// hole.
// 217 -> 223 on 2026-10-31 (#4568). The kill switch gained a SECOND audit sink,
// recording what a kill actually reached in the sandbox runtime, and the rule
// counts one hole per logged field: a summary plus five `after` members.
//
// Nothing at that sink can carry a prompt, and the types are what say so. Four
// of the six are NUMBERS computed by `sweepOpenSandboxLeases` — attempted,
// deleted, failed — and the fifth is `coverage`, a closed three-member union
// (`running-work-only` | `transport-absent` | `agent-scoped-no-subjects`). The
// sixth is a template over those same locals. The sweep never sees a prompt: it
// reads sandbox ids off `OpenShellSandboxLease` and calls a delete.
//
// The values were resolved into LOCALS before the sink first, which is the
// narrowing this file asks for — and the intermediate attempt that replaced the
// template with `String(...)` concatenation made it WORSE, 218 to 223, because
// each of those calls is another helper the rule cannot open. Recorded because
// the obvious fix was the wrong one.
const MEASURED_HOLES = 223;
// 140 → 143: AGENTIC UI 4/4 (#2467). Three holes in one new sink — the pack
// export's audit row — all `identifier bound elsewhere`, all values that are
// local bindings (`title`, `documentBytes`, `PACK_RETENTION_DAYS`) beside field
// names that ARE in the source. Nothing in that row carries pack CONTENT: the
// document itself goes to `Evidence.content`, and what the audit row keeps is
// its size, its title and the enforcement flag that qualifies it.
// 76 → 78: AGENTIC UI 1/4 (#2441) added two `logger.warn` catch-sites, one at
// each agentic notification bell. UNCHANGED holes — both were written with
// `err.message` and a literal rather than `String(err)`, which is a
// TRANSPARENT_CALL the rule walks into and then records a hole for. Raising the
// denominator TIGHTENS `HOLES_PER_SINK_CEILING`, which is the direction this
// pair is supposed to move.
// 98 → 99: FLUE PER-TURN ACCOUNTING. See the note on `MEASURED_HOLES` above
// for the one sink and the one hole, and for why the pair was measured on a
// tree with no unmerged paths.
// 99 → 100: KILL SWITCH STOPS THE MODEL CALL. The one new sink is
// `haltRunAtKill`'s audit row. Raising the denominator TIGHTENS
// `HOLES_PER_SINK_CEILING`, which is the direction this pair is meant to move.
// 100 -> 102: the same relocation brings TWO sinks with it — the unattributable
// refusal's `logger.warn` and the audit-write failure's `logger.error`. Raising
// the denominator by more than the numerator TIGHTENS `HOLES_PER_SINK_CEILING`
// (1.83 -> 1.8039), which is the direction this pair is meant to move.
//
// Raised by MY OWN contribution only. The live sink count on this branch is
// 108, so the floor carries slack from sinks somebody added without recording
// them here; claiming those would set a floor on work I did not do, and a floor
// above the true count fails for an unrelated reason the day somebody deletes a
// log line.
// 102 -> 104: the two sinks of #3471's agent-invoke dispatcher — the one
// refusal warn and the one dispatched info. Raising the denominator TIGHTENS
// `HOLES_PER_SINK_CEILING`, which is the direction this pair is meant to move.
// Still my own contribution only: the live count on this branch is 111.
// 104 -> 108: the four sinks #3484 adds — the settings-read warn, the two
// refusal warns (the early one and the one under the start lock) and the audit
// append. Raising the denominator by more than the numerator TIGHTENS
// `HOLES_PER_SINK_CEILING`, which is the direction this pair is meant to move.
// The live count on this branch is 115.
// 104 -> 106: the two sinks #3472 adds — the shutdown stage's warn/info pair
// counts as one file's worth and the stream route's catch as the other.
// Raising the denominator TIGHTENS `HOLES_PER_SINK_CEILING`, which is the
// direction this pair is meant to move. The live count on this branch is 114.
// 106/108 -> 110: both of the above on the union, re-measured for the reason
// `MEASURED_HOLES` gives. 110 = 104 + 2 (#3472) + 4 (#3484). Raising the
// denominator by more than the numerator TIGHTENS the ratio, which is the
// direction this pair is meant to move.
// 110 -> 111: the ONE sink #3473 adds — the fan-out settings-read warn. Four
// holes against one sink, which LOOSENS rather than tightens the ratio; the
// long note under `MEASURED_HOLES` says why that was accepted rather than
// worked around, and that draining an existing sink is what would actually
// move it.
// 114 -> 122: the Tool Runner engine's eight sinks, all mine: the four of
// `clientForRun`'s SDK logger (Step 2a, #4148, which added them without
// recording them here) and the four of Step 2b's driver, loop and decision
// recorder. Raising the denominator by more than the numerator TIGHTENS
// `HOLES_PER_SINK_CEILING`: (209+6)/114 = 1.886 becomes (212+6)/122 = 1.787.
// 122 -> 124: the REST gate's two sinks (#4481), its denial row and its
// audit-failure warn. TIGHTENS the ratio: (215+6)/124 = 1.782.
//
// 124 -> 125: the reply-claim sink of #3744, recorded beside its hole above.
const MEASURED_SINKS = 125;
const MOST_OPAQUE_SINGLE_CALL = 6;
const HOLES_PER_SINK_CEILING =
    (MEASURED_HOLES + MOST_OPAQUE_SINGLE_CALL) / MEASURED_SINKS;

describe('the agentic path is swept, and the sweep is real', () => {
    it('git lists agentic files at all — otherwise every clean result below is vacuous', () => {
        expect(AGENTIC_FILES.length).toBeGreaterThanOrEqual(30);
    });

    it('the population holds the subsystem cores', () => {
        // Named because they are the seams an external agent drives: the MCP
        // server, the propose-not-commit queue, the workflow engine.
        expect(AGENTIC_FILES).toContain('src/lib/mcp/authorize.ts');
        expect(AGENTIC_FILES).toContain('src/app-layer/usecases/agent-proposals.ts');
        expect(AGENTIC_FILES).toContain('src/app-layer/usecases/workflow-runs.ts');
        expect(AGENTIC_FILES).toContain('src/lib/agentic/workflow-registry.ts');
        // The bracketed route segment specifically. `[tenantSlug]` is a
        // CHARACTER CLASS to minimatch, so a scope written with the literal
        // path would match a one-character directory and quietly cover none of
        // the agent-proposal routes.
        expect(AGENTIC_FILES).toContain(
            'src/app/api/t/[tenantSlug]/agent-proposals/route.ts',
        );
    });

    it('and stops at the boundary the path module declares', () => {
        // The paired negative. A matcher that accepted everything would satisfy
        // every assertion above while making the rule repo-wide, which is a
        // different (and much noisier) check than the one this file claims.
        expect(AGENTIC_FILES).not.toContain('src/app-layer/usecases/risk.ts');
        expect(AGENTIC_FILES).not.toContain('src/lib/permissions.ts');
    });

    it.each(AGENTIC_PATH_GLOBS_LIVE as string[])(
        'the live glob %s matches at least one real file',
        (glob) => {
            // A dead glob enforces nothing, in the lint config exactly as much
            // as here, and it looks identical to a clean sweep.
            const re = globToRegExp(glob);
            expect(repoRelativeFiles().some((rel) => re.test(rel))).toBe(true);
        },
    );

    it.each(AGENTIC_PATH_GLOBS_ANTICIPATORY as string[])(
        'the anticipatory glob %s points at a directory that exists',
        (glob) => {
            // These deliberately match NOTHING today — they exist so the first
            // `src/app-layer/jobs/agent-*.ts` is in scope on its first commit
            // rather than whenever somebody notices. What can still go wrong is
            // a typo'd directory, which would sit here forever matching nothing
            // for a reason nobody intended. So the directory is what is pinned.
            const dir = glob.slice(0, glob.lastIndexOf('/', glob.indexOf('*')) + 1);
            expect(repoRelativeFiles().some((rel) => rel.startsWith(dir))).toBe(true);
        },
    );

    it('the scope is forward-looking at all', () => {
        // Without this, the anticipatory list could be emptied and every
        // assertion above would still pass — leaving a scope that covers only
        // the files that happened to exist the day it was written.
        expect(AGENTIC_PATH_GLOBS_ANTICIPATORY.length).toBeGreaterThan(0);
    });

    it('the sweep recognised sink calls — a clean result over zero sinks says nothing', () => {
        expect(byId('sinkSeen').length).toBeGreaterThanOrEqual(SINK_FLOOR);
    });
});

describe('no raw prompt, tool argument, workflow context or proposal payload is logged', () => {
    it('across every file on the agentic path', () => {
        expect(
            byId('rawContent').map(
                (f) => `${repoRelative(f.file)}:${f.line} — ${f.message}`,
            ),
        ).toEqual([]);
    });
});

describe('what the rule could NOT judge is counted, not hidden', () => {
    it('is exactly the set of file-and-kind pairs written down here', () => {
        // DEDUPED, and the word `set` in the name is now load-bearing. This
        // read one entry per FINDING until 2026-09-05, which was
        // indistinguishable from a set while the population was a single
        // spread — the shape of a check that only looks right at n = 1. With
        // the opaque-identifier class counted the population is 84 findings
        // over 13 pairs, and listing every finding would mean an entry per
        // logged field: a list nobody reads, reddening on ordinary churn.
        //
        // The cost of deduping is stated rather than hidden: one MORE opaque
        // identifier inside a file already listed does not move this
        // assertion. HOLES_PER_SINK_CEILING is the cap that sees that.
        const seen = [
            ...new Set(
                byId('unanalysable').map((f) => {
                    const kind = f.message
                        .replace(/^.*? has a /, '')
                        .replace(/ at this position.*$/, '');
                    return `${repoRelative(f.file)} — ${kind}`;
                }),
            ),
        ].sort();
        // Exact equality in BOTH directions, no drift allowance. A new PAIR is
        // a new file, or a new kind of blindness, on the path a prompt could
        // reach an audit row through — bind the fields at the sink instead of
        // spreading them, or add the entry here with the reason it cannot be.
        // A pair that has been CLOSED must lose its entry in the same diff, or
        // the slack it leaves behind is exactly enough for the next one to
        // land unnoticed.
        expect(seen).toEqual([...KNOWN_UNANALYSABLE].sort());
    });

    it('and the opacity per sink call stays where it was measured', () => {
        // The denominator is part of the result. A detector that understands
        // three call sites out of forty and reports zero violations across them
        // has told nobody anything. See HOLES_PER_SINK_CEILING for why the
        // ceiling is the number it is.
        const sinks = byId('sinkSeen').length;
        const holes = byId('unanalysable').length;
        expect(holes / sinks).toBeLessThan(HOLES_PER_SINK_CEILING);
    });

    it('and the measurement the ceiling is derived from is still the measurement', () => {
        // Without this, MEASURED_HOLES / MEASURED_SINKS could drift far below
        // the real figures and the ceiling would silently become headroom —
        // the same rot the assertion-reach ratchets' DRIFT_ALLOWANCE of 0 is
        // about. A drain (a spread narrowed, a field bag named at the sink) is
        // a real improvement: lower MEASURED_HOLES in the same diff and the
        // ceiling tightens with it.
        expect(byId('unanalysable').length).toBeLessThanOrEqual(MEASURED_HOLES);
        expect(byId('sinkSeen').length).toBeGreaterThanOrEqual(MEASURED_SINKS);
    });
});

describe('the detector fires — otherwise a clean sweep is a rule that reports nothing', () => {
    const planted = (code: string, name: string) =>
        lint(code, path.join(REPO_ROOT, `src/lib/agentic/${name}.ts`));

    it('a raw prompt in an audit row is caught', () => {
        const found = planted(
            `appendAuditEntry({ detailsJson: { category: 'access', prompt: invocation.prompt } });`,
            'planted-prompt',
        ).filter((f) => f.messageId === 'rawContent');
        expect(found.length).toBeGreaterThanOrEqual(1);
        expect(found[0].message).toContain('raw content');
    });

    it('the accumulated workflow context in a log line is caught', () => {
        const found = planted(
            `logger.info('workflow step', { runId, contextJson: run.contextJson });`,
            'planted-context',
        ).filter((f) => f.messageId === 'rawContent');
        expect(found.length).toBeGreaterThanOrEqual(1);
    });

    it('the MCP tool arguments are caught', () => {
        const found = planted(
            `log('warn', 'tool refused', { tool: name, args });`,
            'planted-args',
        ).filter((f) => f.messageId === 'rawContent');
        expect(found.length).toBeGreaterThanOrEqual(1);
    });

    it('a prompt RENAMED on the way in is counted as a hole, not silently passed', () => {
        // The class this rule cannot see, and the easiest way to write the leak:
        // `detail` says nothing about what it holds. Until 2026-09-05 this
        // produced no message of any kind — not a violation, which is correct,
        // but not a hole either, which meant the capped denominator above
        // excluded an unbounded class and reported full coverage of the rest.
        // It is the FIRST hole the rule's own header names.
        const found = planted(
            `const detail = invocation.prompt;\nlogger.info('agent step', { detail });`,
            'planted-renamed',
        );
        expect(found.filter((f) => f.messageId === 'rawContent')).toEqual([]);
        expect(
            found
                .filter((f) => f.messageId === 'unanalysable')
                .map((f) => f.message.replace(/^.*? has a /, '').replace(/ at this position.*$/, '')),
        ).toEqual(['identifier bound elsewhere']);
    });

    it('and so is one interpolated into the message string, where no field bag exists', () => {
        // A different position with the same consequence, and the one the
        // field-bag index would have skipped: `logger.info(msg)` is argument 0,
        // below the index at which opacity is counted. An interpolated value is
        // stringified into the emitted text, so the index does not apply.
        const found = planted(
            'const detail = invocation.prompt;\nlogger.info(`agent asked: ${detail}`);',
            'planted-renamed-template',
        );
        expect(found.filter((f) => f.messageId === 'unanalysable').length).toBe(1);
    });

    it('but the digest form is NOT caught — a rule that flags the remedy is one people route around', () => {
        const found = planted(
            `appendAuditEntry({ detailsJson: { category: 'access', promptDigest: computeInputDigest(invocation.prompt), argsLength: args.length } });`,
            'planted-ok',
        ).filter((f) => f.messageId === 'rawContent');
        expect(found).toEqual([]);
    });
});

/**
 * The glob dialect `agentic-path.js` documents: `*` is any run of non-`/`, `**`
 * is any number of segments. Re-implemented here rather than imported so the
 * dead-glob assertion above is an INDEPENDENT reading of the pattern — checking
 * a matcher against itself would pass for a pattern that matches nothing.
 */
function globToRegExp(glob: string): RegExp {
    const source = glob
        .split('/')
        .map((seg) =>
            seg === '**'
                ? '(?:.*)'
                : seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'),
        )
        .join('/')
        .replace(/\/\(\?:\.\*\)\//g, '/(?:.*/)?');
    return new RegExp(`^${source}$`);
}
