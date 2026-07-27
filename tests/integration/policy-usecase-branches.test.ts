/**
 * Branch-coverage integration test for the policy usecases — exercises
 * not-found throws, READER (canWrite) + EDITOR (canAdmin) permission
 * denials, the createPolicyVersion validation matrix (archived /
 * EXTERNAL_LINK-without-url / MARKDOWN-without-text / published→draft),
 * the approval workflow (request → decide APPROVED/REJECTED → conflict),
 * the publish approval-gate + bypass branches, review/metadata
 * three-states, template instantiation, and the bulk-action empty /
 * non-empty branches.
 *
 * Hits a real DB (project convention).
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import {
    listPolicies,
    listPoliciesPaginated,
    getPolicy,
    listPolicyTemplates,
    getPolicyActivity,
    createPolicy,
    createPolicyFromTemplate,
    markPolicyReviewed,
    createPolicyVersion,
    rollbackPolicy,
    updatePolicyMetadata,
    requestPolicyApproval,
    decidePolicyApproval,
    publishPolicy,
    archivePolicy,
    deletePolicy,
    listPoliciesWithDeleted,
    bulkAssignPolicy,
    bulkDeletePolicy,
    bulkArchivePolicy,
} from '@/app-layer/usecases/policy';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE_TAG = `pol-br-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${SUITE_TAG}`;

let ownerUserId: string;
let adminUserId: string;
let editorUserId: string;
let readerUserId: string;
let templateId: string;
let ctx: ReturnType<typeof makeRequestContext>;
let editor: ReturnType<typeof makeRequestContext>;
let reader: ReturnType<typeof makeRequestContext>;

async function makeUser(label: string, role: Role): Promise<string> {
    const email = `${SUITE_TAG}-${label}@example.test`;
    const u = await globalPrisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await globalPrisma.tenantMembership.create({
        data: { tenantId: TENANT_ID, userId: u.id, role, status: MembershipStatus.ACTIVE },
    });
    return u.id;
}

describeFn('policy usecase — branch coverage (integration)', () => {
    beforeAll(async () => {
        await globalPrisma.tenant.upsert({
            where: { id: TENANT_ID },
            update: {},
            create: { id: TENANT_ID, name: `t ${SUITE_TAG}`, slug: SUITE_TAG },
        });
        ownerUserId = await makeUser('owner', Role.OWNER);
        adminUserId = await makeUser('admin', Role.ADMIN);
        editorUserId = await makeUser('editor', Role.EDITOR);
        readerUserId = await makeUser('reader', Role.READER);
        const tmpl = await globalPrisma.policyTemplate.create({
            data: {
                title: `Tmpl ${SUITE_TAG}`,
                category: 'Security',
                contentType: 'MARKDOWN',
                contentText: '# Template body\n\nSome policy text.',
            },
        });
        templateId = tmpl.id;
        ctx = makeRequestContext('OWNER', { tenantId: TENANT_ID, tenantSlug: SUITE_TAG, userId: ownerUserId });
        editor = makeRequestContext('EDITOR', { tenantId: TENANT_ID, tenantSlug: SUITE_TAG, userId: editorUserId });
        reader = makeRequestContext('READER', { tenantId: TENANT_ID, tenantSlug: SUITE_TAG, userId: readerUserId });
    });

    afterAll(async () => {
        await globalPrisma.notificationOutbox.deleteMany({ where: { tenantId: TENANT_ID } }).catch(() => {});
        await globalPrisma.policyApproval.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.policyEvidenceItem.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.policyVersion.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.policy.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.policyTemplate.deleteMany({ where: { id: templateId } });
        await globalPrisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, TENANT_ID);
            await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT_ID);
        });
        await globalPrisma.user.deleteMany({ where: { id: { in: [ownerUserId, adminUserId, editorUserId, readerUserId] } } });
        await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } });
        await globalPrisma.$disconnect();
    });

    it('not-found paths throw across read + mutation usecases', async () => {
        await expect(getPolicy(ctx, 'nope')).rejects.toThrow(/not found/i);
        await expect(markPolicyReviewed(ctx, 'nope')).rejects.toThrow(/not found/i);
        await expect(createPolicyVersion(ctx, 'nope', { contentType: 'MARKDOWN', contentText: 'x' })).rejects.toThrow(/not found/i);
        await expect(updatePolicyMetadata(ctx, 'nope', { title: 'x' })).rejects.toThrow(/not found/i);
        await expect(requestPolicyApproval(ctx, 'nope', 'v')).rejects.toThrow(/not found/i);
        await expect(decidePolicyApproval(ctx, 'p1', 'nope', { decision: 'APPROVED' })).rejects.toThrow(/not found/i);
        await expect(publishPolicy(ctx, 'nope', 'v')).rejects.toThrow(/not found/i);
        await expect(archivePolicy(ctx, 'nope')).rejects.toThrow(/not found/i);
        await expect(deletePolicy(ctx, 'nope')).rejects.toThrow(/not found/i);
        await expect(createPolicyFromTemplate(ctx, 'nope')).rejects.toThrow(/not found/i);
        expect(Array.isArray(await listPolicies(ctx))).toBe(true);
        expect(await listPoliciesPaginated(ctx, { take: 5 } as any)).toBeDefined();
        expect(Array.isArray(await listPolicyTemplates(ctx))).toBe(true);
    });

    it('permission denials: READER (write) + EDITOR (admin)', async () => {
        await expect(createPolicy(reader, { title: 'x' })).rejects.toThrow(/permission|denied/i);
        await expect(createPolicyVersion(reader, 'x', { contentType: 'MARKDOWN', contentText: 'y' })).rejects.toThrow(/permission|denied/i);
        await expect(updatePolicyMetadata(reader, 'x', {})).rejects.toThrow(/permission|denied/i);
        await expect(markPolicyReviewed(reader, 'x')).rejects.toThrow(/permission|denied/i);
        await expect(requestPolicyApproval(reader, 'x', 'v')).rejects.toThrow(/permission|denied/i);
        await expect(bulkAssignPolicy(reader, ['x'], null)).rejects.toThrow(/permission|denied/i);

        // EDITOR can write but not admin
        await expect(decidePolicyApproval(editor, 'p1', 'x', { decision: 'APPROVED' })).rejects.toThrow(/permission|denied/i);
        await expect(publishPolicy(editor, 'x', 'v')).rejects.toThrow(/permission|denied/i);
        await expect(archivePolicy(editor, 'x')).rejects.toThrow(/permission|denied/i);
        await expect(deletePolicy(editor, 'x')).rejects.toThrow(/permission|denied/i);
        await expect(bulkArchivePolicy(editor, ['x'])).rejects.toThrow(/permission|denied/i);
        await expect(bulkDeletePolicy(editor, ['x'])).rejects.toThrow(/permission|denied/i);
        await expect(listPoliciesWithDeleted(editor)).rejects.toThrow(/permission|denied/i);
    });

    it('createPolicy: with content + slug collision + empty-title fallback', async () => {
        const p1 = await createPolicy(ctx, { title: 'Access Control', content: '# Hello', category: 'Sec' });
        expect(p1.slug).toBe('access-control');
        const versions = await globalPrisma.policyVersion.findMany({ where: { policyId: p1.id } });
        expect(versions).toHaveLength(1);

        // collision → -1 suffix
        const p2 = await createPolicy(ctx, { title: 'Access Control' });
        expect(p2.slug).toBe('access-control-1');

        // empty/symbol title → base 'policy'
        const p3 = await createPolicy(ctx, { title: '!!!' });
        expect(p3.slug).toBe('policy');

        await getPolicyActivity(ctx, p1.id);
    });

    it('createPolicyVersion validation + published→draft transition', async () => {
        const policy = await createPolicy(ctx, { title: `Versioned ${randomUUID().slice(0, 6)}` });

        // EXTERNAL_LINK without url → badRequest
        await expect(
            createPolicyVersion(ctx, policy.id, { contentType: 'EXTERNAL_LINK' }),
        ).rejects.toThrow(/externalUrl is required/i);

        // MARKDOWN without text → badRequest
        await expect(
            createPolicyVersion(ctx, policy.id, { contentType: 'MARKDOWN' }),
        ).rejects.toThrow(/contentText is required/i);

        // valid HTML version
        const v = await createPolicyVersion(ctx, policy.id, { contentType: 'HTML', contentText: '<p>hi</p>' });
        expect(v.versionNumber).toBeGreaterThanOrEqual(1);

        // move policy to APPROVED, then a new version drops it back to DRAFT
        await globalPrisma.policy.update({ where: { id: policy.id }, data: { status: 'APPROVED' } });
        await createPolicyVersion(ctx, policy.id, { contentType: 'MARKDOWN', contentText: 'more' });
        const after = await getPolicy(ctx, policy.id);
        expect(after.status).toBe('DRAFT');

        // archived policy rejects new versions
        await globalPrisma.policy.update({ where: { id: policy.id }, data: { status: 'ARCHIVED' } });
        await expect(
            createPolicyVersion(ctx, policy.id, { contentType: 'MARKDOWN', contentText: 'z' }),
        ).rejects.toThrow(/archived/i);
    });

    // Helper: seed a PENDING/decided PolicyApproval row directly via the
    // independent globalPrisma client. The app-prisma read-after-write of a
    // PolicyApproval written in `requestPolicyApproval`'s own (audit +
    // email-enqueue) transaction is occasionally invisible to the very next
    // app-prisma transaction under the pg connection pool, so deciding tests
    // seed through globalPrisma (a separate, fully-committed connection that
    // every app-prisma read reliably sees).
    async function seedApproval(policyId: string, versionId: string, status: 'PENDING' | 'APPROVED' = 'PENDING', requesterId: string = editorUserId) {
        return globalPrisma.policyApproval.create({
            data: {
                tenantId: TENANT_ID,
                policyId,
                policyVersionId: versionId,
                // Requester defaults to the EDITOR so the OWNER (ctx) can decide
                // without tripping the segregation-of-duties self-approval guard.
                requestedByUserId: requesterId,
                status,
            },
        });
    }

    it('requestPolicyApproval: version mismatch + happy IN_REVIEW transition', async () => {
        const policy = await createPolicy(ctx, { title: `Approve ${randomUUID().slice(0, 6)}` });
        const v = await createPolicyVersion(ctx, policy.id, { contentType: 'MARKDOWN', contentText: 'body' });

        // version not belonging to policy → badRequest
        const other = await createPolicy(ctx, { title: `Other ${randomUUID().slice(0, 6)}` });
        const ov = await createPolicyVersion(ctx, other.id, { contentType: 'MARKDOWN', contentText: 'x' });
        await expect(requestPolicyApproval(ctx, policy.id, ov.id)).rejects.toThrow(/does not belong/i);

        // request (notifies the ADMIN member) → IN_REVIEW + PENDING approval
        const approval = await requestPolicyApproval(ctx, policy.id, v.id);
        expect(approval.id).toBeTruthy();
        const inReview = await getPolicy(ctx, policy.id);
        expect(inReview.status).toBe('IN_REVIEW');
    });

    it('decidePolicyApproval: APPROVED, REJECTED, and already-decided conflict', async () => {
        const policy = await createPolicy(ctx, { title: `Decide ${randomUUID().slice(0, 6)}` });
        // Authored by the EDITOR so the OWNER (ctx) can APPROVE without tripping
        // the authorship SoD guard (they neither requested nor authored it).
        const v = await createPolicyVersion(editor, policy.id, { contentType: 'MARKDOWN', contentText: 'body' });
        await globalPrisma.policy.update({ where: { id: policy.id }, data: { status: 'IN_REVIEW' } });

        // APPROVED branch → policy APPROVED
        const a1 = await seedApproval(policy.id, v.id);
        const decided = await decidePolicyApproval(ctx, policy.id, a1.id, { decision: 'APPROVED', comment: 'lgtm' });
        expect(decided).toBeTruthy();
        expect((await getPolicy(ctx, policy.id)).status).toBe('APPROVED');

        // already-decided (seed an APPROVED row) → conflict
        const aDone = await seedApproval(policy.id, v.id, 'APPROVED');
        await expect(decidePolicyApproval(ctx, policy.id, aDone.id, { decision: 'APPROVED' })).rejects.toThrow(/already been decided/i);

        // REJECTED branch → policy DRAFT
        await globalPrisma.policy.update({ where: { id: policy.id }, data: { status: 'IN_REVIEW' } });
        const a2 = await seedApproval(policy.id, v.id);
        await decidePolicyApproval(ctx, policy.id, a2.id, { decision: 'REJECTED', comment: 'no' });
        expect((await getPolicy(ctx, policy.id)).status).toBe('DRAFT');
    });

    it('decidePolicyApproval: segregation of duties — the requester cannot APPROVE their own request', async () => {
        const policy = await createPolicy(ctx, { title: `SoD ${randomUUID().slice(0, 6)}` });
        const v = await createPolicyVersion(ctx, policy.id, { contentType: 'MARKDOWN', contentText: 'body' });
        await globalPrisma.policy.update({ where: { id: policy.id }, data: { status: 'IN_REVIEW' } });

        // Requested by the OWNER; the OWNER (ctx) may NOT approve it.
        const selfApproval = await seedApproval(policy.id, v.id, 'PENDING', ownerUserId);
        await expect(decidePolicyApproval(ctx, policy.id, selfApproval.id, { decision: 'APPROVED' })).rejects.toThrow(/[Ss]eparation of duties|cannot approve/);
        // Still PENDING (the guard fires before any status change).
        expect((await globalPrisma.policyApproval.findUnique({ where: { id: selfApproval.id } }))?.status).toBe('PENDING');

        // A self-REJECTION is allowed (a requester may withdraw).
        await decidePolicyApproval(ctx, policy.id, selfApproval.id, { decision: 'REJECTED', comment: 'withdraw' });
        expect((await globalPrisma.policyApproval.findUnique({ where: { id: selfApproval.id } }))?.status).toBe('REJECTED');
    });

    it('publishPolicy: version mismatch, approval-gate, bypass, and approved publish', async () => {
        const policy = await createPolicy(ctx, { title: `Publish ${randomUUID().slice(0, 6)}` });
        const v = await createPolicyVersion(ctx, policy.id, { contentType: 'MARKDOWN', contentText: 'pub body' });

        // version mismatch
        const other = await createPolicy(ctx, { title: `PubOther ${randomUUID().slice(0, 6)}` });
        const ov = await createPolicyVersion(ctx, other.id, { contentType: 'MARKDOWN', contentText: 'x' });
        await expect(publishPolicy(ctx, policy.id, ov.id)).rejects.toThrow(/does not belong/i);

        // DRAFT + no bypass → blocked
        await expect(publishPolicy(ctx, policy.id, v.id)).rejects.toThrow(/cannot publish/i);

        // DRAFT + bypass reason → publishes (bypass audit)
        const bypassed = await publishPolicy(ctx, policy.id, v.id, { bypassApprovalReason: 'emergency hotfix' });
        expect(bypassed!.status).toBe('PUBLISHED');
        const bypassRows = await globalPrisma.auditLog.findMany({
            where: { tenantId: TENANT_ID, entityId: policy.id, action: 'POLICY_PUBLISH_BYPASS' },
        });
        expect(bypassRows.length).toBeGreaterThanOrEqual(1);

        // APPROVED publish (no bypass needed).
        //
        // The APPROVED approval row is seeded alongside the status, because
        // publish now BINDS the version it publishes to the version that was
        // actually approved. Forcing `status: 'APPROVED'` alone produces a
        // state the product cannot reach — `decidePolicyApproval` is the only
        // path that sets APPROVED, and it always leaves a record — so the
        // shortcut was asserting against a shape that does not occur.
        const policy2 = await createPolicy(ctx, { title: `PubApproved ${randomUUID().slice(0, 6)}` });
        const v2 = await createPolicyVersion(ctx, policy2.id, { contentType: 'MARKDOWN', contentText: 'b' });
        await globalPrisma.policy.update({ where: { id: policy2.id }, data: { status: 'APPROVED' } });
        await seedApproval(policy2.id, v2.id, 'APPROVED');
        const published = await publishPolicy(ctx, policy2.id, v2.id);
        expect(published!.status).toBe('PUBLISHED');

        // ...and publishing a DIFFERENT version than the approved one is
        // refused. This is the exploit the binding closes: draft v1 and v2,
        // get v1 approved, then publish v2 — unreviewed content going live
        // under an APPROVED status, with none of decidePolicyApproval's
        // separation-of-duties checks in the way.
        const policy3 = await createPolicy(ctx, { title: `PubBind ${randomUUID().slice(0, 6)}` });
        const p3v1 = await createPolicyVersion(ctx, policy3.id, { contentType: 'MARKDOWN', contentText: 'reviewed' });
        const p3v2 = await createPolicyVersion(ctx, policy3.id, { contentType: 'MARKDOWN', contentText: 'NOT reviewed' });
        await globalPrisma.policy.update({ where: { id: policy3.id }, data: { status: 'APPROVED' } });
        await seedApproval(policy3.id, p3v1.id, 'APPROVED');
        await expect(publishPolicy(ctx, policy3.id, p3v2.id)).rejects.toThrow(/not the version that was approved/i);
        // The approved version still publishes.
        const ok = await publishPolicy(ctx, policy3.id, p3v1.id);
        expect(ok!.status).toBe('PUBLISHED');
    });

    it('requestPolicyApproval refuses to withdraw a PUBLISHED policy, and dedupes open requests', async () => {
        const policy = await createPolicy(ctx, { title: `Guard ${randomUUID().slice(0, 6)}`, content: '# body' });
        const full = await getPolicy(ctx, policy.id);
        const v1 = full.currentVersion!.id;

        // Publish it (bypass — the point here is the PUBLISHED end state).
        await publishPolicy(ctx, policy.id, v1, { bypassApprovalReason: 'seed' });
        expect((await getPolicy(ctx, policy.id)).status).toBe('PUBLISHED');

        // Requesting approval on a LIVE policy used to set IN_REVIEW
        // unconditionally — silently withdrawing it: attestPolicy requires
        // PUBLISHED, so every acknowledgement stopped being possible, with no
        // version change and no admin involved.
        await expect(requestPolicyApproval(ctx, policy.id, v1)).rejects.toThrow(/published/i);
        expect((await getPolicy(ctx, policy.id)).status).toBe('PUBLISHED');

        // Dedupe: a second open request is refused while one is outstanding.
        const draft = await createPolicy(ctx, { title: `Dedupe ${randomUUID().slice(0, 6)}`, content: '# d' });
        const dv = (await getPolicy(ctx, draft.id)).currentVersion!.id;
        await requestPolicyApproval(ctx, draft.id, dv);
        await expect(requestPolicyApproval(ctx, draft.id, dv)).rejects.toThrow(/awaiting a decision/i);
    });

    it('a stale approval cannot un-publish a live policy, and publish supersedes outstanding requests', async () => {
        const policy = await createPolicy(ctx, { title: `Stale ${randomUUID().slice(0, 6)}`, content: '# body' });
        const v1 = (await getPolicy(ctx, policy.id)).currentVersion!.id;

        // An approval is requested (policy -> IN_REVIEW), then an admin
        // publishes via the bypass path WITHOUT deciding it. That is exactly
        // how a PENDING row ends up sitting behind a live policy.
        await requestPolicyApproval(ctx, policy.id, v1);
        const pendingRow = await globalPrisma.policyApproval.findFirst({
            where: { policyId: policy.id, status: 'PENDING' },
        });
        expect(pendingRow).toBeTruthy();

        await publishPolicy(ctx, policy.id, v1, { bypassApprovalReason: 'emergency' });
        expect((await getPolicy(ctx, policy.id)).status).toBe('PUBLISHED');

        // Publish now RESOLVES what was outstanding, so the loaded gun is gone.
        const after = await globalPrisma.policyApproval.findUnique({ where: { id: pendingRow!.id } });
        expect(after?.status).toBe('REJECTED');

        // And even if a PENDING row survives some other way, deciding it
        // against a policy that has moved on is refused rather than silently
        // dropping a LIVE policy to DRAFT and stranding its acknowledgements.
        const revived = await seedApproval(policy.id, v1, 'PENDING');
        await expect(
            decidePolicyApproval(ctx, policy.id, revived.id, { decision: 'REJECTED' }),
        ).rejects.toThrow(/no longer current/i);
        expect((await getPolicy(ctx, policy.id)).status).toBe('PUBLISHED');
    });

    it('lifecycle history + rollback (Prompt-3.1): publish increments lifecycleVersion, records prior snapshot, rollback restores it', async () => {
        const policy = await createPolicy(ctx, { title: `LC ${randomUUID().slice(0, 6)}`, content: '# v1' });
        const full = await getPolicy(ctx, policy.id);
        const v1 = full.currentVersion!.id;

        // First publish (bypass) → lifecycleVersion 2, no history yet.
        await publishPolicy(ctx, policy.id, v1, { bypassApprovalReason: 'seed' });
        let p = await getPolicy(ctx, policy.id);
        expect(p.lifecycleVersion).toBe(2);
        expect(p.lifecycleHistoryJson ?? []).toHaveLength(0);

        // Second version + publish → lifecycleVersion 3, v1 recorded in history.
        const v2 = await createPolicyVersion(ctx, policy.id, { contentType: 'MARKDOWN', contentText: '# v2' });
        await publishPolicy(ctx, policy.id, v2.id, { bypassApprovalReason: 'v2' });
        p = await getPolicy(ctx, policy.id);
        expect(p.lifecycleVersion).toBe(3);
        expect(p.currentVersionId).toBe(v2.id);
        expect(p.lifecycleHistoryJson).toHaveLength(1);
        expect((p.lifecycleHistoryJson as Array<{ versionId: string }>)[0].versionId).toBe(v1);

        // Rollback → v1 is current again; the OUTGOING v2 is SNAPSHOTTED into
        // history (reversible), not discarded, and lifecycleVersion is bumped.
        await rollbackPolicy(ctx, policy.id);
        p = await getPolicy(ctx, policy.id);
        expect(p.currentVersionId).toBe(v1);
        expect(p.status).toBe('PUBLISHED');
        expect(p.lifecycleHistoryJson).toHaveLength(1);
        expect((p.lifecycleHistoryJson as Array<{ versionId: string }>)[0].versionId).toBe(v2.id);
        expect(p.lifecycleVersion).toBe(4);

        // Rollback is REVERSIBLE — a second rollback rolls FORWARD to v2 (history
        // no longer drains to empty while the counter keeps climbing).
        await rollbackPolicy(ctx, policy.id);
        p = await getPolicy(ctx, policy.id);
        expect(p.currentVersionId).toBe(v2.id);
        expect((p.lifecycleHistoryJson as Array<{ versionId: string }>)[0].versionId).toBe(v1);
        expect(p.lifecycleVersion).toBe(5);
    });

    it('rollbackPolicy: refuses to roll back an ARCHIVED policy', async () => {
        const policy = await createPolicy(ctx, { title: `Arch ${randomUUID().slice(0, 6)}`, content: '# v1' });
        const full = await getPolicy(ctx, policy.id);
        await publishPolicy(ctx, policy.id, full.currentVersion!.id, { bypassApprovalReason: 'seed' });
        const v2 = await createPolicyVersion(ctx, policy.id, { contentType: 'MARKDOWN', contentText: '# v2' });
        await publishPolicy(ctx, policy.id, v2.id, { bypassApprovalReason: 'v2' });
        await globalPrisma.policy.update({ where: { id: policy.id }, data: { status: 'ARCHIVED' } });
        await expect(rollbackPolicy(ctx, policy.id)).rejects.toThrow(/ARCHIVED/i);
    });

    it('decidePolicyApproval: SoD covers AUTHORSHIP — the version author cannot approve, even when another user requested it', async () => {
        const admin = makeRequestContext('ADMIN', { tenantId: TENANT_ID, tenantSlug: SUITE_TAG, userId: adminUserId });
        const policy = await createPolicy(admin, { title: `AuthorSoD ${randomUUID().slice(0, 6)}` });
        // Version AUTHORED by the admin.
        const v = await createPolicyVersion(admin, policy.id, { contentType: 'MARKDOWN', contentText: 'body' });
        await globalPrisma.policy.update({ where: { id: policy.id }, data: { status: 'IN_REVIEW' } });
        // Requested by a DIFFERENT user (the owner) — so requester-SoD would NOT
        // fire for the admin; only the authorship guard catches this.
        const approval = await seedApproval(policy.id, v.id, 'PENDING', ownerUserId);
        await expect(decidePolicyApproval(admin, policy.id, approval.id, { decision: 'APPROVED' })).rejects.toThrow(/[Ss]eparation of duties|authored/);
        expect((await globalPrisma.policyApproval.findUnique({ where: { id: approval.id } }))?.status).toBe('PENDING');
    });

    it('createPolicyVersion proposeOnly (Prompt-3.2): does NOT demote a live PUBLISHED policy', async () => {
        const policy = await createPolicy(ctx, { title: `Prop ${randomUUID().slice(0, 6)}`, content: '# live' });
        const full = await getPolicy(ctx, policy.id);
        const liveVersionId = full.currentVersion!.id;
        await publishPolicy(ctx, policy.id, liveVersionId, { bypassApprovalReason: 'seed' });

        // A normal edit demotes to DRAFT...
        const normal = await createPolicyVersion(ctx, policy.id, { contentType: 'MARKDOWN', contentText: '# edit' });
        expect((await getPolicy(ctx, policy.id)).status).toBe('DRAFT');
        // re-publish to get back to a live state
        await publishPolicy(ctx, policy.id, normal.id, { bypassApprovalReason: 'republish' });
        expect((await getPolicy(ctx, policy.id)).status).toBe('PUBLISHED');

        // ...but a proposeOnly (external) change keeps the policy PUBLISHED + current unchanged.
        const proposed = await createPolicyVersion(ctx, policy.id, { contentType: 'MARKDOWN', contentText: '# external' }, { proposeOnly: true });
        const after = await getPolicy(ctx, policy.id);
        expect(after.status).toBe('PUBLISHED');
        expect(after.currentVersionId).toBe(normal.id);
        expect(after.currentVersionId).not.toBe(proposed.id);
    });

    it('markPolicyReviewed + updatePolicyMetadata three-state branches', async () => {
        // with cadence → nextReviewAt computed
        const withCadence = await createPolicy(ctx, { title: `Rev ${randomUUID().slice(0, 6)}`, reviewFrequencyDays: 30 });
        const r1 = await markPolicyReviewed(ctx, withCadence.id);
        expect(r1?.nextReviewAt).toBeTruthy();

        // without cadence → nextReviewAt null
        const noCadence = await createPolicy(ctx, { title: `Rev2 ${randomUUID().slice(0, 6)}` });
        const r2 = await markPolicyReviewed(ctx, noCadence.id);
        expect(r2?.nextReviewAt).toBeNull();

        // without cadence BUT with an explicitly-set review date → PRESERVED.
        // A manually-set nextReviewAt must survive a "mark reviewed" click
        // rather than being cleared to null.
        const manual = await createPolicy(ctx, { title: `Rev3 ${randomUUID().slice(0, 6)}` });
        await updatePolicyMetadata(ctx, manual.id, { nextReviewAt: new Date('2028-06-01').toISOString() });
        const r3 = await markPolicyReviewed(ctx, manual.id);
        expect(r3?.nextReviewAt).toEqual(new Date('2028-06-01'));

        // metadata: nextReviewAt string → Date
        await updatePolicyMetadata(ctx, withCadence.id, {
            title: 'Renamed Policy',
            nextReviewAt: new Date('2027-01-01').toISOString(),
        });
        // metadata: nextReviewAt null branch
        const m = await updatePolicyMetadata(ctx, withCadence.id, { nextReviewAt: null, description: 'd' });
        expect(m?.nextReviewAt).toBeNull();
    });

    it('createPolicyFromTemplate: with + without overrides', async () => {
        const withOverrides = await createPolicyFromTemplate(ctx, templateId, {
            title: 'Custom Title',
            category: 'Ops',
            description: 'desc',
        });
        expect(withOverrides.title).toBe('Custom Title');

        const defaults = await createPolicyFromTemplate(ctx, templateId);
        expect(defaults.title).toBe(`Tmpl ${SUITE_TAG}`);
        expect(defaults.ownerUserId).toBe(ownerUserId);
    });

    it('archive + delete + bulk-action branches', async () => {
        const a = await createPolicy(ctx, { title: `Arch ${randomUUID().slice(0, 6)}` });
        expect(await archivePolicy(ctx, a.id)).toEqual({ success: true });

        const d = await createPolicy(ctx, { title: `Del ${randomUUID().slice(0, 6)}` });
        expect(await deletePolicy(ctx, d.id)).toEqual({ success: true });

        // bulk empty branches
        expect(await bulkAssignPolicy(ctx, [], null)).toEqual({ updated: 0 });
        expect(await bulkDeletePolicy(ctx, [])).toEqual({ deleted: 0 });
        expect(await bulkArchivePolicy(ctx, [])).toEqual({ updated: 0 });

        // bulk non-empty
        const b1 = await createPolicy(ctx, { title: `Bulk1 ${randomUUID().slice(0, 6)}` });
        const b2 = await createPolicy(ctx, { title: `Bulk2 ${randomUUID().slice(0, 6)}` });
        expect((await bulkAssignPolicy(ctx, [b1.id], ownerUserId)).updated).toBe(1);
        expect((await bulkAssignPolicy(ctx, [b1.id], null)).updated).toBe(1);
        expect((await bulkArchivePolicy(ctx, [b1.id])).updated).toBe(1);
        expect((await bulkDeletePolicy(ctx, [b2.id])).deleted).toBe(1);

        // listPoliciesWithDeleted (admin)
        expect(Array.isArray(await listPoliciesWithDeleted(ctx))).toBe(true);
    });
});
