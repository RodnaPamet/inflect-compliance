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
    declaresTargetField,
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
        const parsed = parseOpenFields({ workEmail: NARROW }, null);
        expect(parsed).toEqual({ state: 'ok', fields: { workEmail: NARROW } });
    });

    it('distinguishes ABSENT from UNREADABLE', () => {
        // The whole reason this returns a discriminated result. `absent` is the
        // degenerate template every pre-#3051 row is and dispatches normally;
        // `unreadable` must make the set undispatchable. A nullable return
        // would collapse them and the tool boundary would widen on corruption.
        expect(parseOpenFields(null, null)).toEqual({ state: 'absent' });
        expect(parseOpenFields(undefined, null)).toEqual({ state: 'absent' });
        expect(parseOpenFields({ workEmail: { kind: 'regex' } }, null).state).toBe('unreadable');
        expect(parseOpenFields('not an object', null).state).toBe('unreadable');
        expect(parseOpenFields([NARROW], null).state).toBe('unreadable');
    });

    it('refuses an unknown key INSIDE a constraint rather than dropping it', () => {
        // `{kind:'regex', pattern:'^a$', flags:'i'}` silently losing `flags`
        // would be approved as case-sensitive and stored as something else.
        expect(
            parseOpenFields({ workEmail: { kind: 'regex', pattern: '^a$', flags: 'i' } }, null).state,
        ).toBe('unreadable');
    });

    it('refuses an unknown constraint kind', () => {
        expect(parseOpenFields({ n: { kind: 'glob', pattern: '*' } }, null).state).toBe('unreadable');
    });

    it('refuses an empty object, a reserved name, a shape-breaking name, and too many fields', () => {
        expect(parseOpenFields({}, null).state).toBe('unreadable');
        expect(parseOpenFields({ parameterSet: NARROW }, null).state).toBe('unreadable');
        expect(parseOpenFields({ __proto__: NARROW }, null).state).toBe('unreadable');
        expect(parseOpenFields({ 'has space': NARROW }, null).state).toBe('unreadable');
        const tooMany: Record<string, ValueConstraint> = {};
        for (let i = 0; i <= MAX_OPEN_FIELDS; i++) tooMany[`f${i}`] = NARROW;
        expect(Object.keys(tooMany)).toHaveLength(MAX_OPEN_FIELDS + 1);
        expect(parseOpenFields(tooMany, null).state).toBe('unreadable');
        // The control: exactly at the cap is accepted, so the refusal above is
        // about the count and not about the fixture.
        delete tooMany[`f${MAX_OPEN_FIELDS}`];
        expect(parseOpenFields(tooMany, null).state).toBe('ok');
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

// ═════════════════════════════════════════════════════════════════════
// #3051 step 5c — THE TARGET FIELD AND ITS POPULATION
//
// A fifth openFields kind, `{"kind":"target"}`, marks the argument that names
// the ROW; the population that bounds it is the row's `targetPopulation`
// column. Two facts, each stored once, which is the whole reason these tests
// exist: the interesting failures are the two states where only ONE of them is
// present, and both must fail CLOSED.
//
// Every refusal below is paired with the case that must still be ACCEPTED, so a
// check that refuses everything cannot pass as a check that refuses the right
// thing.
// ═════════════════════════════════════════════════════════════════════

const TARGET_MARKER = { kind: 'target' } as const;
const POP = 'terminated_employee_work_emails';
const POP2 = 'terminated_employee_hris_record_ids';

describe('5c — the target marker in the wire shape', () => {
    it('accepts a marker, and HYDRATES it with the row population', () => {
        const parsed = parseOpenFields({ employeeEmail: TARGET_MARKER }, POP);
        // The stored shape carries no population; the parsed shape does. One
        // place holds both halves, so nothing downstream reaches back to the row
        // and risks reading a different one's column.
        expect(parsed).toEqual({
            state: 'ok',
            fields: { employeeEmail: { kind: 'target', population: POP } },
        });
    });

    it('accepts a target BESIDE a value field', () => {
        const parsed = parseOpenFields({ employeeEmail: TARGET_MARKER, workEmail: NARROW }, POP);
        expect(parsed.state).toBe('ok');
        expect(parsed.state === 'ok' && Object.keys(parsed.fields).sort()).toEqual([
            'employeeEmail',
            'workEmail',
        ]);
    });

    it('refuses a marker carrying its own population', () => {
        // `.strict()` matters most here: a marker that quietly dropped an extra
        // `population` key would read as bounded by the COLUMN while naming
        // something else — the one disagreement a reviewer could not see.
        expect(
            parseOpenFields({ employeeEmail: { kind: 'target', population: 'other' } }, POP).state,
        ).toBe('unreadable');
    });

    it('refuses TWO target fields, and accepts one — the control', () => {
        expect(parseOpenFields({ a: TARGET_MARKER, b: TARGET_MARKER }, POP).state).toBe(
            'unreadable',
        );
        expect(parseOpenFields({ a: TARGET_MARKER }, POP).state).toBe('ok');
    });

    it('counts the target against the MAX_OPEN_FIELDS review budget', () => {
        const atCap: Record<string, unknown> = { t: TARGET_MARKER };
        for (let i = 0; i < MAX_OPEN_FIELDS - 1; i++) atCap[`f${i}`] = NARROW;
        expect(Object.keys(atCap)).toHaveLength(MAX_OPEN_FIELDS);
        expect(parseOpenFields(atCap, POP).state).toBe('ok');
        atCap[`f${MAX_OPEN_FIELDS}`] = NARROW;
        expect(parseOpenFields(atCap, POP).state).toBe('unreadable');
    });
});

describe('5c — the two halves must agree, and disagreement is UNREADABLE', () => {
    it('refuses a marker with NO population — the dangerous direction', () => {
        // Nothing would bound which row the agent addresses. This is the state
        // step 5c exists to prevent, so it must not read as "absent".
        const parsed = parseOpenFields({ employeeEmail: TARGET_MARKER }, null);
        expect(parsed.state).toBe('unreadable');
        expect(parsed.state === 'unreadable' && parsed.detail).toContain('employeeEmail');
    });

    it('refuses a population with NO marker, even though it opens nothing', () => {
        // Harmless at dispatch — no field is opened — and still refused: the row
        // asserts something about a target its field list does not, so a
        // reviewer approved one of two readings and nobody knows which.
        expect(parseOpenFields({ workEmail: NARROW }, POP).state).toBe('unreadable');
    });

    it('refuses a population with NO open fields at all', () => {
        expect(parseOpenFields(null, POP).state).toBe('unreadable');
        // The control: no population and no fields is ABSENT, which is every row
        // written before #3051 and dispatches normally.
        expect(parseOpenFields(null, null)).toEqual({ state: 'absent' });
    });

    it('treats an empty-string population as no population', () => {
        // A `''` in the column could only come from outside the usecase, and
        // reading it as a population name would make the bound the empty string.
        expect(parseOpenFields({ employeeEmail: TARGET_MARKER }, '').state).toBe('unreadable');
    });
});

describe('5c — a target has no width to judge, but still cannot shadow a value', () => {
    it('accepts a target without asking refusalForConstraint about it', () => {
        // `refusalForConstraint`'s whole subject is how much a PATTERN admits. A
        // target admits whatever the population returns, which is not a property
        // of this row — so it is skipped rather than given a fifth arm.
        expect(
            refusalForOpenFields({ employeeEmail: { kind: 'target', population: POP } }, [
                'department',
            ]),
        ).toBeNull();
    });

    it('still refuses a target that shadows an approved exact value', () => {
        // The merge is approved-then-open, so this would REPLACE the row a human
        // named with whatever the agent chose — the widest possible version of
        // the shadow bug, and the reason the rule is not about patterns.
        const refusal = refusalForOpenFields(
            { employeeEmail: { kind: 'target', population: POP } },
            ['employeeEmail'],
        );
        expect(refusal?.code).toBe('open_field_shadows_approved_value');
    });

    it('still judges the width of a VALUE field sitting beside a target', () => {
        const refusal = refusalForOpenFields(
            {
                employeeEmail: { kind: 'target', population: POP },
                note: { kind: 'regex', pattern: '^.*$' },
            },
            [],
        );
        expect(refusal?.code).toMatch(/^constraint_pattern_/);
    });
});

describe('5c — the projection never enumerates the population', () => {
    it('advertises a bounded string and nothing about the members', () => {
        const schema = jsonSchemaForConstraint({ kind: 'target', population: POP });
        expect(schema).toEqual({ type: 'string', maxLength: MAX_VALUE_LENGTH });
        // An `enum` here would be a snapshot taken at assembly presented as the
        // live bound — a row that left the population mid-run would still look
        // addressable — and it would put tenant identifiers into a tool listing.
        expect(schema.enum).toBeUndefined();
        expect(JSON.stringify(schema)).not.toContain(POP);
    });
});

describe('5c — sameConstraint compares POPULATIONS, not just the kind', () => {
    it('separates two targets bounded by different populations', () => {
        expect(
            sameConstraint({ kind: 'target', population: POP }, { kind: 'target', population: POP }),
        ).toBe(true);
        // The population lives on the SET, so two sets can mark the same
        // argument as their target against different populations. Treating them
        // as one bound would advertise a bound half the labels do not have.
        expect(
            sameConstraint(
                { kind: 'target', population: POP },
                { kind: 'target', population: POP2 },
            ),
        ).toBe(false);
        expect(sameConstraint({ kind: 'target', population: POP }, NARROW)).toBe(false);
    });
});

describe('5c — declaresTargetField reads the STORED shape', () => {
    it('answers without a population, which is what propose-time needs', () => {
        expect(declaresTargetField({ employeeEmail: TARGET_MARKER })).toBe(true);
        expect(declaresTargetField({ workEmail: NARROW })).toBe(false);
        expect(declaresTargetField(null)).toBe(false);
        expect(declaresTargetField('nonsense')).toBe(false);
    });
});

describe('5c — the digest covers the population', () => {
    const params = { department: 'ops' };
    const open = { employeeEmail: TARGET_MARKER };

    it('MOVES when only the population changes', () => {
        // THE DISCRIMINATOR FOR THIS WHOLE STEP. Swapping the population leaves
        // the field list, the field names and the exact values identical, and it
        // is the widest change this table can express. Outside the digest it
        // would hash the same as what is in force — `proposeParameterChange`
        // would refuse it as a no-op, and a swap between the review and the
        // click would match the hash the approver named.
        const a = hashParameterSet(params, open, POP);
        const b = hashParameterSet(params, open, POP2);
        expect(a).not.toBe(b);
    });

    it('leaves the pre-5b and 5b digests byte-identical', () => {
        // Both older forms must be stable, because `proposeParameterChange`
        // compares a candidate against the STORED hash to refuse a no-op: a
        // change in how an existing row hashes makes every such row look edited.
        expect(hashParameterSet(params, null, null)).toBe(hashParameters(params));
        expect(hashParameterSet(params, null)).toBe(hashParameters(params));
        expect(hashParameterSet(params, { workEmail: NARROW }, null)).toBe(
            hashParameterSet(params, { workEmail: NARROW }),
        );
    });

    it('is not forgeable by an exact-value set shaped like a targeted template', () => {
        const impostor = { parameters: params, openFields: open, targetPopulation: POP };
        expect(hashParameterSet(impostor, null)).not.toBe(hashParameterSet(params, open, POP));
    });
});

describe('5c — saveParameterSet: a baseline may not carry a target', () => {
    it('refuses a target population on a first save, naming the target', async () => {
        await expect(
            saveParameterSet(ctx, {
                toolName: TOOL,
                label: 'ops',
                parameters: { department: 'ops' },
                targetPopulation: POP,
            }),
        ).rejects.toThrow(/target population/i);
        expect(mockTx.externalToolParameterSet.create).not.toHaveBeenCalled();
    });
});

describe('5c — proposeParameterChange', () => {
    const existingRow = (over: Record<string, unknown> = {}) => {
        mockTx.externalToolParameterSet.findFirst.mockResolvedValue({
            id: 'set_1',
            toolName: TOOL,
            label: 'ops',
            parametersHash: 'in-force-hash',
            openFields: null,
            targetPopulation: null,
            ...over,
        });
    };
    const updatedRow = (over: Record<string, unknown> = {}) => {
        mockTx.externalToolParameterSet.update.mockResolvedValue({
            id: 'set_1',
            toolName: TOOL,
            label: 'ops',
            parameters: { department: 'ops' },
            parametersHash: 'in-force-hash',
            openFields: null,
            targetPopulation: null,
            revision: 1,
            approvalSource: 'BASELINE',
            approvedByUserId: null,
            approvedAt: new Date(),
            pendingParameters: { department: 'ops' },
            pendingOpenFields: { employeeEmail: TARGET_MARKER },
            pendingTargetPopulation: POP,
            pendingHash: 'pending-hash',
            pendingByUserId: 'user-1',
            pendingAt: new Date(),
            ...over,
        });
    };

    it('refuses a population this build does not define, and lists the ones it does', async () => {
        existingRow();
        await expect(
            proposeParameterChange(ctx, {
                id: 'set_1',
                parameters: { department: 'ops' },
                openFields: { employeeEmail: TARGET_MARKER },
                targetPopulation: 'everyone_in_the_roster',
            }),
        ).rejects.toThrow(/external_target_population_unknown/);
        expect(mockTx.externalToolParameterSet.update).not.toHaveBeenCalled();
    });

    it('accepts a population it DOES define — the control', async () => {
        existingRow();
        updatedRow();
        const after = await proposeParameterChange(ctx, {
            id: 'set_1',
            parameters: { department: 'ops' },
            openFields: { employeeEmail: TARGET_MARKER },
            targetPopulation: POP,
        });
        expect(after.pending?.targetPopulation).toBe(POP);
        const data = mockTx.externalToolParameterSet.update.mock.calls[0][0].data;
        expect(data.pendingTargetPopulation).toBe(POP);
    });

    it('refuses a marker with no population', async () => {
        existingRow();
        await expect(
            proposeParameterChange(ctx, {
                id: 'set_1',
                parameters: { department: 'ops' },
                openFields: { employeeEmail: TARGET_MARKER },
            }),
        ).rejects.toThrow(/external_target_population_missing/);
        expect(mockTx.externalToolParameterSet.update).not.toHaveBeenCalled();
    });

    it('refuses a population with no marker', async () => {
        existingRow();
        await expect(
            proposeParameterChange(ctx, {
                id: 'set_1',
                parameters: { department: 'ops' },
                openFields: { workEmail: NARROW },
                targetPopulation: POP,
            }),
        ).rejects.toThrow(/external_target_field_missing/);
        expect(mockTx.externalToolParameterSet.update).not.toHaveBeenCalled();
    });

    it('CARRIES FORWARD the population when the key is omitted', async () => {
        // The same trap `openFields` has, and worse: reading absence as "no
        // target" would unbind a template's row-level bound whenever somebody
        // edited only its exact values — and the promotion trigger would accept
        // it, because dropping a bound is a NARROWING and needs only the
        // ordinary signature. A narrowing nobody intended is a change nobody
        // reviewed.
        existingRow({ openFields: { employeeEmail: TARGET_MARKER }, targetPopulation: POP });
        updatedRow({ openFields: { employeeEmail: TARGET_MARKER }, targetPopulation: POP });
        await proposeParameterChange(ctx, { id: 'set_1', parameters: { department: 'hr' } });
        const data = mockTx.externalToolParameterSet.update.mock.calls[0][0].data;
        expect(data.pendingTargetPopulation).toBe(POP);
        expect(data.pendingOpenFields).toEqual({ employeeEmail: TARGET_MARKER });
    });

    it('removes the target only when BOTH halves are explicitly cleared', async () => {
        existingRow({ openFields: { employeeEmail: TARGET_MARKER }, targetPopulation: POP });
        updatedRow({
            openFields: { employeeEmail: TARGET_MARKER },
            targetPopulation: POP,
            pendingOpenFields: null,
            pendingTargetPopulation: null,
        });
        await proposeParameterChange(ctx, {
            id: 'set_1',
            parameters: { department: 'hr' },
            openFields: null,
            targetPopulation: null,
        });
        const data = mockTx.externalToolParameterSet.update.mock.calls[0][0].data;
        expect(data.pendingTargetPopulation).toBeNull();
    });

    it('refuses clearing only ONE half', async () => {
        existingRow({ openFields: { employeeEmail: TARGET_MARKER }, targetPopulation: POP });
        await expect(
            proposeParameterChange(ctx, {
                id: 'set_1',
                parameters: { department: 'hr' },
                targetPopulation: null,
            }),
        ).rejects.toThrow(/external_target_population_missing/);
    });

    it('audits the population KEY in full, and still never the bounds', async () => {
        // A key is a code-defined identifier from a closed set in this
        // repository — it names no host, filter or tenant datum — and it is the
        // single most important fact an incident reviewer needs about a target
        // edit: WHICH rows this agent was pointed at.
        existingRow();
        updatedRow();
        const { logEvent } = jest.requireMock('@/app-layer/events/audit') as {
            logEvent: jest.Mock;
        };
        await proposeParameterChange(ctx, {
            id: 'set_1',
            parameters: { department: 'ops' },
            openFields: { employeeEmail: TARGET_MARKER, workEmail: NARROW },
            targetPopulation: POP,
        });
        const details = logEvent.mock.calls[0][2].detailsJson;
        expect(details.targetPopulation).toBe(POP);
        expect(details.previousTargetPopulation).toBeNull();
        expect(details.openFieldNames).toEqual(['employeeEmail', 'workEmail']);
        expect(JSON.stringify(details)).not.toContain('company\\\\.test');
    });
});
