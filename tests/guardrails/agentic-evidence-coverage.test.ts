/**
 * EVERY AGENTIC RISK HAS AN AUTOMATED CONTROL TEST, OR A WRITTEN REASON WHY NOT.
 *
 * 4/10 shipped the OWASP Agentic AI Top 10 as installable library content, so
 * ASI01…ASI10 are real `FrameworkRequirement` rows a customer's evidence hangs
 * off. What that did NOT settle is which of them the product can EVIDENCE on a
 * schedule. This ratchet settles it, and keeps it settled.
 *
 * ── The population comes from the library, not from a list here ──
 *
 * The codes are read out of `owasp-agentic-top10.yaml` through the same parser
 * the importer uses, so an upstream revision that adds ASI11 turns this red on
 * the day the library is updated rather than on the day somebody notices. A
 * hand-written array here would be a denominator that agrees with itself and
 * with nothing else — the failure `docs/_status/doc-classification.json`'s
 * deleted `counts` header records, and the one
 * `tests/guardrails/coverage-gate-population.test.ts` exists to prevent one
 * level up.
 *
 * ── Two directions, because one of them is the quiet failure ──
 *
 * UNCOVERED is the obvious direction: a risk with neither a check nor an
 * exemption fails. DOUBLY-CLAIMED is the other: an exemption sitting beside a
 * working check reads, to anybody auditing the list, as a risk nobody covers —
 * and the exemption's prose will still be there explaining why it is impossible
 * long after somebody made it possible. Both are pinned by exact equality
 * against `[]`, never by a count.
 *
 * ── And the check has to be one the runner can actually run ──
 *
 * A coverage table naming a check the dispatcher does not recognise would claim
 * evidence that no scheduled run could ever produce. So every id in the table
 * is put through `parseAgenticCheckConfig` — the same function the handler
 * calls on a real plan's `automationConfig` — and the handler's registration on
 * the runner is exercised rather than asserted about.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { parseLibraryFile, loadLibrary } from '@/app-layer/libraries';
import {
    AGENTIC_CHECKS,
    AGENTIC_CHECK_IDS,
    AGENTIC_CONTROL_EXEMPTIONS,
    agenticControlTestHandler,
    parseAgenticCheckConfig,
    registerAgenticControlTestHandler,
    type AgenticCheckId,
} from '@/app-layer/services/agent-control-tests';
import { runnerHandlerRegistry } from '@/app-layer/jobs/control-test-runner';

import { REPO_ROOT } from '../helpers/repo-files';
import { functionBodyOf } from '../helpers/source-blocks';

const LIB = path.join(REPO_ROOT, 'src/data/libraries/owasp-agentic-top10.yaml');

/** The assessable requirement keys, straight out of the shipped library. */
const ASI_CODES: readonly string[] = loadLibrary(
    parseLibraryFile(LIB),
    'owasp-agentic-top10.yaml',
).framework.nodes
    .filter((n) => n.assessable)
    .map((n) => n.refId);

interface Classification {
    code: string;
    checks: AgenticCheckId[];
    exempt: boolean;
}

/**
 * Classify a population against the coverage table.
 *
 * Takes the codes as an ARGUMENT rather than closing over `ASI_CODES`, so the
 * mutation proof at the bottom can run the real classifier over a population
 * carrying an unknown risk. A detector that can only be pointed at the input it
 * already passes on is a detector nobody has tested.
 */
function classify(codes: readonly string[]): Classification[] {
    const byCode = new Map<string, AgenticCheckId[]>();
    for (const def of Object.values(AGENTIC_CHECKS)) {
        for (const code of def.covers) {
            byCode.set(code, [...(byCode.get(code) ?? []), def.id]);
        }
    }
    return codes.map((code) => ({
        code,
        checks: byCode.get(code) ?? [],
        exempt: Object.prototype.hasOwnProperty.call(AGENTIC_CONTROL_EXEMPTIONS, code),
    }));
}

describe('the agentic risk set is fully triaged', () => {
    it('reads a non-empty population out of the shipped library', () => {
        // A population that silently resolved to zero would make every
        // assertion below vacuously true — the exact shape of failure the
        // checks under test are themselves written to avoid.
        expect(ASI_CODES.length).toBeGreaterThanOrEqual(10);
        expect(new Set(ASI_CODES).size).toBe(ASI_CODES.length);
    });

    it('every risk has an automated control test or a written exemption', () => {
        const uncovered = classify(ASI_CODES)
            .filter((c) => c.checks.length === 0 && !c.exempt)
            .map((c) => c.code);
        expect(uncovered).toEqual([]);
    });

    it('no risk is both covered and exempt', () => {
        const both = classify(ASI_CODES)
            .filter((c) => c.checks.length > 0 && c.exempt)
            .map((c) => c.code);
        expect(both).toEqual([]);
    });

    it('no exemption names a risk the library does not carry', () => {
        const stale = Object.keys(AGENTIC_CONTROL_EXEMPTIONS).filter(
            (code) => !ASI_CODES.includes(code),
        );
        expect(stale).toEqual([]);
    });

    it('every exemption carries a reason substantial enough to argue with', () => {
        const thin = Object.entries(AGENTIC_CONTROL_EXEMPTIONS)
            .filter(([, reason]) => reason.trim().length < 200)
            .map(([code]) => code);
        expect(thin).toEqual([]);
    });

    it('no exemption is a deferral in disguise', () => {
        // "TODO", "will be" and friends are how an exemption becomes a promise
        // nobody tracks. An exemption states where the control LIVES today.
        const deferrals = Object.entries(AGENTIC_CONTROL_EXEMPTIONS)
            .filter(([, reason]) => /\b(TODO|FIXME|coming soon|not yet implemented)\b/i.test(reason))
            .map(([code]) => code);
        expect(deferrals).toEqual([]);
    });
});

describe('the coverage table names checks the runner can actually run', () => {
    afterEach(() => runnerHandlerRegistry._reset());

    it('the id list, the table keys and the dispatcher agree', () => {
        expect(Object.keys(AGENTIC_CHECKS).sort()).toEqual([...AGENTIC_CHECK_IDS].sort());
        // The table's own `id` field must match its key, or a lookup by key
        // would return a definition describing a different check.
        const mismatched = Object.entries(AGENTIC_CHECKS)
            .filter(([key, def]) => def.id !== key)
            .map(([key]) => key);
        expect(mismatched).toEqual([]);
    });

    it('every check id is one a real plan config would select', () => {
        const unrecognised = AGENTIC_CHECK_IDS.filter(
            (id) => parseAgenticCheckConfig({ check: id })?.check !== id,
        );
        expect(unrecognised).toEqual([]);
    });

    it('every check claims at least one risk, and only risks that exist', () => {
        const claimless = Object.values(AGENTIC_CHECKS)
            .filter((def) => def.covers.length === 0)
            .map((def) => def.id);
        expect(claimless).toEqual([]);

        const unknown = Object.values(AGENTIC_CHECKS).flatMap((def) =>
            def.covers.filter((code) => !ASI_CODES.includes(code)).map((code) => `${def.id}:${code}`),
        );
        expect(unknown).toEqual([]);
    });

    it('registration installs THIS handler on the runner, and is idempotent', () => {
        runnerHandlerRegistry._reset();
        registerAgenticControlTestHandler();
        expect(runnerHandlerRegistry.get('INTEGRATION')).toBe(agenticControlTestHandler);
        // Called twice — the worker registers per job pickup, so a second call
        // must not throw the registry's duplicate error.
        expect(() => registerAgenticControlTestHandler()).not.toThrow();
        expect(runnerHandlerRegistry.get('INTEGRATION')).toBe(agenticControlTestHandler);
    });

    it('the production entry point calls that registration before running a plan', () => {
        // Bound to `controlTestRunnerExecutor`'s own body — the function the
        // BullMQ executor calls — rather than grepped over the file. An
        // unanchored read would be satisfied by the same call sitting in any
        // other function in the module, or by a mention in a comment, while the
        // control-test path registered nothing.
        const src = readFileSync(
            path.join(REPO_ROOT, 'src/app-layer/jobs/control-test-runner.ts'),
            'utf8',
        );
        const body = functionBodyOf(src, 'controlTestRunnerExecutor');
        expect(body).toContain('registerAgenticControlTestHandler()');
        // And it happens BEFORE the run, not after it: a registration that
        // landed after `runControlTestRunner` would leave the FIRST pickup on
        // every worker boot running with no engine, which is precisely the
        // shape of bug that only ever shows up in production.
        expect(body.indexOf('registerAgenticControlTestHandler()')).toBeLessThan(
            body.indexOf('runControlTestRunner(payload)'),
        );
    });
});

describe('the coverage detector fires', () => {
    it('reports an unknown risk as uncovered', () => {
        // The proof that "uncovered === []" above means something. A risk this
        // build has never heard of must land in the uncovered bucket, which is
        // exactly what an upstream Top-10 revision looks like.
        const withNewRisk = classify([...ASI_CODES, 'ASI11']);
        expect(
            withNewRisk.filter((c) => c.checks.length === 0 && !c.exempt).map((c) => c.code),
        ).toEqual(['ASI11']);
    });

    it('reports a risk that has a check as covered by that check', () => {
        // The companion to the negative above: a detector that reported
        // EVERYTHING as uncovered would satisfy the mutation proof and nothing
        // else, and would look identical from inside the assertion.
        const asi04 = classify(['ASI04'])[0];
        expect(asi04.checks).toEqual(['AGENTIC_TOOL_MANIFEST_INTEGRITY']);
        expect(asi04.exempt).toBe(false);
    });
});
