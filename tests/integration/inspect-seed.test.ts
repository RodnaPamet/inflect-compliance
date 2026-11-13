/**
 * THE INSPECT SEED, RUN TWICE AGAINST A REAL DATABASE (inspect.md Phase 1.6).
 *
 * `scripts/inspect-seed.ts` makes the agent-evals nightly runnable: four seed
 * tenants, their eval agents, bound keys, approved profiles, the automation
 * rules that start the Tool Runner runs, fixtures, and a manifest `tasks.py`
 * reads. What is asserted is the contract it states:
 *
 *   - every row it promises exists, through the usecases (scored, active,
 *     granted, carded agents; approved four-eyes profiles allowing the
 *     AUTOMATION trigger alone; one ENABLED rule per profile, authored by the
 *     owner, firing on its samples' titles; bound keys for Flue agents only);
 *   - a second run duplicates nothing and writes the same manifest;
 *   - the raw keys are in the keys file, verify as keys bound to their agent,
 *     and appear nowhere in the manifest; a profile agent holds no live key;
 *   - the manifest has the shape `evals/inspect/fixtures/seed-manifest.example.json`
 *     pins for the Python side;
 *   - a task titled with a sample's input fires exactly that profile's rule,
 *     and the dispatch it enqueues admits a run of the profile as its agent,
 *     the AUTOMATION trigger the version allows (the harness's start path);
 *   - it refuses production and a database off loopback.
 */
// The queue is not the subject: the dispatch jobs are run here by hand, and a
// run is admitted, never executed.
jest.mock('@/app-layer/jobs/queue', () => ({
    ...jest.requireActual('@/app-layer/jobs/queue'),
    enqueue: jest.fn(async () => undefined),
}));

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { verifyApiKey } from '@/lib/auth/api-key-auth';
import { hashForLookup } from '@/lib/security/encryption';
import { parseProfileRunKey } from '@/lib/agentic/agent-profile';
import { enqueue } from '@/app-layer/jobs/queue';
import { runAutomationEventDispatch } from '@/app-layer/jobs/automation-event-dispatch';
import { runAgentInvokeDispatch, type AgentInvokeDispatchPayload } from '@/app-layer/jobs/agent-invoke-dispatch';
import {
    SEED_KEY_NAME,
    assertSeedTarget,
    loadCommittedTaskSet,
    seedInspectTenants,
    writeSeedOutputs,
    type InspectSeedResult,
} from '../../scripts/inspect-seed';
import {
    AUTOMATION_TRIGGER_EVENT,
    BULK_RISK_COUNT,
    FINDING_SOURCE_KIND,
    NEVER_GRANTED,
    SECRET_CONTROL_CODE,
    planSeed,
} from '../../scripts/inspect-seed/fixtures';

const prisma: PrismaClient = prismaTestClient();
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(600_000);

const SWITCHES = { AGENT_DRIVER_FLUE: '1', AGENT_DRIVER_TOOL_RUNNER: '1', AGENT_PROFILES: '1' } as const;
const ROOT = path.resolve(__dirname, '../..');
const EXAMPLE = JSON.parse(readFileSync(path.join(ROOT, 'evals/inspect/fixtures/seed-manifest.example.json'), 'utf8'));
const PLAN = planSeed(loadCommittedTaskSet());
const quiet = () => undefined;

async function userIdOf(email: string): Promise<string> {
    const user = await prisma.user.findUniqueOrThrow({ where: { emailHash: hashForLookup(email) }, select: { id: true } });
    return user.id;
}

/** Every row the seed writes, counted, so a second run can be shown to add none. */
async function footprint(tenantIds: string[]) {
    const where = { tenantId: { in: tenantIds } };
    const [agents, grants, cards, profiles, versions, findings, controls, risks, memberships, liveKeys, rules] = await Promise.all([
        prisma.registeredAgent.count({ where }),
        prisma.registeredAgentTool.count({ where }),
        prisma.agentPolicyCard.count({ where }),
        prisma.agentProfile.count({ where }),
        prisma.agentProfileVersion.count({ where }),
        prisma.finding.count({ where }),
        prisma.control.count({ where }),
        prisma.risk.count({ where }),
        prisma.tenantMembership.count({ where }),
        prisma.tenantApiKey.count({ where: { ...where, revokedAt: null } }),
        prisma.automationRule.count({ where: { ...where, deletedAt: null } }),
    ]);
    return { agents, grants, cards, profiles, versions, findings, controls, risks, memberships, liveKeys, rules };
}

describeFn('scripts/inspect-seed', () => {
    const saved: Record<string, string | undefined> = {};
    let dir: string;
    let first: InspectSeedResult;
    let second: InspectSeedResult;
    let tenantIds: Record<string, string>;
    let before: Awaited<ReturnType<typeof footprint>>;
    let after: Awaited<ReturnType<typeof footprint>>;

    beforeAll(async () => {
        for (const [k, v] of Object.entries(SWITCHES)) {
            saved[k] = process.env[k];
            process.env[k] = v;
        }
        dir = mkdtempSync(path.join(os.tmpdir(), 'inspect-seed-'));
        first = await seedInspectTenants(quiet);
        const rows = await prisma.tenant.findMany({
            where: { slug: { in: PLAN.tenants.map((t) => t.slug) } },
            select: { id: true, slug: true },
        });
        tenantIds = Object.fromEntries(rows.map((r) => [r.slug, r.id]));
        before = await footprint(Object.values(tenantIds));
        second = await seedInspectTenants(quiet);
        after = await footprint(Object.values(tenantIds));
        writeSeedOutputs(second, {
            manifestPath: path.join(dir, 'seed-manifest.json'),
            agentKeysPath: path.join(dir, 'agent-keys.json'),
        });
    });

    afterAll(async () => {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        if (dir) rmSync(dir, { recursive: true, force: true });
        await prisma.$disconnect();
    });

    it('creates the four tenants with their residency and engine', async () => {
        expect(Object.keys(tenantIds).sort()).toEqual(
            ['inspect-ext-flue', 'inspect-ext-tool-runner', 'inspect-local-flue', 'inspect-local-tool-runner'],
        );
        for (const t of PLAN.tenants) {
            const settings = await prisma.tenantSecuritySettings.findUnique({
                where: { tenantId: tenantIds[t.slug] },
                select: { aiResidency: true, agentDriver: true },
            });
            expect(settings).toEqual({ aiResidency: t.residency, agentDriver: t.engineSetting });
        }
    });

    it('gives each tenant an OWNER who signs in and a second ADMIN', async () => {
        for (const t of PLAN.tenants) {
            const members = await prisma.tenantMembership.findMany({
                where: { tenantId: tenantIds[t.slug], status: 'ACTIVE' },
                select: { role: true, userId: true, user: { select: { passwordHash: true } } },
            });
            const byUser = Object.fromEntries(members.map((m) => [m.userId, m]));
            const owner = byUser[await userIdOf(t.ownerEmail)];
            expect(owner?.role).toBe('OWNER');
            expect(owner?.user.passwordHash).toBeTruthy();
            expect(byUser[await userIdOf(t.approverEmail)]?.role).toBe('ADMIN');
            expect(members).toHaveLength(2);
            expect(first.tenants[t.slug].ownerEmail).toBe(t.ownerEmail);
        }
    });

    it('registers ACTIVE, scored, carded eval agents holding exactly their grants', async () => {
        for (const t of PLAN.tenants) {
            const tenantId = tenantIds[t.slug];
            const agents = await prisma.registeredAgent.findMany({
                where: { tenantId, deletedAt: null },
                select: { id: true, name: true, status: true, riskTier: true },
            });
            expect(agents.map((a) => a.name).sort()).toEqual(t.agents.map((a) => a.name).sort());
            for (const a of agents) {
                const def = t.agents.find((d) => d.name === a.name)!;
                expect(a.status).toBe('ACTIVE');
                expect(a.riskTier).not.toBeNull();
                expect(await prisma.agentPolicyCard.count({ where: { tenantId, agentId: a.id } })).toBe(1);
                const tools = await prisma.registeredAgentTool.findMany({ where: { tenantId, agentId: a.id }, select: { toolName: true } });
                const grants = tools.map((g) => g.toolName).sort();
                expect(grants).toEqual([...def.grants].sort());
                for (const never of NEVER_GRANTED) expect(grants).not.toContain(never);
            }
        }
    });

    it('approves every Tool Runner profile, authored by the owner and decided by the second person', async () => {
        for (const t of PLAN.tenants) {
            const m = second.tenants[t.slug];
            expect(Object.keys(m.profiles).sort()).toEqual(t.profiles.map((p) => p.fixture).sort());
            for (const p of t.profiles) {
                const key = parseProfileRunKey(m.profiles[p.fixture]);
                expect(key).not.toBeNull();
                const profile = await prisma.agentProfile.findUniqueOrThrow({
                    where: { id: key!.profileId },
                    select: { agentId: true, currentApprovedVersion: true, tenantId: true },
                });
                expect(profile.tenantId).toBe(tenantIds[t.slug]);
                expect(profile.agentId).toBe(m.profileAgents[p.fixture]);
                expect(profile.currentApprovedVersion).toBe(key!.version);
                const version = await prisma.agentProfileVersion.findFirstOrThrow({
                    where: { profileId: key!.profileId, version: key!.version },
                    select: { status: true, toolNames: true, authoredByUserId: true, decidedByUserId: true, allowedTriggers: true },
                });
                expect(version.status).toBe('APPROVED');
                // The trigger the harness starts it by, and no other (#5367).
                expect(version.allowedTriggers).toEqual(['AUTOMATION']);
                expect([...version.toolNames].sort()).toEqual([...p.toolNames].sort());
                expect(version.authoredByUserId).toBe(await userIdOf(t.ownerEmail));
                expect(version.decidedByUserId).toBe(await userIdOf(t.approverEmail));
            }
        }
    });

    it('gives every profile one ENABLED INVOKE_AGENT rule, authored by the owner, firing on its samples\' titles', async () => {
        for (const t of PLAN.tenants) {
            const m = second.tenants[t.slug];
            expect(Object.keys(m.automationRules).sort()).toEqual(t.profiles.map((p) => p.fixture).sort());
            const rules = await prisma.automationRule.findMany({
                where: { tenantId: tenantIds[t.slug], deletedAt: null },
                select: { id: true, triggerEvent: true, triggerFilterJson: true, actionType: true, actionConfigJson: true, status: true, createdByUserId: true },
            });
            expect(rules.map((r) => r.id).sort()).toEqual(Object.values(m.automationRules).sort());
            for (const p of t.profiles) {
                const rule = rules.find((r) => r.id === m.automationRules[p.fixture])!;
                expect(rule.triggerEvent).toBe(AUTOMATION_TRIGGER_EVENT);
                expect(rule.actionType).toBe('INVOKE_AGENT');
                expect(rule.status).toBe('ENABLED');
                expect(rule.createdByUserId).toBe(await userIdOf(t.ownerEmail));
                expect(rule.actionConfigJson).toEqual({
                    agentId: m.profileAgents[p.fixture],
                    workflowKey: m.profiles[p.fixture],
                    inputMapping: { question: 'title' },
                });
                expect(rule.triggerFilterJson).toEqual({
                    logic: 'AND',
                    conditions: [{ field: 'title', operator: 'in', value: [...p.triggerTitles] }],
                });
                expect(p.triggerTitles.length).toBeGreaterThan(0);
            }
        }
    });

    it('seeds the fixtures the tenant\'s tasks name, and none elsewhere', async () => {
        for (const t of PLAN.tenants) {
            const tenantId = tenantIds[t.slug];
            const findings = await prisma.finding.findMany({
                where: { tenantId, sourceKind: FINDING_SOURCE_KIND },
                select: { sourceRef: true },
            });
            expect(findings.map((f) => f.sourceRef).sort()).toEqual(t.fixtures.filter((f) => f.startsWith('finding-')).sort());
            const secret = await prisma.control.count({ where: { tenantId, code: SECRET_CONTROL_CODE } });
            expect(secret).toBe(t.fixtures.includes('control-secret') ? 1 : 0);
            const risks = await prisma.risk.count({ where: { tenantId } });
            expect(risks).toBe(t.fixtures.includes('risks-bulk') ? BULK_RISK_COUNT : 0);
        }
    });

    it('a second run duplicates nothing and writes the same manifest', () => {
        expect(after).toEqual(before);
        expect(second.seedFixtureHash).toBe(first.seedFixtureHash);
        expect(second.tenants).toEqual(first.tenants);
    });

    it('binds one live seed key to each Flue agent, with mcp:orchestrate and the grants\' scopes, in the keys file only', async () => {
        const keys = JSON.parse(readFileSync(path.join(dir, 'agent-keys.json'), 'utf8')) as Record<string, Record<string, string>>;
        expect(statSync(path.join(dir, 'agent-keys.json')).mode & 0o777).toBe(0o600);
        const manifestText = readFileSync(path.join(dir, 'seed-manifest.json'), 'utf8');
        // No key, and nothing key-shaped, anywhere in the manifest.
        const inManifest = (needle: string) => manifestText.includes(needle);
        expect(inManifest('iflk_')).toBe(false);

        for (const t of PLAN.tenants) {
            const m = second.tenants[t.slug];
            if (t.engine !== 'flue') {
                // A profile agent's runs start from its rule: no key, in the
                // file or live in the tenant.
                expect(keys[t.slug]).toEqual({});
                expect(await prisma.tenantApiKey.count({ where: { tenantId: tenantIds[t.slug], revokedAt: null } })).toBe(0);
                continue;
            }
            const agentIds = [m.agentId!];
            expect(Object.keys(keys[t.slug]).sort()).toEqual([...agentIds].sort());
            for (const agentId of agentIds) {
                const raw = keys[t.slug][agentId];
                expect(inManifest(raw)).toBe(false);
                const verified = await verifyApiKey(raw);
                expect(verified.valid).toBe(true);
                if (!verified.valid) continue;
                expect(verified.ctx.agentId).toBe(agentId);
                expect(verified.ctx.tenantId).toBe(tenantIds[t.slug]);

                const live = await prisma.tenantApiKey.findMany({
                    where: { tenantId: tenantIds[t.slug], agentId, revokedAt: null },
                    select: { name: true, scopes: true },
                });
                expect(live).toHaveLength(1);
                expect(live[0].name).toBe(SEED_KEY_NAME);
                const def = t.agents.find((d) => d.profileFixture === null)!;
                expect([...(live[0].scopes as string[])].sort()).toEqual([...def.keyScopes].sort());
                expect(def.keyScopes).toContain('mcp:orchestrate');
            }
        }
        // The first run's keys were revoked, not left beside the second's.
        const revoked = await prisma.tenantApiKey.count({
            where: { tenantId: { in: Object.values(tenantIds) }, name: SEED_KEY_NAME, revokedAt: { not: null } },
        });
        expect(revoked).toBeGreaterThanOrEqual(
            PLAN.tenants.reduce((n, t) => n + t.agents.filter((a) => a.startedBy === 'agent-key').length, 0),
        );
    });

    it('writes the manifest in the shape the Python side reads', () => {
        const manifest = JSON.parse(readFileSync(path.join(dir, 'seed-manifest.json'), 'utf8'));
        expect(Object.keys(manifest).sort()).toEqual(Object.keys(EXAMPLE).sort());
        expect(manifest.seedFixtureHash).toMatch(/^sha256:[0-9a-f]{64}$/);
        for (const t of PLAN.tenants) {
            const real = manifest[t.slug];
            const example = EXAMPLE[t.slug];
            expect(Object.keys(real).sort()).toEqual(Object.keys(example).sort());
            expect(Object.keys(real.profiles).sort()).toEqual(Object.keys(example.profiles).sort());
            expect(Object.keys(real.profileAgents).sort()).toEqual(Object.keys(example.profileAgents).sort());
            expect(Object.keys(real.automationRules).sort()).toEqual(Object.keys(example.automationRules).sort());
            expect(Object.keys(real.markers).sort()).toEqual(Object.keys(example.markers).sort());
            expect(real.agentId === null).toBe(example.agentId === null);
            expect(real.ownerEmail).toBe(example.ownerEmail);
        }
    });

    it("a task titled with a sample's input fires exactly its profile's rule, and the run starts as AUTOMATION", async () => {
        const t = PLAN.tenants.find((x) => x.slug === 'inspect-ext-tool-runner')!;
        const m = second.tenants[t.slug];
        const tenantId = tenantIds[t.slug];
        const queued = enqueue as unknown as jest.Mock;
        for (const p of t.profiles) {
            queued.mockClear();
            const title = p.triggerTitles[0];
            await runAutomationEventDispatch({
                tenantId,
                event: {
                    event: AUTOMATION_TRIGGER_EVENT,
                    tenantId,
                    entityType: 'Task',
                    entityId: `task-${p.fixture}`,
                    actorUserId: await userIdOf(t.ownerEmail),
                    emittedAt: new Date().toISOString(),
                    stableKey: `task-${p.fixture}`,
                    data: { key: `TSK-${p.fixture}`, title, type: 'TASK', severity: 'MEDIUM', priority: 'P2', assigneeUserId: null, controlId: null },
                },
            });
            const invokes = queued.mock.calls.filter(([name]) => name === 'agent-invoke-dispatch');
            expect(invokes).toHaveLength(1); // one task, one rule
            const payload = invokes[0][1] as AgentInvokeDispatchPayload;
            expect(payload).toMatchObject({ agentId: m.profileAgents[p.fixture], workflowKey: m.profiles[p.fixture] });

            const started = await runAgentInvokeDispatch(payload);
            expect(started.refusal).toBeNull();
            const run = await prisma.workflowRun.findUniqueOrThrow({
                where: { id: started.runId! },
                select: { tenantId: true, agentId: true, workflowKey: true },
            });
            expect(run).toEqual({ tenantId, agentId: m.profileAgents[p.fixture], workflowKey: m.profiles[p.fixture] });
        }
        // A title no sample carries fires nothing.
        queued.mockClear();
        await runAutomationEventDispatch({
            tenantId,
            event: {
                event: AUTOMATION_TRIGGER_EVENT, tenantId, entityType: 'Task', entityId: 'task-other', actorUserId: null,
                emittedAt: new Date().toISOString(), stableKey: 'task-other',
                data: { key: 'TSK-other', title: 'An unrelated task', type: 'TASK', severity: 'MEDIUM', priority: 'P2', assigneeUserId: null, controlId: null },
            },
        });
        expect(queued.mock.calls.filter(([name]) => name === 'agent-invoke-dispatch')).toHaveLength(0);
    });

    it('refuses production and a database off loopback', () => {
        const local = 'postgresql://ci:ci@localhost:5432/ci_testdb';
        expect(() => assertSeedTarget({ NODE_ENV: 'test', DATABASE_URL: local } as NodeJS.ProcessEnv)).not.toThrow();
        expect(() => assertSeedTarget({ NODE_ENV: 'production', DATABASE_URL: local } as NodeJS.ProcessEnv)).toThrow(/production/);
        expect(() =>
            assertSeedTarget({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://u:p@db.internal:5432/x' } as NodeJS.ProcessEnv),
        ).toThrow(/loopback/);
        expect(() =>
            assertSeedTarget({ NODE_ENV: 'test', DATABASE_URL: local, DIRECT_DATABASE_URL: 'postgresql://u:p@10.0.0.5/x' } as NodeJS.ProcessEnv),
        ).toThrow(/DIRECT_DATABASE_URL/);
        expect(() => assertSeedTarget({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);
    });
});
