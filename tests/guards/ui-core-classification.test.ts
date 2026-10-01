/**
 * Every file under the shared-UI candidate roots is triaged, and a GENERIC
 * classification is re-derived rather than trusted.
 *
 * #3047. T01–T08 of #3003 neutralised the ~120-file keep-set playerz vendors;
 * the other ~490 under these roots had never been looked at. So "inflect's UI
 * is product-neutral" was true of the files somebody checked and UNKNOWN of
 * the rest. This is the triage, stored as data a guard reads.
 *
 * ─── Why data and not a document ────────────────────────────────────
 *
 * The issue is explicit that a 613-row markdown table is derived data stored
 * beside its own source, and starts rotting the day it merges — the failure
 * the `counts` header in `doc-classification.json` caused, where two branches
 * each bumping `494 -> 495` merged cleanly and left main wrong by one with no
 * suspicious diff.
 *
 * So: **this file stores no totals.** Every count below is derived from the
 * map at run time. There is no number for two branches to bump.
 *
 * ─── The split, and why it is not arbitrary ──────────────────────────
 *
 * Of the five couplings the port kept finding, three are greppable and two
 * need judgement:
 *
 *   JUDGEMENT, recorded in the map — hardcoded copy, and domain-specific
 *     props or domain examples in prose. A reader has to decide whether
 *     `controls` is the GRC noun or a widget prop.
 *   MECHANICAL, re-derived here — a storage key not built through the T01
 *     seam, a brand FILL token used as text, an import from `src/app-layer`
 *     or a domain module. These should never rest on an opinion, so a file
 *     recorded GENERIC that trips one of them fails.
 *
 * That asymmetry is the point: the audit's judgement is preserved where a
 * grep cannot substitute, and overruled where it can.
 *
 * ─── Read through `codeOf` ───────────────────────────────────────────
 *
 * Comments are masked at the read seam. Writing this guard the naive way
 * caught `use-local-storage.ts` — the storage primitive itself — because its
 * docstring contains the example `useLocalStorage('k', {})`. A guard that
 * reads prose as code reports the seam that exists to contain a pattern as a
 * violation of it. String literals are KEPT: a Tailwind class and a storage
 * key both live in one.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    mechanicalCouplings,
    sharedUiPopulation,
} from '../helpers/shared-ui-couplings';

const ROOT = path.resolve(__dirname, '../..');
const MAP_PATH = 'docs/_status/ui-core-classification.json';

type Entry = {
    classification: 'GENERIC' | 'COUPLED' | 'MIXED';
    reason: string;
    derivation: string;
};

const MAP: Record<string, Entry> = JSON.parse(
    fs.readFileSync(path.join(ROOT, MAP_PATH), 'utf8'),
);

/**
 * The roots, the population and the three mechanical detectors all come from
 * `tests/helpers/shared-ui-couplings.ts`. They were defined inline here first;
 * #3048 needs the same derivation to ratchet the totals, and a detector copied
 * into two guards is two detectors that drift.
 */
const POPULATION = sharedUiPopulation(ROOT);
const mechanical = (rel: string) => mechanicalCouplings(ROOT, rel);

describe('shared-UI coupling classification (#3047)', () => {
    it('covers the population exactly — a new file must be triaged', () => {
        // The denominator is DERIVED from disk, never listed. A hand-maintained
        // population is one nothing checks, which is the lesson
        // `source-scan-population.test.ts` records.
        const mapped = new Set(Object.keys(MAP));
        const missing = POPULATION.filter((f) => !mapped.has(f));
        const stale = [...mapped].filter((f) => !POPULATION.includes(f)).sort();
        expect({ missing, stale }).toEqual({ missing: [], stale: [] });
        expect(POPULATION.length).toBeGreaterThan(600);
    });

    it('records a classification and a reason for every entry', () => {
        const bad = Object.entries(MAP)
            .filter(([, e]) => !['GENERIC', 'COUPLED', 'MIXED'].includes(e.classification) || !e.reason?.trim())
            .map(([p]) => p);
        expect(bad).toEqual([]);
    });

    it('no file recorded GENERIC trips a MECHANICAL coupling', () => {
        // The half that must not rest on judgement. A GENERIC here is a claim
        // that a second product can vendor the file as-is; these three are
        // exactly the claims a grep can check.
        const wrong = Object.entries(MAP)
            .filter(([, e]) => e.classification === 'GENERIC')
            .map(([p]) => [p, mechanical(p)] as const)
            .filter(([, c]) => c.length > 0)
            .map(([p, c]) => `${p} -> ${c.join(', ')}`);
        expect(wrong).toEqual([]);
    });

    it('the mechanical detectors fire — positive controls', () => {
        // Without this the assertion above passes when the regexes are broken,
        // which is the shape every "0 findings" result shares with a dead
        // detector. Each control is a file that genuinely trips its rule.
        const cases: Array<[string, string]> = [
            ['src/components/ui/charts/areas.tsx', 'brand-as-text'],
            ['src/components/ui/aside-panel.tsx', 'storage-key'],
            ['src/components/ui/FileDropzone.tsx', 'domain-import'],
        ];
        for (const [file, kind] of cases) {
            if (!fs.existsSync(path.join(ROOT, file))) continue; // moved; covered by the coverage case
            expect(mechanical(file)).toContain(kind);
        }
    });

    it('reads code, not prose — the negative control', () => {
        // `use-local-storage.ts` IS the storage primitive and its docstring
        // contains `useLocalStorage('k', {})`. Masking comments is what stops
        // the guard reporting the seam as a breach of itself.
        const hook = 'src/components/ui/hooks/use-local-storage.ts';
        if (fs.existsSync(path.join(ROOT, hook))) {
            expect(mechanical(hook)).not.toContain('storage-key');
        }
        // And a pure icon stays clean, so the detectors are not matching
        // everything indiscriminately.
        const icon = 'src/components/ui/icons/nucleo/shield-check.tsx';
        if (fs.existsSync(path.join(ROOT, icon))) {
            expect(mechanical(icon)).toEqual([]);
        }
    });

    it('stores no totals, so there is no number to drift', () => {
        // The `counts` header in `doc-classification.json` is the worked
        // example: two branches each bumping it merged clean and left main
        // wrong by one. Counts belong in the assertion, not the artefact.
        const raw = fs.readFileSync(path.join(ROOT, MAP_PATH), 'utf8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        expect(Object.keys(parsed).every((k) => k.startsWith('src/'))).toBe(true);
        expect(raw).not.toMatch(/"counts"/);
    });
});
