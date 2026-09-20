/**
 * COSO ICF 2013 — the library is complete, assessable, and originally worded.
 *
 * ── WHY THESE ASSERTIONS AND NOT OTHERS ─────────────────────────────────────
 *
 * COSO is unlike every other framework in this repo, and the difference decides
 * what is worth guarding. ISO 27001's Annex A IS a control catalogue, so its
 * library can be checked against a published list. COSO stops at 5 components
 * and 17 principles by design — organizations are expected to design their own
 * controls — and its nearest equivalent to a control list, the 87 "points of
 * focus", is the copyrighted part we deliberately do not carry.
 *
 * So there is no external list to diff against. What can be guarded is that the
 * ENUMERATION is complete and well-formed, and that the prose is ours:
 *
 *   · 22 nodes / 17 assessable / P1..P17 with no gap or duplicate — the
 *     enumeration is public and fixed, so any deviation is an error rather than
 *     a judgement call;
 *   · every principle sits under one of the five component codes, because the
 *     component is what `ControlTemplate.category` will carry when the content
 *     PRs land, and a principle in the wrong component silently miscategorises
 *     every control that links to it;
 *   · a length floor on descriptions, which is the cheap detector for a
 *     placeholder stub that passes every structural check;
 *   · NO TWO DESCRIPTIONS IDENTICAL. This is the licensing guard in disguise:
 *     the failure mode when someone reaches for the source text is
 *     copy-and-adjust, and duplicated prose is its first symptom. It cannot
 *     detect paraphrase that is too close — only a human can — which is why the
 *     implementation note asks for legal review rather than claiming this test
 *     settles it.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
 *
 * Crosswalk resolution. `tests/guardrails/mapping-targets-exist.test.ts` already
 * discovers every file in `src/data/libraries/mappings/` and asserts that each
 * ref resolves — including the two COSO sets, which it picked up with no change.
 * A `coso-crosswalk.test.ts` asserting the same thing would be a second copy of
 * a working guard, and the copy is the one that rots. What IS here is the part
 * that guard cannot know: which principles we chose to map and why the rest are
 * absent.
 */
import fs from 'node:fs';
import path from 'node:path';

import yaml from 'js-yaml';

import { loadLibrary, parseLibraryFile } from '@/app-layer/libraries/library-loader';

const ROOT = path.resolve(__dirname, '../..');
const LIB = path.join(ROOT, 'src/data/libraries/coso-icf-2013.yaml');
const MAPPINGS = path.join(ROOT, 'src/data/libraries/mappings');

const COMPONENTS = ['CE', 'RA', 'CA', 'IC', 'MA'] as const;

/** The published enumeration. Fixed, public, and not a matter of taste. */
const PRINCIPLES_BY_COMPONENT: Readonly<Record<string, readonly string[]>> = {
    CE: ['P1', 'P2', 'P3', 'P4', 'P5'],
    RA: ['P6', 'P7', 'P8', 'P9'],
    CA: ['P10', 'P11', 'P12'],
    IC: ['P13', 'P14', 'P15'],
    MA: ['P16', 'P17'],
};

const library = loadLibrary(parseLibraryFile(LIB), 'coso-icf-2013.yaml');
const nodes = library.framework.nodes;
const assessable = nodes.filter((n) => n.assessable);
const groupings = nodes.filter((n) => !n.assessable);

describe('the COSO library carries the whole enumeration', () => {
    it('is 22 nodes: 5 components and 17 principles', () => {
        expect({ total: nodes.length, components: groupings.length, principles: assessable.length })
            .toEqual({ total: 22, components: 5, principles: 17 });
    });

    it('carries P1..P17 with no gap and no duplicate', () => {
        const codes = assessable.map((n) => String(n.refId));
        const expected = Array.from({ length: 17 }, (_, i) => `P${i + 1}`);
        expect([...codes].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))).toEqual(expected);
        expect(new Set(codes).size).toBe(17);
    });

    it('puts every principle under the component the framework assigns it', () => {
        const live: Record<string, string[]> = {};
        for (const n of assessable) {
            const c = String(n.category);
            (live[c] ??= []).push(String(n.refId));
        }
        for (const c of Object.keys(live)) {
            live[c].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
        }
        expect(live).toEqual(PRINCIPLES_BY_COMPONENT);
    });

    it('names the five components as the grouping nodes', () => {
        expect(groupings.map((n) => String(n.refId)).sort()).toEqual([...COMPONENTS].sort());
    });
});

describe('the prose is real, and is ours', () => {
    it('gives every principle a description long enough to be an actual statement', () => {
        // 120 chars is a placeholder detector, not a quality bar: a stub reads
        // "TODO" or repeats the title, and neither survives this.
        const short = assessable
            .filter((n) => (n.description ?? '').trim().length < 120)
            .map((n) => `${n.refId} (${(n.description ?? '').trim().length} chars)`);
        expect(short).toEqual([]);
    });

    it('repeats no description between nodes — the copy-and-adjust tell', () => {
        const seen = new Map<string, string>();
        const dupes: string[] = [];
        for (const n of nodes) {
            const d = (n.description ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (!d) continue;
            const prior = seen.get(d);
            if (prior) dupes.push(`${prior} and ${n.refId}`);
            else seen.set(d, String(n.refId));
        }
        expect(dupes).toEqual([]);
    });

    it('does not restate a principle\'s own name as its description', () => {
        const echoes = assessable
            .filter((n) => {
                const name = String(n.name ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
                const desc = (n.description ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
                return name.length > 0 && desc.startsWith(name);
            })
            .map((n) => String(n.refId));
        expect(echoes).toEqual([]);
    });
});

describe('the crosswalks say what we chose to claim', () => {
    const read = (file: string) =>
        yaml.load(fs.readFileSync(path.join(MAPPINGS, file), 'utf8')) as {
            source_framework_ref: string;
            target_framework_ref: string;
            mapping_entries: { source_ref: string; target_ref: string; strength: string }[];
        };

    it('maps COSO onto SOC 2 from the COSO side', () => {
        const set = read('coso-to-soc2.yaml');
        expect([set.source_framework_ref, set.target_framework_ref]).toEqual([
            'COSO-ICF-2013',
            'SOC2-2017',
        ]);
    });

    it('maps COSO onto ISO 27001 from the COSO side', () => {
        const set = read('coso-to-iso27001.yaml');
        expect([set.source_framework_ref, set.target_framework_ref]).toEqual([
            'COSO-ICF-2013',
            'ISO27001-2022',
        ]);
    });

    it('claims only principles that have a real counterpart, and no others', () => {
        // The SOC 2 library here carries ONE assessable node per common-criteria
        // series, not the full published TSC. So principles whose genuine
        // counterpart is a code this library lacks (P3/P4/P5 against
        // CC1.3/CC1.4/CC1.5) are absent ON PURPOSE. Pinning the claimed set
        // stops a later edit from "completing" the map onto whichever node
        // happens to exist, which would read as coverage that was never there.
        const soc2 = read('coso-to-soc2.yaml');
        expect([...new Set(soc2.mapping_entries.map((e) => e.source_ref))].sort()).toEqual(
            ['P1', 'P10', 'P13', 'P16', 'P17', 'P2', 'P6', 'P7'].sort(),
        );
    });

    it('keeps the ISO map to the three places the frameworks genuinely meet', () => {
        const iso = read('coso-to-iso27001.yaml');
        expect([...new Set(iso.mapping_entries.map((e) => e.source_ref))].sort()).toEqual(
            ['P1', 'P11', 'P5'].sort(),
        );
    });

    it('targets only ASSESSABLE nodes, so every row reaches the database', () => {
        // A mapping onto a grouping node resolves and then does nothing —
        // `library-importer` writes RequirementMapping rows for assessable
        // targets only. Two clause-9/10 rows were written here and removed for
        // exactly this reason; see the comment in coso-to-iso27001.yaml.
        const assessableOf = (file: string) =>
            new Set(
                loadLibrary(
                    parseLibraryFile(path.join(ROOT, 'src/data/libraries', file)),
                    file,
                ).framework.nodes
                    .filter((n) => n.assessable)
                    .map((n) => String(n.refId)),
            );
        const targets: Record<string, Set<string>> = {
            'SOC2-2017': assessableOf('soc2-2017.yaml'),
            'ISO27001-2022': assessableOf('iso27001-2022.yaml'),
        };
        const inert: string[] = [];
        for (const file of ['coso-to-soc2.yaml', 'coso-to-iso27001.yaml']) {
            const set = read(file);
            for (const e of set.mapping_entries) {
                if (!targets[set.target_framework_ref].has(String(e.target_ref))) {
                    inert.push(`${file}: ${e.source_ref} -> ${e.target_ref}`);
                }
            }
        }
        expect(inert).toEqual([]);
    });
});
