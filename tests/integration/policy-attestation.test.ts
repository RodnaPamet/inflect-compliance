/**
 * Integration (live-DB) test for the policy-attestation loop (Prompt-1).
 *
 * Covers attest (happy + idempotent + non-PUBLISHED refused), the required-
 * acknowledgement campaign (assign → roster % complete), and the shared
 * coverage predicate gating (a PUBLISHED policy counts in coverageSummary; a
 * DRAFT does not).
 *
 * Hits a real DB (project convention).
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { createPolicy, getPolicy, publishPolicy, createPolicyVersion, listPolicies } from '@/app-layer/usecases/policy';
import {
    attestPolicy,
    requirePolicyAcknowledgement,
    getPolicyAcknowledgementRoster,
    getPolicyAttestation,
} from '@/app-layer/usecases/policy-attestation';
import { coverageSummary } from '@/app-layer/usecases/traceability';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE_TAG = `pol-att-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${SUITE_TAG}`;

let adminUserId: string;
let readerUserId: string;
let admin: ReturnType<typeof makeRequestContext>;
let reader: ReturnType<typeof makeRequestContext>;
let publishedPolicyId: string;
let draftPolicyId: string;

async function makeUser(label: string, role: Role): Promise<string> {
    const email = `${SUITE_TAG}-${label}@example.test`;
    const u = await globalPrisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await globalPrisma.tenantMembership.create({
        data: { tenantId: TENANT_ID, userId: u.id, role, status: MembershipStatus.ACTIVE },
    });
    return u.id;
}

describeFn('policy attestation loop (integration)', () => {
    beforeAll(async () => {
        await globalPrisma.tenant.upsert({
            where: { id: TENANT_ID },
            update: {},
            create: { id: TENANT_ID, name: `t ${SUITE_TAG}`, slug: SUITE_TAG },
        });
        adminUserId = await makeUser('admin', Role.ADMIN);
        readerUserId = await makeUser('reader', Role.READER);
        admin = makeRequestContext('ADMIN', { tenantId: TENANT_ID, tenantSlug: SUITE_TAG, userId: adminUserId });
        reader = makeRequestContext('READER', { tenantId: TENANT_ID, tenantSlug: SUITE_TAG, userId: readerUserId });

        // A PUBLISHED policy (via the emergency bypass to skip the approval dance).
        const published = await createPolicy(admin, { title: `Acceptable Use ${SUITE_TAG}`, content: '# Body' });
        const full = await getPolicy(admin, published.id);
        const versionId = full.currentVersion?.id ?? full.versions[0].id;
        await publishPolicy(admin, published.id, versionId, { bypassApprovalReason: 'integration-test' });
        publishedPolicyId = published.id;

        // A DRAFT policy (never published).
        const draft = await createPolicy(admin, { title: `Draft ${SUITE_TAG}`, content: '# Draft' });
        draftPolicyId = draft.id;
    });

    afterAll(async () => {
        await globalPrisma.notification.deleteMany({ where: { tenantId: TENANT_ID } }).catch(() => {});
        await globalPrisma.policyApproval.deleteMany({ where: { tenantId: TENANT_ID } }).catch(() => {});
        // PolicyAcknowledgement + PolicyAcknowledgementAssignment cascade on version delete.
        await globalPrisma.policyVersion.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.policy.deleteMany({ where: { tenantId: TENANT_ID } });
        await deleteAuditRowsForTenants(globalPrisma, TENANT_ID);
        await globalPrisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT_ID);
        });
        await globalPrisma.user.deleteMany({ where: { id: { in: [adminUserId, readerUserId] } } });
        await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } });
        await globalPrisma.$disconnect();
    });

    it('a DRAFT policy cannot be attested', async () => {
        await expect(attestPolicy(reader, draftPolicyId)).rejects.toThrow(/Only PUBLISHED/);
    });

    it('any member can attest a PUBLISHED policy (created: true), idempotently (created: false)', async () => {
        const first = await attestPolicy(reader, publishedPolicyId);
        expect(first.created).toBe(true);
        expect(first.userId).toBe(readerUserId);

        const again = await attestPolicy(reader, publishedPolicyId);
        expect(again.created).toBe(false);
        expect(again.acknowledgementId).toBe(first.acknowledgementId);

        const status = await getPolicyAttestation(reader, publishedPolicyId);
        expect(status?.userId).toBe(readerUserId);
    });

    it('a required-acknowledgement campaign tracks % complete and who is outstanding', async () => {
        // Require all active members (admin + reader) to acknowledge.
        const res = await requirePolicyAcknowledgement(admin, publishedPolicyId, { audience: { type: 'all' } });
        expect(res.assignedCount).toBe(2);

        const roster = await getPolicyAcknowledgementRoster(admin, publishedPolicyId);
        expect(roster.assignedCount).toBe(2);
        // reader acknowledged in the previous test; admin has not.
        expect(roster.acknowledgedCount).toBe(1);
        expect(roster.pctComplete).toBe(50);
        const adminEntry = roster.entries.find((e) => e.userId === adminUserId);
        expect(adminEntry?.required).toBe(true);
        expect(adminEntry?.acknowledgedAt).toBeNull();
    });

    it('coverageSummary counts the PUBLISHED policy but not the DRAFT', async () => {
        const cov = (await coverageSummary(admin)) as { totalPolicies: number };
        // Exactly one policy counts: the published one (the draft is excluded).
        expect(cov.totalPolicies).toBe(1);
    });

    it('a named-user audience assigns exactly the named active members', async () => {
        const p = await createPolicy(admin, { title: `NamedAudience ${SUITE_TAG}`, content: '# v1' });
        const full = await getPolicy(admin, p.id);
        await publishPolicy(admin, p.id, full.currentVersion?.id ?? full.versions[0].id, { bypassApprovalReason: 'test' });

        // Name the reader plus a bogus id — the bogus id is dropped (not active).
        const res = await requirePolicyAcknowledgement(admin, p.id, {
            audience: { type: 'users', userIds: [readerUserId, 'ghost-user-id'] },
        });
        expect(res.assignedCount).toBe(1);
        const roster = await getPolicyAcknowledgementRoster(admin, p.id);
        expect(roster.entries.filter((e) => e.required).map((e) => e.userId)).toEqual([readerUserId]);
        // Provenance: the admin requested it.
        expect(roster.entries.find((e) => e.userId === readerUserId)?.assignedById).toBe(adminUserId);
    });

    it('re-publishing a revised policy carries the acknowledgement requirement forward; stale acks do not count', async () => {
        const p = await createPolicy(admin, { title: `Carryforward ${SUITE_TAG}`, content: '# v1' });
        const full = await getPolicy(admin, p.id);
        const v1 = full.currentVersion?.id ?? full.versions[0].id;
        await publishPolicy(admin, p.id, v1, { bypassApprovalReason: 'test' });

        // Require the reader, and have them acknowledge v1.
        await requirePolicyAcknowledgement(admin, p.id, { audience: { type: 'users', userIds: [readerUserId] } });
        await attestPolicy(reader, p.id);
        let roster = await getPolicyAcknowledgementRoster(admin, p.id);
        expect(roster.acknowledgedCount).toBe(1);

        // Revise → create + publish v2. Clear the v1 notifications first so the
        // re-notify assertion below isn't confused by the original campaign.
        const v2 = await createPolicyVersion(admin, p.id, { contentType: 'MARKDOWN', contentText: '# v2', changeSummary: 'revised' });
        await globalPrisma.notification.deleteMany({ where: { tenantId: TENANT_ID, userId: readerUserId } });
        await publishPolicy(admin, p.id, v2.id, { bypassApprovalReason: 'test' });

        // The requirement carried forward to v2; the reader is assigned again,
        // but their v1 ack is now STALE and does NOT count toward completion.
        roster = await getPolicyAcknowledgementRoster(admin, p.id);
        expect(roster.assignedCount).toBe(1);
        expect(roster.acknowledgedCount).toBe(0);
        const entry = roster.entries.find((e) => e.userId === readerUserId);
        expect(entry?.status).toBe('ACKNOWLEDGED_SUPERSEDED');
        expect(entry?.supersededAckAt).not.toBeNull();

        // The carried assignee was re-notified (dedupeKey scoped to the new version).
        const notif = await globalPrisma.notification.findFirst({
            where: { tenantId: TENANT_ID, userId: readerUserId, dedupeKey: `POLICY_ACK_REQUIRED:${v2.id}:${readerUserId}` },
        });
        expect(notif).not.toBeNull();
    });

    it('the list rollup counts the INTERSECTION — a voluntary ack by a non-assigned user does not count', async () => {
        const p = await createPolicy(admin, { title: `Voluntary ${SUITE_TAG}`, content: '# v1' });
        const full = await getPolicy(admin, p.id);
        await publishPolicy(admin, p.id, full.currentVersion?.id ?? full.versions[0].id, { bypassApprovalReason: 'test' });

        // Require the ADMIN only, then have the READER attest voluntarily.
        // The reader is NOT assigned, so their ack must not reduce the
        // outstanding count — this is what the LEFT JOIN on (version, user)
        // buys over a plain groupBy of acknowledgements.
        await requirePolicyAcknowledgement(admin, p.id, {
            audience: { type: 'users', userIds: [adminUserId] },
        });
        await attestPolicy(reader, p.id);

        const rows = (await listPolicies(admin)) as Array<{
            id: string;
            acknowledgement: { assignedCount: number; acknowledgedCount: number; outstanding: boolean };
        }>;
        const row = rows.find((r) => r.id === p.id);
        expect(row?.acknowledgement).toEqual({
            assignedCount: 1,
            acknowledgedCount: 0,
            outstanding: true,
        });

        // And once the ASSIGNED user acknowledges, the campaign closes.
        await attestPolicy(admin, p.id);
        const after = (await listPolicies(admin)) as Array<{ id: string; acknowledgement: { acknowledgedCount: number; outstanding: boolean } }>;
        expect(after.find((r) => r.id === p.id)?.acknowledgement).toEqual({
            assignedCount: 1,
            acknowledgedCount: 1,
            outstanding: false,
        });
    });

    it('the outstandingAck filter narrows server-side, in the WHERE', async () => {
        // Fully-acknowledged (closed in the previous test) vs still-outstanding.
        const closedTitle = `Voluntary ${SUITE_TAG}`;
        const openTitle = `Outstanding ${SUITE_TAG}`;

        const open = await createPolicy(admin, { title: openTitle, content: '# v1' });
        const openFull = await getPolicy(admin, open.id);
        await publishPolicy(admin, open.id, openFull.currentVersion?.id ?? openFull.versions[0].id, { bypassApprovalReason: 'test' });
        await requirePolicyAcknowledgement(admin, open.id, {
            audience: { type: 'users', userIds: [readerUserId] },
        });

        const filtered = (await listPolicies(admin, { outstandingAck: true })) as Array<{
            id: string;
            title: string;
            acknowledgement: { outstanding: boolean };
        }>;
        const titles = filtered.map((r) => r.title);
        expect(titles).toContain(openTitle);
        expect(titles).not.toContain(closedTitle);
        // Every returned row genuinely has an unmet requirement — the filter is
        // a `currentVersionId IN (…)` narrowing, not a post-fetch predicate.
        for (const r of filtered) {
            expect(r.acknowledgement.outstanding).toBe(true);
        }

        // A DRAFT policy is never outstanding (no published version to ack).
        expect(filtered.map((r) => r.id)).not.toContain(draftPolicyId);
    });
});
