/**
 * Profiling, end to end, against the fake server.
 *
 * The mock here is a SEAM INJECTOR rather than a stub: it delegates to the real
 * `@/lib/mcp/client` and only supplies the `fetchImpl` that no file under `src/`
 * is allowed to pass. So the real transport runs, the real usecase runs, and the
 * fake server's REQUEST LOG is populated — which is the only way to prove the
 * hardening item as written: "profiling never requests a denylisted column,
 * proven by the fake server's request log".
 *
 * A stub could not prove it. It would assert what we told the mock to expect.
 */
import { PrismaClient } from '@prisma/client';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import {
    createLegacyMcpFakeServer,
    KEY_COLUMN,
    type LegacyMcpFakeServer,
} from '../helpers/legacy-mcp-fake-server';

let server: LegacyMcpFakeServer;

jest.mock('@/lib/mcp/client', () => {
    const actual = jest.requireActual('@/lib/mcp/client');
    type Opts = Record<string, unknown>;
    return {
        ...actual,
        probeManifest: (o: Opts) =>
            actual.probeManifest({ ...o, fetchImpl: server.fetch }),
        profileFirstPage: (o: Opts) =>
            actual.profileFirstPage({ ...o, fetchImpl: server.fetch }),
    };
});

import { encryptField } from '@/lib/security/encryption';
import { profileLegacyConnection } from '@/app-layer/usecases/legacy-access-profile';
import { isDeniedColumn } from '@/lib/legacy-access/canonical';

const prisma: PrismaClient = prismaTestClient();
const TENANT = 'lgpr-tenant';
const ctx = () => makeRequestContext('OWNER', { tenantId: TENANT });

let connectionId: string;

/** Every `?fields=` the client actually asked for, flattened. */
const requestedColumns = (): string[] =>
    server.requests
        .map((r) => r.uri ?? '')
        .filter((u) => u.includes('fields='))
        .flatMap((u) => {
            const q = u.split('fields=')[1] ?? '';
            return decodeURIComponent(q.split('&')[0]).split(',').filter(Boolean);
        });

beforeAll(async () => {
    await resetDatabase(prisma);
    await prisma.integrationConnection.deleteMany({ where: { tenantId: TENANT } });
    await prisma.tenant.upsert({
        where: { id: TENANT },
        update: {},
        create: { id: TENANT, name: 'Profile Tenant', slug: TENANT },
    });
    // The drift test saves a mapping, which writes a hash-chained audit row
    // carrying `userId` — an FK to `User`. Seeded HERE rather than relied upon:
    // this suite passed locally only because a sibling suite had created
    // `user-1` in the same scratch database and nothing deletes users, so it was
    // riding on another suite's leftovers. CI's fresh database is the honest
    // environment, and it failed there (#3332, shard 3/4).
    await prisma.user.upsert({
        where: { id: 'user-1' },
        update: {},
        create: { id: 'user-1', email: 'profiler@lgpr.test', name: 'Profiler' },
    });
});

beforeEach(async () => {
    await prisma.legacyAccount.deleteMany({ where: { tenantId: TENANT } });
    await prisma.legacyAccessSnapshot.deleteMany({ where: { tenantId: TENANT } });
    await prisma.integrationConnection.deleteMany({ where: { tenantId: TENANT } });
    const conn = await prisma.integrationConnection.create({
        data: {
            tenantId: TENANT,
            provider: 'legacy-mcp',
            name: 'legacy',
            configJson: { endpointUrl: 'https://legacy.example.com/rpc' },
            secretEncrypted: encryptField(JSON.stringify({ bearerToken: 'tok-123' })),
        },
    });
    connectionId = conn.id;
});

afterAll(async () => {
    await prisma.legacyAccount.deleteMany({ where: { tenantId: TENANT } });
    await prisma.legacyAccessSnapshot.deleteMany({ where: { tenantId: TENANT } });
    await prisma.integrationConnection.deleteMany({ where: { tenantId: TENANT } });
    await prisma.$disconnect();
});

describe('profiling a conforming server', () => {
    beforeEach(() => {
        server = createLegacyMcpFakeServer({ accounts: 40, rowsPerPage: 10 });
    });

    it('returns a profile per column, with the application it fronts', async () => {
        const r = await profileLegacyConnection(ctx(), connectionId);
        expect(r.application.name).toBeTruthy();
        expect(r.columns.map((c) => c.profile.name)).toContain(KEY_COLUMN);
        expect(r.rowsSampled).toBe(10);
    });

    it('reads ONE page and says so, rather than treating the rest as a cap breach', async () => {
        const r = await profileLegacyConnection(ctx(), connectionId);
        // 40 accounts at 10 per page is four pages; a profile wants one.
        expect(r.truncated).toBe(true);
        const pageReads = server.requests.filter((q) => (q.uri ?? '').includes('accounts'));
        expect(pageReads).toHaveLength(1);
    });

    it('is NOT truncated when the table fits on one page', async () => {
        // The denominator. Without it, a bug that always reported `truncated`
        // would pass the test above.
        server = createLegacyMcpFakeServer({ accounts: 3, rowsPerPage: 10 });
        const r = await profileLegacyConnection(ctx(), connectionId);
        expect(r.truncated).toBe(false);
    });

    it('persists NOTHING — no snapshot and no account row', async () => {
        await profileLegacyConnection(ctx(), connectionId);
        expect(await prisma.legacyAccount.count({ where: { tenantId: TENANT } })).toBe(0);
        expect(await prisma.legacyAccessSnapshot.count({ where: { tenantId: TENANT } })).toBe(0);
    });

    it('offers a fingerprint over the CURRENT column set, for the caller to confirm', async () => {
        const r = await profileLegacyConnection(ctx(), connectionId);
        expect(r.columnSetFingerprint).toMatch(/^[0-9a-f]{64}$/);
        expect(r.observedColumns).toContain(KEY_COLUMN);
    });

    it('reports no drift when no mapping is saved', async () => {
        const r = await profileLegacyConnection(ctx(), connectionId);
        expect(r.drift).toBeNull();
        expect(r.mappingVersion).toBeNull();
    });
});

describe('the denylist, proven by the request log', () => {
    beforeEach(() => {
        server = createLegacyMcpFakeServer({
            accounts: 40,
            rowsPerPage: 10,
            declaresDeniedColumn: true,
        });
    });

    it('never REQUESTS the denylisted column the server declares', async () => {
        await profileLegacyConnection(ctx(), connectionId);
        const asked = requestedColumns();

        // The log is non-empty, or the assertion below is vacuous.
        expect(asked.length).toBeGreaterThan(0);
        expect(asked).toContain(KEY_COLUMN);
        // And not one requested column is denylisted.
        expect(asked.filter(isDeniedColumn)).toEqual([]);
        expect(asked).not.toContain('PASSWORD_HASH');
    });

    it('still SHOWS the column, as present and unmappable', async () => {
        // Omitting it would leave an administrator wondering where it went;
        // profiling it is what the denylist exists to prevent. So it appears with
        // no statistics and `denied: true`.
        const r = await profileLegacyConnection(ctx(), connectionId);
        const denied = r.columns.find((c) => c.profile.name === 'PASSWORD_HASH');
        expect(denied).toBeDefined();
        expect(denied!.suggestion.denied).toBe(true);
        expect(denied!.suggestion.suggested).toBeNull();
        expect(denied!.profile.nonNullCount).toBe(0);
        expect(denied!.profile.distinctCount).toBe(0);
    });

    it('carries no value from it anywhere in the response', async () => {
        const r = await profileLegacyConnection(ctx(), connectionId);
        const json = JSON.stringify(r);
        // The fixture's password-ish values never left the server, because they
        // were never requested.
        expect(json).not.toContain('hash-');
        expect(json).not.toContain('secret');
    });
});

describe('drift against a saved mapping', () => {
    it('names the columns added and removed since confirmation', async () => {
        // `schemaDrift` adds COST_CENTRE from the second pull onward. The first
        // profile sees the base set; save a mapping against it; the next profile
        // sees the wider set and must say what changed.
        server = createLegacyMcpFakeServer({
            accounts: 20, rowsPerPage: 20, faults: { schemaDrift: true },
        });
        const first = await profileLegacyConnection(ctx(), connectionId);

        const { saveLegacyAccessMapping } = await import('@/app-layer/usecases/legacy-access-mapping');
        await saveLegacyAccessMapping(ctx(), {
            connectionId,
            fields: { accountKey: KEY_COLUMN, email: 'EMAIL_ADDR' },
            entitlements: { kind: 'none' },
            columnSetFingerprint: first.columnSetFingerprint,
            confirmedColumns: first.observedColumns,
        });

        // The fixture's drift column appears from pull 2 onward, and `pull`
        // advances only on an explicit `nextPull()` — it does not auto-increment,
        // so without this the second profile sees the same column set and there is
        // no drift to report.
        server.nextPull();

        const second = await profileLegacyConnection(ctx(), connectionId);
        expect(second.mappingVersion).toBe(1);
        expect(second.drift).not.toBeNull();
        expect(second.drift!.indeterminate).toBe(false);
        expect(second.drift!.added).toEqual(['COST_CENTRE']);
        expect(second.drift!.removed).toEqual([]);
    });
});
