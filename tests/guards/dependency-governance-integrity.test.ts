/**
 * Dependency-governance capstone — the meta-ratchet.
 *
 * The build-integrity roadmap closed the dependency story with a set
 * of structural guardrails, each protecting a distinct regression
 * class:
 *
 *   1. Deterministic installs   — `npm ci`, pinned Node, locked tree.
 *   2. Strict peer resolution   — no `--legacy-peer-deps`.
 *   3. Framework version coherence — `@next/swc-*` tracks `next`.
 *   4. Reviewed runtime risk    — CVE-active packages stay correctly
 *                                 classified, on their reviewed major.
 *   5. Auth-stack pin           — `next-auth` stays on v4 stable
 *                                 (the NextAuth-v5 policy).
 *
 * Each of those five shipped its own guardrail. THIS test guards the
 * guards: it fails CI if any one of them is deleted or gutted to a
 * no-op, and it asserts the governance docs survive with their
 * load-bearing policy statements intact. A contributor who removes a
 * dependency guardrail must reckon with a red meta-ratchet — the gap
 * cannot silently reopen.
 *
 * Sibling of `ci-pipeline-integrity.test.ts`,
 * `observability-reliability-integrity.test.ts`, and
 * `verification-integrity.test.ts` — same "guard the guards"
 * pattern, the dependency-governance domain.
 *
 * See docs/dependency-governance.md.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { mdSection } from '../helpers/markdown-regions';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
/**
 * TWO READERS, ONE PER LANGUAGE (#2246 Class A).
 *
 * `read` — the TypeScript seam, MASKED. The anchors below name code symbols
 * and `itCount` counts real `it(` blocks, so a guardrail gutted to a no-op
 * with its vocabulary left in a docblock must not satisfy this meta-ratchet.
 * Measured over the five guardrails, nothing empties and the tightening is
 * large: `beta` 10→2, `devDependencies` 6→2, `npm ci` 4→2, `.nvmrc` 4→2,
 * `@next/swc` 13→8, `next` 38→27, `legacy-peer-deps` 7→5.
 *
 * `readMarkdown` — prose, NOT masked. `mdCodeOf` keeps a document's code and
 * blanks its sentences; measured on `docs/dependency-governance.md` it takes
 * ten of the thirteen doc needles below to ZERO, which would have left those
 * assertions passing vacuously for ever. They are NARROWED instead, each to
 * the section its own test names.
 */
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const readMarkdown = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

/**
 * The dependency-governance guardrail registry. Each must exist,
 * still contain its subject anchors (proof it was not gutted), and
 * carry a real assertion surface.
 */
const GUARDRAILS: ReadonlyArray<{
    file: string;
    pillar: string;
    anchors: string[];
}> = [
    {
        file: 'tests/guards/deterministic-install.test.ts',
        pillar: 'deterministic installs — npm ci + pinned Node + locked tree',
        anchors: ['npm ci', 'engines', '.nvmrc'],
    },
    {
        file: 'tests/guards/no-legacy-peer-deps.test.ts',
        pillar: 'strict peer resolution — no --legacy-peer-deps',
        anchors: ['legacy-peer-deps'],
    },
    {
        file: 'tests/guards/swc-version-coherence.test.ts',
        pillar: 'framework version coherence — @next/swc-* tracks next',
        anchors: ['@next/swc', 'next'],
    },
    {
        file: 'tests/guards/dependency-risk-review.test.ts',
        pillar: 'reviewed runtime risk — CVE-active packages stay classified',
        anchors: ['REVIEWED', 'devDependencies'],
    },
    {
        file: 'tests/guardrails/auth-stack-pinning.test.ts',
        pillar: 'auth-stack pin — next-auth stays on v4 stable',
        anchors: ['next-auth', 'beta'],
    },
];

/** Docs that make the dependency-governance model explicit. */
const GOVERNANCE_DOCS: ReadonlyArray<{ file: string; role: string }> = [
    { file: 'docs/dependency-governance.md', role: 'the unified governance model' },
    { file: 'docs/dependency-policy.md', role: 'install-time policy — strict peers, npm ci, overrides' },
    { file: 'docs/dependency-risk-review.md', role: 'the package-by-package risk review' },
];

/** Count `it(` / `it.each(` assertion blocks in a test file. */
function itCount(src: string): number {
    return (src.match(/\bit(?:\.each)?\s*[(`]/g) ?? []).length;
}

describe('dependency-governance integrity — guard the guards', () => {
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

    it('the registry is complete (5 dependency guardrails, distinct)', () => {
        expect(GUARDRAILS).toHaveLength(5);
        expect(new Set(GUARDRAILS.map((g) => g.file)).size).toBe(5);
    });

    it.each(GOVERNANCE_DOCS)('$role — $file exists', ({ file }) => {
        expect(exists(file)).toBe(true);
    });

    it('the governance doc states the four-pillar enforcement model', () => {
        // The load-bearing structure of the model — if the doc is
        // hollowed out, this catches it. Narrowed to the section that IS the
        // model; measured raw → section, 1→1, 3→1, 1→1, 10→2.
        const pillars = mdSection(
            readMarkdown('docs/dependency-governance.md'),
            'The four governance pillars',
        );
        expect(pillars).toMatch(/deterministic install/i);
        expect(pillars).toMatch(/strict peer/i);
        expect(pillars).toMatch(/version coherence/i);
        expect(pillars).toMatch(/risk/i);
    });

    it('the governance doc states the NextAuth stay-on-v4 policy', () => {
        // The deliberate-decision rationale — must name v4, the v5
        // beta-only status, and the recheck trigger. Over the whole document
        // `/next-?auth/i` matched 11 times and `/5\.0\.0|beta-only|GA/` 7,
        // most of them in the neighbouring react-window decision and the CI
        // section: the NextAuth section could have gone and this stayed
        // green. Measured raw → section, 11→8, 5→5, 7→7, 4→3.
        const nextAuth = mdSection(
            readMarkdown('docs/dependency-governance.md'),
            'NextAuth — stay on v4 until 5.0.0 GA',
        );
        expect(nextAuth).toMatch(/next-?auth/i);
        expect(nextAuth).toMatch(/\bv4\b/);
        expect(nextAuth).toMatch(/5\.0\.0|beta-only|GA/);
        expect(nextAuth).toMatch(/recheck|dist-tag/i);
    });

    it('the governance doc states the contributor dependency lifecycle', () => {
        // Adding / upgrading / removing — the safe-path workflow. Each needle
        // is the text of one `###` under this section; 1→1 for all three.
        const lifecycle = mdSection(
            readMarkdown('docs/dependency-governance.md'),
            'The dependency lifecycle — contributor workflow',
        );
        expect(lifecycle).toMatch(/adding a dependency/i);
        expect(lifecycle).toMatch(/upgrading a dependency/i);
        expect(lifecycle).toMatch(/removing a dependency/i);
    });

    it('the governance doc explains the two kinds of override', () => {
        // Bridge vs security override — conflating them is how a
        // security override gets dropped on convenience. Measured raw →
        // section, 1→1 and 3→2.
        const overrides = mdSection(
            readMarkdown('docs/dependency-governance.md'),
            'The `overrides` block — two kinds, one rule',
        );
        expect(overrides).toMatch(/bridge override/i);
        expect(overrides).toMatch(/security override/i);
    });
});
