/**
 * Coverage for `src/app-layer/jobs/compliance-digest.ts`.
 *
 * Two layers:
 *
 * 1. PURE render branches (no DB) — `_renderDigestEmail` exercises
 *    formatDelta (null/positive/negative/zero), deltaColor
 *    (null/invertBetter/better/worse/zero), and the "Attention
 *    Required" item permutations (each conditional + the all-clear
 *    fallback), plus the text-section conditional spreads.
 *
 * 2. DB-backed loop (`runComplianceDigest` + `_getDigestRecipients`)
 *    against the real test DB with a StubEmailProvider:
 *      - no-snapshot tenant → skipped.
 *      - snapshot present + ADMIN recipient → email sent (actioned).
 *      - prior snapshot present → trend deltas computed (non-null).
 *      - recipientOverrides path bypasses the membership query.
 *      - no recipients → skipped.
 *      - single-tenant filter (options.tenantId).
 */
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { DB_AVAILABLE } from '../../integration/db-helper';
import { prismaTestClient } from '../../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { setEmailProvider, StubEmailProvider, ConsoleEmailProvider } from '@/lib/mailer';
import {
    runComplianceDigest,
    _renderDigestEmail,
    _getDigestRecipients,
    type DigestData,
} from '@/app-layer/jobs/compliance-digest';

function baseData(over: Partial<DigestData> = {}): DigestData {
    return {
        tenantName: 'Acme',
        snapshotDate: '2026-06-01',
        controlCoveragePercent: 75.3,
        controlsImplemented: 30,
        controlsApplicable: 40,
        risksTotal: 12,
        risksOpen: 5,
        risksCritical: 0,
        risksHigh: 2,
        evidenceOverdue: 0,
        evidenceDueSoon7d: 0,
        policiesOverdueReview: 0,
        tasksOpen: 8,
        tasksOverdue: 0,
        findingsOpen: 3,
        coverageDelta: null,
        risksOpenDelta: null,
        evidenceOverdueDelta: null,
        findingsOpenDelta: null,
        ...over,
    };
}

describe('_renderDigestEmail (pure)', () => {
    it('renders N/A deltas + all-clear attention block when nulls/zeros', () => {
        const { subject, text, html } = _renderDigestEmail(baseData(), 7);
        expect(subject).toContain('Acme');
        expect(subject).toContain('2026-06-01');
        expect(text).toContain('N/A'); // formatDelta(null)
        expect(text).toContain('No urgent items'); // all-clear text branch
        expect(html).toContain('No urgent items'); // all-clear html branch
        expect(html).toContain('#94a3b8'); // deltaColor(null) neutral
    });

    it('renders positive deltas as improvement color (coverage invertBetter)', () => {
        const { text, html } = _renderDigestEmail(
            baseData({
                coverageDelta: 5, // improvement (invertBetter) → green
                risksOpenDelta: -2, // negative sign in text
                evidenceOverdueDelta: 3, // positive sign in text
                findingsOpenDelta: 0, // zero
            }),
            14,
        );
        expect(text).toContain('+5.0pp'); // positive sign
        expect(text).toContain('-2.0'); // negative, no extra sign
        expect(text).toContain('+3.0');
        // coverageDelta>0 with invertBetter → green via deltaColor.
        expect(html).toContain('color:#22c55e;margin-left:auto;');
    });

    it('renders a declining coverage delta with the worse (red) color', () => {
        const { html } = _renderDigestEmail(baseData({ coverageDelta: -4 }), 7);
        // coverageDelta<0 with invertBetter → not better → red.
        expect(html).toContain('color:#ef4444;margin-left:auto;');
    });

    it('renders every Attention Required item when all thresholds tripped', () => {
        const { text, html } = _renderDigestEmail(
            baseData({
                risksCritical: 2,
                evidenceOverdue: 4,
                tasksOverdue: 1,
                policiesOverdueReview: 3,
            }),
            7,
        );
        expect(text).toContain('2 critical risks');
        expect(text).toContain('4 overdue evidence items');
        expect(text).toContain('overdue tasks');
        expect(text).toContain('policies need review');
        // html pluralization branches
        expect(html).toContain('2 critical risks');
        expect(html).toContain('overdue evidence');
    });

    it('uses singular html label when exactly one critical/overdue', () => {
        const { html } = _renderDigestEmail(
            baseData({ risksCritical: 1, tasksOverdue: 1 }),
            7,
        );
        expect(html).toContain('1 critical risk<'); // no trailing "s"
        expect(html).toContain('1 overdue task<');
    });
});

const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('runComplianceDigest (real DB)', () => {
    let prisma: PrismaClient;
    let stub: StubEmailProvider;
    const SUITE = `cd-${randomUUID().slice(0, 8)}`;
    const T1 = `t-${SUITE}-snap`;
    const T2 = `t-${SUITE}-empty`;

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();
    });

    afterAll(async () => {
        setEmailProvider(new ConsoleEmailProvider());
        await cleanup();
    });

    beforeEach(() => {
        stub = new StubEmailProvider();
        setEmailProvider(stub);
    });

    afterEach(cleanup);

    async function cleanup() {
        for (const t of [T1, T2]) {
            await prisma.complianceSnapshot.deleteMany({ where: { tenantId: t } });
            await prisma.tenantMembership.deleteMany({ where: { tenantId: t } });
            await prisma.tenant.deleteMany({ where: { id: t } });
        }
        await prisma.user.deleteMany({ where: { email: { contains: SUITE } } });
    }

    async function makeSnapshot(tenantId: string, date: Date, over: Record<string, number> = {}) {
        return prisma.complianceSnapshot.create({
            data: {
                tenantId,
                snapshotDate: date,
                controlCoverageBps: 7530,
                controlsImplemented: 30,
                controlsApplicable: 40,
                risksTotal: 12,
                risksOpen: 5,
                risksCritical: 1,
                risksHigh: 2,
                evidenceOverdue: 0,
                evidenceDueSoon7d: 0,
                policiesOverdueReview: 0,
                tasksOpen: 8,
                tasksOverdue: 0,
                findingsOpen: 3,
                ...over,
            },
        });
    }

    it('skips tenants with no snapshot, sends for tenants with one + ADMIN recipient', async () => {
        await prisma.tenant.create({ data: { id: T1, name: 'Snap', slug: T1 } });
        await prisma.tenant.create({ data: { id: T2, name: 'Empty', slug: T2 } });
        const email = `${SUITE}-admin@example.test`;
        const u = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        await prisma.tenantMembership.create({
            data: { tenantId: T1, userId: u.id, role: 'ADMIN', status: 'ACTIVE' },
        });
        // Latest + a prior snapshot (trend delta path).
        await makeSnapshot(T1, new Date('2026-05-20'), { controlCoverageBps: 7000, risksOpen: 7 });
        await makeSnapshot(T1, new Date('2026-06-01'));

        const { result } = await runComplianceDigest({});
        expect(result.success).toBe(true);
        // Both tenants scanned; T1 actioned, T2 skipped.
        expect(result.itemsScanned).toBeGreaterThanOrEqual(2);
        expect(result.itemsActioned).toBeGreaterThanOrEqual(1);
        const sent = stub.sentMessages.filter((m) => m.to === email);
        expect(sent).toHaveLength(1);
        expect(sent[0].subject).toContain('Snap');
    });

    it('does NOT mail a soft-deleted tenant, even with active ADMIN members (#3164)', async () => {
        /*
            Reproduces production. Removing a tenant soft-deletes it, but seven
            removed tenants were found still holding ~11 ACTIVE ADMIN
            memberships each — exactly what `getDigestRecipients` selects — so
            the job mailed people about tenants that no longer exist.

            Active members on a deleted tenant is the whole point of the
            fixture: filtering on membership status alone would not have caught
            this, which is why the filter belongs on `deletedAt`.

            Note this job calls `sendEmail` DIRECTLY rather than enqueuing, so
            `NotificationOutbox` carries no trace of it. Checking the outbox for
            evidence of the defect finds none and proves nothing — the stub
            mailer is the only place it is visible.
        */
        await prisma.tenant.create({
            data: { id: T1, name: 'Removed', slug: T1, deletedAt: new Date('2026-09-09') },
        });
        const email = `${SUITE}-ghost-admin@example.test`;
        const u = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        await prisma.tenantMembership.create({
            data: { tenantId: T1, userId: u.id, role: 'ADMIN', status: 'ACTIVE' },
        });
        await makeSnapshot(T1, new Date('2026-06-01'));

        const { result } = await runComplianceDigest({});

        expect(result.success).toBe(true);
        expect(stub.sentMessages.filter((m) => m.to === email)).toHaveLength(0);
        // Not merely unsent — never scanned, so the work is skipped too.
        expect(result.itemsScanned).toBe(0);
    });

    it('and an explicit tenantId cannot re-run a removed tenant by hand', async () => {
        // The narrower branch. A manual invocation naming a removed tenant
        // would otherwise do exactly what the schedule no longer does.
        await prisma.tenant.create({
            data: { id: T1, name: 'Removed', slug: T1, deletedAt: new Date('2026-09-09') },
        });
        await makeSnapshot(T1, new Date('2026-06-01'));

        const { result } = await runComplianceDigest({
            tenantId: T1,
            recipientOverrides: ['override@example.test'],
        });

        expect(result.itemsScanned).toBe(0);
        expect(stub.sentMessages.some((m) => m.to === 'override@example.test')).toBe(false);
    });

    it('while a LIVE tenant with the same shape still receives one', async () => {
        // Teeth for both: a filter that refused everything would pass the two
        // assertions above while breaking the feature.
        await prisma.tenant.create({ data: { id: T2, name: 'Live', slug: T2 } });
        const email = `${SUITE}-live-admin@example.test`;
        const u = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        await prisma.tenantMembership.create({
            data: { tenantId: T2, userId: u.id, role: 'ADMIN', status: 'ACTIVE' },
        });
        await makeSnapshot(T2, new Date('2026-06-01'));

        const { result } = await runComplianceDigest({});

        expect(result.itemsScanned).toBe(1);
        expect(stub.sentMessages.filter((m) => m.to === email)).toHaveLength(1);
    });

    it('honours recipientOverrides + a single tenantId filter', async () => {
        await prisma.tenant.create({ data: { id: T1, name: 'Snap', slug: T1 } });
        await makeSnapshot(T1, new Date('2026-06-01'));

        const { result } = await runComplianceDigest({
            tenantId: T1,
            recipientOverrides: ['override@example.test'],
        });
        expect(result.itemsScanned).toBe(1);
        expect(result.itemsActioned).toBe(1);
        expect(stub.sentMessages.some((m) => m.to === 'override@example.test')).toBe(true);
    });

    it('skips when a snapshot exists but there are no recipients', async () => {
        await prisma.tenant.create({ data: { id: T1, name: 'Snap', slug: T1 } });
        await makeSnapshot(T1, new Date('2026-06-01'));

        const { result } = await runComplianceDigest({ tenantId: T1 });
        expect(result.itemsActioned).toBe(0);
        expect(result.itemsSkipped).toBe(1);
        expect(stub.sentMessages).toHaveLength(0);
    });

    it('_getDigestRecipients returns only ACTIVE ADMIN emails', async () => {
        await prisma.tenant.create({ data: { id: T1, name: 'Snap', slug: T1 } });
        const a = `${SUITE}-a@example.test`;
        const r = `${SUITE}-r@example.test`;
        const inactive = `${SUITE}-i@example.test`;
        const ua = await prisma.user.create({ data: { email: a, emailHash: hashForLookup(a) } });
        const ur = await prisma.user.create({ data: { email: r, emailHash: hashForLookup(r) } });
        const ui = await prisma.user.create({ data: { email: inactive, emailHash: hashForLookup(inactive) } });
        await prisma.tenantMembership.create({ data: { tenantId: T1, userId: ua.id, role: 'ADMIN', status: 'ACTIVE' } });
        await prisma.tenantMembership.create({ data: { tenantId: T1, userId: ur.id, role: 'READER', status: 'ACTIVE' } });
        await prisma.tenantMembership.create({ data: { tenantId: T1, userId: ui.id, role: 'ADMIN', status: 'DEACTIVATED' } });

        const recipients = await _getDigestRecipients(T1);
        expect(recipients).toEqual([a]);
    });
});
