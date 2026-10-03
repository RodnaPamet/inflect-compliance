/**
 * THE TARGET POPULATION — and why every claim here needs a real database
 * (#3051 step 5c).
 *
 * Opening the TARGET is, in this issue's own words, "the step that makes an
 * agent able to touch a row nobody reviewed". Three of the four things standing
 * between a template and that outcome are Postgres, and none of them is
 * observable from TypeScript:
 *
 *   1. THE POPULATION IS A TENANT-SCOPED READ. "One tenant's population never
 *      resolves another tenant's rows" is a claim about RLS and about a `where`
 *      clause against real rows. A mocked Prisma proves the call shape and
 *      nothing about the result.
 *   2. THE TWO HALVES OF A TARGET CANNOT DISAGREE. Which ARGUMENT is the target
 *      lives in `openFields`; which POPULATION bounds it is a column. A row with
 *      only one of them is refused by a CHECK, which exists precisely for the
 *      paths the usecase does not own.
 *   3. THE POPULATION MOVES ONLY THROUGH FOUR EYES. Swapping a template's
 *      population is the widest change this table can express — the field list,
 *      the field names and the approved exact values all read unchanged — and
 *      the promotion trigger is the only thing that refuses it.
 *
 * The fourth is the dispatch refusal, which is a tool-boundary concern and is
 * proved in `tests/unit/external-tool-open-field-dispatch.test.ts` against a
 * population whose contents that test controls.
 *
 * Every refusal below is paired with the case that must still be ACCEPTED, so a
 * constraint that refuses everything cannot pass as one that refuses the right
 * thing.
 */
import { Prisma, PrismaClient, MembershipStatus, Role } from '@prisma/client';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import {
    approveParameterChange,
    proposeParameterChange,
    saveParameterSet,
    signParameterChange,
} from '@/app-layer/usecases/external-tool-parameters';
import {
    MAX_POPULATION_ROWS,
    POPULATION_OBSERVATION_FRESHNESS_MS,
    resolveTargetPopulation,
    TARGET_POPULATIONS,
    targetPopulationKeys,
} from '@/app-layer/usecases/external-tool-target-populations';
import { externalToolName } from '@/lib/mcp/external-tool-name';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(90_000);

const T1 = 'tgtpop-tenant-one';
const T2 = 'tgtpop-tenant-two';
const TOOL = externalToolName('cmconnaaa', 'update_user');

const PEOPLE = ['proposer', 'approver'] as const;
type Person = (typeof PEOPLE)[number];

const EXACT = { reason: 'offboarding' };
/** The open-field blob of a targeted template — the STORED shape, no population. */
const TARGETED = { employeeEmail: { kind: 'target' } };
const EMAIL_POP = 'terminated_employee_work_emails';
const HRIS_POP = 'terminated_employee_hris_record_ids';
const ENTRA_POP = 'terminated_employee_entra_account_ids';

const users: Record<string, string> = {};
const ctxFor = (tenantId: string, who: Person = 'proposer') =>
    makeRequestContext('OWNER', {
        tenantId,
        tenantSlug: tenantId,
        userId: users[`${tenantId}:${who}`],
    });

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: [T1, T2] } };
    await prisma.externalToolParameterSetApproval.deleteMany({ where: t });
    await prisma.externalToolParameterSet.deleteMany({ where: t });
    await prisma.identityAccountLink.deleteMany({ where: t });
    await prisma.connectedIdentityAccount.deleteMany({ where: t });
    await prisma.integrationConnection.deleteMany({ where: t });
    await prisma.employee.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, [T1, T2]);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(
            `DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`,
            [T1, T2],
        );
    });
    await prisma.user.deleteMany({
        where: {
            emailHash: {
                in: [T1, T2].flatMap((t2) => PEOPLE.map((p) => hashForLookup(`${p}@${t2}.test`))),
            },
        },
    });
    await prisma.tenant.deleteMany({ where: { id: { in: [T1, T2] } } });
}

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();
    for (const id of [T1, T2]) {
        await prisma.tenant.create({ data: { id, name: id, slug: id } });
        for (const who of PEOPLE) {
            const email = `${who}@${id}.test`;
            const user = await prisma.user.create({
                data: { email, emailHash: hashForLookup(email) },
            });
            await prisma.tenantMembership.create({
                data: {
                    tenantId: id,
                    userId: user.id,
                    role: Role.OWNER,
                    status: MembershipStatus.ACTIVE,
                },
            });
            users[`${id}:${who}`] = user.id;
        }
    }
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

beforeEach(async () => {
    await prisma.externalToolParameterSetApproval.deleteMany({
        where: { tenantId: { in: [T1, T2] } },
    });
    await prisma.externalToolParameterSet.deleteMany({ where: { tenantId: { in: [T1, T2] } } });
    await prisma.identityAccountLink.deleteMany({ where: { tenantId: { in: [T1, T2] } } });
    await prisma.connectedIdentityAccount.deleteMany({ where: { tenantId: { in: [T1, T2] } } });
    await prisma.integrationConnection.deleteMany({ where: { tenantId: { in: [T1, T2] } } });
    await prisma.employee.deleteMany({ where: { tenantId: { in: [T1, T2] } } });
});

/** One worker, in one tenant, at one status. */
async function employee(
    tenantId: string,
    workEmail: string,
    status: 'ACTIVE' | 'TERMINATED',
    hrisRecordId: string | null = null,
): Promise<string> {
    const row = await prisma.employee.create({
        data: { tenantId, fullName: workEmail, workEmail, status, hrisRecordId },
    });
    return row.id;
}

/** A saved EXACT-VALUE set — the only kind a first save may create. */
const baseline = (tenantId = T1, label = 'ops') =>
    saveParameterSet(ctxFor(tenantId), { toolName: TOOL, label, parameters: EXACT });

// ═════════════════════════════════════════════════════════════════════
// 1. THE POPULATION IS TENANT-SCOPED
// ═════════════════════════════════════════════════════════════════════

describe('the registry resolves one tenant and never another', () => {
    it('returns only this tenant\'s terminated workers, by work email', async () => {
        await employee(T1, 'gone.one@t1.test', 'TERMINATED');
        await employee(T1, 'still.here@t1.test', 'ACTIVE');
        await employee(T2, 'gone.two@t2.test', 'TERMINATED');

        const one = await resolveTargetPopulation(ctxFor(T1), EMAIL_POP);
        const two = await resolveTargetPopulation(ctxFor(T2), EMAIL_POP);

        expect(one.state).toBe('ok');
        expect(two.state).toBe('ok');
        // THE ISOLATION CLAIM, both directions. Asserting only "T1 contains its
        // own row" would pass for a resolver that returned every tenant's rows.
        expect(one.state === 'ok' && [...one.values].sort()).toEqual(['gone.one@t1.test']);
        expect(two.state === 'ok' && [...two.values].sort()).toEqual(['gone.two@t2.test']);
        expect(one.state === 'ok' && one.values.has('gone.two@t2.test')).toBe(false);
        expect(two.state === 'ok' && two.values.has('gone.one@t1.test')).toBe(false);
    });

    it('excludes an ACTIVE worker — the status predicate does work', async () => {
        await employee(T1, 'still.here@t1.test', 'ACTIVE');
        const r = await resolveTargetPopulation(ctxFor(T1), EMAIL_POP);
        // EMPTY, not "ok with one member". The distinction is the point: an empty
        // population refuses at dispatch with its own message rather than letting
        // the refusal read as the model choosing badly.
        expect(r.state).toBe('empty');
    });

    it('reports an EMPTY population rather than an absent one', async () => {
        const r = await resolveTargetPopulation(ctxFor(T1), EMAIL_POP);
        expect(r).toEqual({ state: 'empty', key: EMAIL_POP });
    });

    it('fails closed on a key this build does not define', async () => {
        const r = await resolveTargetPopulation(ctxFor(T1), 'everyone_in_the_roster');
        expect(r).toEqual({ state: 'unknown_key', key: 'everyone_in_the_roster' });
    });
});

describe('the HRIS-handle population refuses a worker with no handle', () => {
    it('omits a terminated worker whose hrisRecordId is NULL', async () => {
        // The schema is emphatic that a reader must treat a null handle as "no
        // handle, refuse" and must NEVER fall back to workEmail or externalId.
        // So this is that rule, not a convenience filter — and the control below
        // proves the filter is about the handle and not about the fixture.
        await employee(T1, 'no.handle@t1.test', 'TERMINATED', null);
        expect((await resolveTargetPopulation(ctxFor(T1), HRIS_POP)).state).toBe('empty');

        await employee(T1, 'has.handle@t1.test', 'TERMINATED', 'HR-991');
        const r = await resolveTargetPopulation(ctxFor(T1), HRIS_POP);
        expect(r.state === 'ok' && [...r.values]).toEqual(['HR-991']);
    });

    it('is tenant-scoped too', async () => {
        await employee(T1, 'a@t1.test', 'TERMINATED', 'HR-1');
        await employee(T2, 'b@t2.test', 'TERMINATED', 'HR-2');
        const one = await resolveTargetPopulation(ctxFor(T1), HRIS_POP);
        const two = await resolveTargetPopulation(ctxFor(T2), HRIS_POP);
        expect(one.state === 'ok' && [...one.values]).toEqual(['HR-1']);
        expect(two.state === 'ok' && [...two.values]).toEqual(['HR-2']);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 2. THE ENTRA POPULATION — five bounds beyond the status, each with a control
// ═════════════════════════════════════════════════════════════════════

/**
 * A terminated worker with a linked directory account, built so each clause of
 * the Entra population can be broken one at a time.
 */
async function linkedLeaver(
    tenantId: string,
    opts: {
        upn: string;
        provider?: string;
        isProtected?: boolean;
        lastVerifiedAt?: Date;
        contradictedAt?: Date | null;
        employeeStatus?: 'ACTIVE' | 'TERMINATED';
    },
): Promise<void> {
    const employeeId = await employee(
        tenantId,
        `${opts.upn}@${tenantId}.test`,
        opts.employeeStatus ?? 'TERMINATED',
    );
    const connection = await prisma.integrationConnection.create({
        data: { tenantId, provider: opts.provider ?? 'entra-id', name: `conn-${opts.upn}` },
    });
    const account = await prisma.connectedIdentityAccount.create({
        data: {
            tenantId,
            connectionId: connection.id,
            provider: opts.provider ?? 'entra-id',
            externalUserId: opts.upn,
            email: `${opts.upn}@${tenantId}.test`,
            isProtected: opts.isProtected ?? false,
            syncedAt: new Date(),
        },
    });
    await prisma.identityAccountLink.create({
        data: {
            tenantId,
            employeeId,
            connectedAccountId: account.id,
            matchMethod: 'EMAIL_EXACT',
            lastVerifiedAt: opts.lastVerifiedAt ?? new Date(),
            contradictedAt: opts.contradictedAt ?? null,
        },
    });
}

describe('the Entra population carries the leaver pass\'s own bounds', () => {
    it('returns a fresh, unprotected, uncontradicted entra link — the control', async () => {
        await linkedLeaver(T1, { upn: 'leaver-ok' });
        const r = await resolveTargetPopulation(ctxFor(T1), ENTRA_POP);
        expect(r.state === 'ok' && [...r.values]).toEqual(['leaver-ok']);
    });

    it('excludes a link last observed outside the freshness window', async () => {
        // A link is not evidence that a pairing is still true, only a bound on
        // how long ago it was.
        //
        // The cutoff is DERIVED from the constant the resolver uses, not a
        // hard-coded "30 days ago": a fixture that happened to sit outside a
        // guessed window would keep passing after somebody widened the real one.
        await linkedLeaver(T1, {
            upn: 'leaver-stale',
            lastVerifiedAt: new Date(
                Date.now() - POPULATION_OBSERVATION_FRESHNESS_MS - 60_000,
            ),
        });
        expect((await resolveTargetPopulation(ctxFor(T1), ENTRA_POP)).state).toBe('empty');
    });

    it('includes a link observed JUST INSIDE the window — the boundary control', async () => {
        // Paired with the test above so the exclusion is about the window and not
        // about any non-current timestamp being rejected.
        await linkedLeaver(T1, {
            upn: 'leaver-fresh-enough',
            lastVerifiedAt: new Date(
                Date.now() - POPULATION_OBSERVATION_FRESHNESS_MS + 60_000,
            ),
        });
        const r = await resolveTargetPopulation(ctxFor(T1), ENTRA_POP);
        expect(r.state === 'ok' && [...r.values]).toEqual(['leaver-fresh-enough']);
    });

    it('excludes a link the reconciler has CONTRADICTED', async () => {
        await linkedLeaver(T1, { upn: 'leaver-wrong', contradictedAt: new Date() });
        expect((await resolveTargetPopulation(ctxFor(T1), ENTRA_POP)).state).toBe('empty');
    });

    it('excludes a PROTECTED account', async () => {
        // The account-protection flag exists so a named account is never written
        // to by automation; a target population that ignored it would hand an
        // agent exactly the accounts somebody asked it to leave alone.
        await linkedLeaver(T1, { upn: 'leaver-protected', isProtected: true });
        expect((await resolveTargetPopulation(ctxFor(T1), ENTRA_POP)).state).toBe('empty');
    });

    it('excludes another provider\'s account', async () => {
        // A mixed-provider population would widen the admissible value set for a
        // tool that addresses one directory. A second provider is a second ENTRY.
        await linkedLeaver(T1, { upn: 'leaver-ad', provider: 'active-directory' });
        expect((await resolveTargetPopulation(ctxFor(T1), ENTRA_POP)).state).toBe('empty');
    });

    it('excludes an account whose employee is still ACTIVE', async () => {
        await linkedLeaver(T1, { upn: 'joiner', employeeStatus: 'ACTIVE' });
        expect((await resolveTargetPopulation(ctxFor(T1), ENTRA_POP)).state).toBe('empty');
    });

    it('is tenant-scoped', async () => {
        await linkedLeaver(T1, { upn: 'one' });
        await linkedLeaver(T2, { upn: 'two' });
        const one = await resolveTargetPopulation(ctxFor(T1), ENTRA_POP);
        const two = await resolveTargetPopulation(ctxFor(T2), ENTRA_POP);
        expect(one.state === 'ok' && [...one.values]).toEqual(['one']);
        expect(two.state === 'ok' && [...two.values]).toEqual(['two']);
    });
});

describe('every registry entry is bounded and tenant-scoped', () => {
    it('declares a cap and a written bound, and resolves nothing globally', async () => {
        // DERIVED from the registry rather than listed, so an entry added without
        // a bound sentence, or one whose resolver drops the tenant filter, fails
        // here instead of being noticed later.
        const keys = targetPopulationKeys();
        expect(keys.length).toBeGreaterThanOrEqual(3);
        await employee(T2, 'only.in.t2@t2.test', 'TERMINATED', 'HR-T2');
        await linkedLeaver(T2, { upn: 'only-in-t2' });
        for (const key of keys) {
            const entry = TARGET_POPULATIONS[key];
            expect(entry.key).toBe(key);
            expect(entry.description.length).toBeGreaterThan(20);
            // The sentence a reviewer checks against the resolver beside it.
            expect(entry.bound).toMatch(/runInTenantContext/);
            expect(entry.bound).toMatch(/MAX_POPULATION_ROWS/);
            // T1 holds nothing, and T2 holds a member of every population. A
            // resolver reading globally would come back `ok` here.
            expect((await resolveTargetPopulation(ctxFor(T1), key)).state).toBe('empty');
        }
        expect(MAX_POPULATION_ROWS).toBeGreaterThan(0);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 3. THE TWO HALVES OF A TARGET CANNOT DISAGREE
// ═════════════════════════════════════════════════════════════════════

/**
 * A set with a legitimate pending EXACT-VALUE edit — the row shape the CHECK
 * tests below mutate.
 *
 * The CHECKs are tested through the PENDING columns on purpose, and the reason is
 * worth stating because the obvious route does not work: a BEFORE ROW trigger
 * fires before constraint evaluation, so any raw UPDATE of the IN-FORCE columns
 * is refused by the promotion trigger (`NOT_PROMOTED`) and the CHECK is never
 * reached. A test asserting `/matches_marker|NOT_PROMOTED/` there would pass with
 * the CHECK dropped entirely — it would be a test of the trigger wearing the
 * CHECK's name.
 *
 * Touching only `pending*` leaves `v_open_changed` false and `v_promotion` false,
 * so the trigger returns early and the CHECK is the ONLY control in the way.
 */
async function withPendingEdit(label: string): Promise<string> {
    const set = await baseline(T1, label);
    await proposeParameterChange(ctxFor(T1), {
        id: set.id,
        parameters: { reason: 'a different reason' },
    });
    return set.id;
}

describe('the CHECKs refuse a half-written target (reached via the pending columns)', () => {
    it('refuses a pending marker with no pending population', async () => {
        // The dangerous direction: an edit that, once promoted, would let the
        // agent choose a row bounded by nothing at all.
        const id = await withPendingEdit('chk-marker');
        await expect(
            prisma.$executeRawUnsafe(
                `UPDATE "ExternalToolParameterSet" SET "pendingOpenFields" = $1::jsonb WHERE "id" = $2`,
                JSON.stringify(TARGETED),
                id,
            ),
        ).rejects.toThrow(/target_population_matches_marker/);
    });

    it('refuses a pending population with no pending marker', async () => {
        const id = await withPendingEdit('chk-pop');
        await expect(
            prisma.$executeRawUnsafe(
                `UPDATE "ExternalToolParameterSet" SET "pendingTargetPopulation" = $1 WHERE "id" = $2`,
                EMAIL_POP,
                id,
            ),
        ).rejects.toThrow(/target_population_matches_marker/);
    });

    it('accepts both pending halves together — the control', async () => {
        // Without this the two refusals above would also be satisfied by a CHECK
        // that rejected every pending target.
        const id = await withPendingEdit('chk-both');
        await prisma.$executeRawUnsafe(
            `UPDATE "ExternalToolParameterSet"
                SET "pendingOpenFields" = $1::jsonb, "pendingTargetPopulation" = $2
              WHERE "id" = $3`,
            JSON.stringify(TARGETED),
            EMAIL_POP,
            id,
        );
        const row = await prisma.externalToolParameterSet.findUniqueOrThrow({ where: { id } });
        expect(row.pendingTargetPopulation).toBe(EMAIL_POP);
    });

    it('refuses TWO pending markers beside one population', async () => {
        // The equality CHECK alone is satisfied by two markers and one
        // population, so the at-most-one CHECK is not redundant with it.
        const id = await withPendingEdit('chk-two');
        await expect(
            prisma.$executeRawUnsafe(
                `UPDATE "ExternalToolParameterSet"
                    SET "pendingOpenFields" = $1::jsonb, "pendingTargetPopulation" = $2
                  WHERE "id" = $3`,
                JSON.stringify({ a: { kind: 'target' }, b: { kind: 'target' } }),
                EMAIL_POP,
                id,
            ),
        ).rejects.toThrow(/at_most_one_target_field/);
    });

    it('refuses a pending population with no pending edit beside it', async () => {
        const set = await baseline(T1, 'chk-orphan');
        await expect(
            prisma.$executeRawUnsafe(
                `UPDATE "ExternalToolParameterSet" SET "pendingTargetPopulation" = $1 WHERE "id" = $2`,
                EMAIL_POP,
                set.id,
            ),
        ).rejects.toThrow(/pending_target_needs_pending/);
    });
});

describe('the trigger refuses a direct write to the IN-FORCE columns', () => {
    it('refuses a raw UPDATE that sets openFields and a population', async () => {
        // Refused by the TRIGGER, named exactly: a BEFORE ROW trigger runs before
        // constraint evaluation, so this never reaches the CHECKs.
        const set = await baseline(T1, 'raw-inforce');
        await expect(
            prisma.$executeRawUnsafe(
                `UPDATE "ExternalToolParameterSet"
                    SET "openFields" = $1::jsonb, "targetPopulation" = $2
                  WHERE "id" = $3`,
                JSON.stringify(TARGETED),
                EMAIL_POP,
                set.id,
            ),
        ).rejects.toThrow(/NOT_PROMOTED/);
    });

    it('refuses a BASELINE created with a target population', async () => {
        // Without this, the whole four-eyes requirement is avoidable by deleting
        // a set and saving it again with the target you wanted.
        await expect(
            prisma.externalToolParameterSet.create({
                data: {
                    tenantId: T1,
                    toolName: TOOL,
                    label: 'raw-target',
                    parameters: EXACT,
                    parametersHash: 'h',
                    approvalSource: 'BASELINE',
                    openFields: TARGETED,
                    targetPopulation: EMAIL_POP,
                },
            }),
        ).rejects.toThrow(/NOT_ON_BASELINE/);
    });

    it('refuses a BASELINE carrying a population with no open fields', async () => {
        // The clause that says "a target may not be created", separately from the
        // one about open fields — a reader should not have to compose two other
        // constraints to learn it.
        await expect(
            prisma.externalToolParameterSet.create({
                data: {
                    tenantId: T1,
                    toolName: TOOL,
                    label: 'raw-pop-only',
                    parameters: EXACT,
                    parametersHash: 'h',
                    approvalSource: 'BASELINE',
                    targetPopulation: EMAIL_POP,
                },
            }),
        ).rejects.toThrow(/EXTERNAL_TOOL_TARGET_NOT_ON_BASELINE/);
    });

    it('refuses a BASELINE created with a target population', async () => {
        // Without this, the whole four-eyes requirement is avoidable by deleting
        // a set and saving it again with the target you wanted.
        await expect(
            prisma.externalToolParameterSet.create({
                data: {
                    tenantId: T1,
                    toolName: TOOL,
                    label: 'raw-target',
                    parameters: EXACT,
                    parametersHash: 'h',
                    approvalSource: 'BASELINE',
                    openFields: TARGETED,
                    targetPopulation: EMAIL_POP,
                },
            }),
        ).rejects.toThrow(/NOT_ON_BASELINE/);
    });

    it('still creates an exact-value baseline — the control', async () => {
        const set = await baseline(T1, 'control');
        expect(set).toMatchObject({ targetPopulation: null, openFields: null });
    });
});

describe('the usecase refuses a half-written target with a sentence', () => {
    it('refuses a marker with no population', async () => {
        const set = await baseline();
        await expect(
            proposeParameterChange(ctxFor(T1), {
                id: set.id,
                parameters: EXACT,
                openFields: TARGETED,
            }),
        ).rejects.toThrow(/external_target_population_missing/);
    });

    it('refuses a population with no marker', async () => {
        const set = await baseline();
        await expect(
            proposeParameterChange(ctxFor(T1), {
                id: set.id,
                parameters: EXACT,
                openFields: { note: { kind: 'length', min: 1, max: 20 } },
                targetPopulation: EMAIL_POP,
            }),
        ).rejects.toThrow(/external_target_field_missing/);
    });

    it('refuses a population this build does not define', async () => {
        const set = await baseline();
        await expect(
            proposeParameterChange(ctxFor(T1), {
                id: set.id,
                parameters: EXACT,
                openFields: TARGETED,
                targetPopulation: 'everyone_in_the_roster',
            }),
        ).rejects.toThrow(/external_target_population_unknown/);
    });

    it('accepts both halves together — the control', async () => {
        const set = await baseline();
        const after = await proposeParameterChange(ctxFor(T1), {
            id: set.id,
            parameters: EXACT,
            openFields: TARGETED,
            targetPopulation: EMAIL_POP,
        });
        expect(after.pending?.targetPopulation).toBe(EMAIL_POP);
        // NOT in force: the agent keeps dispatching what was approved.
        expect(after.targetPopulation).toBeNull();
    });
});

// ═════════════════════════════════════════════════════════════════════
// 4. THE POPULATION MOVES ONLY THROUGH FOUR EYES
// ═════════════════════════════════════════════════════════════════════

/** Baseline, then propose the targeted template. */
async function proposeTarget(
    tenantId = T1,
    population = EMAIL_POP,
    label = 'ops',
): Promise<{ id: string; hash: string }> {
    const set = await baseline(tenantId, label);
    const after = await proposeParameterChange(ctxFor(tenantId), {
        id: set.id,
        parameters: EXACT,
        openFields: TARGETED,
        targetPopulation: population,
    });
    return { id: set.id, hash: after.pending!.hash };
}

describe('a target comes into force only by promoting what was pending', () => {
    it('refuses a promotion with ZERO signatures', async () => {
        const { id, hash } = await proposeTarget();
        await expect(
            approveParameterChange(ctxFor(T1, 'proposer'), {
                id,
                expectedPendingHash: hash,
            }),
        ).rejects.toThrow(/signature|FOUR_EYES|approver/i);
        const row = await prisma.externalToolParameterSet.findUniqueOrThrow({ where: { id } });
        expect(row.targetPopulation).toBeNull();
    });

    it('promotes once an independent human has signed — the control', async () => {
        const { id, hash } = await proposeTarget();
        await signParameterChange(ctxFor(T1, 'approver'), { id, expectedPendingHash: hash });
        const after = await approveParameterChange(ctxFor(T1, 'approver'), {
            id,
            expectedPendingHash: hash,
        });
        expect(after.targetPopulation).toBe(EMAIL_POP);
        expect(after.openFields).toEqual(TARGETED);
        expect(after.pending).toBeNull();
    });

    it('refuses the PROPOSER as the signature, even for a target-only edit', async () => {
        // The exclusion is a SET property, not an ordinal one: "the proposer is
        // not among the approvers" rather than "the second approver is not the
        // proposer", because the ordinal form is bypassed by controlling who
        // clicks first.
        const { id, hash } = await proposeTarget();
        await expect(
            signParameterChange(ctxFor(T1, 'proposer'), { id, expectedPendingHash: hash }),
        ).rejects.toThrow(/proposed this edit|cannot also be/i);
    });

    it('refuses a direct UPDATE that swaps the population of a live template', async () => {
        // THE SHARPEST WIDENING THIS TABLE CAN EXPRESS, and the reason the
        // trigger gates the column rather than relying on the marker CHECK: the
        // row already HAS a marker, so retargeting it to a wider population
        // satisfies every CHECK while the approved field list, the approved exact
        // values and the field names all read unchanged.
        const { id, hash } = await proposeTarget();
        await signParameterChange(ctxFor(T1, 'approver'), { id, expectedPendingHash: hash });
        await approveParameterChange(ctxFor(T1, 'approver'), { id, expectedPendingHash: hash });

        await expect(
            prisma.externalToolParameterSet.update({
                where: { id },
                data: { targetPopulation: HRIS_POP },
            }),
        ).rejects.toThrow(/NOT_PROMOTED/);

        const row = await prisma.externalToolParameterSet.findUniqueOrThrow({ where: { id } });
        expect(row.targetPopulation).toBe(EMAIL_POP);
    });

    it('refuses a promotion that promotes a DIFFERENT population from the pending one', async () => {
        const { id, hash } = await proposeTarget();
        await signParameterChange(ctxFor(T1, 'approver'), { id, expectedPendingHash: hash });
        const row = await prisma.externalToolParameterSet.findUniqueOrThrow({
            where: { id },
            select: { pendingHash: true, revision: true, pendingOpenFields: true },
        });
        await expect(
            prisma.externalToolParameterSet.update({
                where: { id },
                data: {
                    parametersHash: row.pendingHash!,
                    revision: row.revision + 1,
                    approvalSource: 'APPROVED',
                    approvedByUserId: users[`${T1}:approver`],
                    openFields: row.pendingOpenFields as object,
                    // Not what was proposed: a different population, slipped in
                    // at the moment of promotion, with the reviewed field list.
                    targetPopulation: HRIS_POP,
                    // `Prisma.DbNull` on the two Json columns: a literal `null`
                    // is not expressible there, and `undefined` would mean
                    // "leave it alone", which is a different row.
                    pendingParameters: Prisma.DbNull,
                    pendingOpenFields: Prisma.DbNull,
                    pendingTargetPopulation: null,
                    pendingHash: null,
                    pendingByUserId: null,
                    pendingAt: null,
                },
            }),
        ).rejects.toThrow(/NOT_PROMOTED/);
    });

    it('requires a signature to RETARGET a live template, not only to create one', async () => {
        const { id, hash } = await proposeTarget();
        await signParameterChange(ctxFor(T1, 'approver'), { id, expectedPendingHash: hash });
        await approveParameterChange(ctxFor(T1, 'approver'), { id, expectedPendingHash: hash });

        const retarget = await proposeParameterChange(ctxFor(T1, 'proposer'), {
            id,
            parameters: EXACT,
            openFields: TARGETED,
            targetPopulation: HRIS_POP,
        });
        // The digest MOVED even though only the population changed — which is
        // what makes the retarget proposable at all rather than being refused as
        // "already in force".
        expect(retarget.pending?.hash).not.toBe(hash);

        await expect(
            approveParameterChange(ctxFor(T1, 'proposer'), {
                id,
                expectedPendingHash: retarget.pending!.hash,
            }),
        ).rejects.toThrow(/signature|FOUR_EYES|approver/i);

        await signParameterChange(ctxFor(T1, 'approver'), {
            id,
            expectedPendingHash: retarget.pending!.hash,
        });
        const after = await approveParameterChange(ctxFor(T1, 'approver'), {
            id,
            expectedPendingHash: retarget.pending!.hash,
        });
        expect(after.targetPopulation).toBe(HRIS_POP);
    });

    it('lets an EXACT-VALUE edit still take one approval — the 5b path is untouched', async () => {
        // The gate must not have widened to cover edits it was never about: a
        // control shaped like an outage is a control people route around.
        const set = await baseline(T1, 'plain');
        const proposed = await proposeParameterChange(ctxFor(T1, 'proposer'), {
            id: set.id,
            parameters: { reason: 'something else' },
        });
        const after = await approveParameterChange(ctxFor(T1, 'approver'), {
            id: set.id,
            expectedPendingHash: proposed.pending!.hash,
        });
        expect(after.revision).toBe(2);
        expect(after.targetPopulation).toBeNull();
    });
});
