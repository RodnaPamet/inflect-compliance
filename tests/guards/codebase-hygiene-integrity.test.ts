/**
 * Codebase-hygiene capstone — the meta-ratchet.
 *
 * Roadmap-6 closed three codebase-hygiene gaps, each with a
 * structural guardrail:
 *
 *   1. `as any` debt — driven 174 → 4, held on a downward ratchet
 *      (binding baseline + per-pattern caps).
 *   2. Logging discipline — `console.*` banned in server code, with
 *      the dub-ported utility tree no longer blanket-exempt.
 *   3. Async route-handler `params` typing — every handler migrated
 *      to the Next 15 `Promise` contract; the transparent-await shim
 *      retired.
 *
 * Each shipped its own guardrail. THIS test guards the guards: it
 * fails CI if any one is deleted or gutted to a no-op, and it
 * asserts the codebase-hygiene doc survives with its load-bearing
 * pillar statements. A contributor who removes a hygiene guardrail
 * must reckon with a red meta-ratchet — the gap cannot silently
 * reopen.
 *
 * Sibling of `ci-pipeline-integrity.test.ts`,
 * `observability-reliability-integrity.test.ts`,
 * `verification-integrity.test.ts`, and
 * `dependency-governance-integrity.test.ts` — same "guard the
 * guards" pattern, the codebase-hygiene domain.
 *
 * See docs/codebase-hygiene.md.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { headingLines } from '../helpers/markdown-regions';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
/**
 * TWO READERS, ONE PER LANGUAGE (#2246 Class A).
 *
 * `read` is the TypeScript seam and is MASKED: every anchor below names a
 * code symbol, and `itCount` is counting real `it(` blocks — a guardrail
 * gutted to a no-op with its symbols left behind in a docblock is exactly
 * what this meta-ratchet exists to catch, so the prose must not count.
 * Measured across the four guardrails, masking removes a lot of satisfying
 * text without emptying anything: `as any` 20→9 and 12→2, `console` 14→6,
 * `params` 27→16, `Promise` 11→6, `dub-utils` 6→3. It also moves one real
 * number — `tests/guards/no-explicit-any-ratchet.test.ts` has 4 `it(`
 * occurrences raw and 3 in code, i.e. one of them is COMMENTED OUT and was
 * padding the ">= 3 blocks" floor this file asserts.
 *
 * `readMarkdown` is the prose seam and is deliberately NOT masked: `codeOf`
 * lexes TypeScript, and the markdown masker would blank the very sentences
 * the doc assertion is about. That read is NARROWED instead — see below.
 */
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const readMarkdown = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

/**
 * The codebase-hygiene guardrail registry. Each must exist, still
 * contain its subject anchors (proof it was not gutted), and carry a
 * real assertion surface.
 */
const GUARDRAILS: ReadonlyArray<{
    file: string;
    pillar: string;
    anchors: string[];
}> = [
    {
        file: 'tests/guardrails/no-explicit-any-ratchet.test.ts',
        pillar: 'no `as any` growth — downward-ratcheted baseline',
        anchors: ['CURRENT_BASELINE', 'as any'],
    },
    {
        file: 'tests/guards/no-explicit-any-ratchet.test.ts',
        pillar: '`any`-pattern caps — `: any` / `<any>` / `as any` / `@ts-ignore`',
        anchors: ['CAPS', 'as any'],
    },
    {
        file: 'tests/guardrails/logging-import-hygiene.test.ts',
        pillar: 'logging discipline — no `console.*`, adapted code included',
        anchors: ['console', 'dub-utils'],
    },
    {
        file: 'tests/guards/async-params-route-typing.test.ts',
        pillar: 'async route-handler `params` typing',
        anchors: ['params', 'Promise'],
    },
];

/** Count `it(` / `it.each(` / `test(` / `test.each(` blocks. */
function itCount(src: string): number {
    return (src.match(/\b(?:it|test)(?:\.each)?\s*[(`]/g) ?? []).length;
}

describe('codebase-hygiene integrity — guard the guards', () => {
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

        it('the guardrail carries a real assertion surface (>= 3 blocks)', () => {
            expect(itCount(read(file))).toBeGreaterThanOrEqual(3);
        });
    });

    it('the registry is complete (4 hygiene guardrails, distinct)', () => {
        expect(GUARDRAILS).toHaveLength(4);
        expect(new Set(GUARDRAILS.map((g) => g.file)).size).toBe(4);
    });

    it('the codebase-hygiene doc exists', () => {
        expect(exists('docs/codebase-hygiene.md')).toBe(true);
    });

    it('the doc states all three hygiene pillars', () => {
        // The load-bearing structure — if the doc is hollowed out,
        // this catches it.
        //
        // NARROWED to the doc's level-2 HEADING LINES (#2246 Class A). A
        // PILLAR in this document is a `## Pillar N — …` section, and each of
        // the three headings carries both of its own needles, so the level-2
        // heading lines are the region this test is actually about. Over the
        // whole document the needles were badly over-satisfied — `/params/i`
        // matched 10 times and `/as any/i` 4 — meaning a pillar could have
        // been deleted outright and its needle kept matching from a body
        // paragraph elsewhere. Masking would have been worse than useless:
        // `/downward ratchet/i`, `/logging discipline/i` and `/adapted/i` all
        // fall to ZERO through `mdCodeOf`, which would have made three of the
        // six assertions permanently vacuous. Measured raw → heading lines:
        // 4→1, 1→1, 1→1, 2→1, 10→1, 6→1.
        const pillars = headingLines(readMarkdown('docs/codebase-hygiene.md'), 2);
        expect(pillars).toMatch(/as any/i);
        expect(pillars).toMatch(/downward ratchet/i);
        expect(pillars).toMatch(/logging discipline/i);
        expect(pillars).toMatch(/adapted/i);
        expect(pillars).toMatch(/params/i);
        expect(pillars).toMatch(/Promise/);
    });
});
