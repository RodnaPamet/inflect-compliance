/**
 * `unwrapCappedList` — the client-side reader for the backfill-capped
 * `{ rows, truncated }` envelope.
 *
 * This exists because of a real production outage: #1788 converted
 * `GET /api/t/:slug/assets` from a bare array to the capped envelope,
 * and the "Link a CVE" modal on the Vulnerabilities page still
 * declared `useTenantSWR<AssetOption[]>('/assets')` and called `.map`
 * on the result. The SWR generic is an unchecked assertion, so `tsc`
 * passed and the browser threw
 *
 *     TypeError: (d ?? []).map is not a function
 *
 * which the error boundary turned into a blank page.
 *
 * The companion structural guard
 * (`tests/guards/capped-list-consumer-shape.test.ts`) proves no
 * consumer declares the wrong generic. It reads source text and
 * executes none of this logic — so these cases execute it.
 */

import {
    applyBackfillCap,
    unwrapCappedList,
    LIST_BACKFILL_CAP,
    type CappedList,
} from '@/lib/list-backfill-cap';

interface Row {
    id: string;
}

describe('unwrapCappedList', () => {
    it('reads rows out of the capped envelope', () => {
        const capped: CappedList<Row> = {
            rows: [{ id: 'a' }, { id: 'b' }],
            truncated: false,
        };
        expect(unwrapCappedList(capped)).toEqual([{ id: 'a' }, { id: 'b' }]);
    });

    it('passes a bare array through unchanged', () => {
        const rows: Row[] = [{ id: 'a' }];
        // Same reference — no needless copy for the legacy shape.
        expect(unwrapCappedList(rows)).toBe(rows);
    });

    it('returns [] for undefined (SWR before first response)', () => {
        // This is the pre-fetch render. It must not throw, and must not
        // produce `undefined` for a caller about to call `.map`.
        expect(unwrapCappedList(undefined)).toEqual([]);
    });

    it('returns [] for null', () => {
        expect(unwrapCappedList(null)).toEqual([]);
    });

    it('returns [] for a malformed body instead of throwing', () => {
        // An error envelope or a shape drift must degrade to an empty
        // picker, never take the page down.
        const bogus = { error: { message: 'nope' } } as unknown as CappedList<Row>;
        expect(unwrapCappedList(bogus)).toEqual([]);
    });

    it('returns [] when rows is present but not an array', () => {
        const bogus = { rows: 'not-an-array', truncated: false } as unknown as CappedList<Row>;
        expect(unwrapCappedList(bogus)).toEqual([]);
    });

    it('reproduces the regression: the capped envelope has no .map', () => {
        // The exact failure mode, pinned. `assets.map` on the envelope is
        // a TypeError; routed through the helper it is a usable array.
        const capped = applyBackfillCap<Row>([{ id: 'a' }]);
        expect(
            () => (capped as unknown as Row[]).map((r) => r.id),
        ).toThrow(TypeError);
        expect(unwrapCappedList(capped).map((r) => r.id)).toEqual(['a']);
    });

    it('round-trips whatever applyBackfillCap produces, truncated or not', () => {
        const under = applyBackfillCap<Row>([{ id: 'a' }]);
        expect(under.truncated).toBe(false);
        expect(unwrapCappedList(under)).toHaveLength(1);

        const over = applyBackfillCap<Row>(
            Array.from({ length: LIST_BACKFILL_CAP + 1 }, (_, i) => ({ id: String(i) })),
        );
        expect(over.truncated).toBe(true);
        // Unwrapping a truncated list yields the clamped rows, not the input.
        expect(unwrapCappedList(over)).toHaveLength(LIST_BACKFILL_CAP);
    });
});
