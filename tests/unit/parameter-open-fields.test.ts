/**
 * BOUNDED TEMPLATES: the wire shape, the save-time refusal, and the digest.
 *
 * `parameter-constraints.ts` (#3094) already proves the WIDTH rules — a pattern
 * admitting arbitrary content, an unanchored one, an unbounded range. Nothing
 * here re-proves them. What is proved here is the layer above:
 *
 *   · an `openFields` blob is accepted only in the exact shape the vocabulary
 *     names, and ABSENT is distinguished from UNREADABLE (the tool boundary's
 *     fail-closed decision depends on telling them apart);
 *   · the per-template refusal carries the per-field refusal's OWN message, so
 *     an operator is told what to write instead;
 *   · an open field may not shadow an approved exact value, because the merge
 *     order means it would silently replace it;
 *   · a template may not be CREATED — a baseline has no reviewed moment;
 *   · the digest covers the bounds, and is byte-identical to the pre-#3051 one
 *     when there are none.
 *
 * The four-eyes COUNT is not here and cannot be: it is a trigger, asserted in
 * `tests/integration/external-tool-parameter-approval.test.ts`.
 */
const mockTx = {
    externalToolParameterSet: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
    },
    externalToolParameterSetApproval: { create: jest.fn(), findMany: jest.fn() },
};
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockTx)),
}));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn(async () => undefined) }));

import {
    MAX_OPEN_FIELDS,
    jsonSchemaForConstraint,
    parseOpenFields,
    refusalForOpenFields,
    sameConstraint,
    type OpenFields,
} from '@/lib/integrations/open-fields';
import { MAX_VALUE_LENGTH, type ValueConstraint } from '@/lib/integrations/parameter-constraints';
import {
    hashParameterSet,
    hashParameters,
    proposeParameterChange,
    saveParameterSet,
} from '@/app-layer/usecases/external-tool-parameters';
import { externalToolName } from '@/lib/mcp/external-tool-name';
import { makeRequestContext } from '../helpers/make-context';

const TOOL = externalToolName('cmconnaaa', 'update_user');
const ctx = makeRequestContext('OWNER');

/** A bound `refusalForConstraint` accepts — the control for every refusal below. */
const NARROW: ValueConstraint = {
    kind: 'regex',
    pattern: '^[a-z.]{1,64}@company\\.test$',
};

beforeEach(() => {
    jest.clearAllMocks();
});

describe('the wire shape', () => {
    it('accepts one constraint per field', () => {
        const parsed = parseOpenFields({ workEmail: NARROW });
        expect(parsed).toEqual({ state: 'ok', fields: { workEmail: NARROW } });
    });

    it('distinguishes ABSENT from UNREADABLE', () => {
        // The whole reason this returns a discriminated result. `absent` is the
        // degenerate template every pre-#3051 row is and dispatches normally;
        // `unreadable` must make the set undispatchable. A nullable return
        // would collapse them and the tool boundary would widen on corruption.
        expect(parseOpenFields(null)).toEqual({ state: 'absent' });
        expect(parseOpenFields(undefined)).toEqual({ state: 'absent' });
        expect(parseOpenFields({ workEmail: { kind: 'regex' } }).state).toBe('unreadable');
        expect(parseOpenFields('not an object').state).toBe('unreadable');
        expect(parseOpenFields([NARROW]).state).toBe('unreadable');
    });

    it('refuses an unknown key INSIDE a constraint rather than dropping it', () => {
        // `{kind:'regex', pattern:'^a$', flags:'i'}` silently losing `flags`
        // would be approved as case-sensitive and stored as something else.
        expect(
            parseOpenFields({ workEmail: { kind: 'regex', pattern: '^a$', flags: 'i' } }).state,
        ).toBe('unreadable');
    });

    it('refuses an unknown constraint kind', () => {
        expect(parseOpenFields({ n: { kind: 'glob', pattern: '*' } }).state).toBe('unreadable');
    });

    it('refuses an empty object, a reserved name, a shape-breaking name, and too many fields', () => {
        expect(parseOpenFields({}).state).toBe('unreadable');
        expect(parseOpenFields({ parameterSet: NARROW }).state).toBe('unreadable');
        expect(parseOpenFields({ __proto__: NARROW }).state).toBe('unreadable');
        expect(parseOpenFields({ 'has space': NARROW }).state).toBe('unreadable');
        const tooMany: Record<string, ValueConstraint> = {};
        for (let i = 0; i <= MAX_OPEN_FIELDS; i++) tooMany[`f${i}`] = NARROW;
        expect(Object.keys(tooMany)).toHaveLength(MAX_OPEN_FIELDS + 1);
        expect(parseOpenFields(tooMany).state).toBe('unreadable');
        // The control: exactly at the cap is accepted, so the refusal above is
        // about the count and not about the fixture.
        delete tooMany[`f${MAX_OPEN_FIELDS}`];
        expect(parseOpenFields(tooMany).state).toBe('ok');
    });
});

describe('the per-template refusal', () => {
    it('carries the per-field refusal, named by its field', () => {
        const refusal = refusalForOpenFields({ workEmail: { kind: 'regex', pattern: '^.*$' } }, []);
        expect(refusal?.code).toMatch(/^constraint_pattern_/);
        expect(refusal?.detail).toContain('Open field "workEmail"');
    });

    it('accepts a narrow bound — the control', () => {
        expect(refusalForOpenFields({ workEmail: NARROW }, ['userId'])).toBeNull();
    });

    it('refuses an open field that shadows an approved exact value', () => {
        // The merge is approved-then-open, so this field would REPLACE the
        // value a human typed while that value still read as being in force.
        const refusal = refusalForOpenFields({ workEmail: NARROW }, ['workEmail', 'userId']);
        expect(refusal?.code).toBe('open_field_shadows_approved_value');
    });
});

describe('the JSON Schema projection', () => {
    it('carries a bound the model can act on, per kind', () => {
        expect(jsonSchemaForConstraint(NARROW)).toEqual({
            type: 'string',
            pattern: NARROW.kind === 'regex' ? NARROW.pattern : '',
            maxLength: MAX_VALUE_LENGTH,
        });
        expect(jsonSchemaForConstraint({ kind: 'enum', values: ['a', 'b'] })).toEqual({
            type: 'string',
            enum: ['a', 'b'],
        });
        expect(jsonSchemaForConstraint({ kind: 'integer', min: 1, max: 9 })).toEqual({
            type: 'integer',
            minimum: 1,
            maximum: 9,
        });
        expect(jsonSchemaForConstraint({ kind: 'length', min: 3, max: 10 })).toEqual({
            type: 'string',
            minLength: 3,
            maxLength: 10,
        });
    });
});

describe('sameConstraint', () => {
    it('separates identical bounds from merely same-kind ones', () => {
        expect(sameConstraint(NARROW, { ...NARROW })).toBe(true);
        expect(sameConstraint(NARROW, { kind: 'regex', pattern: '^b$' })).toBe(false);
        expect(sameConstraint({ kind: 'enum', values: ['a'] }, { kind: 'enum', values: ['a'] })).toBe(
            true,
        );
        expect(sameConstraint({ kind: 'enum', values: ['a'] }, { kind: 'enum', values: ['b'] })).toBe(
            false,
        );
        expect(
            sameConstraint({ kind: 'integer', min: 1, max: 2 }, { kind: 'integer', min: 1, max: 3 }),
        ).toBe(false);
        expect(sameConstraint({ kind: 'length', min: 1, max: 2 }, { kind: 'integer', min: 1, max: 2 })).toBe(
            false,
        );
    });
});

describe('the digest', () => {
    const params = { userId: '7', department: 'ops' };

    it('is byte-identical to the pre-#3051 one when nothing is open', () => {
        // Every row written before this change still matches its stored
        // `parametersHash`, so the "already in force" check keeps working and
        // nothing needs backfilling.
        expect(hashParameterSet(params, null)).toBe(hashParameters(params));
        expect(hashParameterSet(params, undefined)).toBe(hashParameters(params));
    });

    it('MOVES when only a bound changes', () => {
        // The discriminator. With the bounds outside the digest, an edit that
        // changed only a pattern would hash identically to what is in force —
        // so `proposeParameterChange` would reject it as a no-op, and an
        // approver naming a hash would not be naming the constraints.
        const a = hashParameterSet(params, { workEmail: NARROW });
        const b = hashParameterSet(params, {
            workEmail: { kind: 'regex', pattern: '^[a-z.]{1,64}@other\\.test$' },
        });
        expect(a).not.toBe(b);
        expect(a).not.toBe(hashParameters(params));
    });

    it('cannot be forged by an exact-value set shaped like a template', () => {
        // The domain tag is a PREFIX, not a wrapper key, because any wrapper
        // key is one a tool could genuinely advertise.
        const impostor = { parameters: params, openFields: { workEmail: NARROW } };
        expect(hashParameterSet(impostor, null)).not.toBe(
            hashParameterSet(params, { workEmail: NARROW }),
        );
    });
});

describe('saveParameterSet — a baseline may not be a template', () => {
    it('refuses open fields on a first save, naming why', () => {
        return expect(
            saveParameterSet(ctx, {
                toolName: TOOL,
                label: 'ops',
                parameters: { userId: '7' },
                openFields: { workEmail: NARROW },
            }),
        ).rejects.toThrow(/trust-on-first-use|open fields/i);
    });

    it('still saves an exact-value baseline — the control', async () => {
        mockTx.externalToolParameterSet.findUnique.mockResolvedValue(null);
        mockTx.externalToolParameterSet.create.mockResolvedValue({
            id: 'set_1',
            toolName: TOOL,
            label: 'ops',
            parameters: { userId: '7' },
            parametersHash: 'h',
            openFields: null,
            revision: 1,
            approvalSource: 'BASELINE',
            approvedByUserId: null,
            approvedAt: new Date(),
            pendingParameters: null,
            pendingOpenFields: null,
            pendingHash: null,
            pendingByUserId: null,
            pendingAt: null,
        });
        const saved = await saveParameterSet(ctx, {
            toolName: TOOL,
            label: 'ops',
            parameters: { userId: '7' },
        });
        expect(saved.openFields).toBeNull();
        expect(mockTx.externalToolParameterSet.create).toHaveBeenCalledTimes(1);
    });
});

describe('proposeParameterChange — the bounds are checked at save time', () => {
    const existing = (openFields: unknown) => {
        mockTx.externalToolParameterSet.findFirst.mockResolvedValue({
            id: 'set_1',
            toolName: TOOL,
            label: 'ops',
            parametersHash: 'in-force-hash',
            openFields,
        });
    };
    const updated = (over: Record<string, unknown> = {}) => {
        mockTx.externalToolParameterSet.update.mockResolvedValue({
            id: 'set_1',
            toolName: TOOL,
            label: 'ops',
            parameters: { userId: '7' },
            parametersHash: 'in-force-hash',
            openFields: null,
            revision: 1,
            approvalSource: 'BASELINE',
            approvedByUserId: null,
            approvedAt: new Date(),
            pendingParameters: { userId: '7' },
            pendingOpenFields: null,
            pendingHash: 'pending-hash',
            pendingByUserId: 'user-1',
            pendingAt: new Date(),
            ...over,
        });
    };

    it('refuses a bound `refusalForConstraint` refuses, with its own message', async () => {
        existing(null);
        await expect(
            proposeParameterChange(ctx, {
                id: 'set_1',
                parameters: { userId: '7' },
                openFields: { workEmail: { kind: 'regex', pattern: '@company\\.test' } },
            }),
        ).rejects.toThrow(/constraint_pattern_unanchored/);
        expect(mockTx.externalToolParameterSet.update).not.toHaveBeenCalled();
    });

    it('accepts the narrow equivalent — the control', async () => {
        existing(null);
        updated({ pendingOpenFields: { workEmail: NARROW } });
        const after = await proposeParameterChange(ctx, {
            id: 'set_1',
            parameters: { userId: '7' },
            openFields: { workEmail: NARROW },
        });
        expect(after.pending?.openFields).toEqual({ workEmail: NARROW });
        // ONE signature, from a human other than the proposer — reported by the
        // usecase, enforced by the trigger. Two counted signatures plus the
        // exclusion would have meant three people and locked out a two-admin
        // tenant (owner ruling, 2026-10-02).
        expect(after.pending?.requiredApprovals).toBe(1);
    });

    it('CARRIES FORWARD the existing bounds when the key is omitted', async () => {
        // The trap this default exists for: the promotion trigger requires the
        // open fields coming into force to be exactly what was pending, so
        // treating an absent key as "none" would strip a template's bounds
        // whenever somebody edited only its exact values.
        existing({ workEmail: NARROW });
        updated({ openFields: { workEmail: NARROW }, pendingOpenFields: { workEmail: NARROW } });
        await proposeParameterChange(ctx, { id: 'set_1', parameters: { userId: '8' } });
        const data = mockTx.externalToolParameterSet.update.mock.calls[0][0].data;
        expect(data.pendingOpenFields).toEqual({ workEmail: NARROW });
    });

    it('removes them only when `openFields: null` is explicit', async () => {
        existing({ workEmail: NARROW });
        updated({ openFields: { workEmail: NARROW }, pendingOpenFields: null });
        await proposeParameterChange(ctx, {
            id: 'set_1',
            parameters: { userId: '8' },
            openFields: null,
        });
        const data = mockTx.externalToolParameterSet.update.mock.calls[0][0].data;
        // `Prisma.DbNull`, never `undefined` — on a nullable Json column
        // `undefined` means "leave it alone", so the bounds would survive their
        // own removal.
        expect(data.pendingOpenFields).not.toBeUndefined();
        expect(String(data.pendingOpenFields)).toMatch(/DbNull/i);
    });

    it('refuses an open field that shadows an approved exact value', async () => {
        existing(null);
        await expect(
            proposeParameterChange(ctx, {
                id: 'set_1',
                parameters: { workEmail: 'fixed@company.test' },
                openFields: { workEmail: NARROW },
            }),
        ).rejects.toThrow(/open_field_shadows_approved_value/);
    });

    it('audits the field NAMES and never the bounds', async () => {
        existing(null);
        updated({ pendingOpenFields: { workEmail: NARROW } });
        const { logEvent } = jest.requireMock('@/app-layer/events/audit') as {
            logEvent: jest.Mock;
        };
        await proposeParameterChange(ctx, {
            id: 'set_1',
            parameters: { userId: '7' },
            openFields: { workEmail: NARROW },
        });
        const details = logEvent.mock.calls[0][2].detailsJson;
        expect(details.openFieldNames).toEqual(['workEmail']);
        // A pattern can name hosts and filters a tenant considers sensitive,
        // and the audit trail streams to a SIEM.
        expect(JSON.stringify(details)).not.toContain('company\\\\.test');
        expect(JSON.stringify(details)).not.toContain('kind');
    });
});

describe('typing — the fields map is the vocabulary', () => {
    it('is a Record of ValueConstraint and nothing wider', () => {
        const fields: OpenFields = { workEmail: NARROW };
        expect(Object.values(fields).every((c) => typeof c.kind === 'string')).toBe(true);
    });
});
