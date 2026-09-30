/**
 * The process surface carries no suppressions — and must still carry none
 * after the renderer is replaced.
 *
 * ── Why this is a guard and not a checklist line ─────────────────────
 *
 * #2962's cutover list ends with "**Zero page-hacks** — no `eslint-disable`,
 * `@ts-expect-error`, `guardrail-ignore`, `TODO` or `FIXME` anywhere in the
 * process surface", and adds: *"That last one is not aspirational. Verified
 * against `origin/main` … uniquely among the surfaces audited. Do not let a
 * renderer swap introduce the first one."*
 *
 * A property verified once, by hand, at the top of a four-phase migration is
 * a property nobody re-verifies at the bottom of it. The swap is precisely
 * the change that would introduce the first suppression — a new engine's
 * types not quite fitting a prop, a lint rule that does not understand a
 * canvas ref — and the cost of each is paid later by whoever inherits it.
 *
 * So the line becomes executable. It is also the cheapest item on that list
 * to keep honest, which is the argument for doing it first rather than last.
 *
 * ── What would make this guard lie ───────────────────────────────────
 *
 * Two things, and both are asserted against rather than assumed:
 *
 *   1. **An empty population.** Every directory below could be renamed by a
 *      refactor and this file would report zero violations over zero files,
 *      in the same green tick it reports for a clean tree. Hence
 *      `MIN_SURFACE_FILES` and the explicit per-root count — a root that
 *      stops matching fails loudly.
 *
 *   2. **A detector that cannot fire.** A zero from a regex that matches
 *      nothing anywhere is not evidence. The last test runs the SAME
 *      patterns over a synthetic sample and requires each to hit, so the
 *      clean verdict above is known to be a measurement rather than a
 *      silence.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { REPO_ROOT, repoRelativeFiles } from '../helpers/repo-files';

/**
 * The process canvas surface, as directories plus the handful of files that
 * live under shared roots.
 *
 * Deliberately NOT a `/process/i` substring match over `src/`: that also
 * catches `subprocessors/` (vendor chain), `processOutbox.ts` (notification
 * plumbing) and `webhook-processor.ts`, none of which are this surface and
 * none of which the migration touches. A guard whose population is wider
 * than its claim fails for reasons its own name cannot explain.
 */
const SURFACE_ROOTS = [
    'src/components/processes/',
    'src/lib/processes/',
    'src/app/t/[tenantSlug]/(app)/processes/',
    'src/app/api/t/[tenantSlug]/processes/',
] as const;

const SURFACE_FILES = [
    'src/app/api/t/[tenantSlug]/admin/process-canvas-module/route.ts',
    'src/app/api/t/[tenantSlug]/assets/[id]/process-maps/route.ts',
    'src/app/api/t/[tenantSlug]/controls/[controlId]/process-maps/route.ts',
    'src/app/api/t/[tenantSlug]/risks/[id]/process-maps/route.ts',
    'src/app-layer/reports/pdf/processMap.ts',
    'src/app-layer/repositories/ProcessMapRepository.ts',
    'src/app-layer/schemas/process-map.ts',
    'src/app-layer/usecases/process-canvas-module.ts',
    'src/app-layer/usecases/process-map.ts',
] as const;

/**
 * A floor, not an equality: the migration ADDS files to this surface (the
 * tldraw shape layer already did), so pinning an exact count would fail on
 * every PR that grows it. What the floor catches is the population
 * COLLAPSING — a renamed root, a changed path convention — which is the way
 * a scan silently starts proving nothing.
 */
const MIN_SURFACE_FILES = 70;

/** Each root must contribute; a root that matches nothing is a stale path. */
const MIN_PER_ROOT = 4;

const SUPPRESSION_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
    ['eslint-disable', /eslint-disable/],
    ['ts-expect-error', /@ts-expect-error/],
    ['ts-ignore', /@ts-ignore/],
    // `guardrail-ignore` ONLY. `guardrail-allow` is deliberately NOT here:
    // it is the repo's SANCTIONED vocabulary, documented in CLAUDE.md as the
    // required way to declare an intentional unbounded `findMany` with a
    // written reason, and the query-shape guardrail enforces the reason. It
    // appears in 36 files across `src/`, three of them in this surface, each
    // explaining itself above the call.
    //
    // The first draft of this guard matched both and reported those three as
    // violations. They are documented decisions, not suppressions — and
    // #2962's list names `guardrail-ignore`, not `guardrail-allow`. Widening
    // a detector past the claim it is named for produces exactly this kind of
    // false alarm.
    ['guardrail-ignore', /guardrail-ignore/],
    ['TODO', /\bTODO\b/],
    ['FIXME', /\bFIXME\b/],
];

const isSourceFile = (rel: string) =>
    rel.endsWith('.ts') || rel.endsWith('.tsx');

function surfaceFiles(): string[] {
    const all = repoRelativeFiles();
    const byRoot = all.filter(
        (rel) => isSourceFile(rel) && SURFACE_ROOTS.some((r) => rel.startsWith(r)),
    );
    const named = all.filter((rel) => SURFACE_FILES.includes(rel as never));
    return [...new Set([...byRoot, ...named])].sort();
}

describe('the process surface carries no suppressions', () => {
    const files = surfaceFiles();

    it('the population is real and every root still contributes', () => {
        // Printed, not just compared: the denominator is part of the result.
        expect({
            files: files.length,
            floor: MIN_SURFACE_FILES,
        }).toEqual({ files: expect.any(Number), floor: MIN_SURFACE_FILES });
        expect(files.length).toBeGreaterThanOrEqual(MIN_SURFACE_FILES);

        for (const root of SURFACE_ROOTS) {
            const n = files.filter((f) => f.startsWith(root)).length;
            expect({ root, n }).toEqual({
                root,
                n: expect.any(Number),
            });
            expect(n).toBeGreaterThanOrEqual(MIN_PER_ROOT);
        }

        for (const named of SURFACE_FILES) {
            expect(fs.existsSync(path.join(REPO_ROOT, named))).toBe(true);
        }
    });

    it('carries none of the suppression markers', () => {
        const hits: string[] = [];
        for (const rel of files) {
            const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
            src.split('\n').forEach((line, i) => {
                for (const [label, re] of SUPPRESSION_PATTERNS) {
                    if (re.test(line)) hits.push(`${rel}:${i + 1}  [${label}]  ${line.trim()}`);
                }
            });
        }

        // #2962: "Do not let a renderer swap introduce the first one." If this
        // fails, the fix is to remove the suppression — not to add the file to
        // an allowlist. There is deliberately no allowlist.
        expect({ surfaceFiles: files.length, suppressions: hits }).toEqual({
            surfaceFiles: files.length,
            suppressions: [],
        });
    });

    it('and the detector can actually fire (positive control)', () => {
        // A zero above is only evidence if these patterns CAN hit. Each is run
        // against a line that should trip it, and against one that should not.
        const shouldHit: Record<string, string> = {
            'eslint-disable': '// eslint-disable-next-line no-console',
            'ts-expect-error': '// @ts-expect-error engine types disagree',
            'ts-ignore': '// @ts-ignore',
            'guardrail-ignore': '// guardrail-ignore: legacy shape',
            TODO: '// TODO: wire this up',
            FIXME: '// FIXME: leaks on unmount',
        };
        // The clean sample deliberately INCLUDES a sanctioned `guardrail-allow`,
        // so a future widening of that pattern fails here rather than in the
        // surface scan — where it would read as a real violation.
        const clean =
            'const rows = await db.processNode.findMany({ // guardrail-allow: unbounded';

        for (const [label, re] of SUPPRESSION_PATTERNS) {
            expect({ label, fires: re.test(shouldHit[label]) }).toEqual({
                label,
                fires: true,
            });
            expect({ label, falsePositive: re.test(clean) }).toEqual({
                label,
                falsePositive: false,
            });
        }
    });
});
