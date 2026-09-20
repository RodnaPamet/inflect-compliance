/**
 * #2674 — the per-direction `writesEnabled` split, and the thing it must not do.
 *
 * WHAT IS ACTUALLY BEING PROTECTED
 * ────────────────────────────────
 * Not "there are two flags". A gate that read ONE flag and merely PRINTED the
 * direction in its refusal would satisfy every happy-path test, would look
 * right in review, and would leave the joiner riding the leaver's grant — the
 * exact state #2674 exists to end. So the load-bearing assertions here are the
 * CROSS ones: consent to one direction must leave the OTHER refused, in both
 * orders, over the whole `IdentityDirection` population rather than one sample.
 *
 * WHY THE LEAVER ARM GOES THROUGH `createEntraIdWriter` AND THE JOINER ARM
 * DOES NOT
 * ────────────────────────────────────────────────────────────────────────
 * The leaver's call site is real: `EntraIdDirectoryWriter`'s constructor asks
 * the gate for `'leaver'`, so mutating that argument reddens these tests plus
 * most of `entra-id-directory-writer.test.ts`.
 *
 * The joiner has NO production call site today, and that is a fact about the
 * product rather than a gap in this file: `DirectoryWriter` declares no create
 * verb, `JOINER_MAX_MODE` is `DRY_RUN`, nothing dispatches the joiner planner,
 * and the live arm waits on #2608. The gate is where the create verb will ask,
 * and it is exercised here directly. When that verb lands, its own call site
 * must pass `'joiner'` — a default was deliberately NOT given, so forgetting
 * the argument is a type error rather than an inherited grant.
 *
 * THE STORED-CONFIG DECISION THIS FILE PINS
 * ─────────────────────────────────────────
 * A connection holding only the legacy `writesEnabled: true` grants the LEAVER
 * direction and nothing else. That is the narrow reading, argued in
 * `write-direction.ts`; it is asserted here so widening it later is a diff that
 * turns this file red rather than a silent retroactive grant of create
 * authority to every tenant that ever ticked "Allow offboarding writes".
 */
import { createEntraIdWriter } from '@/app-layer/integrations/providers/entra-id/writer';
import {
    describeStoredWriteFlag,
    directionWriteRefusal,
    ENTRA_JOINER_WRITES_FIELD,
    ENTRA_LEAVER_WRITES_FIELD,
    ENTRA_WRITE_FLAG_FIELD,
    isWritesNotEnabledRefusal,
    readDirectionWritesEnabled,
} from '@/app-layer/integrations/providers/entra-id/write-direction';
import { EntraIdProvider } from '@/app-layer/integrations/providers/entra-id';
import type { IdentityDirection } from '@/lib/identity/write-ladder';

/** Both members, written out so the denominator is visible in every loop below. */
const DIRECTIONS: readonly IdentityDirection[] = ['leaver', 'joiner'];

const CREDENTIALS = {
    tenantId: '11111111-1111-1111-1111-111111111111',
    clientId: '22222222-2222-2222-2222-222222222222',
    clientSecret: 'secret-value',
};

/**
 * A transport the constructor never reaches. Every assertion in this file is
 * about a decision made BEFORE a socket could be opened, and a fetch that
 * throws on use proves that rather than assuming it.
 */
const noFetch = (() => {
    throw new Error('the write-direction gate must decide without contacting Graph');
}) as unknown as typeof fetch;

function constructLeaverWriter(config: Record<string, unknown>): Error | null {
    try {
        createEntraIdWriter({ ...CREDENTIALS, ...config }, { fetchImpl: noFetch });
        return null;
    } catch (e) {
        return e as Error;
    }
}

describe('#2674 — the two directions are two separate grants', () => {
    it('each direction reads its OWN field, and the two fields are distinct', () => {
        // The denominator is the whole union, not a sample: a third direction
        // added without its own field would leave this length check red.
        const fields = DIRECTIONS.map((d) => ENTRA_WRITE_FLAG_FIELD[d]);
        expect(fields).toEqual([ENTRA_LEAVER_WRITES_FIELD, ENTRA_JOINER_WRITES_FIELD]);
        expect(new Set(fields).size).toBe(DIRECTIONS.length);
        expect(ENTRA_LEAVER_WRITES_FIELD).not.toBe(ENTRA_JOINER_WRITES_FIELD);
    });

    it.each(DIRECTIONS)(
        'consent to %s does NOT grant the other direction',
        (granted) => {
            const other = DIRECTIONS.find((d) => d !== granted);
            if (!other) throw new Error('expected a second direction');

            const config = { [ENTRA_WRITE_FLAG_FIELD[granted]]: true };

            // The positive control, in the same assertion block: if the granted
            // direction did not pass, the refusal below would prove nothing —
            // a gate that refuses everything separates nothing.
            expect(readDirectionWritesEnabled(config, granted)).toBe(true);
            expect(directionWriteRefusal(config, granted)).toBeNull();

            // The load-bearing half.
            expect(readDirectionWritesEnabled(config, other)).toBe(false);
            expect(directionWriteRefusal(config, other)).not.toBeNull();
        },
    );

    it('a joiner-only connection still refuses a LEAVER write at the writer itself', () => {
        // The cross case at the real call site rather than at the helper: a
        // writer built from a connection consented only for joiner writes must
        // refuse, or the split is decorative.
        const err = constructLeaverWriter({ [ENTRA_JOINER_WRITES_FIELD]: true });
        expect(err).toBeInstanceOf(Error);
        expect(err?.message).toMatch(/leaver/);
    });

    it('a leaver-consented connection constructs a writer — the positive control', () => {
        expect(constructLeaverWriter({ [ENTRA_LEAVER_WRITES_FIELD]: true })).toBeNull();
    });
});

describe('#2674 — what an existing writesEnabled: true means, decided narrowly', () => {
    it('grants the leaver direction', () => {
        expect(readDirectionWritesEnabled({ writesEnabled: true }, 'leaver')).toBe(true);
    });

    it('does NOT grant the joiner direction', () => {
        // The security statement. Every connection already storing this flag
        // ticked a box labelled "Allow offboarding writes", whose description
        // says it lets leaver offboarding DISABLE accounts. Reading it as
        // covering creates would grant an authority the checkbox never
        // described — and `WRITE_ROLES` means the credential itself cannot
        // re-impose the separation.
        expect(readDirectionWritesEnabled({ writesEnabled: true }, 'joiner')).toBe(false);
        expect(directionWriteRefusal({ writesEnabled: true }, 'joiner')).not.toBeNull();
    });

    it('is read STRICTLY — a truthy-looking value is not a grant, in either direction', () => {
        const notGrants: readonly unknown[] = ['true', 'yes', 'on', '1', 1, {}, [], 'TRUE'];
        for (const direction of DIRECTIONS) {
            const field = ENTRA_WRITE_FLAG_FIELD[direction];
            const results = notGrants.map((v) =>
                readDirectionWritesEnabled({ [field]: v }, direction),
            );
            // One assertion carrying its own denominator: 8 values per
            // direction, none of which may read as consent.
            expect(results).toEqual(notGrants.map(() => false));
        }
    });
});

describe('#2674 — the refusal names the direction and stays classifiable', () => {
    it.each(DIRECTIONS)('names %s, and says the other is a separate opt-in', (direction) => {
        const refusal = directionWriteRefusal({}, direction);
        expect(refusal).not.toBeNull();
        expect(refusal).toContain(direction);
        expect(refusal).toContain(ENTRA_WRITE_FLAG_FIELD[direction === 'leaver' ? 'joiner' : 'leaver']);
        expect(refusal).toContain('separate opt-in');
    });

    it.each(DIRECTIONS)(
        'stays recognisable to the writer factory as the deliberate opt-out (%s)',
        (direction) => {
            const refusal = directionWriteRefusal({}, direction);
            // The factory turns this into WRITES_NOT_ENABLED rather than
            // WRITER_REFUSED. Adding the direction to the sentence is exactly
            // the edit that used to be able to break that classification,
            // because the matcher was an independent regex in another file.
            expect(isWritesNotEnabledRefusal(refusal ?? '')).toBe(true);
        },
    );

    it('a misconfiguration is NOT classified as the opt-out — the negative control', () => {
        // Without this, the assertion above would also pass for a predicate
        // that returned true unconditionally.
        expect(isWritesNotEnabledRefusal('Entra writer needs a Directory (tenant) ID')).toBe(false);
    });

    it('the leaver refusal reaching an operator through the writer names its switch', () => {
        const err = constructLeaverWriter({});
        expect(err?.message).toMatch(/Allow offboarding writes/);
        expect(err?.message).toMatch(/User.EnableDisableAccount.All/);
    });

    it('the joiner refusal says the switch does not exist yet, rather than pointing at one', () => {
        // An operator told to "turn on joiner writes" would go looking for a
        // control that is deliberately not on the form. The refusal has to say
        // that instead, or it sends them hunting.
        const refusal = directionWriteRefusal({}, 'joiner') ?? '';
        expect(refusal).toContain('no switch for this direction');
        expect(refusal).toContain(ENTRA_JOINER_WRITES_FIELD);
    });
});

describe('#2674 — the stored-value diagnostic follows the field it is about', () => {
    it.each(DIRECTIONS)('names the %s field when the stored value merely looks true', (direction) => {
        const sentence = describeStoredWriteFlag(direction, 'true');
        expect(sentence).toContain(ENTRA_WRITE_FLAG_FIELD[direction]);
        expect(sentence).toContain('string-coercing helper');
    });

    it.each(DIRECTIONS)('says nothing extra when the %s flag is simply absent', (direction) => {
        // The common case. A paragraph about string coercion would be noise on
        // every connection that never opted in.
        expect(describeStoredWriteFlag(direction, undefined)).toBe('');
        expect(describeStoredWriteFlag(direction, null)).toBe('');
        expect(describeStoredWriteFlag(direction, false)).toBe('');
    });

    it('distinguishes a value that looks affirmative from one that plainly does not', () => {
        expect(describeStoredWriteFlag('leaver', 'true')).toContain('reads as ON in the admin UI');
        expect(describeStoredWriteFlag('leaver', {})).toContain('is not an opt-in');
        expect(describeStoredWriteFlag('leaver', {})).not.toContain('reads as ON in the admin UI');
    });
});

describe('#2674 — the joiner field is NOT on the connection form, and that is pinned', () => {
    const configFieldKeys = (): readonly string[] =>
        new EntraIdProvider().configSchema.configFields.map((f) => f.key);

    it('declares the leaver opt-in — the positive control for this scan', () => {
        // Without it, the absence below could just mean the read returned an
        // empty list.
        expect(configFieldKeys()).toContain(ENTRA_LEAVER_WRITES_FIELD);
    });

    it('does NOT declare the joiner opt-in', () => {
        // Deliberate, per `write-direction.ts`: a checkbox is a question put to
        // a customer, and there is no create verb behind this direction yet. A
        // box ticked today would authorise nothing today and would ALREADY be
        // ticked on the day it gains meaning. It arrives in the diff that ships
        // the create verb — which is this assertion going red, on purpose.
        expect(configFieldKeys()).not.toContain(ENTRA_JOINER_WRITES_FIELD);
    });
});
