/**
 * Verification-integrity capstone — the meta-ratchet.
 *
 * Roadmap-4 closed the "structural ratchet green but the feature is
 * actually broken" gap with four remediations:
 *
 *   1. Frontend assurance model — structural ratchets distinguished
 *      from rendered/behavioural verification; high-risk UI
 *      primitives require a rendered test
 *      (`behavioural-coverage-registry.test.ts`).
 *   2. Rich-text sanitiser coverage — structural completeness from
 *      the `ENCRYPTED_FIELDS` registry, not a numeric floor
 *      (`sanitize-rich-text-coverage.test.ts`).
 *   3. Test-portfolio balance — guardrails support, not substitute
 *      for, functional tests (`docs/test-portfolio.md`).
 *   4. Verification policy — "structurally present" vs "functionally
 *      tested" vs "browser verified" made explicit
 *      (`docs/verification-policy.md`).
 *
 * Pillars 1 and 2 shipped their own structural guardrails. THIS test
 * guards the guards: it fails CI if either is deleted or gutted to a
 * no-op, and it asserts the verification-policy docs + diagnostic
 * survive. A contributor who removes a verification guardrail must
 * reckon with a red meta-ratchet — the gap cannot silently reopen.
 *
 * Sibling of `ci-pipeline-integrity.test.ts` and
 * `observability-reliability-integrity.test.ts` — same "guard the
 * guards" pattern, the frontend/verification domain.
 *
 * See docs/verification-policy.md.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { mdProseOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// #2246 Class A — the markdown read below goes through the PROSE mask. Its
// four needles are the policy's load-bearing sentences, and against the whole
// document any of them could be satisfied by a fenced sample instead. The
// inverse masker `mdCodeOf` would be exactly wrong here: it keeps the code and
// blanks the prose, which deletes the subject. Measured on
// docs/verification-policy.md — 1 / 3 / 2 / 2 raw, identical through
// `mdProseOf`, and ZERO through `mdCodeOf`.
//
// Proved to have teeth rather than assumed. Replace every prose occurrence of
// `structurally present` and append a fenced block that lists the three state
// names: RAW is still satisfied and the guard stays green while the policy no
// longer states the rule; `mdProseOf` is not, and the guard goes red.
const readMdProse = (rel: string) => mdProseOf(read(rel));
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

/**
 * The verification guardrail registry. Each must exist, still contain
 * its subject anchors (proof it was not gutted), and carry a real
 * assertion surface.
 */
const GUARDRAILS: ReadonlyArray<{
    file: string;
    pillar: string;
    anchors: string[];
}> = [
    {
        file: 'tests/guards/behavioural-coverage-registry.test.ts',
        pillar: 'frontend assurance — high-risk UI needs rendered tests',
        anchors: ['behavioural', 'tests/rendered', 'REGISTRY'],
    },
    {
        file: 'tests/guardrails/sanitize-rich-text-coverage.test.ts',
        pillar: 'rich-text sanitiser coverage — structural completeness',
        anchors: ['ENCRYPTED_FIELDS', 'RICH_TEXT_COVERAGE'],
    },
    {
        file: 'tests/guards/rendered-coverage-floor.test.ts',
        pillar: 'staged upward ratchet — rendered/E2E verification must only grow',
        anchors: ['RENDERED_TEST_FLOOR', 'upward'],
    },
];

/** Docs + tooling that make the verification policy explicit. */
const VERIFICATION_ARTEFACTS: ReadonlyArray<{ file: string; role: string }> = [
    { file: 'docs/verification-policy.md', role: 'the unified verification policy' },
    { file: 'docs/frontend-assurance-model.md', role: 'the structural-vs-rendered-vs-browser model' },
    { file: 'docs/test-portfolio.md', role: 'the healthy test-portfolio model' },
    { file: 'scripts/test-portfolio-report.ts', role: 'the portfolio-health diagnostic' },
];

/** Count `it(` / `it.each(` assertion blocks in a test file. */
function itCount(src: string): number {
    return (src.match(/\bit(?:\.each)?\s*[(`]/g) ?? []).length;
}

describe('verification integrity — guard the guards', () => {
    describe.each(GUARDRAILS)('$pillar — $file', ({ file, anchors }) => {
        it('the guardrail file exists', () => {
            expect(exists(file)).toBe(true);
        });

        it('the guardrail still references its subject (not gutted)', () => {
            const src = read(file);
            for (const anchor of anchors) {
                expect(src).toContain(anchor);
            }
        });

        it('the guardrail carries a real assertion surface (>= 3 it-blocks)', () => {
            expect(itCount(read(file))).toBeGreaterThanOrEqual(3);
        });
    });

    it('the registry is complete (3 verification guardrails, distinct)', () => {
        expect(GUARDRAILS).toHaveLength(3);
        expect(new Set(GUARDRAILS.map((g) => g.file)).size).toBe(3);
    });

    it.each(VERIFICATION_ARTEFACTS)(
        '$role — $file exists',
        ({ file }) => {
            expect(exists(file)).toBe(true);
        },
    );

    it('the verification policy states the structural-is-not-verified rule', () => {
        // The load-bearing sentence of the policy — if the doc is
        // hollowed out, this catches it.
        const policy = readMdProse('docs/verification-policy.md');
        expect(policy).toMatch(/not\s+\*\*?proof|not.*proof a feature works/i);
        expect(policy).toMatch(/structurally present/i);
        expect(policy).toMatch(/functionally tested/i);
        expect(policy).toMatch(/browser verified/i);
    });
});
