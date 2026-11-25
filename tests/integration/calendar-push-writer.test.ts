/**
 * The calendar push on a real database (#5937 step 2): the nightly job reads a
 * `v2:` token under the TENANT's key, pushes only the person's OWN deadlines,
 * writes `UserCalendarEventMapping` rows under RLS, and persists a rotated
 * token sealed under the tenant's key BEFORE it is used.
 *
 * Integration, not unit: what is proved is the interaction of the real job,
 * the real encryption extension with a real per-tenant DEK, the real
 * aggregation and the table's real RLS policies. The provider is the one fake:
 * nothing here reaches Google or Microsoft.
 */
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { createTenantWithDek, getTenantDek, _resetTenantDekCache } from '@/lib/security/tenant-key-manager';
import { decryptWithKey, hashForLookup } from '@/lib/security/encryption';
import { saveCalendarConnection } from '@/app-layer/usecases/user-calendar-connection';
import { runCalendarPushTenant } from '@/app-layer/jobs/calendar-push';
import type { CalendarWriter } from '@/app-layer/usecases/calendar-reconcile-sweep';
import type { CalendarAccessTokens } from '@/app-layer/integrations/providers/calendar/calendar-http';

const d = DB_AVAILABLE ? describe : describe.skip;

d('calendar push — tenant key, own deadlines, RLS', () => {
    const prisma = prismaTestClient();
    const tenantIds: string[] = [];
    const DAY = 86_400_000;
    // Throwaway fixture values written to temporary tenants; never real tokens.
    const fresh = () => ({ accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: Math.floor(Date.now() / 1000) + 3600 }); // pragma: allowlist secret

    /**
     * The workspace's Microsoft organisation consent, as the admin-consent
     * callback records it. The connect flow refuses an Outlook connection
     * without one, and the push holds a connection whose consent is not in force.
     */
    async function grantMicrosoftConsent(tenantId: string, grantedByUserId: string, revokedAt: Date | null = null) {
        await prisma.tenantCalendarConsent.create({
            data: { tenantId, provider: 'outlook-calendar', externalTenantId: 'entra-dir-1', grantedByUserId, revokedAt },
        });
    }

    async function workspace(label: string) {
        const slug = `calpush-${label}-${Date.now()}`;
        const tenant = await createTenantWithDek({ name: slug, slug });
        tenantIds.push(tenant.id);
        const mk = async (who: string) => {
            const email = `${slug}-${who}@example.test`;
            const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email), name: who } });
            await prisma.tenantMembership.create({ data: { tenantId: tenant.id, userId: user.id, role: 'EDITOR', status: 'ACTIVE' } });
            return user;
        };
        const me = await mk('me');
        const colleague = await mk('colleague');
        const task = (title: string, assigneeUserId: string, inDays: number) =>
            prisma.task.create({
                data: {
                    tenantId: tenant.id,
                    title,
                    createdByUserId: me.id,
                    assigneeUserId,
                    dueAt: new Date(Math.floor(Date.now() / DAY) * DAY + inDays * DAY),
                },
            });
        return { tenant, me, colleague, task, ctx: makeRequestContext('EDITOR', { tenantId: tenant.id, userId: me.id, tenantSlug: slug }) };
    }

    /** A provider that holds events and records the bearer tokens it was handed. */
    function fakeProvider() {
        const seen: { tokens: string[]; titles: string[] } = { tokens: [], titles: [] };
        let n = 0;
        const writerFor = (_provider: string, tokens: CalendarAccessTokens): CalendarWriter => ({
            async insert({ event }) {
                seen.tokens.push(await tokens.current());
                seen.titles.push(event.title);
                return { remoteEventId: `remote-${++n}` };
            },
            async patch() {},
            async remove() {},
        });
        return { seen, writerFor };
    }

    async function storedToken(tenantId: string, userId: string): Promise<string> {
        const rows = (await prisma.$queryRawUnsafe(
            `SELECT "tokenEncrypted" FROM "UserCalendarConnection" WHERE "tenantId" = $1 AND "userId" = $2`,
            tenantId,
            userId,
        )) as Array<{ tokenEncrypted: string }>;
        return rows[0].tokenEncrypted;
    }

    /** Read mapping rows as `app_user` with a tenant bound: what RLS alone allows. */
    async function mappingsVisibleTo(boundTenantId: string): Promise<Array<{ tenantId: string }>> {
        return prisma.$transaction(async (tx: typeof prisma) => {
            await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
            await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${boundTenantId}', true)`);
            return tx.$queryRawUnsafe(`SELECT "tenantId" FROM "UserCalendarEventMapping"`) as Promise<Array<{ tenantId: string }>>;
        });
    }

    beforeEach(() => _resetTenantDekCache());

    afterAll(async () => {
        await prisma.userCalendarEventMapping.deleteMany({ where: { tenantId: { in: tenantIds } } });
        await prisma.userCalendarConnection.deleteMany({ where: { tenantId: { in: tenantIds } } });
        await prisma.tenantCalendarConsent.deleteMany({ where: { tenantId: { in: tenantIds } } });
        await prisma.task.deleteMany({ where: { tenantId: { in: tenantIds } } });
        await prisma.$disconnect();
    });

    it('reads the v2 token under the tenant key and pushes only the person\'s own deadlines', async () => {
        const a = await workspace('a');
        const b = await workspace('b');
        await a.task('Mine A', a.me.id, 3);
        await a.task('Colleague A', a.colleague.id, 4);
        await b.task('Mine B', b.me.id, 5);
        await saveCalendarConnection(a.ctx, { provider: 'google-calendar', token: fresh(), scopesGranted: ['x'] });
        await saveCalendarConnection(b.ctx, { provider: 'google-calendar', token: fresh(), scopesGranted: ['x'] });
        expect((await storedToken(a.tenant.id, a.me.id)).startsWith('v2:')).toBe(true);

        const provider = fakeProvider();
        const out = await runCalendarPushTenant({ tenantId: a.tenant.id }, { writerFor: provider.writerFor as never });

        expect(out.outcomes.pushed).toBe(1);
        // The decrypted access token reached the writer: the DEK resolved.
        expect(provider.seen.tokens).toEqual(['fixture-access']);
        // The person's own deadline, never the colleague's.
        expect(provider.seen.titles).toEqual(['Task due: Mine A']);

        const rows = await prisma.userCalendarEventMapping.findMany({ where: { tenantId: a.tenant.id } });
        expect(rows).toEqual([
            expect.objectContaining({ userId: a.me.id, provider: 'google-calendar', sourceKey: 'task-due', state: 'PUSHED', remoteEventId: 'remote-1' }),
        ]);
        const conn = await prisma.userCalendarConnection.findFirst({ where: { tenantId: a.tenant.id, userId: a.me.id } });
        expect(conn?.lastPushedAt).toBeInstanceOf(Date);

        // RLS alone: tenant B bound sees none of tenant A's rows.
        const visibleToB = await mappingsVisibleTo(b.tenant.id);
        expect(visibleToB.some((r) => r.tenantId === a.tenant.id)).toBe(false);
        const visibleToA = await mappingsVisibleTo(a.tenant.id);
        expect(visibleToA.length).toBeGreaterThan(0);
        expect(visibleToA.every((r) => r.tenantId === a.tenant.id)).toBe(true);

        // Tenant B's job did not run; nothing was written for it.
        expect(await prisma.userCalendarEventMapping.count({ where: { tenantId: b.tenant.id } })).toBe(0);
    }, 60_000);

    it('in the workspace\'s language, and a second run over an unchanged calendar writes nothing', async () => {
        const a = await workspace('bg');
        await prisma.tenant.update({ where: { id: a.tenant.id }, data: { defaultLocale: 'bg' } });
        await a.task('Ротация на ключове', a.me.id, 2);
        await grantMicrosoftConsent(a.tenant.id, a.me.id);
        await saveCalendarConnection(a.ctx, { provider: 'outlook-calendar', token: fresh(), scopesGranted: [] });

        const provider = fakeProvider();
        await runCalendarPushTenant({ tenantId: a.tenant.id }, { writerFor: provider.writerFor as never });
        expect(provider.seen.titles).toEqual(['Предстояща задача: Ротация на ключове']);

        const again = await runCalendarPushTenant({ tenantId: a.tenant.id }, { writerFor: provider.writerFor as never });
        expect(again.outcomes['nothing-to-do']).toBe(1);
        expect(provider.seen.titles).toHaveLength(1);
    }, 60_000);

    it('a rotated token is persisted under the tenant key before it is used', async () => {
        const a = await workspace('rotate');
        await a.task('Mine', a.me.id, 1);
        const expired = { ...fresh(), expiresAt: Math.floor(Date.now() / 1000) - 60 };
        await grantMicrosoftConsent(a.tenant.id, a.me.id);
        await saveCalendarConnection(a.ctx, { provider: 'outlook-calendar', token: expired, scopesGranted: [] });

        const rotated = { accessToken: 'fixture-access-2', refreshToken: 'fixture-refresh-2', expiresAt: Math.floor(Date.now() / 1000) + 3600 }; // pragma: allowlist secret
        const onDiskWhenUsed: string[] = [];
        const writerFor = (_p: string, tokens: CalendarAccessTokens): CalendarWriter => ({
            async insert() {
                const token = await tokens.current();
                const raw = await storedToken(a.tenant.id, a.me.id);
                onDiskWhenUsed.push(`${token}|${JSON.parse(decryptWithKey(await getTenantDek(a.tenant.id), raw)).refreshToken}|${raw.slice(0, 3)}`);
                return { remoteEventId: 'r' };
            },
            async patch() {},
            async remove() {},
        });
        await runCalendarPushTenant({ tenantId: a.tenant.id }, { writerFor: writerFor as never, refresh: async () => rotated });

        expect(onDiskWhenUsed).toEqual(['fixture-access-2|fixture-refresh-2|v2:']);
    }, 60_000);
    it('a withdrawn Microsoft organisation consent stops the push at once, and keeps the connection', async () => {
        const a = await workspace('withdrawn');
        await a.task('Mine', a.me.id, 1);
        await grantMicrosoftConsent(a.tenant.id, a.me.id, new Date());
        await saveCalendarConnection(a.ctx, { provider: 'outlook-calendar', token: fresh(), scopesGranted: [] });

        const provider = fakeProvider();
        await runCalendarPushTenant({ tenantId: a.tenant.id }, { writerFor: provider.writerFor as never });

        expect(provider.seen.titles).toEqual([]);
        expect(provider.seen.tokens).toEqual([]);
        expect(await prisma.userCalendarEventMapping.count({ where: { tenantId: a.tenant.id } })).toBe(0);
        const conn = await prisma.userCalendarConnection.findFirst({ where: { tenantId: a.tenant.id } });
        expect(conn?.revokedAt).toBeNull();
    }, 60_000);
});
