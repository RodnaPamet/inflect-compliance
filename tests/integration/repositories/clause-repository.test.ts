/**
 * Integration coverage for `src/app-layer/repositories/ClauseRepository.ts`.
 *
 * DB-backed. Clause is a GLOBAL table (no RLS); ClauseProgress is
 * tenant-scoped, so list()/updateProgress() run through withTenantDb so
 * the `db` (tenant tx) reads/writes honour RLS.
 *
 * Branches:
 *   list:
 *     - upserts the ISO clause catalogue (idempotent on `number`).
 *     - clause WITHOUT progress → status NOT_STARTED + notes '' defaults.
 *     - clause WITH progress → uses persisted status/notes + checklist.
 *   updateProgress:
 *     - create branch (first write) + notes fallback ('' when omitted).
 *     - update branch (second write changes status).
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './../db-helper';
import { withTenantDb } from '@/lib/db-context';
import { makeRequestContext } from '../../helpers/make-context';
import { ClauseRepository } from '@/app-layer/repositories/ClauseRepository';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const rawPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE = `clause-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const ctx = makeRequestContext('ADMIN', { tenantId: TENANT, tenantSlug: SUITE });

describeFn('ClauseRepository (real DB)', () => {
    beforeAll(async () => {
        await rawPrisma.$connect();
        await rawPrisma.tenant.upsert({ where: { id: TENANT }, update: {}, create: { id: TENANT, name: SUITE, slug: SUITE } });
    });

    afterAll(async () => {
        await rawPrisma.clauseProgress.deleteMany({ where: { tenantId: TENANT } });
        // Tenant is intentionally left behind: the append-only AuditLog
        // (written by the Prisma middleware during the clause upserts)
        // blocks a tenant DELETE — same convention as the RLS suites.
        await rawPrisma.$disconnect();
    });

    afterEach(async () => {
        await rawPrisma.clauseProgress.deleteMany({ where: { tenantId: TENANT } });
    });

    it('list() upserts the clause catalogue and defaults unprogressed clauses', async () => {
        const rows = await withTenantDb(TENANT, (db) => ClauseRepository.list(db, ctx), rawPrisma as unknown as PrismaClient);
        expect(rows.length).toBeGreaterThan(0);
        // No progress yet → every row defaults.
        for (const r of rows) {
            expect(r.status).toBe('NOT_STARTED');
            expect(r.notes).toBe('');
            expect(Array.isArray(r.checklist)).toBe(true);
        }
    });

    it('updateProgress() creates then updates a progress row, list() reflects it', async () => {
        // Ensure clauses exist + grab one id.
        const rows = await withTenantDb(TENANT, (db) => ClauseRepository.list(db, ctx), rawPrisma as unknown as PrismaClient);
        const clauseId = rows[0].id;

        // create branch (notes omitted → '' fallback)
        const created = await withTenantDb(
            TENANT,
            (db) => ClauseRepository.updateProgress(db, ctx, clauseId, { status: 'IN_PROGRESS' }),
            rawPrisma as unknown as PrismaClient,
        );
        expect(created.status).toBe('IN_PROGRESS');
        expect(created.notes).toBe('');

        // update branch (changes status + sets notes)
        const updated = await withTenantDb(
            TENANT,
            (db) => ClauseRepository.updateProgress(db, ctx, clauseId, { status: 'READY', notes: 'done' }),
            rawPrisma as unknown as PrismaClient,
        );
        expect(updated.status).toBe('READY');
        expect(updated.notes).toBe('done');

        // list() now surfaces the persisted status/notes for that clause.
        const after = await withTenantDb(TENANT, (db) => ClauseRepository.list(db, ctx), rawPrisma as unknown as PrismaClient);
        const row = after.find((r) => r.id === clauseId)!;
        expect(row.status).toBe('READY');
        expect(row.notes).toBe('done');
        expect(row.progressId).toBeTruthy();
    });

    it('list() writes nothing once the catalogue exists — a read leaves the audit trail alone', async () => {
        // Seed the catalogue (a no-op if an earlier test already did).
        await withTenantDb(TENANT, (db) => ClauseRepository.list(db, ctx), rawPrisma as unknown as PrismaClient);
        const clauseAudit = () =>
            rawPrisma.auditLog.count({ where: { tenantId: TENANT, entity: 'Clause' } });
        const before = await clauseAudit();

        const rows = await withTenantDb(TENANT, (db) => ClauseRepository.list(db, ctx), rawPrisma as unknown as PrismaClient);

        // Every catalogue clause is still listed…
        expect(rows.length).toBeGreaterThan(0);
        expect(new Set(rows.map((r) => r.number)).size).toBe(rows.length);
        // …and listing them appended no hash-chained audit row. It used to
        // append one `UPSERT Clause` per clause on every call, each waiting
        // on the tenant's audit lock while the tenant transaction stayed
        // open — the body that overran TENANT_TX_TIMEOUT_MS on a loaded runner.
        expect(await clauseAudit()).toBe(before);
    });
});
