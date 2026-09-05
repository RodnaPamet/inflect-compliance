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
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tsParser = require('@typescript-eslint/parser');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rule = require('../../eslint-rules/rules/no-raw-prompt-logging');
// The SAME module `eslint.config.mjs` scopes the rule with. One definition, so
// the lint scope and the swept population cannot drift apart — a scope that
// disagrees with itself reports full coverage of whichever half is smaller.
// eslint-disable-next-line @typescript-eslint/no-require-imports
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
    'src/app-layer/usecases/agent-policy-card.ts — identifier bound elsewhere',
    'src/app-layer/usecases/agent-proposals.ts — identifier bound elsewhere',
    'src/app-layer/usecases/agent-registry.ts — identifier bound elsewhere',
    'src/app-layer/usecases/agent-risk-assessment.ts — identifier bound elsewhere',
    'src/app-layer/usecases/agent-tool-exposure.ts — identifier bound elsewhere',
    'src/app-layer/usecases/workflow-runs.ts — identifier bound elsewhere',
    'src/lib/agentic/agent-authority.ts — identifier bound elsewhere',
    'src/lib/agentic/agent-registration-gate.ts — identifier bound elsewhere',
    'src/lib/agentic/policy-card-store.ts — identifier bound elsewhere',
    'src/lib/mcp/auth.ts — identifier bound elsewhere',
    'src/lib/mcp/authorize.ts — identifier bound elsewhere',
    'src/lib/mcp/authorize.ts — spread of an object whose keys are not in the source',
    'src/lib/mcp/tools/registry.ts — identifier bound elsewhere',
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
 *   MEASURED_HOLES / MEASURED_SINKS         the path today, 84 / 39 = 2.154
 *   MOST_OPAQUE_SINGLE_CALL                 the worst single call on it, 6
 *
 * The ceiling is `(84 + 6) / 39`. In words: the path may absorb ONE more sink
 * call as opaque as the most opaque one it already has before somebody has to
 * look. Two such calls fail. Seven more opaque fields on the EXISTING calls,
 * with no new sink, fail. That is the sensitivity this cap is for — it moves
 * when a field bag grows, which is the thing the exact set above cannot see.
 *
 * A rejected alternative, recorded because the reasoning matters more than the
 * number: the rule could also census the NAMED POSITIONS it resolves (object
 * keys, member-chain final properties), which gives `holes / positions = 0.099`
 * — under the old 0.1 ceiling, no change required. That denominator is mostly
 * object KEYS, and keys are not where a renamed value hides. Picking it would
 * have been choosing the denominator that keeps the number green, which is the
 * defect this cap exists to catch, one level up.
 */
const MEASURED_HOLES = 84;
const MEASURED_SINKS = 39;
/** `src/lib/mcp/auth.ts` — a six-field `detailsJson` bag built out of locals. */
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
