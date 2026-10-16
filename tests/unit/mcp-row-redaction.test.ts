import { applyRowRedaction, applyRedaction } from '@/lib/mcp/authorize';

import type { McpInvocation } from '@/lib/mcp/authorize';

/**
 * ROW-LEVEL REDACTION DROPS WHAT THE CALLER MAY NOT SEE (#3617).
 *
 * `applyRowRedaction` had **no test at all**, and twelve of the forty-five
 * uncovered branches in `authorize.ts` were inside it. It is the pass that
 * removes individual ROWS from a tool's payload according to the acting
 * context's permissions — so an unexercised arm here is a row reaching a caller
 * who may not see it, which is the one failure this function exists to prevent.
 *
 * It is exported and takes values, so none of this needs a database.
 *
 * ── WHAT THE BRANCHES ACTUALLY DECIDE ───────────────────────────────────────
 *
 * Every uncovered path was a degradation rule: a missing permission domain, a
 * permission that is present but not exactly `true`, a declared path that is
 * not an array, a path that walks through a non-object, and a row whose key is
 * `null`. Each one answers "what happens when the payload is not the shape the
 * rule assumed" — and the two possible answers are "filter nothing" and "throw
 * mid-response". The docstring commits to the first; nothing checked it.
 */

/** An invocation carrying just the permissions the redactor reads. */
const inv = (perms: Record<string, Record<string, boolean>>): McpInvocation =>
    ({ ctx: { appPermissions: perms } }) as unknown as McpInvocation;

/** A rule over `rows`, keyed by each row's `need` field. */
const rowsRule = [
    {
        path: 'rows',
        keyOf: (row: unknown) => (row as { need?: string | null }).need ?? null,
    },
];

describe('applyRowRedaction — the permitted rows and no others', () => {
    it('returns the data untouched when there are no rules', () => {
        // Identity, and the SAME object: the no-rule path must not pay for a
        // clone on every tool response that declares nothing.
        const data = { rows: [{ need: 'risks.view' }] };
        expect(applyRowRedaction(inv({}), undefined, data)).toBe(data);
        expect(applyRowRedaction(inv({}), [], data)).toBe(data);
    });

    it('keeps a row whose permission is granted and drops one that is not', () => {
        const out = applyRowRedaction(
            inv({ risks: { view: true } }),
            rowsRule,
            { rows: [{ need: 'risks.view' }, { need: 'controls.view' }] },
        ) as { rows: Array<{ need: string }> };

        expect(out.rows.map((r) => r.need)).toEqual(['risks.view']);
    });

    it('KEEPS a row whose key is null — a row with no key is not permission-controlled', () => {
        // `key === null || granted(key)`. Reading the null arm as "drop" would
        // silently empty every payload whose rows are not all keyed.
        const out = applyRowRedaction(
            inv({}),
            rowsRule,
            { rows: [{ need: null }, { other: 'no need field' }] },
        ) as { rows: unknown[] };

        expect(out.rows).toHaveLength(2);
    });

    it('treats an absent permission DOMAIN as not granted', () => {
        // `perms[domain]?.[action]`. Without the optional chain this throws on a
        // domain the role has never heard of — a 500 instead of a redaction.
        const out = applyRowRedaction(
            inv({ risks: { view: true } }),
            rowsRule,
            { rows: [{ need: 'nosuchdomain.view' }] },
        ) as { rows: unknown[] };

        expect(out.rows).toEqual([]);
    });

    it('requires exactly `true` — a truthy value is not a grant', () => {
        // `=== true` rather than a truthiness test. A permission set carrying
        // `1`, `"yes"` or `{}` for an action must not grant it: those are the
        // shapes a mis-serialised or partially-migrated permission row takes,
        // and they must fail CLOSED.
        for (const truthy of [1, 'yes', {}, [], 'true'] as unknown[]) {
            const out = applyRowRedaction(
                inv({ risks: { view: truthy } } as unknown as Record<string, Record<string, boolean>>),
                rowsRule,
                { rows: [{ need: 'risks.view' }] },
            ) as { rows: unknown[] };
            expect(out.rows).toEqual([]);
        }
        // And the positive control, so the loop above is not passing because
        // the redactor drops everything.
        const granted = applyRowRedaction(
            inv({ risks: { view: true } }),
            rowsRule,
            { rows: [{ need: 'risks.view' }] },
        ) as { rows: unknown[] };
        expect(granted.rows).toHaveLength(1);
    });

    it('filters nothing when the declared path is not an array', () => {
        // The documented degradation: "a payload shape change degrades to
        // 'filters nothing extra' rather than throwing mid-response".
        const out = applyRowRedaction(
            inv({}),
            rowsRule,
            { rows: { not: 'an array' } },
        ) as { rows: unknown };

        expect(out.rows).toEqual({ not: 'an array' });
    });

    it('filters nothing when the path walks through a non-object', () => {
        // The inner loop's guard. `a.b.rows` where `a.b` is a string must not
        // index into it and must not throw.
        const rule = [{ path: 'a.b.rows', keyOf: () => 'risks.view' }];
        expect(() => applyRowRedaction(inv({}), rule, { a: { b: 'a string' } })).not.toThrow();
        expect(() => applyRowRedaction(inv({}), rule, { a: null })).not.toThrow();
        expect(() => applyRowRedaction(inv({}), rule, {})).not.toThrow();
    });

    it('filters a NESTED path', () => {
        // The positive control for the walk — without it, the three guards above
        // are satisfied by an implementation that never descends at all.
        const rule = [
            {
                path: 'a.b.rows',
                keyOf: (row: unknown) => (row as { need: string }).need,
            },
        ];
        const out = applyRowRedaction(
            inv({ risks: { view: true } }),
            rule,
            { a: { b: { rows: [{ need: 'risks.view' }, { need: 'secrets.view' }] } } },
        ) as { a: { b: { rows: Array<{ need: string }> } } };

        expect(out.a.b.rows.map((r) => r.need)).toEqual(['risks.view']);
    });

    it('does not mutate its input', () => {
        // The composition property the docstring names: it takes
        // `applyRedaction`'s OUTPUT and clones again "rather than mutating a
        // shared object, so a tool can declare both without either pass
        // depending on whether the other ran".
        const data = { rows: [{ need: 'risks.view' }, { need: 'secrets.view' }] };
        const before = JSON.stringify(data);

        applyRowRedaction(inv({ risks: { view: true } }), rowsRule, data);

        expect(JSON.stringify(data)).toBe(before);
    });

    it('survives a null or undefined payload', () => {
        // `data ?? null` before the clone. `JSON.stringify(undefined)` is
        // `undefined`, which `JSON.parse` throws on — so the fallback is what
        // keeps a tool returning nothing from becoming a 500.
        expect(() => applyRowRedaction(inv({}), rowsRule, undefined)).not.toThrow();
        expect(applyRowRedaction(inv({}), rowsRule, undefined)).toBeNull();
        expect(applyRowRedaction(inv({}), rowsRule, null)).toBeNull();
    });
});

/**
 * SECTION REDACTION, AND THE MARKER THAT SAYS IT HAPPENED (#3617).
 *
 * `applyRedaction` is the sibling pass — it removes whole SECTIONS of a payload
 * whose domain the caller cannot see, where `applyRowRedaction` removes
 * individual rows. It had no test either.
 *
 * Its most consequential line is not the deletion but the `redactedDomains`
 * marker, and the docstring says why: "without it a redacted payload is
 * indistinguishable from a tenant that has no risks, and an agent reasoning
 * over the difference would draw the opposite conclusion from the right one."
 * An agent told there are no risks behaves very differently from one told it
 * was not allowed to look.
 */
describe('applyRedaction — strip the sections, and say so', () => {
    const rules = [{ key: 'risks.view', paths: ['riskCounts', 'nested.riskDetail'] }];

    it('returns the data untouched when there are no rules', () => {
        const data = { riskCounts: 3 };
        expect(applyRedaction(inv({}), undefined, data)).toBe(data);
        expect(applyRedaction(inv({}), [], data)).toBe(data);
    });

    it('returns the data untouched — and unmarked — when every domain is granted', () => {
        // The SAME object: a fully-permitted call must not pay for a clone, and
        // must not carry a marker claiming something was removed.
        const data = { riskCounts: 3 };
        const out = applyRedaction(inv({ risks: { view: true } }), rules, data);
        expect(out).toBe(data);
        expect(out).not.toHaveProperty('redactedDomains');
    });

    it('deletes the declared paths and NAMES what it removed', () => {
        const out = applyRedaction(
            inv({}),
            rules,
            { riskCounts: 3, nested: { riskDetail: 'x', keep: 'y' }, other: 1 },
        ) as Record<string, unknown>;

        expect(out).not.toHaveProperty('riskCounts');
        expect(out.nested).toEqual({ keep: 'y' });
        expect(out.other).toBe(1);
        // The marker, which is the difference between "no risks" and "not
        // allowed to see risks".
        expect(out.redactedDomains).toEqual(['risks.view']);
    });

    it('does NOT attach the marker to an array payload', () => {
        // The documented guard: "spreading an array into an object literal turns
        // it into `{0: …, 1: …}` and silently breaks every consumer". The array
        // comes back an array, marker or no marker.
        const out = applyRedaction(inv({}), [{ key: 'risks.view', paths: ['x'] }], [1, 2, 3]);
        expect(Array.isArray(out)).toBe(true);
        expect(out).toEqual([1, 2, 3]);
    });

    it('requires exactly `true` to skip redaction', () => {
        // `!== true`, so a truthy non-true permission redacts rather than
        // admits — failing CLOSED, the opposite direction to a row key.
        const out = applyRedaction(
            inv({ risks: { view: 1 } } as unknown as Record<string, Record<string, boolean>>),
            rules,
            { riskCounts: 3 },
        ) as Record<string, unknown>;
        expect(out).not.toHaveProperty('riskCounts');
        expect(out.redactedDomains).toEqual(['risks.view']);
    });

    it('redacts nothing extra when a declared path is absent', () => {
        // The documented degradation. A payload that changed shape must not
        // throw mid-response.
        const out = applyRedaction(
            inv({}),
            [{ key: 'risks.view', paths: ['gone', 'also.gone.deeper'] }],
            { kept: 1 },
        ) as Record<string, unknown>;
        expect(out.kept).toBe(1);
        expect(out.redactedDomains).toEqual(['risks.view']);
    });

    it('names EVERY missing domain, not just the first', () => {
        // An agent acting on a partial answer needs the whole list; one name
        // would understate what it cannot see.
        const out = applyRedaction(
            inv({ risks: { view: true } }),
            [
                { key: 'risks.view', paths: ['a'] },
                { key: 'controls.view', paths: ['b'] },
                { key: 'vendors.view', paths: ['c'] },
            ],
            { a: 1, b: 2, c: 3 },
        ) as Record<string, unknown>;

        expect(out.redactedDomains).toEqual(['controls.view', 'vendors.view']);
        // The granted one survives.
        expect(out.a).toBe(1);
        expect(out).not.toHaveProperty('b');
    });

    it('survives a null payload', () => {
        expect(() => applyRedaction(inv({}), rules, null)).not.toThrow();
        expect(applyRedaction(inv({}), rules, null)).toBeNull();
        expect(applyRedaction(inv({}), rules, undefined)).toBeNull();
    });

    it('does not mutate its input', () => {
        const data = { riskCounts: 3, nested: { riskDetail: 'x' } };
        const before = JSON.stringify(data);
        applyRedaction(inv({}), rules, data);
        expect(JSON.stringify(data)).toBe(before);
    });
});
