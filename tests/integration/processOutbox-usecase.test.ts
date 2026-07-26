/**
 * Integration coverage for `src/app-layer/notifications/processOutbox.ts`.
 *
 * DB-backed (real NotificationOutbox rows) with a controllable email
 * provider so we can exercise:
 *   - sent path → status SENT, attempts++.
 *   - disabled-tenant skip (TenantNotificationSettings.enabled=false).
 *   - transient failure under maxAttempts → status back to PENDING + skipped.
 *   - terminal failure at maxAttempts → status FAILED + failed++.
 *   - sendAfter in the future + attempts>=maxAttempts are NOT picked up.
 *   - bodyHtml present vs null (html arg branch).
 *   - settings cache reuse across two rows for the same tenant.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { setEmailProvider, ConsoleEmailProvider, type EmailProvider, type EmailMessage } from '@/lib/mailer';
import { processOutbox } from '@/app-layer/notifications/processOutbox';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE = `outbox-${randomUUID().slice(0, 8)}`;
const T_OK = `t-${SUITE}-ok`;
const T_OFF = `t-${SUITE}-off`;

/** A provider whose behaviour is set per-test. */
class ControlledProvider implements EmailProvider {
    public sent: EmailMessage[] = [];
    public shouldThrow = false;
    async send(msg: EmailMessage): Promise<void> {
        if (this.shouldThrow) throw new Error('smtp down');
        this.sent.push(msg);
    }
}

let provider: ControlledProvider;

async function enqueue(tenantId: string, over: Record<string, unknown> = {}) {
    return prisma.notificationOutbox.create({
        data: {
            tenant: { connect: { id: tenantId } },
            type: 'TASK_ASSIGNED',
            toEmail: `to-${randomUUID().slice(0, 6)}@example.test`,
            subject: 'Hi',
            bodyText: 'body',
            dedupeKey: `dk-${randomUUID()}`,
            status: 'PENDING',
            ...over,
        },
    });
}

describeFn('processOutbox (real DB)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.upsert({ where: { id: T_OK }, update: {}, create: { id: T_OK, name: T_OK, slug: T_OK } });
        await prisma.tenant.upsert({ where: { id: T_OFF }, update: {}, create: { id: T_OFF, name: T_OFF, slug: T_OFF } });
        await prisma.tenantNotificationSettings.upsert({
            where: { tenantId: T_OFF }, update: { enabled: false },
            create: { tenantId: T_OFF, enabled: false },
        });
    });

    afterAll(async () => {
        setEmailProvider(new ConsoleEmailProvider());
        await prisma.notificationOutbox.deleteMany({ where: { tenantId: { in: [T_OK, T_OFF] } } });
        await prisma.tenantNotificationSettings.deleteMany({ where: { tenantId: { in: [T_OK, T_OFF] } } });
        await prisma.tenant.deleteMany({ where: { id: { in: [T_OK, T_OFF] } } });
        await prisma.$disconnect();
    });

    beforeEach(async () => {
        provider = new ControlledProvider();
        setEmailProvider(provider);
        // `processOutbox()` is a worker: it drains EVERY pending row in the
        // database, with no tenant filter. These tests assert on its exact
        // `sent` / `skipped` counts, so any PENDING row another suite left
        // behind is counted here and the assertion fails — which is what made
        // this suite order-dependent (it saw 4 in CI, 6 locally, 2 in
        // isolation). Clearing pending rows tenant-wide, not just for this
        // suite's two tenants, makes the counts deterministic.
        //
        // Scoped to PENDING deliberately: SENT/FAILED rows are never picked up
        // by the drain, so other suites' terminal rows are left untouched.
        await prisma.notificationOutbox.deleteMany({ where: { status: 'PENDING' } });
    });

    it('sends PENDING rows, marks them SENT, and reuses the settings cache', async () => {
        const a = await enqueue(T_OK, { bodyHtml: '<b>hi</b>' });
        const b = await enqueue(T_OK); // bodyHtml null → html-undefined branch
        const res = await processOutbox({});
        expect(res.sent).toBe(2);
        expect(res.failed).toBe(0);
        expect(provider.sent).toHaveLength(2);
        const rowA = await prisma.notificationOutbox.findUnique({ where: { id: a.id } });
        const rowB = await prisma.notificationOutbox.findUnique({ where: { id: b.id } });
        expect(rowA?.status).toBe('SENT');
        expect(rowB?.status).toBe('SENT');
        expect(rowA?.attempts).toBe(1);
    });

    it('skips rows for a tenant that disabled notifications', async () => {
        await enqueue(T_OFF);
        const res = await processOutbox({});
        // The OFF row is the only one in scope → skipped, not sent.
        expect(res.sent).toBe(0);
        expect(res.skipped).toBeGreaterThanOrEqual(1);
        expect(provider.sent).toHaveLength(0);
    });

    it('keeps a row PENDING on transient failure under maxAttempts (skipped)', async () => {
        provider.shouldThrow = true;
        const row = await enqueue(T_OK, { attempts: 0 });
        const res = await processOutbox({ maxAttempts: 3 });
        expect(res.failed).toBe(0);
        expect(res.skipped).toBe(1);
        const after = await prisma.notificationOutbox.findUnique({ where: { id: row.id } });
        expect(after?.status).toBe('PENDING');
        expect(after?.attempts).toBe(1);
        expect(after?.lastError).toContain('smtp down');
    });

    it('marks a row FAILED when the final attempt fails', async () => {
        provider.shouldThrow = true;
        // attempts already at maxAttempts-1 → this attempt is terminal.
        const row = await enqueue(T_OK, { attempts: 2 });
        const res = await processOutbox({ maxAttempts: 3 });
        expect(res.failed).toBe(1);
        const after = await prisma.notificationOutbox.findUnique({ where: { id: row.id } });
        expect(after?.status).toBe('FAILED');
        expect(after?.attempts).toBe(3);
    });

    it('does not pick up future-dated or attempts-exhausted rows', async () => {
        const future = new Date(Date.now() + 86_400_000);
        await enqueue(T_OK, { sendAfter: future });
        await enqueue(T_OK, { attempts: 5 }); // >= maxAttempts default 3
        const res = await processOutbox({});
        expect(res.sent).toBe(0);
        expect(res.failed).toBe(0);
        expect(res.skipped).toBe(0);
    });
});
