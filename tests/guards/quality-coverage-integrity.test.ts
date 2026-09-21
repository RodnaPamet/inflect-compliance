/**
 * Quality-coverage capstone — the meta-ratchet.
 *
 * The quality roadmap closed three governance gaps, each with a
 * structural surface that holds the gain:
 *
 *   1. The per-layer coverage floors + the never-lowered ratchet
 *      (`coverage-ratchet.test.ts`, `jest.thresholds.json`).
 *   2. The E2E coverage manifest for the four browser-shaped UI
 *      surfaces that were explicitly deferred to Playwright
 *      (`e2e-coverage-manifest.test.ts`).
 *   3. The two policy / portfolio docs that explain WHY the
 *      enforced numbers are what they are
 *      (`coverage-policy.md`, `test-portfolio.md`).
 *
 * THIS test guards the guards: it fails CI if any one of those
 * surfaces is deleted, renamed, or gutted to a no-op, and if the
 * load-bearing facts inside them are removed. A contributor who
 * removes a quality-coverage surface must reckon with a red
 * meta-ratchet — the gap cannot silently reopen.
 *
 * Sibling of `ci-pipeline-integrity.test.ts`,
 * `observability-reliability-integrity.test.ts`,
 * `verification-integrity.test.ts`,
 * `codebase-hygiene-integrity.test.ts`, and
 * `dependency-governance-integrity.test.ts` — same "guard the
 * guards" pattern, the quality-coverage domain.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
import { codeOf } from '../helpers/source-blocks';

// #2246 Class A — the mask goes at the READ SEAM, and WHICH masker depends on
// the language. `read` stays RAW because this file also reads JSON and Markdown, none of
// which `codeOf` lexes — handing it YAML once blanked a bare-scalar URL from
// `//` to end of line. TypeScript reads go through `readSrc`, which masks.
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readSrc = (rel: string) => codeOf(read(rel));
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

/**
 * The quality-coverage guardrail registry. Each test surface must
 * exist, still carry its load-bearing anchors (proof it was not
 * gutted), and carry a real assertion surface (≥3 `it` blocks for
 * test files).
 */
interface GuardEntry {
    file: string;
    pillar: string;
    anchors: ReadonlyArray<string>;
    /** When true the file is a test and is checked for ≥3 it-blocks. */
    isTest: boolean;
}

const GUARDRAILS: ReadonlyArray<GuardEntry> = [
    {
        file: 'tests/guards/coverage-ratchet.test.ts',
        pillar:
            'coverage thresholds — never-lowered ratchet across global + per-layer keys',
        anchors: ['RATCHET_FLOOR', 'jest.thresholds.json', 'src/app-layer/usecases/'],
        isTest: true,
    },
    {
        file: 'tests/guards/e2e-coverage-manifest.test.ts',
        pillar:
            'E2E first-wave manifest — the four browser-shaped UI surfaces',
        anchors: ['E2E_MANIFEST', 'search-affordances', 'tenant-switcher', 'entity-detail-layout'],
        isTest: true,
    },
    {
        file: 'docs/coverage-policy.md',
        pillar:
            'coverage policy — risk tiers, staged plan, never-lowered rule',
        anchors: ['Risk tiers', 'staged ratchet', 'ratchet: never'],
        isTest: false,
    },
    {
        file: 'docs/test-portfolio.md',
        pillar:
            'test portfolio — layered assurance model + structural-vs-behavioural rule',
        anchors: ['structural ratchet is never a substitute', 'six layers', 'substitution smell'],
        isTest: false,
    },
];

/** Count `it(` / `it.each(` / `test(` / `test.each(` blocks. */
function itCount(src: string): number {
    return (src.match(/\b(?:it|test)(?:\.each)?\s*[(`]/g) ?? []).length;
}

describe('quality-coverage integrity — guard the guards', () => {
    describe.each(GUARDRAILS)('$pillar — $file', ({ file, anchors, isTest }) => {
        it('the guardrail surface exists', () => {
            expect(exists(file)).toBe(true);
        });

        it('the surface still references its load-bearing anchors (not gutted)', () => {
            const src = read(file);
            for (const anchor of anchors) {
                expect(src).toContain(anchor);
            }
        });

        if (isTest) {
            it('the test still carries ≥3 it-blocks (not no-opped)', () => {
                expect(itCount(read(file))).toBeGreaterThanOrEqual(3);
            });
        }
    });

    // ─── jest.thresholds.json — keys + their RATCHET_FLOOR parity ────
    it('jest.thresholds.json carries the five required keys', () => {
        const t = JSON.parse(read('jest.thresholds.json'));
        // The risk tiers in docs/coverage-policy.md require dedicated
        // keys for each tier-A and tier-B layer plus the global floor.
        const REQUIRED = [
            'global',
            './src/app-layer/usecases/',
            './src/app-layer/policies/',
            './src/app-layer/events/',
            './src/lib/',
        ] as const;
        for (const key of REQUIRED) {
            expect(t[key]).toBeDefined();
            // Each must carry all four standard coverage metrics.
            for (const m of ['branches', 'functions', 'lines', 'statements']) {
                expect(typeof t[key][m]).toBe('number');
            }
        }
    });

    it('jest.thresholds.json keys are mirrored in RATCHET_FLOOR', () => {
        const t = JSON.parse(read('jest.thresholds.json'));
        const ratchet = readSrc('tests/guards/coverage-ratchet.test.ts');
        for (const key of Object.keys(t)) {
            // Every threshold key must have a matching RATCHET_FLOOR
            // entry, or the never-lowered guarantee is incomplete.
            const literal = key === 'global' ? 'global:' : `'${key}':`;
            expect(ratchet).toContain(literal);
        }
    });
});
