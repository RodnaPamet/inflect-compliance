/**
 * The org non-performing table's status tones: two deliberate divergences,
 * three that must not drift.
 *
 * #1921 and #1928 consolidated six private ControlStatus→variant maps onto
 * `CONTROL_STATUS_VARIANT`. This table is the ONE that stayed private, and the
 * question a future reader will ask is whether that was a decision or an
 * oversight. Left unrecorded it reads as an oversight, and the tidy-up is
 * obvious: import the shared map, delete five lines, ship a regression.
 *
 * So this pins the shape of the exception rather than the fact of it:
 *
 *   - the three statuses that AGREE with the shared map must keep agreeing,
 *     so a change there surfaces here as a decision instead of as drift;
 *   - the two that diverge must diverge in the direction the view exists for
 *     — hotter, never cooler.
 *
 * A test that simply asserted the five literals would pass while the shared
 * map moved underneath it, which is the failure this file is built to avoid.
 */
import { CONTROL_STATUS_VARIANT } from '@/app-layer/domain/entity-status-mapping';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src/app/org/[orgSlug]/(app)/controls/ControlsTable.tsx');

/** Parse the literal map out of the component, so the test reads what ships. */
function parseVariants(): Record<string, string> {
    const src = fs.readFileSync(SRC, 'utf8');
    const start = src.indexOf('const STATUS_VARIANTS');
    expect(start).toBeGreaterThan(-1);
    const open = src.indexOf('{', src.indexOf('=', start));
    const close = src.indexOf('};', open);
    const body = src.slice(open + 1, close);

    const out: Record<string, string> = {};
    for (const m of body.matchAll(/(\w+):\s*'([a-z]+)'/g)) out[m[1]] = m[2];
    return out;
}

/** Emphasis ordering, coolest → hottest. */
const RANK = ['neutral', 'info', 'warning', 'error'] as const;
const rank = (v: string) => RANK.indexOf(v as (typeof RANK)[number]);

describe('org non-performing controls — status emphasis', () => {
    const variants = parseVariants();

    it('covers exactly the five non-performing statuses', () => {
        // IMPLEMENTED and NOT_APPLICABLE are absent by design: an implemented
        // control is not non-performing. The row type enforces this at compile
        // time; this states the intent for a reader.
        expect(Object.keys(variants).sort()).toEqual([
            'IMPLEMENTING',
            'IN_PROGRESS',
            'NEEDS_REVIEW',
            'NOT_STARTED',
            'PLANNED',
        ]);
    });

    it.each(['IN_PROGRESS', 'IMPLEMENTING', 'NEEDS_REVIEW'])(
        '%s still agrees with the shared map',
        (status) => {
            // The drift guard. If the shared map changes one of these, this
            // fails and someone decides whether the org view follows — rather
            // than the two silently parting company.
            expect(variants[status]).toBe(CONTROL_STATUS_VARIANT[status]);
        },
    );

    it.each([
        ['NOT_STARTED', 'error'],
        ['PLANNED', 'warning'],
    ])('%s deliberately diverges, and only ever hotter', (status, expected) => {
        expect(variants[status]).toBe(expected);
        // The direction is the point. Everything on this screen is already a
        // problem, so the view's only job is ranking them; a divergence that
        // ran COOLER than the shared map would be a bug wearing the same
        // clothes as this exception.
        expect(rank(variants[status])).toBeGreaterThan(
            rank(CONTROL_STATUS_VARIANT[status]),
        );
    });

    it('records why this map is not consolidated', () => {
        // The comment is load-bearing: it is the only thing standing between
        // this file and a well-meant "import the shared map" cleanup.
        const src = fs.readFileSync(SRC, 'utf8');
        expect(src).toMatch(/DELIBERATELY hotter than `CONTROL_STATUS_VARIANT`/);
        expect(src).toMatch(/non-performing/i);
    });
});
