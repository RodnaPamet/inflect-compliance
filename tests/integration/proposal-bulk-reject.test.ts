/**
 * BULK REJECT — atomic over the rows that can be rejected, explicit about the
 * rest.
 *
 * The usecase's own header states the decision and the reasoning; these are the
 * assertions that make it a checkable claim rather than a paragraph. Three
 * things have to be true at once, and each one is a different way for the
 * feature to be quietly wrong:
 *
 *   1. THE ACCEPTED ROWS ACTUALLY MOVE. A response naming ids it did not write
 *      is the worst of the three, because the queue looks cleared and the audit
 *      trail disagrees — so the rows are re-read from the database rather than
 *      believed from the return value.
 *
 *   2. THE REFUSED ROWS ARE UNTOUCHED AND NAMED. "Reject what is rejectable"
 *      degrades into "silently drop what is inconvenient" the moment the reply
 *      stops saying which rows those were. Every skip is asserted with its
 *      reason AND against the row's stored status.
 *
 *   3. THE REFUSALS STILL AUDIT. A quarantined row refused through the single
 *      path writes an AUTHZ_DENIED entry; if the bulk path skipped it quietly,
 *      bulk would be the way to attempt disposal of evidence without leaving a
 *      trail. That is the one refusal whose audit row is asserted directly.
 *
 * And the positive companion, which the other three need to mean anything: a
 * batch of nothing but pending rows rejects ALL of them. A usecase that refused
 * everything would satisfy every "was not rejected" assertion below while
 * taking the bulk control entirely dark.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import {
    bulkRejectAgentProposals,
    createAgentProposal,
    rejectAgentProposal,
} from '@/app-layer/usecases/agent-proposals';
import { NO_POLICY_CARD } from '@/lib/agentic/policy-card';
import { makeRequestContext } from '../helpers/make-context';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `pbulk-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
/** A second tenant, so "another tenant's id" is a real row rather than a typo. */
const OTHER_TENANT = `o-${SUITE}`;
const USER = `u-${SUITE}`;
const OTHER_USER = `ou-${SUITE}`;

const ctx = () =>
    makeRequestContext('OWNER', { tenantId: TENANT, tenantSlug: TENANT, userId: USER });
const otherCtx = () =>
    makeRequestContext('OWNER', {
        tenantId: OTHER_TENANT,
        tenantSlug: OTHER_TENANT,
        userId: OTHER_USER,
    });

const PAYLOAD = {
    title: `${SUITE} unevidenced access recertification`,
    description:
        'The quarterly access recertification for the production account has no ' +
        'signed reviewer record. Remediation is to attach the identity-provider ' +
        'export and have the system owner sign off.',
};

/** Queue one PENDING proposal and hand back its id. */
async function queueProposal(
    who: ReturnType<typeof ctx> = ctx(),
    suffix = randomUUID().slice(0, 6),
): Promise<string> {
    const created = await createAgentProposal(who, {
        kind: 'RISK',
        payload: { ...PAYLOAD, title: `${PAYLOAD.title} ${suffix}` },
        policyCardVersion: NO_POLICY_CARD,
    });
    return created.id;
}

async function statusOf(id: string): Promise<string> {
    const row = await prisma.agentProposal.findFirstOrThrow({ where: { id } });
    return row.status;
}

async function seedTenant(tenantId: string, userId: string): Promise<void> {
    await prisma.tenant.upsert({
        where: { id: tenantId },
        update: {},
        create: { id: tenantId, name: tenantId, slug: tenantId },
    });
    const email = `${userId}@example.test`;
    await prisma.user.upsert({
        where: { id: userId },
        update: {},
        create: { id: userId, email, emailHash: hashForLookup(email) },
    });
    await prisma.tenantMembership.upsert({
        where: { tenantId_userId: { tenantId, userId } },
        update: { role: 'OWNER', status: 'ACTIVE' },
        create: { tenantId, userId, role: 'OWNER', status: 'ACTIVE' },
    });
    await prisma.tenantSecuritySettings.upsert({
        where: { tenantId },
        update: { requireRegisteredAgent: false, aiGuardMode: 'AUDIT' },
        create: { tenantId, requireRegisteredAgent: false, aiGuardMode: 'AUDIT' },
    });
}

describeFn('bulk proposal reject is atomic over what it can reject', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await seedTenant(TENANT, USER);
        await seedTenant(OTHER_TENANT, OTHER_USER);
    }, 120_000);

    afterAll(async () => {
        await prisma.$disconnect();
    });

    it('rejects every pending row in a clean batch — the positive control', async () => {
        const ids = [await queueProposal(), await queueProposal(), await queueProposal()];

        const result = await bulkRejectAgentProposals(ctx(), ids);

        expect(result.rejected.sort()).toStrictEqual([...ids].sort());
        expect(result.skipped).toStrictEqual([]);
        // Re-read, because a return value naming ids it never wrote is exactly
        // the failure this assertion exists to catch.
        for (const id of ids) {
            expect(await statusOf(id)).toBe('REJECTED');
        }
    });

    it('rejects the rejectable rows and names each one it did not, with its reason', async () => {
        const pending = await queueProposal();
        const alreadyDecided = await queueProposal();
        await rejectAgentProposal(ctx(), alreadyDecided);
        const expired = await queueProposal();
        await prisma.agentProposal.update({
            where: { id: expired },
            // The state a real closed window leaves a row in for most of its
            // life: deadline past, status still PENDING until the nightly
            // sweep notices.
            data: { expiresAt: new Date(Date.now() - 60_000) },
        });
        const foreign = await queueProposal(otherCtx());
        const absent = `missing-${randomUUID()}`;

        const result = await bulkRejectAgentProposals(ctx(), [
            pending,
            alreadyDecided,
            expired,
            foreign,
            absent,
        ]);

        expect(result.rejected).toStrictEqual([pending]);
        expect([...result.skipped].sort((a, b) => a.id.localeCompare(b.id))).toStrictEqual(
            [
                { id: alreadyDecided, reason: 'NOT_PENDING' },
                { id: expired, reason: 'EXPIRED' },
                // Another tenant's row and an id that exists nowhere give the
                // SAME answer. Telling them apart would confirm that an id
                // exists in some tenant the caller cannot see.
                { id: foreign, reason: 'NOT_FOUND' },
                { id: absent, reason: 'NOT_FOUND' },
            ].sort((a, b) => a.id.localeCompare(b.id)),
        );

        expect(await statusOf(pending)).toBe('REJECTED');
        // The expired row is the one that matters here: leaving it PENDING is
        // the difference between "nobody decided in time" and "somebody
        // decided no", and the bulk path must not improve that record either.
        expect(await statusOf(expired)).toBe('PENDING');
        expect(await statusOf(foreign)).toBe('PENDING');
    });

    it('refuses a quarantined row AND leaves the same audit trail the single path leaves', async () => {
        const quarantined = await queueProposal();
        await prisma.agentProposal.update({
            where: { id: quarantined },
            data: { status: 'QUARANTINED', guardVerdict: 'QUARANTINED' },
        });
        const pending = await queueProposal();

        const result = await bulkRejectAgentProposals(ctx(), [quarantined, pending]);

        expect(result.rejected).toStrictEqual([pending]);
        expect(result.skipped).toStrictEqual([
            { id: quarantined, reason: 'QUARANTINED' },
        ]);
        expect(await statusOf(quarantined)).toBe('QUARANTINED');

        const denials = await prisma.auditLog.findMany({
            where: { tenantId: TENANT, entityId: quarantined, action: 'AUTHZ_DENIED' },
            select: { detailsJson: true },
        });
        expect(denials).toHaveLength(1);
        expect(denials[0].detailsJson).toMatchObject({
            reason: 'agent_proposal_quarantined',
            attemptedAction: 'reject',
        });
    });

    it('records one rejection audit entry per row it moved, and none for the rest', async () => {
        const moved = await queueProposal();
        const stale = await queueProposal();
        await rejectAgentProposal(ctx(), stale);
        const auditsBefore = await prisma.auditLog.count({
            where: { tenantId: TENANT, entityId: stale, action: 'AGENT_PROPOSAL_REJECTED' },
        });

        await bulkRejectAgentProposals(ctx(), [moved, stale]);

        expect(
            await prisma.auditLog.count({
                where: { tenantId: TENANT, entityId: moved, action: 'AGENT_PROPOSAL_REJECTED' },
            }),
        ).toBe(1);
        // The already-decided row gains nothing: a second entry would put two
        // rejections of one proposal in the trail, by two different reviewers.
        expect(
            await prisma.auditLog.count({
                where: { tenantId: TENANT, entityId: stale, action: 'AGENT_PROPOSAL_REJECTED' },
            }),
        ).toBe(auditsBefore);
    });

    it('counts a repeated id once', async () => {
        const id = await queueProposal();

        const result = await bulkRejectAgentProposals(ctx(), [id, id]);

        expect(result.rejected).toStrictEqual([id]);
        expect(result.skipped).toStrictEqual([]);
    });
});
