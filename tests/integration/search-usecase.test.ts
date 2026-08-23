/**
 * Integration coverage for `src/app-layer/usecases/search.ts`.
 *
 * DB-backed: seeds one of each searchable entity (control/risk/policy/
 * evidence/asset/task/test-plan) sharing a common substring + a global
 * framework, then asserts the unified fan-out + ranking.
 *
 * Branches:
 *   - no viewable domain at all → forbidden.
 *   - query shorter than MIN_QUERY_LENGTH → emptyResponse.
 *   - populated query → every per-type hit builder runs (control code
 *     present vs absent, etc.) + ranking/capPerType.
 *   - perTypeLimit override.
 *   - per-domain permission skipping (2026-08-24): a custom role without
 *     `<domain>.view` gets that domain omitted and its `perTypeCounts`
 *     entry zeroed, while every other domain still returns.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { getPermissionsForRole, type PermissionSet } from '@/lib/permissions';
import type { RequestContext } from '@/app-layer/types';
// The APP client — the one carrying the Epic B field-encryption extension.
// The suite's own `prisma` below is a bare client with no middleware, so a
// row seeded through it lands in the column as PLAINTEXT. For the encrypted
// column under test that would make the assertion vacuous, so that one row
// is written through the real write path instead.
import { prisma as encryptingPrisma } from '@/lib/prisma';
import { getUnifiedSearch } from '@/app-layer/usecases/search';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE = `srch-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const TOKEN = `zqx${SUITE.slice(-6)}`; // rare substring shared across seeds
const ctx = makeRequestContext('ADMIN', { tenantId: TENANT, tenantSlug: SUITE });

/** A token that only ever appears in a Task's (encrypted) description. */
const DESC_ONLY_TOKEN = `wvq${SUITE.slice(-6)}`;

/**
 * A `TenantCustomRole`-shaped context: a real base role whose
 * `permissionsJson` zeroes some flags. That is the only population this
 * gate can refuse — every built-in role carries `view: true` everywhere.
 */
function customRole(mutate: (p: PermissionSet) => void): RequestContext {
    const appPermissions = structuredClone(getPermissionsForRole('READER'));
    mutate(appPermissions);
    return makeRequestContext('READER', {
        tenantId: TENANT,
        tenantSlug: SUITE,
        appPermissions,
    });
}

describeFn('getUnifiedSearch (real DB)', () => {
    let uid: string;
    let descTaskId: string;
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
        // Title deliberately does NOT carry DESC_ONLY_TOKEN — only the
        // description does. Written through `encryptingPrisma` so the column
        // holds what production holds. See the dead-clause test below.
        descTaskId = (
            await encryptingPrisma.task.create({
                data: {
                    tenantId: TENANT,
                    title: `${TOKEN} task with a description`,
                    description: `${DESC_ONLY_TOKEN} only lives in the description`,
                    createdByUserId: uid,
                },
            })
        ).id;
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

    it('throws forbidden when the caller can view no searchable domain', async () => {
        // Replaces an `if (!ctx.role)` assertion. That branch was unreachable
        // — `getTenantCtx` always populates the role — so the test proved only
        // that a context no caller produces was refused. This context has a
        // populated role and is refused on the permissions.
        const blind = customRole((p) => {
            for (const domain of [
                'controls', 'risks', 'policies', 'evidence',
                'assets', 'tasks', 'tests', 'frameworks',
            ] as const) {
                p[domain].view = false;
            }
        });
        expect(blind.role).toBeTruthy();
        await expect(getUnifiedSearch(blind, TOKEN)).rejects.toThrow(
            /permission to view any searchable records/i,
        );
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

    it('a READER — the least-privileged built-in role — still gets every type', async () => {
        // The load-bearing positive companion. A READER can already reach
        // every one of these rows through the list pages, so a gate that
        // refused them here would be a regression dressed as a fix.
        const reader = makeRequestContext('READER', { tenantId: TENANT, tenantSlug: SUITE });
        const res = await getUnifiedSearch(reader, TOKEN);
        const types = new Set(res.hits.map((h) => h.type));
        for (const t of ['control', 'risk', 'policy', 'evidence', 'asset', 'task', 'test', 'framework']) {
            expect(types.has(t as never)).toBe(true);
        }
    });

    it('omits a denied domain and zeroes its count, while other domains still return', async () => {
        const noEvidence = customRole((p) => {
            p.evidence.view = false;
        });
        const res = await getUnifiedSearch(noEvidence, TOKEN);

        expect(res.hits.some((h) => h.type === 'evidence')).toBe(false);
        // The response must not claim results it withheld.
        expect(res.meta.perTypeCounts.evidence).toBe(0);

        // Everything else is untouched — this is skipping, not refusing.
        const types = new Set(res.hits.map((h) => h.type));
        for (const t of ['control', 'risk', 'policy', 'asset', 'task', 'test', 'framework']) {
            expect(types.has(t as never)).toBe(true);
        }
        expect(res.meta.perTypeCounts.control).toBeGreaterThan(0);
    });

    it('honours frameworks.view even though the catalogue is global', async () => {
        // Frameworks carry no tenantId, so this is a deliberate call rather
        // than a fallout of tenant scoping: a framework hit links into
        // /t/<slug>/frameworks/<key>, which has refused `frameworks.view:
        // false` since 2026-08-23. Returning a row whose only affordance is a
        // 403 would be incoherent.
        const noFrameworks = customRole((p) => {
            p.frameworks.view = false;
        });
        const res = await getUnifiedSearch(noFrameworks, TOKEN);
        expect(res.hits.some((h) => h.type === 'framework')).toBe(false);
        expect(res.meta.perTypeCounts.framework).toBe(0);
        expect(res.hits.some((h) => h.type === 'control')).toBe(true);
    });

    it('does not match a Task by its description — the column is encrypted', async () => {
        // Evidence for the clause removed from the task query on 2026-08-24.
        // `Task.description` is in the Epic B encryption manifest, so a row
        // written through the app's client lands as AES-GCM ciphertext and an
        // ILIKE for the plaintext can never match it.

        // (a) The diagnosis, read straight off the column with the bare
        //     client. Without this the test below would pass just as happily
        //     against a task that was never seeded.
        const stored = await prisma.$queryRawUnsafe<Array<{ description: string | null }>>(
            'SELECT description FROM "Task" WHERE id = $1',
            descTaskId,
        );
        expect(stored[0].description).toMatch(/^v[12]:/);
        expect(stored[0].description).not.toContain(DESC_ONLY_TOKEN);

        // (b) The row is real and the plaintext round-trips — the app client
        //     decrypts it back. So (c) is the ILIKE failing, not a bad seed.
        const readBack = await encryptingPrisma.task.findUnique({ where: { id: descTaskId } });
        expect(readBack?.description).toContain(DESC_ONLY_TOKEN);

        // (c) The consequence: searching the description finds nothing.
        const res = await getUnifiedSearch(ctx, DESC_ONLY_TOKEN);
        expect(res.hits.filter((h) => h.type === 'task')).toEqual([]);
        expect(res.meta.perTypeCounts.task).toBe(0);

        // (d) …while the same row IS findable by its title.
        const byTitle = await getUnifiedSearch(ctx, TOKEN);
        expect(
            byTitle.hits.some(
                (h) => h.type === 'task' && h.title.includes('with a description'),
            ),
        ).toBe(true);
    });

    it('honours a perTypeLimit override', async () => {
        const res = await getUnifiedSearch(ctx, TOKEN, { perTypeLimit: 1 });
        expect(res.meta.perTypeLimit).toBe(1);
        for (const c of Object.values(res.meta.perTypeCounts)) {
            expect(c).toBeLessThanOrEqual(1);
        }
    });
});
