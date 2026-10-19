/**
 * Client estates, scanned on a schedule, against a real database (#3678).
 *
 *   1. THREE ESTATES, A SCHEDULE EACH, A NAMED OWNER PER SOURCE. The three
 *      fixture estates are declared through the usecase and stored with their
 *      cadence and an ACTIVE member owning every source — the cadence the
 *      scanner's own configuration runs at.
 *   2. HEALTH FROM REAL SCANS. The reference scanner (the package) reads the
 *      HTTP fakes, signs, and its reports go through the real ingest; the health
 *      view then shows the last complete scan per estate and per source, and a
 *      STALE estate as stale — overdue, incomplete, or missing a declared source.
 *   3. THE WRITES REFUSE what would make an estate unaccountable or ambiguous.
 *   4. AUTHORITY. Declaring is the register key's; reading is the inventory's.
 *   5. ISOLATION. Through the usecases one tenant cannot see or change another's
 *      estates, and under `app_user` both tables hold to the tenant bound.
 *   6. THE DATABASE holds the cadence bounds and the source vocabulary below
 *      the usecase.
 */
import { generateKeyPairSync } from 'crypto';
import { MembershipStatus, PrismaClient, Role } from '@prisma/client';

import { prismaTestClient } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import {
    AZURE_CLIENT_SECRET_VALUE,
    createSourceFakes,
    NEVER_REPORTED,
    OKTA_TOKEN_VALUE,
    oktaFixture,
    SCANNER_OKTA_TOKEN_ID,
    vaultFixture,
    VAULT,
    type Fakes,
} from '../helpers/agent-harness-source-fakes';
import { CLIENT_ESTATES, GLOBEX_OKTA_ORG, INITECH_VAULT } from '../helpers/agent-harness-estate-fixtures';
import { createRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import { ingestHarnessReport } from '@/app-layer/usecases/agent-harness-scans';
import { addHarnessScannerKey } from '@/app-layer/usecases/agent-harness-scanner-keys';
import {
    createHarnessEstate,
    deleteHarnessEstate,
    getHarnessEstateHealth,
    updateHarnessEstate,
} from '@/app-layer/usecases/agent-harness-estates';
import { parseScannerConfig } from '../../packages/agent-harness-scanner/src/config';
import { jsonLineLog } from '../../packages/agent-harness-scanner/src/log';
import { rawPublicKeyHex } from '../../packages/agent-harness-scanner/src/report';
import { runScan } from '../../packages/agent-harness-scanner/src/scan';
import type { RequestContext } from '@/app-layer/types';
import { SOURCE_KINDS } from '@/lib/agentic/harness-contract';
import type { EstateHealthRow } from '@/lib/agentic/harness-estate-health';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(180_000);

const T1 = 'harness-estates-one';
const T2 = 'harness-estates-two';
const ALL_TENANTS = [T1, T2];
const HOUR = 3_600_000;

interface Seeded {
    ownerUserId: string;
    identityOwnerId: string;
    secretsOwnerId: string;
    departedUserId: string;
    scanners: { agentId: string; pem: string }[];
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
        const { privateKey, publicKey } = generateKeyPairSync('ed25519');
        await addHarnessScannerKey(ctxFor(tenantId), { agentId: agent.id, publicKey: rawPublicKeyHex(publicKey) });
        seeded[tenantId].scanners.push({ agentId: agent.id, pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() });
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

/** Rewrite a fixture's ids so two estates' principals never collide in the tenant's discovered-agent namespace. */
function distinct<T>(fixture: T, tag: string): T {
    return JSON.parse(
        JSON.stringify(fixture)
            .replace(/0oa/g, `0oa${tag}`)
            .replace(/00T/g, `00T${tag}`)
            .replace(/entra:sp:/g, `entra:sp:${tag}-`)
            .replace(/okta:app:/g, `okta:app:${tag}`),
    ) as T;
}

let fakes: Fakes;
const START = Date.now();

/** Run the real scanner for estate `i` as of `hoursAgo`, and post its report through the real ingest. */
async function scanAndIngest(tenantId: string, i: number, hoursAgo: number, env: Record<string, string | undefined> = {}) {
    const fixture = CLIENT_ESTATES[i];
    const config = parseScannerConfig({
        ...fixture.scannerConfig,
        scanner: { ...(fixture.scannerConfig.scanner as object), agentId: seeded[tenantId].scanners[i].agentId },
    });
    const lines: string[] = [];
    const { raw } = await runScan({
        config,
        env: {
            SCANNER_SIGNING_KEY: seeded[tenantId].scanners[i].pem,
            ACME_OKTA_API_TOKEN: OKTA_TOKEN_VALUE,
            ACME_AZURE_CLIENT_SECRET: AZURE_CLIENT_SECRET_VALUE,
            GLOBEX_OKTA_API_TOKEN: OKTA_TOKEN_VALUE,
            INITECH_AZURE_CLIENT_SECRET: AZURE_CLIENT_SECRET_VALUE,
            ...env,
        },
        log: jsonLineLog((l) => lines.push(l)),
        fetchImpl: fakes.fetchImpl,
        now: () => START - hoursAgo * HOUR,
    });
    for (const secret of NEVER_REPORTED) expect(lines.join('')).not.toContain(secret);
    return ingestHarnessReport(ctxFor(tenantId), raw);
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
    fakes = createSourceFakes({
        okta: oktaFixture(),
        oktaOrgs: { [GLOBEX_OKTA_ORG]: distinct(oktaFixture(), 'G') },
        vaults: { [VAULT]: vaultFixture(), [INITECH_VAULT]: distinct(vaultFixture(INITECH_VAULT), 'I') },
    });
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

        // The estate's cadence is the schedule its scanner runs at.
        for (const fixture of CLIENT_ESTATES) {
            const estate = stored.find((e) => e.name === fixture.name)!;
            expect(parseScannerConfig(fixture.scannerConfig).schedule.everyHours).toBe(estate.cadenceHours);
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

describe('2. the health view, from real scans through the real ingest', () => {
    beforeAll(async () => {
        // Acme: a complete scan two hours ago, inside its 24-hour cadence.
        await scanAndIngest(T1, 0, 2);
        // Globex: its last scan 30 hours ago, against a 12-hour cadence.
        await scanAndIngest(T1, 1, 30);
        // Initech: complete 60 hours ago; the latest, three hours ago, could not read the vault.
        await scanAndIngest(T1, 2, 60);
        await scanAndIngest(T1, 2, 3, { INITECH_AZURE_CLIENT_SECRET: undefined });
    });

    it('every Okta API token raises SHADOW_AGENT through the real ingest, except the scanner\'s own', async () => {
        const shadowRefs = (
            await prisma.finding.findMany({
                where: { tenantId: T1, sourceKind: 'AGENT_HARNESS', sourceRef: { startsWith: 'SHADOW_AGENT:okta:api-token:' } },
                select: { sourceRef: true },
            })
        ).map((f) => f.sourceRef as string);
        // Acme's org and Globex's, each with two tokens beside the scanner's own.
        expect(shadowRefs.sort()).toEqual([
            'SHADOW_AGENT:okta:api-token:00TGToken1',
            'SHADOW_AGENT:okta:api-token:00TGToken2',
            'SHADOW_AGENT:okta:api-token:00TToken1',
            'SHADOW_AGENT:okta:api-token:00TToken2',
        ]);
        const own = await prisma.discoveredAgent.count({
            where: { tenantId: T1, discoveredId: { in: [`okta:api-token:${SCANNER_OKTA_TOKEN_ID}`, 'okta:api-token:00TGScannerOwn'] } },
        });
        expect(own).toBe(0);
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

    it('no credential reached a stored scan or an estate audit row', async () => {
        const scans = await prisma.agentHarnessScan.findMany({ where: { tenantId: T1 }, select: { sourcesJson: true, signature: true } });
        const audits = await prisma.auditLog.findMany({ where: { tenantId: T1, action: { startsWith: 'AGENT_HARNESS_' } } });
        const text = JSON.stringify([scans, audits]);
        for (const secret of NEVER_REPORTED) expect(text).not.toContain(secret);
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
