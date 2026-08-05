/**
 * `criticality` has ONE meaning: the stored `Asset.criticality` enum,
 * derived on write from the C/I/A triad.
 *
 * It was previously both — stored (read by the list filter, the dashboard
 * KPI and the detail meta bar) AND re-derived client-side (the table cell,
 * the sort accessor, the detail badge). Those can disagree, and the
 * disagreement is user-visible in the worst way: filter the list to HIGH,
 * and a cell that recomputes its own answer can render "Medium" on a row
 * the server matched as HIGH.
 *
 * Stored wins because the two consumers that cannot be moved live in SQL —
 * `where.criticality` on the list query and
 * `count({ criticality: { in: ['HIGH','CRITICAL'] } })` on the dashboard.
 * Neither can recompute a per-row value from the triad without reading
 * every row.
 *
 * This suite pins both halves of that contract: the write path derives, and
 * the presentation table is the exact inverse of the write mapping, so a
 * change to one that is not mirrored in the other fails here.
 */
import {
    CRITICALITY_PRESENTATION,
    criticalityToEnum,
    getAssetCriticality,
    presentCriticality,
    type CriticalityEnum,
} from '@/lib/asset-criticality';

describe('criticality — stored is the single source of truth', () => {
    it('presentation is the exact inverse of the write mapping', () => {
        // For every triad, the label the write path stores and the label a
        // read surface renders from that stored value must be the same
        // string. This is the invariant the two-implementations bug broke.
        for (let c = 1; c <= 5; c++) {
            for (let i = 1; i <= 5; i++) {
                for (let a = 1; a <= 5; a++) {
                    const stored = criticalityToEnum(c, i, a);
                    const rendered = presentCriticality(stored);
                    expect(rendered).not.toBeNull();
                    expect(rendered!.label).toBe(getAssetCriticality(c, i, a).label);
                    expect(rendered!.tone).toBe(getAssetCriticality(c, i, a).tone);
                }
            }
        }
    });

    it('covers every member of the Prisma Criticality enum', () => {
        // A new band added to the schema without a presentation entry would
        // render as an em-dash forever, silently.
        const members: CriticalityEnum[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
        for (const m of members) {
            expect(CRITICALITY_PRESENTATION[m]).toBeDefined();
            expect(CRITICALITY_PRESENTATION[m].label.length).toBeGreaterThan(0);
        }
        expect(Object.keys(CRITICALITY_PRESENTATION).sort()).toEqual([...members].sort());
    });

    it('ranks bands in true severity order so the table sort matches the badge', () => {
        const ranks = (['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const).map(
            (m) => CRITICALITY_PRESENTATION[m].rank,
        );
        expect(ranks).toEqual([...ranks].sort((x, y) => x - y));
        expect(new Set(ranks).size).toBe(ranks.length);
    });

    it('returns null for absent or unrecognised stored values', () => {
        // Read surfaces render an em-dash rather than inventing a band —
        // guessing here would resurrect the disagreement this file prevents.
        expect(presentCriticality(null)).toBeNull();
        expect(presentCriticality(undefined)).toBeNull();
        expect(presentCriticality('')).toBeNull();
        expect(presentCriticality('SEVERE')).toBeNull();
    });

    it('keeps the critical-ceiling override on the write path', () => {
        // A single ceiling dimension is Critical regardless of the others.
        expect(criticalityToEnum(5, 1, 1)).toBe('CRITICAL');
        // ...and two elevated dimensions are needed to raise the band,
        // so a lone 4 does not.
        expect(criticalityToEnum(4, 1, 1)).toBe('MEDIUM');
        expect(criticalityToEnum(4, 4, 1)).toBe('HIGH');
    });
});
