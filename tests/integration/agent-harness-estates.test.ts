/**
 * Client estates, scanned on a schedule, against a real database (#3678).
 *
 *   1. THREE ESTATES, A SCHEDULE EACH, A NAMED OWNER PER SOURCE. The three
 *      fixture estates are declared through the usecase and stored with their
 *      cadence and an ACTIVE member owning every source.
 *   2. HEALTH FROM SIGNED SCANS. Each estate's scanner signs its reports with
 *      the reference fake (`agent-harness-fake-scanner.ts`) and they go through
 *      the real ingest; the health view then shows the last complete scan per
 *      estate and per source, and a STALE estate as stale — overdue,
 *      incomplete, or missing a declared source. (These scans were made by the
 *      in-repo scanner reading HTTP fakes until it was removed, scanent #26;
 *      what the scanner reads and leaves out is scanent's to test now.)
 *   3. THE WRITES REFUSE what would make an estate unaccountable or ambiguous.
 *   4. AUTHORITY. Declaring is the register key's; reading is the inventory's.
 *   5. ISOLATION. Through the usecases one tenant cannot see or change another's
 *      estates, and under `app_user` both tables hold to the tenant bound.
 *   6. THE DATABASE holds the cadence bounds and the source vocabulary below
 *      the usecase.
 */
import { MembershipStatus, PrismaClient, Role } from '@prisma/client';

import { prismaTestClient } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { createFakeScanner, validReportBody, type FakeScanner } from '../helpers/agent-harness-fake-scanner';
import { createRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import { ingestHarnessReport } from '@/app-layer/usecases/agent-harness-scans';
import { addHarnessScannerKey } from '@/app-layer/usecases/agent-harness-scanner-keys';
import {
    createHarnessEstate,
    deleteHarnessEstate,
    getHarnessEstateHealth,
    updateHarnessEstate,
} from '@/app-layer/usecases/agent-harness-estates';
import type { RequestContext } from '@/app-layer/types';
import { SOURCE_KINDS, type HarnessReportBodyV2 } from '@/lib/agentic/harness-contract';
import type { EstateHealthRow } from '@/lib/agentic/harness-estate-health';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(180_000);

const T1 = 'harness-estates-one';
const T2 = 'harness-estates-two';
const ALL_TENANTS = [T1, T2];
const HOUR = 3_600_000;

/**
 * Three fixture client estates (#3678): the name and cadence each is declared
 * with, and which seeded member owns each source. Inlined from the fixture
 * module the in-repo scanner's configuration shared, removed with it.
 */
const CLIENT_ESTATES: readonly {
    readonly name: string;
    readonly cadenceHours: number;
    readonly sources: readonly { readonly kind: 'okta-app' | 'vault'; readonly ownerRole: 'identity' | 'secrets' }[];
}[] = [
    {
        name: 'Acme production',
        cadenceHours: 24,
        sources: [
            { kind: 'okta-app', ownerRole: 'identity' },
            { kind: 'vault', ownerRole: 'secrets' },
        ],
    },
    { name: 'Globex identity', cadenceHours: 12, sources: [{ kind: 'okta-app', ownerRole: 'identity' }] },
    { name: 'Initech secrets', cadenceHours: 24, sources: [{ kind: 'vault', ownerRole: 'secrets' }] },
];

interface Seeded {
    ownerUserId: string;
    identityOwnerId: string;
    secretsOwnerId: string;
    departedUserId: string;
    scanners: { agentId: string; signer: FakeScanner }[];
}
const seeded: Record<string, Seeded> = {};

const ctxFor = (tenantId: string, role: Role | string = 'OWNER'): RequestContext =>
    makeRequestContext(role, { tenantId, tenantSlug: tenantId, userId: seeded[tenantId].ownerUserId });

const emails = (tenantId: string) =>
    ['owner', 'identity', 'secrets', 'departed'].map((p) => `${p}@${tenantId}.test`);

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: ALL_TENANTS } };
    await prisma.agentHarnessEstateSource.deleteMany({ where: t });
    await prisma.agentHarnessEstate.deleteMany({ where: t });
    await prisma.agentHarnessAcceptance.deleteMany({ where: t });
    await prisma.agentHarnessScanItem.deleteMany({ where: t });
    await prisma.agentHarnessScan.deleteMany({ where: t });
    await prisma.discoveredAgent.deleteMany({ where: t });
    await prisma.agentHarnessScannerKey.deleteMany({ where: t });
    await prisma.finding.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, ALL_TENANTS);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, ALL_TENANTS);
    });
    await prisma.user.deleteMany({ where: { emailHash: { in: ALL_TENANTS.flatMap(emails).map(hashForLookup) } } });
    await prisma.tenant.deleteMany({ where: { id: { in: ALL_TENANTS } } });
}

async function member(tenantId: string, email: string, role: Role, status: MembershipStatus = MembershipStatus.ACTIVE): Promise<string> {
    const user = await prisma.user.create({ data: { email, name: email.split('@')[0], emailHash: hashForLookup(email) } });
    await prisma.tenantMembership.create({ data: { tenantId, userId: user.id, role, status } });
    return user.id;
}

async function seedTenant(tenantId: string): Promise<void> {
    await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
    const [ownerEmail, identityEmail, secretsEmail, departedEmail] = emails(tenantId);
    const ownerUserId = await member(tenantId, ownerEmail, Role.OWNER);
    seeded[tenantId] = {
        ownerUserId,
        identityOwnerId: await member(tenantId, identityEmail, Role.EDITOR),
        secretsOwnerId: await member(tenantId, secretsEmail, Role.EDITOR),
        departedUserId: await member(tenantId, departedEmail, Role.EDITOR, MembershipStatus.DEACTIVATED),
        scanners: [],
    };
    for (const [i, estate] of CLIENT_ESTATES.entries()) {
        const aiSystem = await prisma.aiSystem.create({ data: { tenantId, name: `Scanner host ${i}`, ownerUserId } });
        const agent = await createRegisteredAgent(ctxFor(tenantId), {
            aiSystemId: aiSystem.id,
            name: `Harness scanner for ${estate.name}`,
            autonomyLevel: 1,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'COMPENSABLE',
            provenance: 'FIRST_PARTY',
            ownerUserId,
        });
        const signer = createFakeScanner();
        await addHarnessScannerKey(ctxFor(tenantId), { agentId: agent.id, publicKey: signer.publicKeyHex });
        seeded[tenantId].scanners.push({ agentId: agent.id, signer });
    }
}

const ownerFor = (tenantId: string, role: 'identity' | 'secrets') =>
    role === 'identity' ? seeded[tenantId].identityOwnerId : seeded[tenantId].secretsOwnerId;

/** Declare fixture estate `i` in `tenantId`, owners by role. */
const declare = (tenantId: string, i: number) =>
    createHarnessEstate(ctxFor(tenantId), {
        name: CLIENT_ESTATES[i].name,
        scannerAgentId: seeded[tenantId].scanners[i].agentId,
        cadenceHours: CLIENT_ESTATES[i].cadenceHours,
        sources: CLIENT_ESTATES[i].sources.map((s) => ({ kind: s.kind, ownerUserId: ownerFor(tenantId, s.ownerRole) })),
    });

let scanSeq = 0;
const START = Date.now();

/** An Okta API token, as a scanner reports one: a principal with no sign of a model. */
const oktaToken = (id: string): HarnessReportBodyV2['agents'][number] => ({
    discoveredId: `okta:api-token:${id}`,
    discoveredVia: ['okta-app'],
    registeredAgentId: null,
    owner: null,
    credentials: [],
    tools: [],
    skills: [],
    verdicts: [],
});

/** A vault principal: an identity found by its tagged secret, again with no sign of a model. */
const vaultPrincipal = (id: string): HarnessReportBodyV2['agents'][number] => ({
    ...oktaToken(id),
    discoveredId: `vault:${id}`,
    discoveredVia: ['vault'],
});

/**
 * What each fixture estate's scanner reads, as its report body: the sources it
 * declares, read in full, and the principals it finds. Every id is the
 * estate's own, so two estates never collide in the tenant's namespace. With
 * `vaultUnreadable`, the vault answered nothing (its credential failed): the
 * source is INCOMPLETE `AUTH_FAILED` and its principals are absent.
 */
function estateReport(i: number, opts: { vaultUnreadable?: boolean } = {}): Pick<HarnessReportBodyV2, 'population' | 'agents'> {
    const vault = (ids: string[]) =>
        opts.vaultUnreadable
            ? { source: { kind: 'vault' as const, status: 'INCOMPLETE' as const, reason: 'AUTH_FAILED' as const, rows: 0 }, agents: [] }
            : { source: { kind: 'vault' as const, status: 'COMPLETE' as const, rows: ids.length }, agents: ids.map(vaultPrincipal) };
    const okta = (ids: string[]) => ({
        source: { kind: 'okta-app' as const, status: 'COMPLETE' as const, rows: ids.length },
        agents: ids.map(oktaToken),
    });
    const parts =
        i === 0 ? [okta(['00TToken1', '00TToken2']), vault(['acme-reporting'])]
        : i === 1 ? [okta(['00TGToken1', '00TGToken2'])]
        : [vault(['initech-billing', 'initech-ledger'])];
    return { population: { sources: parts.map((p) => p.source) }, agents: parts.flatMap((p) => p.agents) };
}

/** Sign estate `i`'s report as of `hoursAgo` with its scanner's key, and post it through the real ingest. */
async function scanAndIngest(tenantId: string, i: number, hoursAgo: number, opts: { vaultUnreadable?: boolean } = {}) {
    const { scanners } = seeded[tenantId];
    const body: HarnessReportBodyV2 = {
        ...validReportBody(),
        ...estateReport(i, opts),
        findings: [],
    };
    body.scan = {
        id: `scan_estate_${++scanSeq}`,
        asOf: new Date(START - hoursAgo * HOUR).toISOString(),
        scanner: { ...body.scan.scanner, agentId: scanners[i].agentId },
    };
    return ingestHarnessReport(ctxFor(tenantId), scanners[i].signer.serialise(body));
}

async function asTenant<T>(tenantId: string | null, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
        if (tenantId) await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${tenantId}', true)`);
        return fn(tx as unknown as PrismaClient);
    });
}

const health = async (tenantId = T1, now = new Date(START + 60_000)) => getHarnessEstateHealth(ctxFor(tenantId), { now });
const rowNamed = (rows: readonly EstateHealthRow[], name: string) => {
    const row = rows.find((r) => r.name === name);
    if (!row) throw new Error(`no estate named ${name}`);
    return row;
};

beforeAll(async () => {
    await clearOwnRows();
    for (const t of ALL_TENANTS) await seedTenant(t);
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('1. three estates, a schedule each, a named owner per source', () => {
    it('declares the three fixture estates with their cadence and an active owner for every source', async () => {
        for (let i = 0; i < CLIENT_ESTATES.length; i++) await declare(T1, i);

        const stored = await prisma.agentHarnessEstate.findMany({
            where: { tenantId: T1 },
            orderBy: { name: 'asc' },
            include: { sources: { orderBy: { kind: 'asc' } } },
        });
        expect(stored.map((e) => [e.name, e.cadenceHours, e.sources.map((s) => s.kind)])).toEqual([
            ['Acme production', 24, ['okta-app', 'vault']],
            ['Globex identity', 12, ['okta-app']],
            ['Initech secrets', 24, ['vault']],
        ]);
        const owners = stored.flatMap((e) => e.sources.map((s) => s.ownerUserId));
        expect(owners.every((id) => id === seeded[T1].identityOwnerId || id === seeded[T1].secretsOwnerId)).toBe(true);
        const active = await prisma.tenantMembership.count({
            where: { tenantId: T1, userId: { in: owners }, status: MembershipStatus.ACTIVE },
        });
        expect(active).toBe(new Set(owners).size);

        // Each estate is stored with the cadence it was declared with.
        for (const fixture of CLIENT_ESTATES) {
            const estate = stored.find((e) => e.name === fixture.name)!;
            expect(estate.cadenceHours).toBe(fixture.cadenceHours);
        }

        const audits = await prisma.auditLog.findMany({ where: { tenantId: T1, action: 'AGENT_HARNESS_ESTATE_DECLARED' } });
        expect(audits).toHaveLength(3);
    });

    it('with no scan yet, every estate and every source reads STALE, never fresh', async () => {
        const view = await health();
        expect(view.estates.rows).toHaveLength(3);
        for (const row of view.estates.rows) {
            expect(row).toMatchObject({ status: 'STALE', lastComplete: null, latest: null });
            expect(row.sources.every((s) => s.status === 'STALE' && s.latest === null)).toBe(true);
        }
    });
});

describe('2. the health view, from signed scans through the real ingest', () => {
    beforeAll(async () => {
        // Acme: a complete scan two hours ago, inside its 24-hour cadence.
        await scanAndIngest(T1, 0, 2);
        // Globex: its last scan 30 hours ago, against a 12-hour cadence.
        await scanAndIngest(T1, 1, 30);
        // Initech: complete 60 hours ago; the latest, three hours ago, could not read the vault.
        await scanAndIngest(T1, 2, 60);
        await scanAndIngest(T1, 2, 3, { vaultUnreadable: true });
    });

    it('every Okta API token is raised through the real ingest as an unregistered identity', async () => {
        // An API token is a principal on no list, and nothing an Okta read
        // reports shows it to run a model: it lists no tool and no model
        // endpoint, and was not found in code, a tracing system or an MCP
        // server. So it is an UNREGISTERED_IDENTITY, not a shadow agent (owner
        // decisions, 2026-11-13), and it has no shortfall finding. (That the
        // scanner leaves its OWN token out is the scanner's rule, tested in
        // scanent since the in-repo scanner was removed.)
        const refsOf = async (prefix: string) =>
            (
                await prisma.finding.findMany({
                    where: { tenantId: T1, sourceKind: 'AGENT_HARNESS', sourceRef: { startsWith: `${prefix}:okta:api-token:` } },
                    select: { sourceRef: true },
                })
            )
                .map((f) => f.sourceRef as string)
                .sort();
        // Acme's org and Globex's, each with two tokens.
        expect(await refsOf('UNREGISTERED_IDENTITY')).toEqual([
            'UNREGISTERED_IDENTITY:okta:api-token:00TGToken1',
            'UNREGISTERED_IDENTITY:okta:api-token:00TGToken2',
            'UNREGISTERED_IDENTITY:okta:api-token:00TToken1',
            'UNREGISTERED_IDENTITY:okta:api-token:00TToken2',
        ]);
        expect(await refsOf('SHADOW_AGENT')).toEqual([]);
        expect(await refsOf('HARNESS_SHORTFALL')).toEqual([]);
    });

    it('a fresh estate shows its last complete scan, per estate and per source', async () => {
        const acme = rowNamed((await health()).estates.rows, 'Acme production');
        expect(acme).toMatchObject({ status: 'FRESH', cadenceHours: 24, staleAfterHours: 36, scannerLive: true });
        expect(acme.lastComplete?.at).toBe(new Date(START - 2 * HOUR).toISOString());
        expect(acme.latest).toMatchObject({ completeness: 'COMPLETE', scanId: acme.lastComplete?.scanId });
        expect(acme.sources.map((s) => [s.kind, s.status, s.latest?.state, s.owner.active])).toEqual([
            ['okta-app', 'FRESH', 'COMPLETE', true],
            ['vault', 'FRESH', 'COMPLETE', true],
        ]);
        expect(acme.sources[0].owner).toMatchObject({ userId: seeded[T1].identityOwnerId, name: 'identity' });
    });

    it('an estate past one and a half cadences is STALE, its last complete scan still shown', async () => {
        const globex = rowNamed((await health()).estates.rows, 'Globex identity');
        expect(globex).toMatchObject({ status: 'STALE', staleAfterHours: 18 });
        expect(globex.lastComplete?.at).toBe(new Date(START - 30 * HOUR).toISOString());
        expect(globex.sources[0]).toMatchObject({ kind: 'okta-app', status: 'STALE', latest: { state: 'COMPLETE' } });
    });

    it('an estate whose latest scan could not read a source is STALE, and the source says why', async () => {
        const initech = rowNamed((await health()).estates.rows, 'Initech secrets');
        expect(initech.status).toBe('STALE');
        // Its only source was unreadable, so the scan found nobody: EMPTY, which
        // is never complete, rather than INCOMPLETE.
        expect(initech.latest?.completeness).toBe('EMPTY');
        expect(initech.lastComplete?.at).toBe(new Date(START - 60 * HOUR).toISOString());
        expect(initech.sources).toEqual([
            expect.objectContaining({ kind: 'vault', status: 'STALE', latest: { state: 'INCOMPLETE', reason: 'AUTH_FAILED' } }),
        ]);
    });

    it('a source the estate declares and the scanner does not read keeps the estate STALE', async () => {
        const [acme] = await prisma.agentHarnessEstate.findMany({ where: { tenantId: T1, name: 'Acme production' } });
        await updateHarnessEstate(ctxFor(T1), acme.id, {
            sources: [
                { kind: 'okta-app', ownerUserId: seeded[T1].identityOwnerId },
                { kind: 'vault', ownerUserId: seeded[T1].secretsOwnerId },
                { kind: 'entra-sp', ownerUserId: seeded[T1].identityOwnerId },
            ],
        });
        const row = rowNamed((await health()).estates.rows, 'Acme production');
        expect(row.status).toBe('STALE');
        expect(row.lastComplete).toBeNull();
        expect(row.sources.find((s) => s.kind === 'entra-sp')).toMatchObject({ status: 'STALE', latest: { state: 'NOT_REPORTED' } });
        // The two it does read are still fresh: per-source health is per source.
        expect(row.sources.filter((s) => s.status === 'FRESH').map((s) => s.kind)).toEqual(['okta-app', 'vault']);

        await updateHarnessEstate(ctxFor(T1), acme.id, {
            sources: [
                { kind: 'okta-app', ownerUserId: seeded[T1].identityOwnerId },
                { kind: 'vault', ownerUserId: seeded[T1].secretsOwnerId },
            ],
        });
        expect(rowNamed((await health()).estates.rows, 'Acme production').status).toBe('FRESH');
    });

    it('the same estate goes STALE when the clock passes its threshold, with no new write', async () => {
        const later = new Date(START + 35 * HOUR);
        expect(rowNamed((await health(T1, later)).estates.rows, 'Acme production').status).toBe('STALE');
    });

    it('a source owner who leaves the tenant is shown as departed, never dropped', async () => {
        await prisma.tenantMembership.updateMany({
            where: { tenantId: T1, userId: seeded[T1].secretsOwnerId },
            data: { status: MembershipStatus.DEACTIVATED },
        });
        try {
            const acme = rowNamed((await health()).estates.rows, 'Acme production');
            expect(acme.sources.find((s) => s.kind === 'vault')?.owner).toMatchObject({ userId: seeded[T1].secretsOwnerId, active: false });
        } finally {
            await prisma.tenantMembership.updateMany({
                where: { tenantId: T1, userId: seeded[T1].secretsOwnerId },
                data: { status: MembershipStatus.ACTIVE },
            });
        }
    });

    it('a narrowed scan window says it is narrowed', async () => {
        const view = await getHarnessEstateHealth(ctxFor(T1), { now: new Date(START), limits: { scans: 1 } });
        expect(view).toMatchObject({ scanWindow: 1, windowTruncated: true });
    });

    it('a busier scanner filling the shared window does not turn a fresh estate STALE (#5317)', async () => {
        // Globex now scans an hour ago, the newest scan of all. With the shared
        // window narrowed to one scan, Acme's fresh scan (two hours ago) is
        // crowded out of it — and the card must still judge Acme as the daily
        // staleness pass does, over Acme's own freshness window.
        await scanAndIngest(T1, 1, 1);
        const view = await getHarnessEstateHealth(ctxFor(T1), { now: new Date(START + 60_000), limits: { scans: 1 } });
        expect(view.windowTruncated).toBe(true);
        expect(rowNamed(view.estates.rows, 'Acme production').status).toBe('FRESH');
        expect(rowNamed(view.estates.rows, 'Globex identity').status).toBe('FRESH');
    });
});

describe('3. the writes refuse an unaccountable or ambiguous estate', () => {
    const scanner = () => seeded[T2].scanners[0].agentId;
    const valid = (over: Record<string, unknown> = {}) => ({
        name: 'Refusal probe',
        scannerAgentId: scanner(),
        cadenceHours: 24,
        sources: [{ kind: 'vault' as const, ownerUserId: seeded[T2].secretsOwnerId }],
        ...over,
    });

    it.each([
        ['an owner from another tenant', () => valid({ sources: [{ kind: 'vault', ownerUserId: seeded[T1].secretsOwnerId }] }), /active member/],
        ['an owner who has left', () => valid({ sources: [{ kind: 'vault', ownerUserId: seeded[T2].departedUserId }] }), /active member/],
        ['no sources', () => valid({ sources: [] }), /at least one source/],
        ['a kind twice', () => valid({ sources: [
            { kind: 'vault', ownerUserId: seeded[T2].secretsOwnerId },
            { kind: 'vault', ownerUserId: seeded[T2].identityOwnerId },
        ] }), /appears once/],
        ['a kind the contract does not define', () => valid({ sources: [{ kind: 'ldap', ownerUserId: seeded[T2].secretsOwnerId }] }), /./],
        ['a cadence of zero', () => valid({ cadenceHours: 0 }), /./],
    ])('refuses %s', async (_label, input, message) => {
        await expect(createHarnessEstate(ctxFor(T2), input() as never)).rejects.toThrow(message);
        expect(await prisma.agentHarnessEstate.count({ where: { tenantId: T2 } })).toBe(0);
    });

    it('refuses a second estate on one scanner, and a second estate of one name', async () => {
        await createHarnessEstate(ctxFor(T2), valid());
        await expect(createHarnessEstate(ctxFor(T2), valid({ name: 'Another' }))).rejects.toThrow(/one estate per scanner/);
        await expect(createHarnessEstate(ctxFor(T2), valid({ scannerAgentId: seeded[T2].scanners[1].agentId }))).rejects.toThrow(/name already exists/);
    });

    it('refuses a scanner the register no longer holds', async () => {
        await prisma.registeredAgent.updateMany({ where: { id: seeded[T2].scanners[2].agentId }, data: { deletedAt: new Date() } });
        await expect(
            createHarnessEstate(ctxFor(T2), valid({ name: 'Deleted scanner', scannerAgentId: seeded[T2].scanners[2].agentId })),
        ).rejects.toThrow(/not found/);
    });
});

describe('4. authority', () => {
    it('a READER can neither read the health nor declare an estate', async () => {
        await expect(getHarnessEstateHealth(ctxFor(T1, 'READER'))).rejects.toThrow(/agent_registry_view/);
        await expect(
            createHarnessEstate(ctxFor(T1, 'READER'), {
                name: 'x',
                scannerAgentId: seeded[T1].scanners[0].agentId,
                cadenceHours: 1,
                sources: [{ kind: 'vault', ownerUserId: seeded[T1].secretsOwnerId }],
            }),
        ).rejects.toThrow(/admin.agent_registry/);
    });

    it('an AUDITOR reads the health through the view key, and declares nothing', async () => {
        const view = await getHarnessEstateHealth(ctxFor(T1, 'AUDITOR'), { now: new Date(START) });
        expect(view.estates.rows.map((r) => r.name)).toEqual(['Acme production', 'Globex identity', 'Initech secrets']);
        const [estate] = view.estates.rows;
        await expect(updateHarnessEstate(ctxFor(T1, 'AUDITOR'), estate.id, { cadenceHours: 6 })).rejects.toThrow(/admin.agent_registry/);
        await expect(deleteHarnessEstate(ctxFor(T1, 'AUDITOR'), estate.id)).rejects.toThrow(/admin.agent_registry/);
    });
});

describe('5. isolation', () => {
    it('through the usecases, one tenant cannot see, change or remove another\'s estates', async () => {
        const mine = (await health(T1)).estates.rows;
        const theirs = (await health(T2)).estates.rows;
        expect(theirs.map((r) => r.name)).toEqual(['Refusal probe']);
        expect(theirs.some((r) => mine.some((m) => m.id === r.id))).toBe(false);

        const target = mine[0].id;
        await expect(updateHarnessEstate(ctxFor(T2), target, { cadenceHours: 1 })).rejects.toThrow(/not found/);
        await expect(deleteHarnessEstate(ctxFor(T2), target)).rejects.toThrow(/not found/);
        await expect(
            createHarnessEstate(ctxFor(T2), {
                name: 'Borrowed scanner',
                scannerAgentId: seeded[T1].scanners[1].agentId,
                cadenceHours: 24,
                sources: [{ kind: 'vault', ownerUserId: seeded[T2].secretsOwnerId }],
            }),
        ).rejects.toThrow(/not found/);
        expect((await prisma.agentHarnessEstate.findUniqueOrThrow({ where: { id: target } })).cadenceHours).toBe(24);
    });

    it('under app_user, each tenant reads and writes only its own rows in both tables', async () => {
        const counts = async (tenantId: string | null) =>
            asTenant(tenantId, async (tx) => ({
                estates: await tx.agentHarnessEstate.count(),
                sources: await tx.agentHarnessEstateSource.count(),
            }));
        expect(await counts(T1)).toEqual({ estates: 3, sources: 4 });
        expect(await counts(T2)).toEqual({ estates: 1, sources: 1 });
        expect(await counts(null)).toEqual({ estates: 0, sources: 0 });

        const [t1Estate] = await prisma.agentHarnessEstate.findMany({ where: { tenantId: T1 }, take: 1 });
        await expect(
            asTenant(T2, (tx) =>
                tx.agentHarnessEstateSource.create({
                    data: { tenantId: T1, estateId: t1Estate.id, kind: 'mcp', ownerUserId: seeded[T1].ownerUserId },
                }),
            ),
        ).rejects.toThrow();
        const moved = await asTenant(T2, (tx) => tx.agentHarnessEstate.updateMany({ where: { id: t1Estate.id }, data: { cadenceHours: 1 } }));
        expect(moved.count).toBe(0);
    });

    it('removing an estate removes its sources and keeps its scans', async () => {
        const [probe] = await prisma.agentHarnessEstate.findMany({ where: { tenantId: T2 } });
        const scansBefore = await prisma.agentHarnessScan.count({ where: { tenantId: T1 } });
        await deleteHarnessEstate(ctxFor(T2), probe.id);
        expect(await prisma.agentHarnessEstateSource.count({ where: { estateId: probe.id } })).toBe(0);
        expect(await prisma.agentHarnessScan.count({ where: { tenantId: T1 } })).toBe(scansBefore);
        expect(await prisma.auditLog.count({ where: { tenantId: T2, action: 'AGENT_HARNESS_ESTATE_REMOVED' } })).toBe(1);
    });
});

describe('6. the database holds the bounds below the usecase', () => {
    it('refuses a cadence outside 1..720 and a source kind outside the contract', async () => {
        const [estate] = await prisma.agentHarnessEstate.findMany({ where: { tenantId: T1 }, take: 1 });
        await expect(
            prisma.$executeRawUnsafe(`UPDATE "AgentHarnessEstate" SET "cadenceHours" = 0 WHERE id = $1`, estate.id),
        ).rejects.toThrow(/cadence_hours_bounded/);
        await expect(
            prisma.$executeRawUnsafe(
                `INSERT INTO "AgentHarnessEstateSource" (id, "tenantId", "estateId", kind, "ownerUserId", "updatedAt") VALUES ('x-4a', $1, $2, 'ldap', $3, now())`,
                T1,
                estate.id,
                seeded[T1].ownerUserId,
            ),
        ).rejects.toThrow(/kind_known/);
    });

    it('admits every kind a report can carry, the `code` source /2 added included (#3754)', async () => {
        const [estate] = await prisma.agentHarnessEstate.findMany({ where: { tenantId: T1, name: 'Initech secrets' } });
        // Through the usecase: an owner for the code source a /2 scanner reads.
        await updateHarnessEstate(ctxFor(T1), estate.id, {
            sources: [
                { kind: 'vault', ownerUserId: seeded[T1].secretsOwnerId },
                { kind: 'code', ownerUserId: seeded[T1].identityOwnerId },
            ],
        });
        const kinds = await prisma.agentHarnessEstateSource.findMany({ where: { estateId: estate.id }, orderBy: { kind: 'asc' } });
        expect(kinds.map((k) => k.kind)).toEqual(['code', 'vault']);

        // And below it: the CHECK admits each of SOURCE_KINDS. Inserted and
        // rolled back, so the estate is left as declared.
        const ROLLBACK = 'rolled back on purpose';
        await expect(
            prisma.$transaction(async (tx) => {
                await tx.agentHarnessEstateSource.deleteMany({ where: { estateId: estate.id } });
                for (const kind of SOURCE_KINDS) {
                    await tx.$executeRawUnsafe(
                        `INSERT INTO "AgentHarnessEstateSource" (id, "tenantId", "estateId", kind, "ownerUserId", "updatedAt") VALUES ($1, $2, $3, $4, $5, now())`,
                        `x-3754-${kind}`,
                        T1,
                        estate.id,
                        kind,
                        seeded[T1].secretsOwnerId,
                    );
                }
                throw new Error(ROLLBACK);
            }),
        ).rejects.toThrow(ROLLBACK);
        expect(await prisma.agentHarnessEstateSource.count({ where: { estateId: estate.id } })).toBe(2);
    });
});
