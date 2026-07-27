/**
 * Integration coverage for the evidence lifecycle + list/metrics usecases.
 *
 * Exercises the uncovered branches of:
 *   - createEvidence       (TEXT + LINK paths, control validation, folder coerce)
 *   - updateEvidence       (three-state folder, notFound)
 *   - reviewEvidence       (full state machine + auth tiers + illegal transitions
 *                           + reviewer notification with/without ownerUserId)
 *   - bulkAssignEvidence   (assign + clear + empty-set early return)
 *   - deleteEvidence / restoreEvidence / purgeEvidence (soft-delete lifecycle + guards)
 *   - getEvidenceMetrics   (counts, KB/MB formatting, top-controls, linkedRate)
 *   - listEvidence / listEvidencePaginated (type/status/control/folder/q/archived filters)
 */
process.env.STORAGE_PROVIDER = 'local';
process.env.FILE_STORAGE_ROOT =
    process.env.FILE_STORAGE_ROOT || '/tmp/test-evidence-lifecycle';

import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import {
    createEvidence,
    updateEvidence,
    reviewEvidence,
    bulkAssignEvidence,
    bulkApproveEvidence,
    deleteEvidence,
    restoreEvidence,
    purgeEvidence,
    getEvidenceMetrics,
    listEvidence,
    listEvidencePaginated,
    getEvidence,
    uploadEvidenceFile,
} from '@/app-layer/usecases/evidence';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(40_000);

const TAG = `elc-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;

let adminUserId = '';
let ownerUserId = '';
let CONTROL_ID = '';

async function makeUser(label: string): Promise<string> {
    const email = `${TAG}-${label}@example.test`;
    const u = await globalPrisma.user.create({
        data: { email, emailHash: hashForLookup(email) },
    });
    return u.id;
}

function adminCtx() {
    return makeRequestContext('ADMIN', { tenantId: TENANT_ID, userId: adminUserId, tenantSlug: TAG });
}
function editorCtx() {
    // EP-1: the editor MUST be a distinct user from the admin reviewer —
    // segregation of duties now forbids approving/rejecting evidence you
    // submitted. `ownerUserId` carries the EDITOR membership (see beforeAll).
    return makeRequestContext('EDITOR', { tenantId: TENANT_ID, userId: ownerUserId, tenantSlug: TAG });
}

async function newDraft(opts: { title: string; type?: 'TEXT' | 'LINK'; controlId?: string; ownerUserId?: string | null; folder?: string | null }) {
    return createEvidence(adminCtx(), {
        type: opts.type ?? 'TEXT',
        title: opts.title,
        content: opts.type === 'LINK' ? 'https://example.com/x' : 'some text',
        controlId: opts.controlId ?? null,
        ownerUserId: opts.ownerUserId ?? null,
        folder: opts.folder ?? undefined,
    } as never);
}

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await globalPrisma.tenant.upsert({
        where: { id: TENANT_ID },
        update: {},
        create: { id: TENANT_ID, name: `t ${TAG}`, slug: TAG },
    });
    adminUserId = await makeUser('admin');
    ownerUserId = await makeUser('owner');
    await globalPrisma.tenantMembership.create({
        data: { tenantId: TENANT_ID, userId: adminUserId, role: Role.ADMIN, status: MembershipStatus.ACTIVE },
    });
    await globalPrisma.tenantMembership.create({
        data: { tenantId: TENANT_ID, userId: ownerUserId, role: Role.EDITOR, status: MembershipStatus.ACTIVE },
    });
    const control = await globalPrisma.control.create({
        data: { tenantId: TENANT_ID, name: 'Lifecycle control', code: 'A.1', annexId: 'A.1' },
    });
    CONTROL_ID = control.id;
});

afterAll(async () => {
    if (!DB_AVAILABLE) { await globalPrisma.$disconnect(); return; }
    const tenants = { tenantId: TENANT_ID };
    for (const fn of [
        () => globalPrisma.auditLog.deleteMany({ where: tenants }),
        () => globalPrisma.notification.deleteMany({ where: tenants }),
        () => globalPrisma.controlEvidenceLink.deleteMany({ where: tenants }),
        () => globalPrisma.evidenceReview.deleteMany({ where: tenants }),
        () => globalPrisma.evidence.deleteMany({ where: tenants }),
        () => globalPrisma.fileRecord.deleteMany({ where: tenants }),
        () => globalPrisma.control.deleteMany({ where: tenants }),
        () => globalPrisma.tenantMembership.deleteMany({ where: tenants }),
        () => globalPrisma.user.deleteMany({ where: { id: { in: [adminUserId, ownerUserId] } } }),
        () => globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } }),
    ]) { try { await fn(); } catch { /* best effort */ } }
    await globalPrisma.$disconnect();
});

describeFn('createEvidence (integration)', () => {
    it('creates a TEXT evidence in DRAFT', async () => {
        const ev = await newDraft({ title: 'text ev', type: 'TEXT' });
        expect(ev.type).toBe('TEXT');
        expect(ev.status).toBe('DRAFT');
    });

    it('creates a LINK evidence tagged to a control via EvidenceControlLink', async () => {
        // EP-3 — evidence↔control is the many-to-many join now; no
        // ControlEvidenceLink "bridge" is written for Evidence entities.
        const ev = await newDraft({ title: 'link ev', type: 'LINK', controlId: CONTROL_ID });
        expect(ev.type).toBe('LINK');
        const link = await globalPrisma.evidenceControlLink.findFirst({
            where: { controlId: CONTROL_ID, tenantId: TENANT_ID, evidenceId: ev.id },
        });
        expect(link).not.toBeNull();
        const bridge = await globalPrisma.controlEvidenceLink.findFirst({
            where: { controlId: CONTROL_ID, tenantId: TENANT_ID, kind: 'LINK' },
        });
        expect(bridge).toBeNull();
    });

    it('null-coerces a blank folder to "no folder"', async () => {
        const ev = await newDraft({ title: 'blank folder', folder: '   ' });
        expect(ev.folder).toBeNull();
    });

    it('rejects creation tagged to a foreign/unknown control', async () => {
        await expect(newDraft({ title: 'bad control', controlId: 'ctrl-nope' })).rejects.toThrow();
    });
});

describeFn('updateEvidence (integration)', () => {
    it('updates title + sets a folder', async () => {
        const ev = await newDraft({ title: 'before update' });
        const upd = await updateEvidence(adminCtx(), ev.id, { title: 'after update', folder: 'Policies' } as never);
        expect(upd.title).toBe('after update');
        expect(upd.folder).toBe('Policies');
    });

    it('clears a folder when null is passed (three-state contract)', async () => {
        const ev = await newDraft({ title: 'folder clear', folder: 'X' });
        const upd = await updateEvidence(adminCtx(), ev.id, { folder: null } as never);
        expect(upd.folder).toBeNull();
    });

    it('throws notFound updating a non-existent id', async () => {
        await expect(updateEvidence(adminCtx(), 'ev-nope', { title: 'x' } as never)).rejects.toThrow();
    });

    // ─── The body round-trip ─────────────────────────────────────────
    //
    // Regression: the UI read/wrote a `description` field that is not a
    // column on Evidence, and UpdateEvidenceSchema (.strip()) silently
    // discarded it. A TEXT note's body was therefore invisible in the
    // detail sheet AND un-editable — the save appeared to succeed and
    // changed nothing. The column is `content`.

    it("a TEXT note's body round-trips create → read → edit", async () => {
        const ev = await newDraft({ title: 'round trip', type: 'TEXT' });
        // Create persisted the body…
        expect(ev.content).toBe('some text');

        // …the read path returns it (this is what the detail sheet renders)…
        const read = await getEvidence(adminCtx(), ev.id);
        expect(read.content).toBe('some text');

        // …and an edit actually changes it.
        const upd = await updateEvidence(
            adminCtx(),
            ev.id,
            { content: 'edited body' } as never,
        );
        expect(upd.content).toBe('edited body');
        expect((await getEvidence(adminCtx(), ev.id)).content).toBe('edited body');
    });

    it('a LINK evidence can edit its target URL', async () => {
        const ev = await newDraft({ title: 'link edit', type: 'LINK' });
        const upd = await updateEvidence(
            adminCtx(),
            ev.id,
            { content: 'https://example.com/moved' } as never,
        );
        expect(upd.content).toBe('https://example.com/moved');
    });

    it('a FILE evidence REFUSES a caller-supplied content on edit (it is the storage pathKey)', async () => {
        // R5-P1 — FILE evidence is created ONLY through the upload path
        // (createEvidence rejects FILE-via-JSON, asserted below); `content`
        // holds the object-storage pathKey. The generic edit form must not
        // overwrite it — this is the server-side half of that gate.
        const ev = await uploadEvidenceFile(
            adminCtx(),
            new File([`fc-${randomUUID()}`], 'guard.txt', { type: 'text/plain' }),
            { title: 'file content guard' },
        );

        const upd = await updateEvidence(
            adminCtx(),
            ev.id,
            { title: 'renamed', content: 'attacker/overwritten' } as never,
        );

        expect(upd.title).toBe('renamed');
        // The upload-derived pathKey survived — the caller value was ignored.
        expect(upd.content).not.toBe('attacker/overwritten');
        expect(upd.content).toBe(ev.content);
    });

    it('createEvidence REJECTS FILE-via-JSON — a FILE row must come from the upload path (R5-P1 #1)', async () => {
        // Writing caller-supplied `content` (a pathKey) for FILE was the seed of
        // the cross-tenant read chain; the JSON create endpoint now refuses it.
        await expect(
            createEvidence(adminCtx(), {
                type: 'FILE',
                title: 'no file via json',
                content: 'tenants/t-other/evidence/victim-key',
            } as never),
        ).rejects.toThrow(/FILE_VIA_UPLOAD|multipart upload/i);
    });
});

describeFn('reviewEvidence — state machine (integration)', () => {
    it('rejects an unknown action with badRequest', async () => {
        const ev = await newDraft({ title: 'bad action' });
        await expect(reviewEvidence(adminCtx(), ev.id, { action: 'WAT' })).rejects.toThrow(/Invalid review action/i);
    });

    it('DRAFT → SUBMITTED (EDITOR write tier)', async () => {
        const ev = await newDraft({ title: 'submit me' });
        const res = await reviewEvidence(editorCtx(), ev.id, { action: 'SUBMITTED' });
        expect(res).toEqual({ success: true, status: 'SUBMITTED' });
    });

    it('illegal DRAFT → APPROVED jump is blocked by the state machine', async () => {
        const ev = await newDraft({ title: 'no jump' });
        await expect(reviewEvidence(adminCtx(), ev.id, { action: 'APPROVED' })).rejects.toThrow(/Illegal evidence transition/i);
    });

    it('SUBMITTED → APPROVED notifies the owner when ownerUserId is set', async () => {
        const ev = await newDraft({ title: 'approve me', ownerUserId });
        await reviewEvidence(editorCtx(), ev.id, { action: 'SUBMITTED' });
        const res = await reviewEvidence(adminCtx(), ev.id, { action: 'APPROVED', comment: 'looks good' });
        expect(res.status).toBe('APPROVED');
        const notif = await globalPrisma.notification.findFirst({
            where: { tenantId: TENANT_ID, userId: ownerUserId, type: 'EVIDENCE_APPROVED' },
        });
        expect(notif).not.toBeNull();
    });

    it('SUBMITTED → REJECTED with no ownerUserId skips notification (graceful degrade)', async () => {
        const ev = await newDraft({ title: 'reject me', ownerUserId: null });
        await reviewEvidence(editorCtx(), ev.id, { action: 'SUBMITTED' });
        const res = await reviewEvidence(adminCtx(), ev.id, { action: 'REJECTED', comment: 'test rejection reason' });
        expect(res.status).toBe('REJECTED');
    });

    it('REJECTED → SUBMITTED re-submission is allowed', async () => {
        const ev = await newDraft({ title: 'resubmit' });
        await reviewEvidence(editorCtx(), ev.id, { action: 'SUBMITTED' });
        await reviewEvidence(adminCtx(), ev.id, { action: 'REJECTED', comment: 'test rejection reason' });
        const res = await reviewEvidence(editorCtx(), ev.id, { action: 'SUBMITTED' });
        expect(res.status).toBe('SUBMITTED');
    });

    it('throws notFound reviewing a non-existent evidence', async () => {
        await expect(reviewEvidence(editorCtx(), 'ev-nope', { action: 'SUBMITTED' })).rejects.toThrow();
    });
});

describeFn('bulkAssignEvidence (integration)', () => {
    it('assigns an owner to multiple evidence rows', async () => {
        const a = await newDraft({ title: 'bulk a' });
        const b = await newDraft({ title: 'bulk b' });
        const res = await bulkAssignEvidence(adminCtx(), [a.id, b.id], ownerUserId);
        expect(res.updated).toBe(2);
        const rows = await globalPrisma.evidence.findMany({ where: { id: { in: [a.id, b.id] } } });
        expect(rows.every(r => r.ownerUserId === ownerUserId)).toBe(true);
    });

    it('clears the owner when ownerUserId is null', async () => {
        const a = await newDraft({ title: 'bulk clear', ownerUserId });
        const res = await bulkAssignEvidence(adminCtx(), [a.id], null);
        expect(res.updated).toBe(1);
        const row = await globalPrisma.evidence.findUnique({ where: { id: a.id } });
        expect(row?.ownerUserId).toBeNull();
    });

    it('returns 0 when no ids match (empty-set early return)', async () => {
        const res = await bulkAssignEvidence(adminCtx(), ['nope-1', 'nope-2'], ownerUserId);
        expect(res.updated).toBe(0);
    });
});

describeFn('bulkApproveEvidence (integration)', () => {
    // EP-1: bulk-approve is now a reviewer-tier action that acts ONLY on
    // rows currently in SUBMITTED — the DRAFT→APPROVED bypass is closed —
    // and refuses self-review. Submit as the editor (ownerUserId), approve
    // as the admin (adminUserId) so the two roles are distinct.
    async function submitAsEditor(id: string) {
        await reviewEvidence(editorCtx(), id, { action: 'SUBMITTED' });
    }

    it('approves ONLY SUBMITTED rows and skips the rest (bypass closed)', async () => {
        const submitted = await newDraft({ title: 'approve submitted' });
        await submitAsEditor(submitted.id);
        const draft = await newDraft({ title: 'stays draft' });
        const res = await bulkApproveEvidence(adminCtx(), [submitted.id, draft.id]);
        expect(res.approved).toBe(1);
        expect(res.skippedNotSubmitted).toBe(1);
        const rows = await globalPrisma.evidence.findMany({ where: { id: { in: [submitted.id, draft.id] } } });
        const byId = Object.fromEntries(rows.map((r) => [r.id, r.status]));
        expect(byId[submitted.id]).toBe('APPROVED');
        expect(byId[draft.id]).toBe('DRAFT'); // never bypassed to APPROVED
    });

    it('an EDITOR cannot bulk-approve (reviewer tier required)', async () => {
        const a = await newDraft({ title: 'editor denied' });
        await submitAsEditor(a.id);
        await expect(bulkApproveEvidence(editorCtx(), [a.id])).rejects.toThrow();
    });

    it('records an EvidenceReview row crediting the approver', async () => {
        const a = await newDraft({ title: 'approve review row' });
        await submitAsEditor(a.id);
        await bulkApproveEvidence(adminCtx(), [a.id]);
        const reviews = await globalPrisma.evidenceReview.findMany({ where: { evidenceId: a.id, action: 'APPROVED' } });
        expect(reviews.length).toBeGreaterThanOrEqual(1);
        expect(reviews[0].reviewerId).toBe(adminUserId);
    });

    it('is idempotent — an already-APPROVED row is skipped (not SUBMITTED)', async () => {
        const a = await newDraft({ title: 'approve idempotent' });
        await submitAsEditor(a.id);
        await bulkApproveEvidence(adminCtx(), [a.id]);
        const res = await bulkApproveEvidence(adminCtx(), [a.id]);
        expect(res.approved).toBe(0);
        expect(res.skippedNotSubmitted).toBe(1);
    });

    it('returns 0 when no ids match (empty-set early return)', async () => {
        const res = await bulkApproveEvidence(adminCtx(), ['nope-1', 'nope-2']);
        expect(res.approved).toBe(0);
    });
});

describeFn('soft-delete lifecycle (integration)', () => {
    it('deleteEvidence soft-deletes, then getEvidence no longer finds it', async () => {
        const ev = await newDraft({ title: 'to delete' });
        const res = await deleteEvidence(adminCtx(), ev.id);
        expect(res).toEqual({ success: true });
        await expect(getEvidence(adminCtx(), ev.id)).rejects.toThrow();
        const row = await globalPrisma.evidence.findUnique({ where: { id: ev.id } });
        expect(row?.deletedAt).not.toBeNull();
    });

    it('deleteEvidence throws notFound for an unknown id', async () => {
        await expect(deleteEvidence(adminCtx(), 'ev-nope')).rejects.toThrow();
    });

    it('restoreEvidence brings a soft-deleted row back', async () => {
        const ev = await newDraft({ title: 'to restore', ownerUserId });
        await deleteEvidence(adminCtx(), ev.id);
        await restoreEvidence(adminCtx(), ev.id);
        const row = await globalPrisma.evidence.findUnique({ where: { id: ev.id } });
        expect(row?.deletedAt).toBeNull();
    });

    it('restoreEvidence throws when the row was never deleted', async () => {
        const ev = await newDraft({ title: 'not deleted' });
        await expect(restoreEvidence(adminCtx(), ev.id)).rejects.toThrow();
    });

    it('purgeEvidence requires the row to be soft-deleted first', async () => {
        const ev = await newDraft({ title: 'purge guard' });
        await expect(purgeEvidence(adminCtx(), ev.id)).rejects.toThrow();
    });

    it('purgeEvidence hard-deletes a soft-deleted row', async () => {
        const ev = await newDraft({ title: 'to purge' });
        await deleteEvidence(adminCtx(), ev.id);
        const res = await purgeEvidence(adminCtx(), ev.id);
        expect(res).toEqual({ success: true, purged: true });
        const row = await globalPrisma.evidence.findUnique({ where: { id: ev.id } });
        expect(row).toBeNull();
    });
});

describeFn('getEvidenceMetrics (integration)', () => {
    it('returns counts, formatted size, linkedRate, and top controls', async () => {
        // Two FILE evidence rows backed by stored FileRecords (seeded via the
        // real upload usecase): one linked to a control, one unlinked —
        // drives the linkedRate < 100 branch + STORED FileRecord byte sum.
        await uploadEvidenceFile(adminCtx(), new File([`m-linked-${randomUUID()}`], 'm1.txt', { type: 'text/plain' }), {
            title: 'm linked', controlId: CONTROL_ID,
        });
        await uploadEvidenceFile(adminCtx(), new File([`m-unlinked-${randomUUID()}`], 'm2.txt', { type: 'text/plain' }), {
            title: 'm unlinked',
        });

        const metrics = await getEvidenceMetrics(adminCtx());
        expect(metrics.totalEvidence).toBeGreaterThan(0);
        expect(metrics.fileEvidence).toBeGreaterThanOrEqual(2);
        expect(metrics.linkedFileEvidence).toBeGreaterThanOrEqual(1);
        expect(metrics.linkedRate).toBeGreaterThan(0);
        expect(metrics.linkedRate).toBeLessThanOrEqual(100);
        // 2048 bytes < 1 MiB → KB formatting branch.
        expect(metrics.totalBytesFormatted).toMatch(/KB$/);
        expect(Array.isArray(metrics.topControlsByEvidence)).toBe(true);
        const top = metrics.topControlsByEvidence.find(t => t.controlId === CONTROL_ID);
        expect(top).toBeDefined();
        // annexId/code + name composition branch.
        expect(top?.controlName).toContain('A.1');
    });
});

describeFn('listEvidence / listEvidencePaginated — filters (integration)', () => {
    it('lists with a take bound and filters by type', async () => {
        await newDraft({ title: 'filter text', type: 'TEXT' });
        await newDraft({ title: 'filter link', type: 'LINK' });
        const onlyText = await listEvidence(adminCtx(), { type: 'TEXT' }, { take: 100 });
        expect((onlyText as Array<{ type: string }>).every(e => e.type === 'TEXT')).toBe(true);
    });

    it('filters by status and controlId and free-text q', async () => {
        const uniq = `qmatch-${randomUUID().slice(0, 6)}`;
        await newDraft({ title: `${uniq} target`, controlId: CONTROL_ID });
        const byControl = await listEvidence(adminCtx(), { controlId: CONTROL_ID }) as Array<{ id: string }>;
        expect(byControl.length).toBeGreaterThan(0);
        const byStatus = await listEvidence(adminCtx(), { status: 'DRAFT' }) as Array<unknown>;
        expect(byStatus.length).toBeGreaterThan(0);
        const byQ = await listEvidence(adminCtx(), { q: uniq }) as Array<{ title: string }>;
        expect(byQ.some(e => e.title.includes(uniq))).toBe(true);
    });

    it('filters by the __none__ folder sentinel and an explicit folder', async () => {
        await newDraft({ title: 'no-folder ev' });
        await newDraft({ title: 'foldered ev', folder: 'Audits' });
        const none = await listEvidence(adminCtx(), { folder: '__none__' }) as Array<{ folder: string | null }>;
        expect(none.every(e => !e.folder)).toBe(true);
        const inAudits = await listEvidence(adminCtx(), { folder: 'Audits' }) as Array<{ folder: string | null }>;
        expect(inAudits.every(e => e.folder === 'Audits')).toBe(true);
    });

    it('filters by archived flag', async () => {
        const notArchived = await listEvidence(adminCtx(), { archived: false }) as Array<unknown>;
        expect(Array.isArray(notArchived)).toBe(true);
    });

    it('paginates with a cursor and applies a filter', async () => {
        for (let i = 0; i < 3; i++) await newDraft({ title: `page ev ${i}` });
        const page1 = await listEvidencePaginated(adminCtx(), { limit: 2, filters: { type: 'TEXT' } });
        expect(page1.items.length).toBeLessThanOrEqual(2);
        expect(page1.pageInfo).toHaveProperty('hasNextPage');
        if (page1.pageInfo.nextCursor) {
            const page2 = await listEvidencePaginated(adminCtx(), { limit: 2, cursor: page1.pageInfo.nextCursor });
            expect(Array.isArray(page2.items)).toBe(true);
        }
    });
});
