/**
 * #2716 — the joiner's HRIS write-back seam.
 *
 * The acceptance that matters is NOT "a write happened" — the write is Phase 2
 * and `HRIS_WRITEBACK_MAX_MODE` is `DRY_RUN`, so no write can happen. It is
 * that the refusal is SPECIFIC to this tenant, that the address survives for a
 * retry, and that nothing writes `Employee.workEmail` directly.
 */
import * as fs from 'fs';
import * as path from 'path';
import { codeOf } from '../helpers/source-blocks';
import {
    attemptJoinerWriteBack,
    type JoinerWriteBackInput,
} from '@/app-layer/usecases/identity-joiner-write-back';

const order: string[] = [];
type UpdateManyArg = {
    where: { id: string; tenantId: string };
    data: { intendedAddress: string };
};
const updateMany = jest.fn(async (_arg: UpdateManyArg) => {
    order.push('record-address');
    return { count: 1 };
});
jest.mock('@/app-layer/integrations/providers/hris/write-back', () => {
    const actual = jest.requireActual('@/app-layer/integrations/providers/hris/write-back');
    return {
        ...actual,
        gateWriteBackPreflight: jest.fn((i: never) => {
            order.push('gate');
            return actual.gateWriteBackPreflight(i);
        }),
    };
});
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn({ preHire: { updateMany } }),
    ),
}));

const CTX = { tenantId: 't-1', userId: 'u-1' } as never;

function input(over: Partial<JoinerWriteBackInput> = {}): JoinerWriteBackInput {
    return {
        provider: 'hris',
        config: { writeBackEnabled: true, hrisRecordId: 'h-1' },
        mode: 'DRY_RUN',
        preHireId: 'ph-1',
        address: 'jane.smith@acme.com',
        ...over,
    };
}

beforeEach(() => {
    order.length = 0;
    jest.clearAllMocks();
});

describe('the refusal is specific to the tenant, not a constant sentence', () => {
    it('names the DISABLED mode rather than "not wired"', async () => {
        const r = await attemptJoinerWriteBack(CTX, input({ mode: 'DISABLED' }));
        expect(r.kind).toBe('REFUSED');
        if (r.kind !== 'REFUSED') throw new Error('narrowing');
        expect(r.outcome).toBe('REFUSED_MODE');
    });

    it('names the opt-in when the connection has not enabled write-back', async () => {
        const r = await attemptJoinerWriteBack(
            CTX,
            input({ config: { writeBackEnabled: false, hrisRecordId: 'h-1' } }),
        );
        expect(r.kind).toBe('REFUSED');
        if (r.kind !== 'REFUSED') throw new Error('narrowing');
        expect(r.outcome).toBe('REFUSED_WRITE_BACK_DISABLED');
    });

    it('distinguishes "not allowed" from "cannot yet"', async () => {
        // Every permission in place: the gate passes and the WRITE still does
        // not exist. Collapsing this into REFUSED would tell a tenant to change
        // a setting that is already correct.
        const r = await attemptJoinerWriteBack(CTX, input());
        expect(r.kind).toBe('NOT_IMPLEMENTED');
        expect(r.detail).toMatch(/Phase 2/);
        expect(r.detail).toMatch(/never written to an HRIS/);
    });
});

describe('the address survives for a retry', () => {
    it('records intendedAddress on the pre-hire BEFORE the gate runs', async () => {
        await attemptJoinerWriteBack(CTX, input({ mode: 'DISABLED' }));
        // Even on the refusal path — especially there, since that is the case
        // a human comes back to.
        expect(updateMany).toHaveBeenCalledTimes(1);
        const arg = updateMany.mock.calls[0][0];
        expect(arg.data.intendedAddress).toBe('jane.smith@acme.com');
        // Tenant-scoped by PREDICATE, not only by RLS.
        expect(arg.where.tenantId).toBe('t-1');
    });

    it('records the address BEFORE the gate runs, not after', async () => {
        // The ordering is the whole recovery story: a crash between the two
        // must leave the derived identity recoverable rather than lost. Without
        // this assertion the guarantee was only a docblock — swapping the two
        // blocks left every other test in this file green.
        await attemptJoinerWriteBack(CTX, input({ mode: 'DISABLED' }));
        expect(order).toEqual(['record-address', 'gate']);
    });

    it('skips the write when there is no pre-hire to attach it to', async () => {
        await attemptJoinerWriteBack(CTX, input({ preHireId: null }));
        expect(updateMany).not.toHaveBeenCalled();
    });

    it('retrying the write-back alone does not re-run a create', async () => {
        // The seam takes no provisioner and holds no create path — the
        // strongest available form of "a retry cannot re-create".
        // MASKED at the read seam (#2246). The first version of this assertion
        // read raw source and failed on this file's own DOCBLOCK, which names
        // `createDirectoryAccount` while explaining that it is not called —
        // prose defeating an assertion about code, the mirror of the defect
        // this repo's Class A campaign exists to remove.
        const src = codeOf(
            fs.readFileSync(
                path.resolve(__dirname, '../../src/app-layer/usecases/identity-joiner-write-back.ts'),
                'utf8',
            ),
        );
        expect(src).not.toMatch(/createBlockedAccount|createDirectoryAccount|DirectoryProvisioner/);
    });
});

describe('no path writes Employee.workEmail directly (#2716 acceptance)', () => {
    // The failure this whole chain exists to prevent: a direct write makes the
    // next HRIS upsert miss its tenantId_workEmail key and mint a DUPLICATE
    // employee row. Asserted over the joiner surface as a population, so a new
    // file in it is covered without anyone remembering.
    const JOINER_FILES = [
        'src/app-layer/usecases/identity-joiner-write-back.ts',
        'src/app-layer/usecases/identity-create-account.ts',
        'src/app-layer/usecases/pre-hire.ts',
    ];

    it('no joiner usecase updates an Employee workEmail', () => {
        const offenders: string[] = [];
        for (const rel of JOINER_FILES) {
            const src = codeOf(fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8'));
            // `employee.update|upsert|create` carrying a workEmail field.
            if (/employee\s*\.\s*(update|updateMany|upsert|create)\s*\(/.test(src)) {
                offenders.push(rel);
            }
        }
        // Positive control: the list is non-empty and the files exist, so an
        // empty offender list means "checked and clean", not "checked nothing".
        expect(JOINER_FILES.length).toBe(3);
        expect(offenders).toEqual([]);
    });
});
