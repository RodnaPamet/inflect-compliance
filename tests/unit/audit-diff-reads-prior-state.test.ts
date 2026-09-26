/**
 * #2881 — `changedFields` names what CHANGED, not what the caller sent.
 *
 * ═══ THE DEFECT ═══
 *
 * `extractChangedFields` is `Object.keys(payload)`. Nothing read the prior
 * row, so every audit row named whatever columns the statement happened to
 * carry. The HRIS upsert names ten unconditionally, so its audit rows claimed
 * `department` and `jobTitle` changed for every employee on every run — an
 * investigator asking when somebody moved got a hit on every sync since the
 * tenant was onboarded. A trail that answers every question affirmatively is
 * not a weaker signal than none; it is a misleading one.
 *
 * ═══ WHY THE OBVIOUS FIX WAS UNSAFE ═══
 *
 * A Prisma query extension is handed no client, so a before-read would have
 * gone through the module-scope singleton: a different connection, outside the
 * caller's transaction, as the OWNING role — bypassing RLS and able to return
 * other tenants' rows, which would then be written into this tenant's audit row
 * as `before`. The reader is therefore bound from INSIDE the transaction, over
 * `tx`, and these tests pin both halves: the comparison, and the fact that the
 * plumbing actually delivers a reader.
 */
import { buildDiffJson } from '@/lib/prisma';

const AFTER = { department: 'Eng', jobTitle: 'Engineer', fullName: 'A' };

describe('changedFields, when the prior row is available', () => {
    it('names only the field that actually differs', async () => {
        const diff = buildDiffJson(
            'update',
            { department: 'Eng', jobTitle: 'Engineer' },
            AFTER,
            { department: 'Sales', jobTitle: 'Engineer' },
        );

        expect(diff?.changedFields).toStrictEqual(['department']);
        expect(diff?.changedFieldsAreDiffed).toBe(true);
    });

    it('returns NOTHING when the payload writes what is already stored', async () => {
        // The assertion the whole finding is about: a statement that changes
        // no value must not produce a row claiming it did.
        const diff = buildDiffJson(
            'update',
            { department: 'Eng', jobTitle: 'Engineer' },
            AFTER,
            { department: 'Eng', jobTitle: 'Engineer' },
        );

        expect(diff).toBeNull();
    });

    it('carries a before, limited to the fields it named', async () => {
        const diff = buildDiffJson(
            'update',
            { department: 'Eng', jobTitle: 'Engineer' },
            AFTER,
            { department: 'Sales', jobTitle: 'Engineer', fullName: 'A' },
        );

        expect(diff?.before).toStrictEqual({ department: 'Sales' });
    });

    it('treats null and undefined as the SAME stored state', async () => {
        // A column holding null, written with null, has not changed. Comparing
        // them raw reports a change on every write for every nullable column a
        // caller names — the same "fires on everything" failure, arrived at
        // from the other direction.
        const diff = buildDiffJson('update', { department: null }, {}, { department: null });

        expect(diff).toBeNull();
    });

    it('compares Dates by value, not identity', async () => {
        const t = '2026-09-26T00:00:00.000Z';
        expect(buildDiffJson('update', { at: new Date(t) }, {}, { at: new Date(t) })).toBeNull();
        expect(
            buildDiffJson('update', { at: new Date(t) }, {}, { at: new Date('2020-01-01T00:00:00.000Z') })
                ?.changedFields,
        ).toStrictEqual(['at']);
    });
});

describe('payload values that are not scalars', () => {
    it('unwraps `{ set: v }`, which is exactly an assignment', async () => {
        expect(buildDiffJson('update', { department: { set: 'Eng' } }, {}, { department: 'Eng' })).toBeNull();
        expect(
            buildDiffJson('update', { department: { set: 'Eng' } }, {}, { department: 'Sales' })?.changedFields,
        ).toStrictEqual(['department']);
    });

    it('treats every OTHER operator as a change rather than computing it', async () => {
        // Deciding whether `{ increment: 0 }` changes anything means
        // reimplementing the database. Reporting it as changed costs a field
        // name; under-reporting would hide a real write from the trail.
        expect(
            buildDiffJson('update', { count: { increment: 1 } }, {}, { count: 5 })?.changedFields,
        ).toStrictEqual(['count']);
    });

    it('does not mistake an operator’s ARGUMENT for the value it would store', async () => {
        // `{ increment: 5 }` against a stored 5 is the case that separates
        // unwrapping `set` from unwrapping anything: a naive
        // `Object.values(op)[0]` compares 5 to 5, calls it unchanged, and the
        // increment vanishes from the trail. Found by a mutation that did
        // exactly that and stayed green against the `increment: 1` case above,
        // where both readings happen to agree.
        expect(
            buildDiffJson('update', { count: { increment: 5 } }, {}, { count: 5 })?.changedFields,
        ).toStrictEqual(['count']);
    });

    it('does not treat an unknown prior field as equal to a written null', async () => {
        // `prior` lacking the key means the row carried no such field — "we do
        // not know", which must read as changed rather than as equal.
        expect(
            buildDiffJson('update', { department: null }, {}, { other: 'x' })?.changedFields,
        ).toStrictEqual(['department']);
    });
});

describe('when no prior row is available', () => {
    it('falls back to payload keys and SAYS SO', async () => {
        // The fallback is the old behaviour, and it must be legible as such.
        // A silent fallback would reintroduce the defect wearing the fix's
        // clothes — a consumer cannot tell a compared field list from a
        // restatement of the request by looking at the list.
        const diff = buildDiffJson('update', { department: 'Eng' }, AFTER, undefined);

        expect(diff?.changedFields).toStrictEqual(['department']);
        expect(diff?.changedFieldsAreDiffed).toBe(false);
        expect(diff).not.toHaveProperty('before');
    });

    it('treats a reader that found NO row as an insert, not as a fallback', async () => {
        // `undefined` means nobody looked; `null` means somebody looked and
        // there was nothing there — an upsert that inserted, where every
        // payload key genuinely is new.
        const diff = buildDiffJson('upsert', { department: 'Eng' }, AFTER, null);

        expect(diff?.changedFields).toStrictEqual(['department']);
        expect(diff?.changedFieldsAreDiffed).toBe(false);
    });
});

describe('operations the diff deliberately does not touch', () => {
    it.each(['create', 'delete', 'updateMany', 'deleteMany'])('returns null for %s', (op) => {
        // `updateMany`/`deleteMany` touch an unbounded set, so a per-row
        // before-image is unbounded work on the write path. `create` has no
        // prior row by definition.
        expect(buildDiffJson(op, { department: 'Eng' }, AFTER, { department: 'Sales' })).toBeNull();
    });
});
