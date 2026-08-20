/**
 * Materialising an auditor comment claims it BEFORE creating anything.
 *
 * ═══ THE BUG ═══
 *
 * The completing write was `markResolved` at the very END — an
 * `update({ where: { id } })` with no state predicate — so it RECORDED the
 * materialisation without ever preventing a second one. Two concurrent callers
 * both read status OPEN with no existing finding, both ran createFinding and
 * createTask, and both returned `alreadyExisted: false`.
 *
 * Two OPEN findings for one auditor comment, each with its own remediation Task
 * burning a TaskKeySequence number and firing TASK_CREATED — so every
 * automation rule bound to that event ran twice.
 *
 * And it could not self-heal: the guard's findFirst matches one duplicate
 * arbitrarily and reports alreadyExisted:true forever after, so the orphan was
 * only clearable by hand-deleting a finding raised by an EXTERNAL AUDITOR.
 * Readiness scoring folds open findings into the cycle score, so the phantom
 * depressed it and closing one of the pair left the other open.
 */
const db = {
    auditPackShareComment: { findFirst: jest.fn(), updateMany: jest.fn(), update: jest.fn() },
    finding: { findFirst: jest.fn() },
    auditPack: { findFirst: jest.fn() },
    audit: { findFirst: jest.fn() },
    auditPackItem: { findFirst: jest.fn() },
};
/** Typed with its real parameter tuple so `mock.calls[0][1]` — the payload — is inspectable. */
const createFinding = jest.fn<Promise<{ id: string }>, [unknown, Record<string, unknown>]>(async () => ({ id: 'f1' }));
const createTask = jest.fn(async () => ({ id: 'task-1' }));
const logEvent = jest.fn(async () => undefined);

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_c: unknown, fn: (d: unknown) => unknown) => fn(db),
}));
jest.mock('@/app-layer/usecases/finding', () => ({
    createFinding: (...a: unknown[]) => createFinding(...(a as [unknown, Record<string, unknown>])),
}));
jest.mock('@/app-layer/usecases/task', () => ({ createTask: (...a: unknown[]) => createTask(...(a as [])) }));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: (...a: unknown[]) => logEvent(...(a as [])) }));

import { materializeShareCommentFinding } from '@/app-layer/usecases/audit-readiness/sharing';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN', { tenantId: 't1', userId: 'reviewer-1' });
const PACK = 'pack-1';
const COMMENT = 'c1';

const comment = (over: Record<string, unknown> = {}) => ({
    id: COMMENT, kind: 'FINDING', body: 'Control lacks evidence', status: 'OPEN', auditPackItemId: null, ...over,
});

let order: string[] = [];

beforeEach(() => {
    jest.clearAllMocks();
    order = [];
    db.auditPackShareComment.findFirst.mockResolvedValue(comment());
    db.finding.findFirst.mockResolvedValue(null);
    db.auditPack.findFirst.mockResolvedValue({ auditCycleId: 'cy1' });
    db.audit.findFirst.mockResolvedValue({ id: 'a1' });
    db.auditPackItem.findFirst.mockResolvedValue(null);
    db.auditPackShareComment.updateMany.mockImplementation(async () => { order.push('claim'); return { count: 1 }; });
    createFinding.mockImplementation(async () => { order.push('createFinding'); return { id: 'f1' }; });
    createTask.mockImplementation(async () => { order.push('createTask'); return { id: 'task-1' }; });
});

describe('the claim precedes both creates', () => {
    it('claims first, then creates the finding and the task', async () => {
        await materializeShareCommentFinding(ctx, PACK, COMMENT);
        expect(order).toEqual(['claim', 'createFinding', 'createTask']);
    });

    it('the claim is predicated on the comment still being OPEN', async () => {
        await materializeShareCommentFinding(ctx, PACK, COMMENT);
        expect(db.auditPackShareComment.updateMany.mock.calls[0][0].where).toMatchObject({
            id: COMMENT, tenantId: 't1', auditPackId: PACK, status: 'OPEN',
        });
    });

    it('never uses the unpredicated update() that caused this', async () => {
        await materializeShareCommentFinding(ctx, PACK, COMMENT);
        expect(db.auditPackShareComment.update).not.toHaveBeenCalled();
    });
});

describe('losing the claim creates NOTHING', () => {
    it('throws and never calls createFinding or createTask', async () => {
        db.auditPackShareComment.updateMany.mockResolvedValueOnce({ count: 0 });
        await expect(materializeShareCommentFinding(ctx, PACK, COMMENT)).rejects.toThrow(
            /already being materialised/i,
        );
        expect(createFinding).not.toHaveBeenCalled();
        expect(createTask).not.toHaveBeenCalled();
    });
});

describe('an already-materialised comment is idempotent', () => {
    it('returns the existing finding without creating a second', async () => {
        db.finding.findFirst.mockResolvedValue({ id: 'existing-f' });
        const r = await materializeShareCommentFinding(ctx, PACK, COMMENT);
        expect(r).toEqual({ findingId: 'existing-f', alreadyExisted: true });
        expect(createFinding).not.toHaveBeenCalled();
    });

    it('works even when the comment is ALREADY RESOLVED — the retry path', async () => {
        // This is what the old ordering made impossible. The RESOLVED check ran
        // before the finding lookup, so a resolved comment always threw, even
        // when it had genuinely materialised and the caller just wanted the id.
        db.auditPackShareComment.findFirst.mockResolvedValue(comment({ status: 'RESOLVED' }));
        db.finding.findFirst.mockResolvedValue({ id: 'existing-f' });

        const r = await materializeShareCommentFinding(ctx, PACK, COMMENT);
        expect(r).toEqual({ findingId: 'existing-f', alreadyExisted: true });
    });

    it('does not re-log the event when nothing actually transitioned', async () => {
        // Auditing a no-op teaches a reviewer to ignore the event.
        db.auditPackShareComment.findFirst.mockResolvedValue(comment({ status: 'RESOLVED' }));
        db.finding.findFirst.mockResolvedValue({ id: 'existing-f' });
        db.auditPackShareComment.updateMany.mockResolvedValue({ count: 0 });

        await materializeShareCommentFinding(ctx, PACK, COMMENT);
        expect(logEvent).not.toHaveBeenCalled();
    });
});

describe('the genuinely stuck state is named, not silently retried', () => {
    it('refuses a RESOLVED comment with no finding, and says which case it is', async () => {
        // Residue of a failed materialisation: claimed, then the create did not
        // complete. Distinct from "already done", and the message says so.
        db.auditPackShareComment.findFirst.mockResolvedValue(comment({ status: 'RESOLVED' }));
        db.finding.findFirst.mockResolvedValue(null);

        await expect(materializeShareCommentFinding(ctx, PACK, COMMENT)).rejects.toThrow(
            /no finding was materialised/i,
        );
        expect(createFinding).not.toHaveBeenCalled();
    });
});

describe('the finding carries the idempotency key the guard reads', () => {
    it('sets sourceKind and sourceRef so a repeat call can find it', async () => {
        await materializeShareCommentFinding(ctx, PACK, COMMENT);
        expect(createFinding.mock.calls[0][1]).toMatchObject({ sourceRef: COMMENT });
    });
});
