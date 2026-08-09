/**
 * The readiness bands have ONE definition. This is the third attempt.
 *
 * 80 and 50 are the boundaries between "ready to be audited", "nearly there"
 * and "at risk". They were written out six times across four files, in three
 * output vocabularies that could not see each other:
 *
 *   readiness/ReadinessOverviewClient.tsx:33    success | attention | critical
 *   readiness/ReadinessOverviewClient.tsx:125   success | warning   | error
 *   readiness/ReadinessOverviewClient.tsx:128   success | warning   | error
 *   readiness/ReadinessOverviewClient.tsx:131   success | warning   | error
 *   cycles/[cycleId]/readiness/page.tsx:236     success | warning   | error
 *   cycles/ReadinessScoreRing.tsx:15            #22c55e | #eab308   | #ef4444
 *
 * WHY A RATCHET AND NOT JUST THE REFACTOR
 * ---------------------------------------
 * Because the refactor already happened once. `<ReadinessScoreRing>` was
 * extracted precisely because these bands "were previously undocumented magic
 * numbers duplicated in two files" — and they grew back, including into
 * `cycles/[cycleId]/readiness/page.tsx`, one of the two files it was extracted
 * from. An extraction with no rule behind it decays as soon as a new surface
 * needs the band in a vocabulary the extracted component does not speak.
 *
 * So this guard does not assert that the refactor happened; it asserts that
 * the numbers cannot come back. That is the part that failed last time.
 *
 * WHAT IT ALLOWS
 * --------------
 * `src/lib/readiness/bands.ts` — the one definition — and prose. A comment
 * saying "aim for 80%+ coverage" is documentation, not a second rule.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

/** The single source of truth. Every other file is policed against it. */
const DEFINITION = 'src/lib/readiness/bands.ts';

/**
 * Where a readiness score is scored or rendered. A threshold literal
 * reappearing in any of these is the regression.
 */
const READINESS_SURFACES = [
    'src/app-layer/usecases/audit-readiness',
    'src/app-layer/usecases/nis2-readiness.ts',
    'src/app-layer/usecases/test-readiness.ts',
    'src/app/t/[tenantSlug]/(app)/audits',
    'src/app/api/t/[tenantSlug]/audits',
];

/**
 * A comparison against 80 or 50 — the shapes that reconstruct a band.
 * `>= 80`, `> 79`, `< 50`, `<= 49`, and the ternary chains built from them.
 */
const THRESHOLD_RE = /[<>]=?\s*(80|79|50|49)\b|\b(80|79|50|49)\s*[<>]=?/;

function walk(dir: string, out: string[] = []): string[] {
    if (!fs.existsSync(dir)) return out;
    const stat = fs.statSync(dir);
    if (stat.isFile()) {
        if (/\.tsx?$/.test(dir)) out.push(dir);
        return out;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
            walk(full, out);
        } else if (/\.tsx?$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

/** Strip comments and JSX text so prose about "80%" never trips the scan. */
function codeOnly(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((l) => {
            const t = l.trim();
            return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('{/*');
        })
        .map((l) => l.replace(/\/\/.*$/, ''))
        .join('\n');
}

describe('readiness bands — one definition, no regrowth', () => {
    it('the definition exists and names both boundaries exactly once', () => {
        const src = fs.readFileSync(path.resolve(ROOT, DEFINITION), 'utf8');
        const code = codeOnly(src);
        expect(code).toMatch(/ready:\s*80/);
        expect(code).toMatch(/nearly:\s*50/);
        // Exactly one occurrence each — the definition must not repeat itself.
        expect((code.match(/\b80\b/g) ?? []).length).toBe(1);
        expect((code.match(/\b50\b/g) ?? []).length).toBe(1);
    });

    it('exports all three vocabularies, so a new surface never re-derives', () => {
        // The regrowth mechanism was a renderer needing a vocabulary the
        // extraction did not speak. Each vocabulary having a home here is what
        // makes "add a map" cheaper than "re-read the thresholds".
        const src = fs.readFileSync(path.resolve(ROOT, DEFINITION), 'utf8');
        expect(src).toMatch(/READINESS_BAND_VARIANT/); // StatusBadge / ProgressBar
        expect(src).toMatch(/READINESS_BAND_TONE/); // KPIStat
        expect(src).toMatch(/READINESS_BAND_COLOR_VAR/); // SVG stroke / fill
        expect(src).toMatch(/export function readinessBand/);
    });

    it('no readiness surface compares against 80 or 50', () => {
        const offenders: string[] = [];
        for (const rel of READINESS_SURFACES) {
            for (const abs of walk(path.resolve(ROOT, rel))) {
                const relPath = path.relative(ROOT, abs).split(path.sep).join('/');
                if (relPath === DEFINITION) continue;
                codeOnly(fs.readFileSync(abs, 'utf8'))
                    .split('\n')
                    .forEach((line, i) => {
                        if (THRESHOLD_RE.test(line)) {
                            offenders.push(`${relPath}:${i + 1}\n    ${line.trim().slice(0, 140)}`);
                        }
                    });
            }
        }
        if (offenders.length > 0) {
            throw new Error(
                `The readiness thresholds have regrown in ${offenders.length} place(s).\n\n` +
                    `They live in ${DEFINITION} and nowhere else. Import \`readinessBand\`, ` +
                    `\`readinessVariant\` or \`readinessTone\` — or, if your surface needs a ` +
                    `vocabulary none of those speak, ADD THE MAP THERE rather than the ` +
                    `numbers here. That is the step whose absence let this regrow twice.\n\n` +
                    `If your literal is genuinely a different scale (see \`PRIORITY_TIER_MIN\` ` +
                    `in nis2-readiness.ts), give it a named constant so it reads as a ` +
                    `different rule.\n\n${offenders.join('\n')}`,
            );
        }
        expect(offenders).toEqual([]);
    });

    it('the scan actually reads files — it cannot pass by finding nothing', () => {
        // A wrong path here would make the guard above vacuous, which is the
        // failure mode of every path-based ratchet.
        const scanned = READINESS_SURFACES.flatMap((rel) => walk(path.resolve(ROOT, rel)));
        expect(scanned.length).toBeGreaterThanOrEqual(20);
    });

    it('the surfaces that used to hold copies now import the definition', () => {
        // Positive counterpart to the ban: proves the six sites were migrated,
        // not merely reworded past the regex.
        const consumers = [
            'src/app/t/[tenantSlug]/(app)/audits/cycles/ReadinessScoreRing.tsx',
            'src/app/t/[tenantSlug]/(app)/audits/readiness/ReadinessOverviewClient.tsx',
            'src/app/t/[tenantSlug]/(app)/audits/cycles/[cycleId]/readiness/page.tsx',
        ];
        for (const rel of consumers) {
            const src = fs.readFileSync(path.resolve(ROOT, rel), 'utf8');
            expect(src).toMatch(/@\/lib\/readiness\/bands/);
        }
    });
});
