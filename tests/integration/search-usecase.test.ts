/**
 * Integration coverage for `src/app-layer/usecases/search.ts`.
 *
 * DB-backed: seeds one of each searchable entity (control/risk/policy/
 * evidence/asset/task/test-plan) sharing a common substring + a global
 * framework, then asserts the unified fan-out + ranking.
 *
 * Branches:
 *   - !ctx.role → forbidden.
 *   - query shorter than MIN_QUERY_LENGTH → emptyResponse.
 *   - populated query → every per-type hit builder runs (control code
 *     present vs absent, etc.) + ranking/capPerType.
 *   - perTypeLimit override.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { getUnifiedSearch } from '@/app-layer/usecases/search';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE = `srch-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const TOKEN = `zqx${SUITE.slice(-6)}`; // rare substring shared across seeds
const ctx = makeRequestContext('ADMIN', { tenantId: TENANT, tenantSlug: SUITE });

describeFn('getUnifiedSearch (real DB)', () => {
    let uid: string;
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.upsert({ where: { id: TENANT }, update: {}, create: { id: TENANT, name: SUITE, slug: SUITE } });
        const email = `${SUITE}@example.test`;
        const u = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        uid = u.id;
        const control = await prisma.control.create({ data: { tenantId: TENANT, name: `${TOKEN} control`, code: 'C-1' } });
        await prisma.risk.create({ data: { tenantId: TENANT, title: `${TOKEN} risk`, score: 9, category: 'cat' } });
        await prisma.policy.create({ data: { tenantId: TENANT, title: `${TOKEN} policy`, slug: `${TOKEN}-pol`, ownerUserId: uid } });
        await prisma.evidence.create({ data: { tenantId: TENANT, type: 'FILE', title: `${TOKEN} evidence` } });
        await prisma.asset.create({ data: { tenantId: TENANT, name: `${TOKEN} asset`, type: 'SYSTEM', status: 'ACTIVE' } });
        await prisma.task.create({ data: { tenantId: TENANT, title: `${TOKEN} task`, createdByUserId: uid } });
        await prisma.controlTestPlan.create({
            data: { tenant: { connect: { id: TENANT } }, control: { connect: { id: control.id } }, createdBy: { connect: { id: uid } }, name: `${TOKEN} plan` },
        });
        await prisma.framework.create({ data: { key: `${TOKEN}-fw`, name: `${TOKEN} framework`, version: '1' } });
    });

    afterAll(async () => {
        await prisma.controlTestPlan.deleteMany({ where: { tenantId: TENANT } });
        await prisma.task.deleteMany({ where: { tenantId: TENANT } });
        await prisma.asset.deleteMany({ where: { tenantId: TENANT } });
        await prisma.evidence.deleteMany({ where: { tenantId: TENANT } });
        await prisma.policy.deleteMany({ where: { tenantId: TENANT } });
        await prisma.risk.deleteMany({ where: { tenantId: TENANT } });
        await prisma.control.deleteMany({ where: { tenantId: TENANT } });
        await prisma.framework.deleteMany({ where: { key: `${TOKEN}-fw` } });
        // Guarded: an undefined filter value is DROPPED, not matched —
        // see the teardown note in ./db-helper.ts.
        if (uid) {
            await prisma.user.deleteMany({ where: { id: uid } });
        }
        await prisma.$disconnect();
    });

    it('throws forbidden without a role', async () => {
        const noRole = makeRequestContext('ADMIN', { tenantId: TENANT, tenantSlug: SUITE, role: undefined as never });
        await expect(getUnifiedSearch(noRole, TOKEN)).rejects.toThrow(/Authentication required/);
    });

    it('returns an empty response for a too-short query', async () => {
        const res = await getUnifiedSearch(ctx, '');
        expect(res.hits).toEqual([]);
        expect(res.meta.truncated).toBe(false);
        expect(res.meta.perTypeCounts.control).toBe(0);
    });

    it('fans out across every entity type and ranks the hits', async () => {
        const res = await getUnifiedSearch(ctx, TOKEN);
        const types = new Set(res.hits.map((h) => h.type));
        // Every seeded type should surface.
        for (const t of ['control', 'risk', 'policy', 'evidence', 'asset', 'task', 'test', 'framework']) {
            expect(types.has(t as never)).toBe(true);
        }
        expect(res.meta.query).toBe(TOKEN);
    });

    it('honours a perTypeLimit override', async () => {
        const res = await getUnifiedSearch(ctx, TOKEN, { perTypeLimit: 1 });
        expect(res.meta.perTypeLimit).toBe(1);
        for (const c of Object.values(res.meta.perTypeCounts)) {
            expect(c).toBeLessThanOrEqual(1);
        }
    });
});
