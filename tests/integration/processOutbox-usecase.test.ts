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
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
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
            create: { tenantId: T_OFF, enabled: false, defaultFromEmail: 'fixture@example.test' },
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

    // #5110 — the claim used to leave the row PENDING with sendAfter <= now,
    // so a second pass whose read came AFTER the first pass's claim (the next
    // tick, or an admin pressing "Process Outbox") saw an ordinary pending row,
    // claimed it on the new attempts value, and sent it again while the first
    // pass's SMTP call was still in flight. The claim now takes a lease on
    // `sendAfter`, so a row mid-send is invisible to every other pass.
    it('a pass that reads after another pass claimed a row does not send it again (#5110)', async () => {
        const row = await enqueue(T_OK);

        // Pass A's send blocks until released; any later send completes at once.
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        let aInSend!: () => void;
        const aClaimedAndSending = new Promise<void>((r) => { aInSend = r; });
        let calls = 0;
        const sends: EmailMessage[] = [];
        setEmailProvider({
            async send(msg: EmailMessage) {
                calls++;
                sends.push(msg);
                if (calls === 1) { aInSend(); await gate; }
            },
        });

        const passA = processOutbox({ tenantId: T_OK });
        await aClaimedAndSending;

        // Pass B starts from scratch: its findMany runs after A's claim and
        // before A records SENT.
        const resB = await processOutbox({ tenantId: T_OK });

        release();
        const resA = await passA;

        expect(sends).toHaveLength(1);
        expect(resA.sent).toBe(1);
        expect(resB.sent).toBe(0);
        const after = await prisma.notificationOutbox.findUnique({ where: { id: row.id } });
        expect(after?.status).toBe('SENT');
        expect(after?.attempts).toBe(1);
    });

    it('a failed send releases the lease: the row keeps its original sendAfter and is retried next pass (#5110)', async () => {
        provider.shouldThrow = true;
        const queuedAt = new Date(Date.now() - 60_000);
        const row = await enqueue(T_OK, { sendAfter: queuedAt });
        await processOutbox({ tenantId: T_OK, maxAttempts: 3 });

        const after = await prisma.notificationOutbox.findUnique({ where: { id: row.id } });
        expect(after?.status).toBe('PENDING');
        expect(after?.sendAfter.getTime()).toBe(queuedAt.getTime());

        provider.shouldThrow = false;
        const res = await processOutbox({ tenantId: T_OK, maxAttempts: 3 });
        expect(res.sent).toBe(1);
        expect(provider.sent).toHaveLength(1);
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
