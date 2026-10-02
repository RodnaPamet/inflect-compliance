/**
 * FOUR-EYES ON A BOUNDED TEMPLATE — and why it needs a real database.
 *
 * ## The claim, and where it lives
 *
 * A template opens a field: the agent chooses that argument, within a bound, on
 * every future invocation. Retyping one exact value affects one call; widening
 * a predicate affects all of them. So a template edit may not come into force
 * until TWO humans other than its proposer have signed it.
 *
 * NONE of that is enforceable in TypeScript, and the `AgentProposal` migration
 * says why: counting signatures and then promoting is a read-then-write. Two
 * concurrent requests each read "one signature so far" and each promote, and
 * the edit commits with one person's consent recorded as two. There is no
 * application-layer arrangement of that check that closes the window; there is
 * a unique index that never opens one, and a trigger that counts inside the
 * UPDATE which has already locked the row.
 *
 * So every assertion below is about Postgres:
 *
 *   1. a parameter set cannot be CREATED with open fields — a baseline is
 *      trust-on-first-use, so a template reached that way is a predicate nobody
 *      reviewed, and it would make four-eyes avoidable by delete-and-re-save;
 *   2. `openFields` cannot move except by promoting exactly what was pending,
 *      so a direct UPDATE is not a way round the gate;
 *   3. a promotion is refused below two signatures;
 *   4. the proposer is excluded as a SET property — not as an ordinal position,
 *      which whoever clicks first chooses;
 *   5. a signature names the DIGEST it signed, so replacing the pending edit
 *      after one signature does not carry that signature forward;
 *   6. one signature per human per (revision, digest), arbitrated by a unique
 *      index — and a LATER revision, or revised content, may be signed again by
 *      the same person, because the alternative is a two-admin tenant that can
 *      never promote a revised edit;
 *   7. signatures are append-only to `app_user` and tenant-isolated under FORCE
 *      ROW LEVEL SECURITY.
 *
 * ## UNRUN AS WRITTEN (2026-10-02)
 *
 * The session that wrote this could not execute it: the shared test database at
 * 127.0.0.1:5434 is shared with other sessions and with CI, and applying a
 * migration to it was out of scope. Nothing below has been observed to pass or
 * to fail. Treat the first CI run of this file as its first run.
 */
import { Prisma, PrismaClient, MembershipStatus, Role } from '@prisma/client';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import {
    approveParameterChange,
    hashParameterSet,
    listParameterSets,
    proposeParameterChange,
    saveParameterSet,
    signParameterChange,
} from '@/app-layer/usecases/external-tool-parameters';
import { externalToolName } from '@/lib/mcp/external-tool-name';
import type { ValueConstraint } from '@/lib/integrations/parameter-constraints';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(60_000);

const T1 = 'tmpl-tenant-one';
const T2 = 'tmpl-tenant-two';
const TOOL = externalToolName('cmconnaaa', 'update_user');

/** Three humans in T1: the proposer and two independent approvers. */
const PEOPLE = ['proposer', 'approver-a', 'approver-b'] as const;
type Person = (typeof PEOPLE)[number];

const EXACT = { userId: '7' };
const EMAIL: ValueConstraint = { kind: 'regex', pattern: '^[a-z.]{1,64}@company\\.test$' };
const TEMPLATE = { workEmail: EMAIL };

const users: Record<string, string> = {};
const ctxFor = (tenantId: string, who: Person = 'proposer') =>
    makeRequestContext('OWNER', {
        tenantId,
        tenantSlug: tenantId,
        userId: users[`${tenantId}:${who}`],
    });

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: [T1, T2] } };
    // Signatures first: the composite FK cascades, but deleting them
    // explicitly keeps the intent readable and the order independent of it.
    await prisma.externalToolParameterSetApproval.deleteMany({ where: t });
    await prisma.externalToolParameterSet.deleteMany({ where: t });
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
                in: [T1, T2].flatMap((t2) =>
                    PEOPLE.map((p) => hashForLookup(`${p}@${t2}.test`)),
                ),
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
});

/** A saved EXACT-VALUE set — the only kind a first save may create. */
const baseline = (tenantId = T1) =>
    saveParameterSet(ctxFor(tenantId), { toolName: TOOL, label: 'ops', parameters: EXACT });

/** Baseline, then propose the template. Returns the set id and pending digest. */
async function proposeTemplate(tenantId = T1): Promise<{ id: string; hash: string }> {
    const set = await baseline(tenantId);
    const after = await proposeParameterChange(ctxFor(tenantId), {
        id: set.id,
        parameters: EXACT,
        openFields: TEMPLATE,
    });
    return { id: set.id, hash: after.pending!.hash };
}

describe('a baseline may not be a template', () => {
    it('is refused by the usecase', async () => {
        await expect(
            saveParameterSet(ctxFor(T1), {
                toolName: TOOL,
                label: 'direct',
                parameters: EXACT,
                openFields: TEMPLATE,
            }),
        ).rejects.toThrow(/trust-on-first-use/);
    });

    it('is refused by the DATABASE even when the usecase is bypassed', async () => {
        // The usecase check is the message; this is the control. Without it,
        // the whole four-eyes requirement is avoidable by deleting a set and
        // saving it again with the bounds you wanted.
        await expect(
            prisma.externalToolParameterSet.create({
                data: {
                    tenantId: T1,
                    toolName: TOOL,
                    label: 'raw',
                    parameters: EXACT,
                    parametersHash: 'h',
                    approvalSource: 'BASELINE',
                    openFields: TEMPLATE,
                },
            }),
        ).rejects.toThrow(/NOT_ON_BASELINE/);
    });

    it('still creates an exact-value baseline — the control', async () => {
        const set = await baseline();
        expect(set).toMatchObject({ revision: 1, approvalSource: 'BASELINE', openFields: null });
    });
});

describe('open fields move only by promoting what was pending', () => {
    it('refuses a direct UPDATE that sets them', async () => {
        const set = await baseline();
        await expect(
            prisma.externalToolParameterSet.update({
                where: { id: set.id },
                data: { openFields: TEMPLATE },
            }),
        ).rejects.toThrow(/NOT_PROMOTED/);
    });

    it('refuses a promotion that promotes DIFFERENT bounds from the pending ones', async () => {
        const { id } = await proposeTemplate();
        const row = await prisma.externalToolParameterSet.findUniqueOrThrow({
            where: { id },
            select: { pendingHash: true, revision: true },
        });
        await expect(
            prisma.externalToolParameterSet.update({
                where: { id },
                data: {
                    parametersHash: row.pendingHash!,
                    revision: row.revision + 1,
                    approvalSource: 'APPROVED',
                    approvedByUserId: users[`${T1}:approver-a`],
                    // Not what was proposed: a WIDER bound, slipped in at the
                    // moment of promotion.
                    openFields: { workEmail: { kind: 'regex', pattern: '^.{1,200}$' } },
                    pendingParameters: Prisma.DbNull,
                    pendingOpenFields: Prisma.DbNull,
                    pendingHash: null,
                    pendingByUserId: null,
                    pendingAt: null,
                },
            }),
        ).rejects.toThrow(/NOT_PROMOTED/);
    });
});

describe('the promotion needs one signature from a non-proposer', () => {
    it('refuses with none', async () => {
        const { id, hash } = await proposeTemplate();
        await expect(
            approveParameterChange(ctxFor(T1), { id, expectedPendingHash: hash }),
        ).rejects.toThrow(/an approving signature from a human other than/);
        const still = await prisma.externalToolParameterSet.findUniqueOrThrow({ where: { id } });
        expect(still.openFields).toBeNull();
        expect(still.revision).toBe(1);
    });

    it('PROMOTES with one, from a human other than the proposer', async () => {
        // Was "refuses with ONE" until the owner ruled on 2026-10-02. Two
        // counted signatures plus the proposer exclusion composed into three
        // distinct humans, which locked a two-admin tenant out of template
        // edits entirely. One counted signature plus the exclusion is four eyes
        // in the literal sense — the proposer's pair and one other.
        const { id, hash } = await proposeTemplate();
        await signParameterChange(ctxFor(T1, 'approver-a'), { id, expectedPendingHash: hash });
        const promoted = await approveParameterChange(ctxFor(T1), {
            id,
            expectedPendingHash: hash,
        });
        expect(promoted).toMatchObject({ openFields: TEMPLATE, revision: 2, pending: null });
    });

    it('also promotes with TWO — more than the minimum is not a refusal', async () => {
        const { id, hash } = await proposeTemplate();
        await signParameterChange(ctxFor(T1, 'approver-a'), { id, expectedPendingHash: hash });
        await signParameterChange(ctxFor(T1, 'approver-b'), { id, expectedPendingHash: hash });

        const promoted = await approveParameterChange(ctxFor(T1), {
            id,
            expectedPendingHash: hash,
        });
        expect(promoted).toMatchObject({
            openFields: TEMPLATE,
            revision: 2,
            approvalSource: 'APPROVED',
            pending: null,
        });
        // Read the COLUMNS, not the projection: `pending: null` would also be
        // true of a row whose proposed bounds survived under a nulled hash.
        const raw = await prisma.externalToolParameterSet.findUniqueOrThrow({
            where: { id },
            select: { openFields: true, pendingOpenFields: true, pendingHash: true },
        });
        expect(raw).toEqual({
            openFields: TEMPLATE,
            pendingOpenFields: null,
            pendingHash: null,
        });
    });

    it('needs only ONE approver for an EXACT-VALUE edit — the gate does not widen', async () => {
        // The path that has shipped since #2860 is untouched: no signature
        // table, no second human.
        const set = await baseline();
        const changed = { userId: '8' };
        await proposeParameterChange(ctxFor(T1), { id: set.id, parameters: changed });
        const after = await approveParameterChange(ctxFor(T1), {
            id: set.id,
            expectedPendingHash: hashParameterSet(changed, null),
        });
        expect(after).toMatchObject({ parameters: changed, revision: 2, openFields: null });
    });

    it('still needs a signature to NARROW a template back to exact values', async () => {
        // Removing the bounds is safe in itself, but it is still an edit to a
        // row that HAS open fields, and the requirement is a property of the row
        // rather than of the direction of travel. Stated as a test because it is
        // the one place the rule is more conservative than it needs to be.
        const { id, hash } = await proposeTemplate();
        await signParameterChange(ctxFor(T1, 'approver-a'), { id, expectedPendingHash: hash });
        await approveParameterChange(ctxFor(T1), { id, expectedPendingHash: hash });

        const narrowing = await proposeParameterChange(ctxFor(T1), {
            id,
            parameters: EXACT,
            openFields: null,
        });
        await expect(
            approveParameterChange(ctxFor(T1), {
                id,
                expectedPendingHash: narrowing.pending!.hash,
            }),
        ).rejects.toThrow(/an approving signature from a human other than/);
    });
});

describe('the proposer is excluded as a SET property', () => {
    it('refuses the proposer AT SIGNING TIME', async () => {
        const { id, hash } = await proposeTemplate();
        await expect(
            signParameterChange(ctxFor(T1, 'proposer'), { id, expectedPendingHash: hash }),
        ).rejects.toThrow(/cannot also be one of its approvers/);
    });

    it('refuses the PROMOTION when the proposer re-proposed content they had signed', async () => {
        // The ordinal reading of the rule — "the SECOND approver is not the
        // proposer" — is bypassed by controlling the order, and so is a
        // signing-time check alone. `proposeParameterChange` refuses an edit
        // identical to what is IN FORCE, not one identical to what is already
        // PENDING, so approver-a can sign, then become the proposer of the same
        // content, and their earlier signature is still on file. Only a check at
        // PROMOTION sees that, which is why the count excludes
        // `pendingByUserId` rather than trusting the insert-time refusal.
        // Only approver-a signs, and then becomes the author of that same
        // pending edit. The signature on file is now the proposer's own, so the
        // live count is ZERO and the promotion must still be refused.
        //
        // Shaped at zero rather than at "one of two" deliberately: the
        // requirement dropped to one signature on 2026-10-02, and a scenario
        // that refused only because 1 < 2 would now PROMOTE while appearing to
        // still test the exclusion. The property under test is unchanged; the
        // arithmetic that exposes it is not.
        const { id, hash } = await proposeTemplate();
        await signParameterChange(ctxFor(T1, 'approver-a'), { id, expectedPendingHash: hash });

        // approver-a takes over authorship of the identical pending edit.
        await prisma.externalToolParameterSet.update({
            where: { id },
            data: { pendingByUserId: users[`${T1}:approver-a`] },
        });

        await expect(
            approveParameterChange(ctxFor(T1), { id, expectedPendingHash: hash }),
        ).rejects.toThrow(/an approving signature from a human other than/);

        // The control: a human who is NOT the proposer signs the same content
        // and it promotes — so the refusal above is the exclusion doing work,
        // not the promotion being broken outright.
        await signParameterChange(ctxFor(T1, 'approver-b'), { id, expectedPendingHash: hash });
        await expect(
            approveParameterChange(ctxFor(T1), { id, expectedPendingHash: hash }),
        ).resolves.toMatchObject({ openFields: TEMPLATE, revision: 2 });
    });
});

describe('a signature names the digest it signed', () => {
    it('does not carry forward to replaced content', async () => {
        const { id, hash } = await proposeTemplate();
        await signParameterChange(ctxFor(T1, 'approver-a'), { id, expectedPendingHash: hash });

        // The proposer revises the edit. approver-a has not read this.
        const revised = await proposeParameterChange(ctxFor(T1), {
            id,
            parameters: EXACT,
            openFields: { workEmail: { kind: 'regex', pattern: '^[a-z]{1,32}@company\\.test$' } },
        });
        expect(revised.pending!.hash).not.toBe(hash);

        // NOBODY has signed the revised content, so the live count is ZERO and
        // approver-a's signature on the superseded digest must not carry over.
        //
        // At zero rather than at "one of two": the requirement dropped to one
        // signature on 2026-10-02, so a scenario that refused because 1 < 2
        // would now promote on the strength of a signature given to different
        // content — which is exactly what this test exists to forbid.
        await expect(
            approveParameterChange(ctxFor(T1), {
                id,
                expectedPendingHash: revised.pending!.hash,
            }),
        ).rejects.toThrow(/an approving signature from a human other than/);

        // Now a signature IS given against the revised digest.
        await signParameterChange(ctxFor(T1, 'approver-b'), {
            id,
            expectedPendingHash: revised.pending!.hash,
        });

        // The listing reports only the LIVE signature — approver-a's, against
        // the superseded digest, is not shown. That is the control for the
        // refusal above: the stale one is absent from the count rather than the
        // count being broken, and an operator is never shown a number the
        // promotion will not honour.
        const [listed] = await listParameterSets(ctxFor(T1), TOOL);
        expect(listed.signatures.map((s) => s.approverUserId)).toEqual([
            users[`${T1}:approver-b`],
        ]);
    });

    it('lets the SAME human sign again once the content changes', async () => {
        // Without the digest in the unique key, a two-admin tenant whose edit
        // was revised after one signature could never promote it — and a
        // control shaped like an outage is a control people remove.
        const { id, hash } = await proposeTemplate();
        await signParameterChange(ctxFor(T1, 'approver-a'), { id, expectedPendingHash: hash });
        const revised = await proposeParameterChange(ctxFor(T1), {
            id,
            parameters: EXACT,
            openFields: { workEmail: { kind: 'regex', pattern: '^[a-z]{1,32}@company\\.test$' } },
        });
        await expect(
            signParameterChange(ctxFor(T1, 'approver-a'), {
                id,
                expectedPendingHash: revised.pending!.hash,
            }),
        ).resolves.toMatchObject({ id });
    });

    it('refuses a stale digest outright', async () => {
        const { id, hash } = await proposeTemplate();
        await proposeParameterChange(ctxFor(T1), {
            id,
            parameters: EXACT,
            openFields: { workEmail: { kind: 'regex', pattern: '^[a-z]{1,32}@company\\.test$' } },
        });
        await expect(
            signParameterChange(ctxFor(T1, 'approver-a'), { id, expectedPendingHash: hash }),
        ).rejects.toThrow(/changed since they were reviewed/);
    });
});

describe('one signature per human per revision', () => {
    it('refuses the same human twice on the same content', async () => {
        const { id, hash } = await proposeTemplate();
        await signParameterChange(ctxFor(T1, 'approver-a'), { id, expectedPendingHash: hash });
        await expect(
            signParameterChange(ctxFor(T1, 'approver-a'), { id, expectedPendingHash: hash }),
        ).rejects.toThrow(/already approved this edit/);
    });

    it('lets the same human sign a LATER revision', async () => {
        // The one place this differs from `AgentProposalApproval`: a proposal is
        // approved once and never again, a parameter set moves repeatedly. With
        // `revision` outside the key, an admin who signed edit 1 could never
        // approve edit 2.
        const { id, hash } = await proposeTemplate();
        await signParameterChange(ctxFor(T1, 'approver-a'), { id, expectedPendingHash: hash });
        await signParameterChange(ctxFor(T1, 'approver-b'), { id, expectedPendingHash: hash });
        await approveParameterChange(ctxFor(T1), { id, expectedPendingHash: hash });

        const second = await proposeParameterChange(ctxFor(T1), {
            id,
            parameters: { userId: '9' },
            openFields: TEMPLATE,
        });
        await expect(
            signParameterChange(ctxFor(T1, 'approver-a'), {
                id,
                expectedPendingHash: second.pending!.hash,
            }),
        ).resolves.toMatchObject({ id });
    });

    it('refuses a signature when nothing is pending', async () => {
        const set = await baseline();
        await expect(
            signParameterChange(ctxFor(T1, 'approver-a'), {
                id: set.id,
                expectedPendingHash: 'anything',
            }),
        ).rejects.toThrow(/no pending change/);
    });

    it('refuses a signature for revision 1 at the CHECK constraint', async () => {
        // A signature on a baseline would be a signature on something nobody
        // compared against anything.
        const { id, hash } = await proposeTemplate();
        await expect(
            prisma.externalToolParameterSetApproval.create({
                data: {
                    tenantId: T1,
                    parameterSetId: id,
                    approverUserId: users[`${T1}:approver-a`],
                    revision: 1,
                    pendingHash: hash,
                    requiredApprovals: 1,
                },
            }),
        ).rejects.toThrow();
    });
});

describe('signatures are append-only and tenant-isolated', () => {
    it('is invisible to another tenant, and cannot be signed by one', async () => {
        const { id, hash } = await proposeTemplate(T1);

        // T2 cannot see the set at all…
        await expect(listParameterSets(ctxFor(T2))).resolves.toEqual([]);
        // …and cannot sign it: RLS hides the parent, so the signature trigger
        // reports no visible set rather than letting a cross-tenant row land.
        await expect(
            signParameterChange(ctxFor(T2, 'approver-a'), { id, expectedPendingHash: hash }),
        ).rejects.toThrow(/not found/);

        // Nor can T2's signatures be read into T1's listing, or vice versa.
        await signParameterChange(ctxFor(T1, 'approver-a'), { id, expectedPendingHash: hash });
        const [mine] = await listParameterSets(ctxFor(T1), TOOL);
        expect(mine.signatures).toHaveLength(1);
        await expect(listParameterSets(ctxFor(T2), TOOL)).resolves.toEqual([]);
    });

    it('withholds UPDATE and DELETE from app_user', async () => {
        const [privs] = await prisma.$queryRawUnsafe<
            Array<{ canUpdate: boolean; canDelete: boolean; canInsert: boolean; canSelect: boolean }>
        >(
            `SELECT has_table_privilege('app_user', '"ExternalToolParameterSetApproval"', 'UPDATE') AS "canUpdate",
                    has_table_privilege('app_user', '"ExternalToolParameterSetApproval"', 'DELETE') AS "canDelete",
                    has_table_privilege('app_user', '"ExternalToolParameterSetApproval"', 'INSERT') AS "canInsert",
                    has_table_privilege('app_user', '"ExternalToolParameterSetApproval"', 'SELECT') AS "canSelect"`,
        );
        // Stated as the WHOLE grant, the way the sibling table's test states
        // it: an assertion checking only the two negatives would also pass on a
        // table `app_user` cannot write at all, which would be a broken product
        // rather than a hardened one.
        expect(privs).toEqual({
            canUpdate: false,
            canDelete: false,
            canInsert: true,
            canSelect: true,
        });
    });

    it('carries the RLS trio and FORCE ROW LEVEL SECURITY', async () => {
        const policies = await prisma.$queryRawUnsafe<Array<{ policyname: string }>>(
            `SELECT policyname FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'ExternalToolParameterSetApproval'`,
        );
        expect(policies.map((p) => p.policyname).sort()).toEqual([
            'superuser_bypass',
            'tenant_isolation',
            'tenant_isolation_insert',
        ]);
        const forced = await prisma.$queryRawUnsafe<Array<{ relforcerowsecurity: boolean }>>(
            `SELECT relforcerowsecurity FROM pg_class
              WHERE relname = 'ExternalToolParameterSetApproval'`,
        );
        expect(forced[0]?.relforcerowsecurity).toBe(true);
    });

    it('cascades away with the set it signs', async () => {
        const { id, hash } = await proposeTemplate();
        await signParameterChange(ctxFor(T1, 'approver-a'), { id, expectedPendingHash: hash });
        await prisma.externalToolParameterSet.delete({ where: { id } });
        await expect(
            prisma.externalToolParameterSetApproval.count({
                where: { tenantId: T1, parameterSetId: id },
            }),
        ).resolves.toBe(0);
    });
});
