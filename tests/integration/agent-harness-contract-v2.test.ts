/**
 * `inflect-agent-harness/2` through the real ingest, against a real database
 * (#3754).
 *
 *   1. BOTH IDS INGEST. A `/1` report from a deployed scanner still verifies and
 *      ingests unchanged; a `/2` report does too, and its `code` source and
 *      `UNPARSEABLE` reason round-trip into the stored scan and its readers.
 *   1c. MODEL ENDPOINTS ARE KEPT (#3759), on the scan item and nowhere else:
 *      NULL is NOT REPORTED, `[]` is reported empty, and a stored value that
 *      no longer re-validates reads UNREADABLE on the matrix.
 *   2. A REFUSED REPORT WRITES NOTHING: a `/1` report carrying a `/2` member,
 *      and an unbound credential with a secret's shape. (Every malformation the
 *      fake scanner names is also driven through the ingest by
 *      `agent-harness-ingest.test.ts`.)
 *   3. ORPHAN_CREDENTIAL IS DERIVED, ON POSITIVE EVIDENCE. It opens when the
 *      source that saw the credential AND every identity-bearing source in the
 *      scan were read in full (owner answer, 2026-10-19); it closes only when a
 *      complete read of that source no longer sees it unbound; an incomplete or
 *      absent source closes nothing, and neither does a `/1` report.
 *   4. TWO TENANTS. One tenant's report opens and closes nothing in the other.
 */
import { MembershipStatus, PrismaClient, Role } from '@prisma/client';

import { prismaTestClient } from '../helpers/db';
import { canonicalJson } from '@/lib/canonical-json';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import {
    createFakeScanner,
    UNBOUND_VAULT_REF,
    V2_MODEL_ENDPOINTS,
    validReportBody,
    validV2ReportBody,
    type FakeScanner,
} from '../helpers/agent-harness-fake-scanner';
import { createRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import { ingestHarnessReport, listHarnessScans } from '@/app-layer/usecases/agent-harness-scans';
import { getHarnessMatrix } from '@/app-layer/usecases/agent-harness-matrix';
import { addHarnessScannerKey } from '@/app-layer/usecases/agent-harness-scanner-keys';
import {
    parseStoredHarnessModels,
    parseStoredHarnessSources,
    parseStoredHarnessTools,
    type HarnessReportBodyV1,
    type HarnessReportBodyV2,
} from '@/lib/agentic/harness-contract';
import { orphanCredentialRefOf } from '@/lib/agentic/harness-findings';
import { runInTenantContext } from '@/lib/db-context';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const T1 = 'harness-v2-one';
const T2 = 'harness-v2-two';
const ALL_TENANTS = [T1, T2];

interface Seeded {
    ownerUserId: string;
    scannerAgentId: string;
    targetAgentId: string;
    scanner: FakeScanner;
}
const seeded: Record<string, Seeded> = {};

const ctxFor = (tenantId: string): RequestContext =>
    makeRequestContext('OWNER', { tenantId, tenantSlug: tenantId, userId: seeded[tenantId].ownerUserId });

const ownerEmail = (tenantId: string) => `owner@${tenantId}.test`;

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: ALL_TENANTS } };
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
    await prisma.user.deleteMany({ where: { emailHash: { in: ALL_TENANTS.map(ownerEmail).map(hashForLookup) } } });
    await prisma.tenant.deleteMany({ where: { id: { in: ALL_TENANTS } } });
}

async function seedTenant(tenantId: string): Promise<void> {
    await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
    const email = ownerEmail(tenantId);
    const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await prisma.tenantMembership.create({
        data: { tenantId, userId: user.id, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });
    seeded[tenantId] = { ownerUserId: user.id } as Seeded;

    const agent = async (name: string) =>
        createRegisteredAgent(ctxFor(tenantId), {
            aiSystemId: (await prisma.aiSystem.create({ data: { tenantId, name: `Host of ${name}`, ownerUserId: user.id } })).id,
            name,
            autonomyLevel: 2,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'COMPENSABLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: user.id,
        });
    const scannerAgent = await agent(`Harness scanner ${tenantId}`);
    const targetAgent = await agent(`Reporting agent ${tenantId}`);
    const scanner = createFakeScanner();
    await addHarnessScannerKey(ctxFor(tenantId), { agentId: scannerAgent.id, publicKey: scanner.publicKeyHex });
    Object.assign(seeded[tenantId], { scannerAgentId: scannerAgent.id, targetAgentId: targetAgent.id, scanner });
}

let scanSeq = 0;

/** The fake scanner's `/1` body, pointed at this tenant's register rows. */
function v1For(tenantId: string, edit?: (b: HarnessReportBodyV1) => void): HarnessReportBodyV1 {
    const body = validReportBody();
    body.scan.id = `scan_v1_${++scanSeq}`;
    body.scan.scanner.agentId = seeded[tenantId].scannerAgentId;
    body.agents[0].registeredAgentId = seeded[tenantId].targetAgentId;
    edit?.(body);
    return body;
}

/**
 * The fake scanner's `/2` body, pointed at this tenant's register rows. Its
 * `code` source stopped early (UNPARSEABLE) unless an edit says otherwise.
 */
function v2For(tenantId: string, ...edits: Array<(b: HarnessReportBodyV2) => void>): HarnessReportBodyV2 {
    const body = validV2ReportBody();
    body.scan.id = `scan_v2_${++scanSeq}`;
    body.scan.scanner.agentId = seeded[tenantId].scannerAgentId;
    body.agents[0].registeredAgentId = seeded[tenantId].targetAgentId;
    for (const edit of edits) edit(body);
    return body;
}

/**
 * Read the `code` source in full. It is identity-bearing, so while it stops
 * early no ORPHAN_CREDENTIAL opens, whatever the vault saw.
 */
const codeReadInFull = (b: HarnessReportBodyV2) => {
    b.population.sources = b.population.sources.map((s) => (s.kind === 'code' ? { kind: 'code', status: 'COMPLETE', rows: 4 } : s));
};

/** Set the vault source of a `/2` body: read in full, stopped early, or not reported at all. */
const vault = (status: 'COMPLETE' | 'INCOMPLETE' | 'ABSENT') => (b: HarnessReportBodyV2) => {
    if (status === 'ABSENT') {
        b.population.sources = b.population.sources.filter((s) => s.kind !== 'vault');
        b.agents.forEach((a) => (a.discoveredVia = a.discoveredVia.filter((k) => k !== 'vault')));
    } else if (status === 'INCOMPLETE') {
        b.population.sources = b.population.sources.map((s) =>
            s.kind === 'vault' ? { kind: 'vault', status: 'INCOMPLETE', reason: 'TIME_BOX', rows: 20 } : s,
        );
    }
};

const ingest = (tenantId: string, body: HarnessReportBodyV1 | HarnessReportBodyV2) =>
    ingestHarnessReport(ctxFor(tenantId), seeded[tenantId].scanner.serialise(body));

const orphanRef = (tenantId: string, ref = UNBOUND_VAULT_REF) => orphanCredentialRefOf(seeded[tenantId].scannerAgentId, 'vault', ref);

async function findingStatus(tenantId: string, sourceRef: string): Promise<string | null> {
    const row = await prisma.finding.findFirst({
        where: { tenantId, sourceKind: 'AGENT_HARNESS', sourceRef, deletedAt: null },
        select: { status: true },
    });
    return row?.status ?? null;
}

async function harnessRowCounts(tenantId: string) {
    const t = { tenantId };
    return {
        scans: await prisma.agentHarnessScan.count({ where: t }),
        items: await prisma.agentHarnessScanItem.count({ where: t }),
        agents: await prisma.discoveredAgent.count({ where: t }),
        findings: await prisma.finding.count({ where: { ...t, sourceKind: 'AGENT_HARNESS' } }),
    };
}

async function asTenant<T>(tenantId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
        await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${tenantId}', true)`);
        return fn(tx as unknown as PrismaClient);
    });
}

beforeAll(async () => {
    await clearOwnRows();
    for (const t of ALL_TENANTS) await seedTenant(t);
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('1. both ids verify and ingest through the one path', () => {
    it('a /1 report from a deployed scanner ingests unchanged, and raises no orphan', async () => {
        const result = await ingest(T1, v1For(T1, (b) => (b.findings = [])));
        expect(result).toMatchObject({ complete: true, agentCount: 2, findingsOpened: 3 });
        const orphans = await prisma.finding.count({ where: { tenantId: T1, sourceRef: { startsWith: 'ORPHAN_CREDENTIAL:' } } });
        expect(orphans).toBe(0);
    });

    it('a /2 report ingests, and its code source and UNPARSEABLE reason round-trip into the stored scan', async () => {
        const body = v2For(T1);
        const result = await ingest(T1, body);
        // The code source stopped early, so the scan derives as incomplete.
        expect(result).toMatchObject({ scanRef: body.scan.id, complete: false, agentCount: 2 });

        const stored = await prisma.agentHarnessScan.findFirstOrThrow({ where: { tenantId: T1, scanRef: body.scan.id } });
        expect(stored.complete).toBe(false);
        expect(parseStoredHarnessSources(stored.sourcesJson)).toContainEqual({
            kind: 'code',
            status: 'INCOMPLETE',
            rows: 4,
            reason: 'UNPARSEABLE',
        });

        // Its readers read it: the list, and the matrix, which would show a
        // source it could not re-read as `null` (and the scan as unreadable).
        expect((await listHarnessScans(ctxFor(T1))).map((s) => s.scanRef)).toContain(body.scan.id);
        const matrix = await getHarnessMatrix(ctxFor(T1));
        const row = matrix.scans.rows.find((r) => r.scanRef === body.scan.id);
        expect(row?.sources).toContainEqual({ kind: 'code', status: 'INCOMPLETE', rows: 4, reason: 'UNPARSEABLE' });
        expect(row?.completeness).toBe('INCOMPLETE');

        // The incompleteness is a finding of its own, naming the reason. Read
        // through the application's client, which decrypts the description.
        const incomplete = await runInTenantContext(ctxFor(T1), (db) =>
            db.finding.findFirstOrThrow({
                where: { tenantId: T1, sourceRef: `INCOMPLETE_SOURCE:${seeded[T1].scannerAgentId}:code`, status: 'OPEN' },
                select: { description: true },
            }),
        );
        expect(incomplete.description).toContain('read source code incompletely (UNPARSEABLE)');

        // The vault, read in full, saw one credential bound to no agent — but
        // the code source, which can report the agent that binds it, stopped
        // early, so no orphan opens (section 3).
        expect(await findingStatus(T1, orphanRef(T1))).toBeNull();
    });
});

describe('1b. per-tool call counts and model endpoints (owner decision, 2026-10-19)', () => {
    it('a /2 report carrying both ingests: the counts round-trip in the stored tools, and the endpoints in the stored item (#3759)', async () => {
        const body = v2For(T1);
        const result = await ingest(T1, body);
        const item = await prisma.agentHarnessScanItem.findFirstOrThrow({
            where: { tenantId: T1, scanId: result.scanId, discoveredAgent: { discoveredId: 'entra:sp:registered-1' } },
        });
        expect(parseStoredHarnessTools(item.toolsJson)).toEqual([
            expect.objectContaining({ name: 'list_accounts', calls: 42, windowDays: 30 }),
        ]);
        // The endpoints round-trip byte for byte after canonicalisation, and
        // read back through the strict schema as reported.
        expect(canonicalJson(item.modelsJson)).toBe(canonicalJson(body.agents[0].models));
        expect(parseStoredHarnessModels(item.modelsJson)).toEqual({ state: 'REPORTED', endpoints: V2_MODEL_ENDPOINTS });
        // They are kept on the scan item and nowhere else.
        const elsewhere = JSON.stringify([
            await prisma.agentHarnessScan.findMany({ where: { tenantId: T1, id: result.scanId } }),
            await prisma.discoveredAgent.findMany({ where: { tenantId: T1 } }),
        ]);
        for (const m of V2_MODEL_ENDPOINTS) expect(elsewhere).not.toContain(m.endpoint);
    });

    it('a secret-shaped endpoint is refused, by path, and nothing is written', async () => {
        const before = await harnessRowCounts(T1);
        const secret = ['gh', 'p_', 'Q'.repeat(36)].join('');
        const body = v2For(T1, (b) => (b.agents[0].models = [{ endpoint: `https://api.example/${secret}`, model: 'gpt-4o-mini' }]));
        await expect(ingest(T1, body)).rejects.toThrow('harness_report_refused: SCHEMA: agents.0.models.0.endpoint');
        await expect(ingest(T1, body)).rejects.not.toThrow(secret);
        expect(await harnessRowCounts(T1)).toEqual(before);
    });

    it('a /1 report carrying a call count or a model endpoint is refused, and nothing is written', async () => {
        const before = await harnessRowCounts(T1);
        const withCalls = v1For(T1, (b) => {
            Object.assign(b.agents[0].tools[0], { calls: 1, windowDays: 1 });
        });
        await expect(ingest(T1, withCalls)).rejects.toThrow('harness_report_refused: SCHEMA: agents.0.tools.0: 2 unrecognized keys');
        const withModels = v1For(T1, (b) => {
            Object.assign(b.agents[0], { models: [{ endpoint: 'https://api.openai.com/v1', model: null }] });
        });
        await expect(ingest(T1, withModels)).rejects.toThrow('harness_report_refused: SCHEMA: agents.0: 1 unrecognized key');
        expect(await harnessRowCounts(T1)).toEqual(before);
    });
});

describe('1c. stored model endpoints: not reported, reported empty, reported, unreadable (#3759)', () => {
    /** The stored column as Postgres holds it: SQL NULL, or the JSON type of the value. */
    async function modelsColumn(itemId: string): Promise<{ isNull: boolean; type: string | null }> {
        const [row] = await prisma.$queryRawUnsafe<Array<{ isNull: boolean; type: string | null }>>(
            `SELECT "modelsJson" IS NULL AS "isNull", jsonb_typeof("modelsJson") AS "type" FROM "AgentHarnessScanItem" WHERE "id" = $1`,
            itemId,
        );
        return row;
    }

    async function itemOf(tenantId: string, scanId: string, discoveredId: string) {
        return prisma.agentHarnessScanItem.findFirstOrThrow({
            where: { tenantId, scanId, discoveredAgent: { discoveredId } },
            select: { id: true, discoveredAgentId: true, modelsJson: true },
        });
    }

    async function matrixModels(tenantId: string, discoveredAgentId: string) {
        const matrix = await getHarnessMatrix(ctxFor(tenantId));
        const row = matrix.sections.flatMap((s) => s.rows).find((r) => r.discoveredAgentId === discoveredAgentId);
        if (!row) throw new Error('expected the agent on the matrix');
        return row.models;
    }

    it('a /1 scan and a /2 agent without models store SQL NULL and read NOT REPORTED; [] stores [] and reads reported empty', async () => {
        const v1 = await ingest(T1, v1For(T1));
        const v1Item = await itemOf(T1, v1.scanId, 'entra:sp:registered-1');
        expect(await modelsColumn(v1Item.id)).toEqual({ isNull: true, type: null });
        expect(await matrixModels(T1, v1Item.discoveredAgentId)).toEqual({ state: 'NOT_REPORTED' });

        // The fake scanner's /2 body gives its shadow agent no `models`.
        const absent = await ingest(T1, v2For(T1));
        const shadow = await itemOf(T1, absent.scanId, 'entra:sp:shadow-1');
        expect(await modelsColumn(shadow.id)).toEqual({ isNull: true, type: null });
        expect(await matrixModels(T1, shadow.discoveredAgentId)).toEqual({ state: 'NOT_REPORTED' });

        const empty = await ingest(T1, v2For(T1, (b) => (b.agents[0].models = [])));
        const emptyItem = await itemOf(T1, empty.scanId, 'entra:sp:registered-1');
        expect(await modelsColumn(emptyItem.id)).toEqual({ isNull: false, type: 'array' });
        expect(emptyItem.modelsJson).toEqual([]);
        expect(await matrixModels(T1, emptyItem.discoveredAgentId)).toEqual({ state: 'REPORTED', endpoints: [] });
    });

    it('the matrix lists what the latest scan reported', async () => {
        const result = await ingest(T1, v2For(T1));
        const item = await itemOf(T1, result.scanId, 'entra:sp:registered-1');
        expect(await matrixModels(T1, item.discoveredAgentId)).toEqual({ state: 'REPORTED', endpoints: V2_MODEL_ENDPOINTS });
    });

    it('a stored value that no longer re-validates reads UNREADABLE on the matrix, never NOT REPORTED or none', async () => {
        const result = await ingest(T1, v2For(T1));
        const item = await itemOf(T1, result.scanId, 'entra:sp:registered-1');
        // A hand edit outside the ingest — the shape the contract refuses at the door.
        await prisma.agentHarnessScanItem.update({
            where: { id: item.id },
            data: { modelsJson: [{ endpoint: 'https://svc@api.example/v1', model: null }] },
        });
        expect(await matrixModels(T1, item.discoveredAgentId)).toEqual({ state: 'UNREADABLE' });
    });

    it('an endpoint carrying userinfo is refused before any write, and nothing is written', async () => {
        const before = await harnessRowCounts(T1);
        const body = v2For(T1, (b) => (b.agents[0].models = [{ endpoint: 'https://svc@api.example/v1', model: null }]));
        await expect(ingest(T1, body)).rejects.toThrow('harness_report_refused: SCHEMA: agents.0.models.0.endpoint');
        expect(await harnessRowCounts(T1)).toEqual(before);
    });

});

describe('2. a refused report writes nothing', () => {
    it('a /1 report carrying a /2 member is refused by the /1 schema', async () => {
        const before = await harnessRowCounts(T1);
        const body = { ...v1For(T1), unboundCredentials: [{ ref: 'kv://prod/agents/x', sourceKind: 'vault' }] };
        await expect(ingest(T1, body as unknown as HarnessReportBodyV1)).rejects.toThrow(
            'harness_report_refused: SCHEMA: (root): 1 unrecognized key',
        );
        expect(await harnessRowCounts(T1)).toEqual(before);
    });

    it('an unbound credential with a secret\'s shape is refused, named by path, never by value', async () => {
        const before = await harnessRowCounts(T1);
        const secret = ['gh', 'p_', 'Q'.repeat(36)].join('');
        const body = v2For(T1, (b) => (b.unboundCredentials = [{ ref: `kv://prod/${secret}`, sourceKind: 'vault' }]));
        const refusal = ingest(T1, body);
        await expect(refusal).rejects.toThrow('harness_report_refused: SCHEMA: unboundCredentials.0.ref');
        await expect(ingest(T1, body)).rejects.not.toThrow(secret);
        expect(await harnessRowCounts(T1)).toEqual(before);
    });
});

describe('3. ORPHAN_CREDENTIAL opens and closes on positive evidence only', () => {
    const raisedAudits = () =>
        prisma.auditLog.count({
            where: { tenantId: T1, action: 'CREATE', entity: 'Finding', details: { contains: 'raised ORPHAN_CREDENTIAL' } },
        });

    it('an incomplete identity source holds it back though the vault was read in full; with both read in full it opens', async () => {
        // The vault lists the credential and was read in full; code stopped early.
        await ingest(T1, v2For(T1));
        expect(await findingStatus(T1, orphanRef(T1))).toBeNull();
        expect(await raisedAudits()).toBe(0);

        await ingest(T1, v2For(T1, codeReadInFull));
        expect(await findingStatus(T1, orphanRef(T1))).toBe('OPEN');
        expect(await raisedAudits()).toBe(1);
    });

    it('a source that stopped early opens nothing, and closes nothing', async () => {
        const halfRead = 'kv://prod/agents/half-read';
        await ingest(T1, v2For(T1, codeReadInFull, (b) => {
            vault('INCOMPLETE')(b);
            b.unboundCredentials = [{ ref: halfRead, sourceKind: 'vault' }];
        }));
        expect(await findingStatus(T1, orphanRef(T1, halfRead))).toBeNull();
        expect(await findingStatus(T1, orphanRef(T1))).toBe('OPEN');
    });

    it('an absent source closes nothing', async () => {
        await ingest(T1, v2For(T1, codeReadInFull, (b) => {
            vault('ABSENT')(b);
            b.unboundCredentials = [];
        }));
        expect(await findingStatus(T1, orphanRef(T1))).toBe('OPEN');
    });

    it('a /1 report closes nothing, though it read the vault in full', async () => {
        await ingest(T1, v1For(T1));
        expect(await findingStatus(T1, orphanRef(T1))).toBe('OPEN');
    });

    it('an incomplete identity source neither closes a credential the vault still lists, nor reopens one', async () => {
        await ingest(T1, v2For(T1));
        expect(await findingStatus(T1, orphanRef(T1))).toBe('OPEN');
    });

    it('a complete read of the same source that no longer sees it unbound closes it; seeing it again reopens it', async () => {
        // Closing is unchanged by the tightening: the vault read in full no
        // longer lists the credential, and the code source stopping early
        // does not hold that back.
        await ingest(T1, v2For(T1, (b) => (b.unboundCredentials = [])));
        expect(await findingStatus(T1, orphanRef(T1))).toBe('CLOSED');
        const closed = await prisma.finding.findFirstOrThrow({
            where: { tenantId: T1, sourceRef: orphanRef(T1) },
            select: { verifiedAt: true },
        });
        expect(closed.verifiedAt).not.toBeNull();

        // Listed again while code stopped early: not reopened.
        await ingest(T1, v2For(T1));
        expect(await findingStatus(T1, orphanRef(T1))).toBe('CLOSED');
        // Listed again with every identity source read in full: reopened.
        await ingest(T1, v2For(T1, codeReadInFull));
        expect(await findingStatus(T1, orphanRef(T1))).toBe('OPEN');
    });
});

describe('4. two tenants', () => {
    it('one tenant\'s report opens nothing in the other, and closes nothing there', async () => {
        // T1 holds an open orphan; T2 has never ingested a report.
        expect(await findingStatus(T1, orphanRef(T1))).toBe('OPEN');
        expect(await prisma.finding.count({ where: { tenantId: T2 } })).toBe(0);

        // T2's own report opens T2's own finding, keyed by T2's scanner.
        await ingest(T2, v2For(T2, codeReadInFull));
        expect(await findingStatus(T2, orphanRef(T2))).toBe('OPEN');
        expect(orphanRef(T2)).not.toBe(orphanRef(T1));

        // T1's scan that closes T1's leaves T2's open.
        await ingest(T1, v2For(T1, (b) => (b.unboundCredentials = [])));
        expect(await findingStatus(T1, orphanRef(T1))).toBe('CLOSED');
        expect(await findingStatus(T2, orphanRef(T2))).toBe('OPEN');

        // Under app_user, each tenant reads only its own orphan findings.
        for (const [own, other] of [[T1, T2], [T2, T1]]) {
            const seen = await asTenant(own, (tx) =>
                tx.finding.findMany({ where: { sourceRef: { startsWith: 'ORPHAN_CREDENTIAL:' } }, select: { tenantId: true } }),
            );
            expect(seen.length).toBeGreaterThan(0);
            expect(seen.every((f) => f.tenantId === own)).toBe(true);
            expect(seen.some((f) => f.tenantId === other)).toBe(false);
        }
    });

    it('one tenant\'s model endpoints (#3759) never reach the other\'s matrix, and RLS hides its items', async () => {
        // Both tenants hold reports by now: T2's own ingested in the test above.
        expect(await prisma.agentHarnessScan.count({ where: { tenantId: T2 } })).toBeGreaterThan(0);
        const marker = 'https://t1-only-model.example/v1';
        await ingest(T1, v2For(T1, (b) => (b.agents[0].models = [{ endpoint: marker, model: 'm-t1' }])));

        expect(JSON.stringify(await getHarnessMatrix(ctxFor(T2)))).not.toContain(marker);
        expect(JSON.stringify(await getHarnessMatrix(ctxFor(T1)))).toContain(marker);

        const seenByT2 = await asTenant(T2, (tx) =>
            tx.agentHarnessScanItem.findMany({ where: { tenantId: T1 }, select: { id: true } }),
        );
        expect(seenByT2).toEqual([]);
        const seenByT1 = await asTenant(T1, (tx) =>
            tx.agentHarnessScanItem.findMany({ where: { tenantId: T1 }, select: { modelsJson: true } }),
        );
        expect(JSON.stringify(seenByT1)).toContain(marker);
    });
});
