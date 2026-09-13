/**
 * Coverage for the governance graph builder (VR-10).
 *
 *  - Pure assembler (`buildGovernanceGraph`, `healthFor`): empty graph,
 *    single node, multi-node with edges, self-loop + unknown-map drop,
 *    edge dedupe, and every health/size bucket. Always runs.
 *  - `getGovernanceGraph` usecase: real DB — process maps + action/group
 *    nodes + rules + 30-day executions → assembled meta-graph, plus the
 *    READER permission path. DB-gated.
 */
import { PrismaClient, Role, MembershipStatus, AutomationActionType } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import {
    buildGovernanceGraph,
    healthFor,
    getGovernanceGraph,
    type MapStat,
    type GraphLink,
} from '@/app-layer/services/governance-graph-builder';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

// ─── Pure assembler (no DB) ──────────────────────────────────────────

describe('healthFor', () => {
    it('maps success rate to ring buckets', () => {
        expect(healthFor(null)).toBe('unknown');
        expect(healthFor(0.95)).toBe('green');
        expect(healthFor(0.9)).toBe('green');
        expect(healthFor(0.8)).toBe('amber');
        expect(healthFor(0.7)).toBe('amber');
        expect(healthFor(0.5)).toBe('red');
    });
});

describe('buildGovernanceGraph', () => {
    it('returns an empty graph for no maps', () => {
        const { nodes, edges } = buildGovernanceGraph([], []);
        expect(nodes).toEqual([]);
        expect(edges).toEqual([]);
    });

    it('builds a single node sized + health-coloured by its stats', () => {
        const maps: MapStat[] = [
            { id: 'm1', name: 'One', canvasMode: 'AUTOMATION', ruleCount: 12, successRate: 0.95 },
        ];
        const { nodes, edges } = buildGovernanceGraph(maps, []);
        expect(nodes).toHaveLength(1);
        expect(nodes[0].size).toBe(3); // >= 10 rules
        expect(nodes[0].health).toBe('green');
        expect(edges).toEqual([]);
    });

    it('covers all size buckets', () => {
        const maps: MapStat[] = [
            { id: 'a', name: 'A', canvasMode: 'AUTOMATION', ruleCount: 1, successRate: null },
            { id: 'b', name: 'B', canvasMode: 'AUTOMATION', ruleCount: 5, successRate: 0.6 },
            { id: 'c', name: 'C', canvasMode: 'AUTOMATION', ruleCount: 10, successRate: 0.75 },
        ];
        const { nodes } = buildGovernanceGraph(maps, []);
        expect(nodes.map((n) => n.size)).toEqual([1, 2, 3]);
        expect(nodes.map((n) => n.health)).toEqual(['unknown', 'red', 'amber']);
    });

    it('builds edges, dropping self-loops, unknown maps, and duplicates', () => {
        const maps: MapStat[] = [
            { id: 'm1', name: 'One', canvasMode: 'AUTOMATION', ruleCount: 2, successRate: 1 },
            { id: 'm2', name: 'Two', canvasMode: 'AUTOMATION', ruleCount: 4, successRate: 0.8 },
        ];
        const links: GraphLink[] = [
            { sourceMapId: 'm1', targetMapId: 'm2', kind: 'subflow-call' },
            { sourceMapId: 'm1', targetMapId: 'm2', kind: 'subflow-call' }, // dup
            { sourceMapId: 'm1', targetMapId: 'm1', kind: 'shared-rule' }, // self-loop
            { sourceMapId: 'm1', targetMapId: 'ghost', kind: 'shared-rule' }, // unknown target
            { sourceMapId: 'ghost', targetMapId: 'm2', kind: 'shared-rule' }, // unknown source
        ];
        const { edges } = buildGovernanceGraph(maps, links);
        expect(edges).toHaveLength(1);
        expect(edges[0]).toMatchObject({ source: 'm1', target: 'm2', kind: 'subflow-call' });
    });
});

// ─── Usecase (DB) ────────────────────────────────────────────────────

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE_TAG = `gov-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${SUITE_TAG}`;

let ownerUserId: string;
let readerUserId: string;
let ctx: ReturnType<typeof makeRequestContext>;
let reader: ReturnType<typeof makeRequestContext>;

async function makeUser(label: string, role: Role): Promise<string> {
    const email = `${SUITE_TAG}-${label}@example.test`;
    const u = await globalPrisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await globalPrisma.tenantMembership.create({
        data: { tenantId: TENANT_ID, userId: u.id, role, status: MembershipStatus.ACTIVE },
    });
    return u.id;
}

describeFn('getGovernanceGraph — usecase (integration)', () => {
    let mapAId: string;
    let mapBId: string;

    beforeAll(async () => {
        await globalPrisma.tenant.upsert({
            where: { id: TENANT_ID },
            update: {},
            create: { id: TENANT_ID, name: `t ${SUITE_TAG}`, slug: SUITE_TAG },
        });
        ownerUserId = await makeUser('owner', Role.OWNER);
        readerUserId = await makeUser('reader', Role.READER);
        ctx = makeRequestContext('OWNER', { tenantId: TENANT_ID, tenantSlug: SUITE_TAG, userId: ownerUserId });
        reader = makeRequestContext('READER', { tenantId: TENANT_ID, tenantSlug: SUITE_TAG, userId: readerUserId });

        const mapA = await globalPrisma.processMap.create({
            data: { tenantId: TENANT_ID, name: 'Map A', canvasMode: 'AUTOMATION', createdByUserId: ownerUserId },
        });
        const mapB = await globalPrisma.processMap.create({
            data: { tenantId: TENANT_ID, name: 'Map B', canvasMode: 'AUTOMATION', createdByUserId: ownerUserId },
        });
        mapAId = mapA.id;
        mapBId = mapB.id;

        // A rule owned by Map A (referenced by an action node), pointing at
        // a sub-flow group that lives in Map B → subflow-call link A→B.
        const ruleA = await globalPrisma.automationRule.create({
            data: {
                tenantId: TENANT_ID,
                name: 'rule A',
                triggerEvent: 'evidence.expiring',
                actionType: AutomationActionType.NOTIFY_USER,
                actionConfigJson: {},
                subFlowGroupId: 'grp-b',
            },
        });
        // An unreferenced rule — its execution hits the "no owning map" continue.
        const ruleOrphan = await globalPrisma.automationRule.create({
            data: {
                tenantId: TENANT_ID,
                name: 'orphan',
                triggerEvent: 'evidence.expiring',
                actionType: AutomationActionType.NOTIFY_USER,
                actionConfigJson: {},
            },
        });

        await globalPrisma.processNode.createMany({
            data: [
                {
                    tenantId: TENANT_ID,
                    processMapId: mapAId,
                    nodeKey: 'act-1',
                    nodeType: 'action',
                    label: 'Action',
                    posX: 0,
                    posY: 0,
                    dataJson: { ruleId: ruleA.id },
                },
                {
                    tenantId: TENANT_ID,
                    processMapId: mapBId,
                    nodeKey: 'grp-b',
                    nodeType: 'group',
                    label: 'Group',
                    posX: 10,
                    posY: 10,
                },
            ],
        });

        await globalPrisma.automationExecution.createMany({
            data: [
                { tenantId: TENANT_ID, ruleId: ruleA.id, triggerEvent: 'evidence.expiring', triggerPayloadJson: {}, status: 'SUCCEEDED' },
                { tenantId: TENANT_ID, ruleId: ruleA.id, triggerEvent: 'evidence.expiring', triggerPayloadJson: {}, status: 'SUCCEEDED' },
                { tenantId: TENANT_ID, ruleId: ruleA.id, triggerEvent: 'evidence.expiring', triggerPayloadJson: {}, status: 'SKIPPED' },
                { tenantId: TENANT_ID, ruleId: ruleOrphan.id, triggerEvent: 'evidence.expiring', triggerPayloadJson: {}, status: 'SUCCEEDED' },
            ],
        });
    });

    afterAll(async () => {
        await globalPrisma.automationExecution.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.processNode.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.automationRule.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.processMap.deleteMany({ where: { tenantId: TENANT_ID } });
        await deleteAuditRowsForTenants(globalPrisma, TENANT_ID);
        await globalPrisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT_ID);
        });
        await globalPrisma.user.deleteMany({ where: { id: { in: [ownerUserId, readerUserId] } } });
        await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } });
        await globalPrisma.$disconnect();
    });

    it('assembles the meta-graph with nodes, health, and the subflow-call edge', async () => {
        const graph = await getGovernanceGraph(ctx, new Date());
        expect(graph.generatedAt).toBeTruthy();
        const nodeIds = graph.nodes.map((n) => n.id).sort();
        expect(nodeIds).toEqual([mapAId, mapBId].sort());

        const a = graph.nodes.find((n) => n.id === mapAId)!;
        expect(a.ruleCount).toBe(1);
        expect(a.successRate).toBe(1); // 2 succeeded / 2 terminal (SKIPPED not terminal)
        expect(a.health).toBe('green');

        const b = graph.nodes.find((n) => n.id === mapBId)!;
        expect(b.ruleCount).toBe(0);
        expect(b.successRate).toBeNull();
        expect(b.health).toBe('unknown');

        expect(graph.edges).toHaveLength(1);
        expect(graph.edges[0]).toMatchObject({ source: mapAId, target: mapBId, kind: 'subflow-call' });
    });

    it('still reads for a READER (assertCanRead passes)', async () => {
        const graph = await getGovernanceGraph(reader, new Date());
        expect(graph.nodes.length).toBe(2);
    });
});
