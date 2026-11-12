/**
 * Seed the four Inspect tenants the agent-evals nightly runs against
 * (`docs/ai-architecture/inspect.md`, Phase 1.6).
 *
 *   npx tsx scripts/inspect-seed.ts --manifest <manifest.json> --agent-keys <keys.json>
 *
 * WHAT IT WRITES, all through the product's own usecases (the definitions are
 * in `scripts/inspect-seed/fixtures.ts`, derived from `evals/inspect/task-set.json`):
 *
 *   - per tenant: an OWNER who signs in with the DAST seed's password, and a
 *     second ADMIN, invited and redeemed, who approves what the owner authors;
 *   - the residency (`updateTenantSecurityConfig`) and the engine
 *     (`setAgentDriverSetting`), then a check that the deployment would really
 *     run the tenant on that engine (`getAgentDriverSetting().effective`);
 *   - the fixtures the tenant's tasks name (`createFinding`, `createControl`,
 *     `createRisk`);
 *   - its eval agents: registered, risk-assessed by the real scorer, activated,
 *     granted, carded; one on a Flue tenant, one PER PROFILE on a Tool Runner
 *     tenant, because a profile runs as its own agent, an agent holds one
 *     profile and only its version in force runs;
 *   - on a Tool Runner tenant, each profile version authored by the owner,
 *     submitted, and approved by the second person;
 *   - per agent, an API key BOUND to it (`createApiKey`), carrying
 *     `mcp:orchestrate` and the scopes its grants need.
 *
 * WHAT IT PRINTS: progress lines only. The manifest (ids, run keys, synthetic
 * markers, the owner's e-mail, `seedFixtureHash`) goes to `--manifest`; the raw
 * keys go to `--agent-keys` ONLY, as `{ slug: { agentId: key } }`, mode 0600.
 * Neither is ever written to stdout: pino logs from the usecases share it.
 *
 * IDEMPOTENT. Every step reads before it writes and skips what is already
 * there. The one exception is the key: a key's plaintext cannot be read back,
 * so a re-run revokes the seed's earlier key for the agent (`revokeApiKey`) and
 * mints one fresh, leaving exactly one live seed key per agent. A definition
 * that disagrees with what an earlier run stored (an agent's data scope, a
 * fixture's title, a card that does not permit a grant) is refused, not
 * overwritten.
 *
 * REFUSES to run with NODE_ENV=production or against a database that is not on
 * loopback (`assertSeedTarget`), and fails closed: any step that cannot
 * complete exits non-zero naming the tenant and the step.
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import prisma from '@/lib/prisma';
import type { RequestContext } from '@/app-layer/types';
import { hashPassword } from '@/lib/auth/passwords';
import { hashForLookup } from '@/lib/security/encryption';
import { runInTenantContext } from '@/lib/db-context';
import { resolveMemberContextWithReason } from '@/app-layer/context-system';
import { createTenantWithOwner } from '@/app-layer/usecases/tenant-lifecycle';
import { createInviteToken, redeemInvite } from '@/app-layer/usecases/tenant-invites';
import { getTenantSecurityConfig, updateTenantSecurityConfig } from '@/app-layer/usecases/tenant-security-settings';
import { getAgentDriverSetting, setAgentDriverSetting } from '@/app-layer/usecases/agent-driver-setting';
import { activateRegisteredAgent, registerAgent } from '@/app-layer/usecases/agent-registry';
import {
    completeAgentRiskAssessment,
    getAgentRiskAssessmentState,
    saveAgentAssessmentAnswer,
} from '@/app-layer/usecases/agent-risk-assessment';
import { grantAgentTool } from '@/app-layer/usecases/agent-tool-exposure';
import { createAgentPolicyCard, getAgentPolicyCard } from '@/app-layer/usecases/agent-policy-card';
import {
    agentProfilesOn,
    approveAgentProfileVersion,
    createAgentProfile,
    createAgentProfileVersion,
    profileInstructionsHash,
    submitAgentProfileVersion,
} from '@/app-layer/usecases/agent-profiles';
import { AgentProfileVersionSchema } from '@/app-layer/schemas/agent-profile.schemas';
import { profileRunKey } from '@/lib/agentic/agent-profile';
import { createApiKey, revokeApiKey } from '@/app-layer/usecases/api-keys';
import { createFinding } from '@/app-layer/usecases/finding';
import { createControl } from '@/app-layer/usecases/control/mutations';
import { createRisk } from '@/app-layer/usecases/risk';
import { ceilingForRiskTier } from '@/lib/agentic/autonomy-ceiling';
import { InspectTaskSetSchema, inspectTaskSetHash } from '@/lib/ai/evals/inspect-record';
import { seedAgentRiskAssessmentLibrary } from '../prisma/agent-risk-assessment-library';
import {
    ASSESSMENT_ANSWER,
    BULK_RISK_TITLE_PREFIX,
    FINDING_SOURCE_KIND,
    FIXTURES,
    NEVER_GRANTED,
    SEED_LOGIN_PASSWORD,
    planSeed,
    seedFixtureHash,
    type AgentDefinition,
    type ProfileDefinition,
    type SeedFixtureId,
    type SeedTenantPlan,
} from './inspect-seed/fixtures';

const ROOT = path.resolve(__dirname, '..');
/** The name every seed key carries: a re-run revokes keys of this name, and no other. */
export const SEED_KEY_NAME = 'Inspect seed (agent-evals nightly)';
const PROFILE_TRIGGERS = ['ASK'] as const;

// ─── The target guard ───────────────────────────────────────────────

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Refuse production and any database off loopback. The seed sets a
 * well-known password and hostile fixture text: it belongs on the CI service
 * container (`localhost:5432`) or a developer's local test database, nowhere
 * else. Every database URL the process holds is checked, because the usecases
 * write through `DATABASE_URL` and the migration ran through the direct one.
 */
export function assertSeedTarget(env: NodeJS.ProcessEnv): void {
    if (env.NODE_ENV === 'production') {
        throw new Error('inspect-seed refuses to run with NODE_ENV=production.');
    }
    const urls = (['DATABASE_URL', 'DIRECT_DATABASE_URL'] as const)
        .map((k) => [k, env[k]] as const)
        .filter((entry): entry is readonly [typeof entry[0], string] => typeof entry[1] === 'string' && entry[1] !== '');
    if (!urls.some(([k]) => k === 'DATABASE_URL')) {
        throw new Error('inspect-seed needs DATABASE_URL (the CI or local test database).');
    }
    for (const [key, url] of urls) {
        let host: string;
        try {
            host = new URL(url).hostname;
        } catch {
            throw new Error(`inspect-seed: ${key} is not a URL it can read.`);
        }
        if (!LOOPBACK.has(host)) {
            throw new Error(
                `inspect-seed refuses ${key} on host "${host}": it seeds a CI or local test database on loopback only.`,
            );
        }
    }
}

// ─── Small helpers ──────────────────────────────────────────────────

type Log = (line: string) => void;

async function step<T>(where: string, label: string, fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`${where}: ${label} failed: ${message}`);
    }
}

/** A seed person's own membership context, as a job acting for them (no human clicked). */
async function memberContext(tenantId: string, userId: string, who: string): Promise<RequestContext> {
    const resolved = await resolveMemberContextWithReason({ tenantId, userId, job: 'inspect-seed', discriminator: randomUUID() });
    if (!resolved.ok) {
        throw new Error(`the ${who} is not an ACTIVE member (${resolved.reason})`);
    }
    return { ...resolved.ctx, actorType: 'JOB' };
}

async function ensureLoginUser(email: string, name: string): Promise<string> {
    const emailHash = hashForLookup(email);
    const passwordHash = await hashPassword(SEED_LOGIN_PASSWORD);
    // The seed person signs in with credentials, as the DAST seed's users do
    // (`prisma/seed.ts`); the hash is re-set so an earlier partial run cannot
    // leave a person the workflow's login step cannot sign in as.
    const user = await prisma.user.upsert({
        where: { emailHash },
        update: { passwordHash },
        create: { email, emailHash, passwordHash, name },
        select: { id: true },
    });
    return user.id;
}

// ─── Tenant, people, settings ───────────────────────────────────────

interface TenantPeople {
    tenantId: string;
    owner: RequestContext;
    approver: RequestContext;
}

async function ensureTenantAndPeople(plan: SeedTenantPlan, log: Log): Promise<TenantPeople> {
    const where = plan.slug;
    const ownerId = await step(where, 'owner user', () => ensureLoginUser(plan.ownerEmail, `Inspect owner (${plan.slug})`));
    const approverId = await step(where, 'approver user', () =>
        ensureLoginUser(plan.approverEmail, `Inspect approver (${plan.slug})`),
    );

    let tenant = await prisma.tenant.findUnique({ where: { slug: plan.slug }, select: { id: true } });
    if (!tenant) {
        const created = await step(where, 'createTenantWithOwner', () =>
            createTenantWithOwner({ name: plan.name, slug: plan.slug, ownerEmail: plan.ownerEmail, requestId: `inspect-seed-${randomUUID()}` }),
        );
        tenant = { id: created.tenant.id };
        log(`${where}: tenant created`);
    }
    const tenantId = tenant.id;

    const owner = await step(where, 'owner context', () => memberContext(tenantId, ownerId, 'owner'));
    if (owner.role !== 'OWNER') throw new Error(`${where}: ${plan.ownerEmail} is a ${owner.role} here, not the OWNER`);

    const membership = await prisma.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId, userId: approverId } },
        select: { status: true },
    });
    if (membership?.status !== 'ACTIVE') {
        // The real membership writer: an invite the owner issues, redeemed by
        // the person it names.
        const invite = await step(where, 'invite the approver', () =>
            createInviteToken(owner, { email: plan.approverEmail, role: 'ADMIN' }),
        );
        await step(where, 'redeem the approver invite', () =>
            redeemInvite({ token: invite.invite.token, userId: approverId, userEmail: plan.approverEmail }),
        );
        log(`${where}: approver joined as ADMIN`);
    }
    const approver = await step(where, 'approver context', () => memberContext(tenantId, approverId, 'approver'));
    if (approver.appPermissions.admin.agent_registry !== true) {
        throw new Error(`${where}: the approver cannot decide profile versions (no admin.agent_registry)`);
    }
    return { tenantId, owner, approver };
}

async function ensureSettings(plan: SeedTenantPlan, owner: RequestContext, log: Log): Promise<void> {
    const where = plan.slug;
    const config = await step(where, 'read security settings', () => getTenantSecurityConfig(owner));
    if (config.aiResidency !== plan.residency) {
        await step(where, 'set residency', () => updateTenantSecurityConfig(owner, { aiResidency: plan.residency }));
        log(`${where}: residency ${config.aiResidency} -> ${plan.residency}`);
    }
    let driver = await step(where, 'read engine setting', () => getAgentDriverSetting(owner));
    if (driver.mode !== plan.engineSetting) {
        driver = await step(where, 'choose engine', () => setAgentDriverSetting(owner, plan.engineSetting));
        log(`${where}: engine -> ${plan.engineSetting}`);
    }
    // The deployment's half of the gate. Seeding a tenant its runs would never
    // reach is how a nightly scores every task VACUOUS and says nothing.
    if (driver.effective.driver !== plan.engine) {
        throw new Error(
            `${where}: this deployment would run the tenant on ${driver.effective.driver}, not ${plan.engine} ` +
                `(${driver.effective.reason ?? 'no reason given'}). Turn on AGENT_DRIVER_FLUE and AGENT_DRIVER_TOOL_RUNNER.`,
        );
    }
    if (plan.profiles.length > 0 && !(await agentProfilesOn(plan.slug))) {
        throw new Error(`${where}: agent profiles are off for this workspace. Set AGENT_PROFILES=1.`);
    }
}

// ─── Fixtures ───────────────────────────────────────────────────────

async function ensureFixtures(plan: SeedTenantPlan, owner: RequestContext, log: Log): Promise<void> {
    const where = plan.slug;
    for (const id of plan.fixtures) {
        const def = FIXTURES[id];
        if (def.kind === 'finding') {
            const existing = await runInTenantContext(owner, (db) =>
                db.finding.findFirst({
                    where: { tenantId: owner.tenantId, sourceKind: FINDING_SOURCE_KIND, sourceRef: id, deletedAt: null },
                    select: { title: true, owner: true },
                }),
            );
            if (existing) {
                if (existing.title !== def.title || existing.owner !== def.owner) {
                    throw new Error(`${where}: finding fixture ${id} exists with different text; reseed a fresh database`);
                }
                continue;
            }
            await step(where, `fixture ${id}`, () =>
                createFinding(owner, {
                    severity: def.severity,
                    type: def.type,
                    title: def.title,
                    owner: def.owner,
                    sourceKind: FINDING_SOURCE_KIND,
                    sourceRef: id,
                }),
            );
            log(`${where}: fixture ${id}`);
        } else if (def.kind === 'control') {
            const existing = await runInTenantContext(owner, (db) =>
                db.control.findFirst({
                    where: { tenantId: owner.tenantId, code: def.code, deletedAt: null },
                    select: { name: true },
                }),
            );
            if (existing) {
                if (existing.name !== def.name) {
                    throw new Error(`${where}: control fixture ${def.code} exists with a different name; reseed a fresh database`);
                }
                continue;
            }
            await step(where, `fixture ${id}`, () =>
                createControl(owner, { code: def.code, name: def.name, status: def.status, isCustom: true }),
            );
            log(`${where}: fixture ${id}`);
        } else {
            const present = new Set(
                (
                    await runInTenantContext(owner, (db) =>
                        db.risk.findMany({
                            where: { tenantId: owner.tenantId, title: { startsWith: BULK_RISK_TITLE_PREFIX }, deletedAt: null },
                            select: { title: true },
                            take: def.risks.length + 1,
                        }),
                    )
                ).map((r) => r.title),
            );
            const missing = def.risks.filter((r) => !present.has(r.title));
            for (const r of missing) {
                await step(where, `fixture ${id} (${r.title})`, () => createRisk(owner, { ...r }));
            }
            if (missing.length > 0) log(`${where}: fixture ${id} (${missing.length} risks)`);
        }
    }
}

// ─── Agents ─────────────────────────────────────────────────────────

async function ensureAgent(plan: SeedTenantPlan, owner: RequestContext, def: AgentDefinition, log: Log): Promise<string> {
    const where = `${plan.slug} / ${def.name}`;
    const read = () =>
        runInTenantContext(owner, (db) =>
            db.registeredAgent.findFirst({
                where: { tenantId: owner.tenantId, name: def.name, deletedAt: null, status: { not: 'RETIRED' } },
                select: { id: true, status: true, riskTier: true, autonomyLevel: true, dataAccessScope: true },
            }),
        );
    let agent = await read();
    if (!agent) {
        await step(where, 'registerAgent', () =>
            registerAgent(owner, {
                name: def.name,
                description:
                    'Synthetic eval agent for the Inspect nightly (docs/ai-architecture/inspect.md). It runs the ' +
                    'governed-run tasks on a seed tenant and is never used for anything else.',
                autonomyLevel: def.autonomyLevel,
                dataAccessScope: def.dataAccessScope,
                reversibility: 'REVERSIBLE',
                provenance: 'FIRST_PARTY',
                modelRef: null,
                ownerUserId: owner.userId,
                purpose: 'Evaluate the product\'s own agent engines against the Inspect task set.',
                useContext: 'CI test deployment only; synthetic seed data; no decisions about people.',
                provider: 'Inflect',
                deploymentRole: 'DEPLOYER',
                classification: {},
            }),
        );
        agent = await read();
        if (!agent) throw new Error(`${where}: registered, then not found`);
        log(`${where}: registered`);
    }
    if (agent.dataAccessScope !== def.dataAccessScope || agent.autonomyLevel !== def.autonomyLevel) {
        throw new Error(`${where}: stored as ${agent.dataAccessScope} / autonomy ${agent.autonomyLevel}, defined differently; reseed a fresh database`);
    }
    const agentId = agent.id;

    if (agent.riskTier === null) {
        const state = await step(where, 'read assessment', () => getAgentRiskAssessmentState(owner, agentId));
        if (state.questions.length === 0) throw new Error(`${where}: the assessment has no questions to answer`);
        for (const q of state.questions) {
            if (q.answer === ASSESSMENT_ANSWER) continue;
            await step(where, `answer ${q.id}`, () =>
                saveAgentAssessmentAnswer(owner, agentId, { questionId: q.id, answer: ASSESSMENT_ANSWER }),
            );
        }
        await step(where, 'complete assessment', () => completeAgentRiskAssessment(owner, agentId));
        agent = await read();
        if (!agent || agent.riskTier === null) throw new Error(`${where}: scored, then read UNSCORED`);
        log(`${where}: assessed ${agent.riskTier}`);
    }
    if (ceilingForRiskTier(agent.riskTier) < def.autonomyLevel) {
        throw new Error(`${where}: assessed ${agent.riskTier}, whose cap is below the autonomy ${def.autonomyLevel} its grants need`);
    }

    if (agent.status !== 'ACTIVE') {
        await step(where, 'activate', () => activateRegisteredAgent(owner, agentId));
        log(`${where}: activated`);
    }

    const granted = new Set(
        (
            await runInTenantContext(owner, (db) =>
                db.registeredAgentTool.findMany({ where: { tenantId: owner.tenantId, agentId }, select: { toolName: true }, take: 500 }),
            )
        ).map((g) => g.toolName),
    );
    const forbidden = [...granted].filter((t) => (NEVER_GRANTED as readonly string[]).includes(t) || !def.grants.includes(t));
    if (forbidden.length > 0) {
        throw new Error(`${where}: holds grants the seed never makes (${forbidden.join(', ')}); reseed a fresh database`);
    }
    for (const toolName of def.grants) {
        if (granted.has(toolName)) continue;
        await step(where, `grant ${toolName}`, () => grantAgentTool(owner, agentId, { toolName }));
    }

    const card = await step(where, 'read policy card', () => getAgentPolicyCard(owner, agentId));
    if (card.card === null) {
        const created = await step(where, 'create policy card', () => createAgentPolicyCard(owner, agentId));
        if (created.withheld.length > 0) {
            throw new Error(`${where}: the card withholds ${created.withheld.map((w) => w.toolName).join(', ')}`);
        }
        log(`${where}: policy card v1`);
    } else {
        const permitted = new Set<string>(card.card.inForce?.permittedTools ?? []);
        const missing = def.grants.filter((t) => !permitted.has(t));
        if (missing.length > 0 || (card.withheld?.length ?? 0) > 0) {
            throw new Error(`${where}: the policy card in force does not permit ${missing.join(', ') || 'every grant'}; reseed a fresh database`);
        }
    }
    return agentId;
}

// ─── Profiles ───────────────────────────────────────────────────────

async function ensureProfile(
    plan: SeedTenantPlan,
    people: TenantPeople,
    agentId: string,
    def: ProfileDefinition,
    log: Log,
): Promise<string> {
    const where = `${plan.slug} / ${def.fixture}`;
    const input = AgentProfileVersionSchema.parse({
        instructions: def.instructions,
        toolNames: [...def.toolNames],
        skillRefs: [],
        modelTier: 'balanced',
        effort: 'low',
        maxTurns: def.maxTurns,
        outputKind: def.outputKind,
        allowedTriggers: [...PROFILE_TRIGGERS],
    });
    const wantHash = profileInstructionsHash(input.instructions.trim());

    const profile = await runInTenantContext(people.owner, (db) =>
        db.agentProfile.findFirst({
            where: { tenantId: people.tenantId, agentId },
            select: { id: true, currentApprovedVersion: true },
        }),
    );
    if (profile?.currentApprovedVersion) {
        const inForce = await runInTenantContext(people.owner, (db) =>
            db.agentProfileVersion.findFirst({
                where: { tenantId: people.tenantId, profileId: profile.id, version: profile.currentApprovedVersion! },
                select: { instructionsHash: true, toolNames: true, outputKind: true, maxTurns: true, modelTier: true, effort: true, flowJson: true },
            }),
        );
        const same =
            inForce !== null &&
            inForce.flowJson === null &&
            inForce.instructionsHash === wantHash &&
            [...inForce.toolNames].sort().join(',') === [...input.toolNames!].sort().join(',') &&
            inForce.outputKind === input.outputKind &&
            inForce.maxTurns === input.maxTurns &&
            inForce.modelTier === input.modelTier &&
            inForce.effort === input.effort;
        if (same) return profileRunKey(profile.id, profile.currentApprovedVersion);
    }

    // The owner AUTHORS, the second person APPROVES: the four-eyes rule
    // (`SELF_DECISION`, CHECK `AgentProfileVersion_not_self_decided`).
    const created = await step(where, profile ? 'createAgentProfileVersion' : 'createAgentProfile', () =>
        profile ? createAgentProfileVersion(people.owner, agentId, input) : createAgentProfile(people.owner, agentId, input),
    );
    await step(where, 'submit', () => submitAgentProfileVersion(people.owner, agentId, created.version));
    const approved = await step(where, 'approve', () =>
        approveAgentProfileVersion(people.approver, agentId, created.version, { instructionsHash: created.instructionsHash }),
    );
    log(`${where}: version ${created.version} approved`);
    return approved.runKey;
}

// ─── Keys ───────────────────────────────────────────────────────────

async function mintAgentKey(plan: SeedTenantPlan, owner: RequestContext, agentId: string, def: AgentDefinition): Promise<string> {
    const where = `${plan.slug} / ${def.name}`;
    const earlier = await runInTenantContext(owner, (db) =>
        db.tenantApiKey.findMany({
            where: { tenantId: owner.tenantId, agentId, name: SEED_KEY_NAME, revokedAt: null },
            select: { id: true },
            take: 100,
        }),
    );
    for (const k of earlier) {
        await step(where, 'revoke the earlier seed key', () => revokeApiKey(owner, k.id));
    }
    const created = await step(where, 'createApiKey', () =>
        createApiKey(owner, {
            name: SEED_KEY_NAME,
            scopes: [...def.keyScopes],
            agentId,
            // min(key, agent): the key cannot drive the agent past its own rung.
            maxAutonomyLevel: def.autonomyLevel,
        }),
    );
    if (!created.plaintext.startsWith('iflk_')) throw new Error(`${where}: the minted key is not an iflk_ key`);
    return created.plaintext;
}

// ─── The run ────────────────────────────────────────────────────────

export interface InspectSeedTenantManifest {
    /** The agent a Flue run binds; null on a Tool Runner tenant, whose runs bind `profileAgents`. */
    agentId: string | null;
    /** profile fixture → `agent-profile:<id>@v<n>` */
    profiles: Record<string, string>;
    /** profile fixture → the agent that profile runs as */
    profileAgents: Record<string, string>;
    /** task id → synthetic fixture marker */
    markers: Record<string, string>;
    ownerEmail: string;
}

export interface InspectSeedResult {
    seedFixtureHash: string;
    seedVersion: number;
    tenants: Record<string, InspectSeedTenantManifest>;
    /** slug → agentId → raw key. Written to the keys file only. */
    keys: Record<string, Record<string, string>>;
}

/** The file `tasks.py` and the workflow read: `{ seedFixtureHash, seedVersion, <slug>: {...} }`. */
export function manifestJson(result: InspectSeedResult): string {
    return `${JSON.stringify({ seedFixtureHash: result.seedFixtureHash, seedVersion: result.seedVersion, ...result.tenants }, null, 2)}\n`;
}

export function loadCommittedTaskSet() {
    const raw = JSON.parse(readFileSync(path.join(ROOT, 'evals/inspect/task-set.json'), 'utf8'));
    const set = InspectTaskSetSchema.parse(raw);
    const pinned = readFileSync(path.join(ROOT, 'evals/inspect/task-set.sha256'), 'utf8').trim();
    if (inspectTaskSetHash(set) !== pinned) {
        throw new Error('inspect-seed: evals/inspect/task-set.json does not hash to task-set.sha256; a record of it would be refused');
    }
    return set;
}

export async function seedInspectTenants(log: Log = (line) => console.info(line)): Promise<InspectSeedResult> {
    assertSeedTarget(process.env);
    const plan = planSeed(loadCommittedTaskSet());
    const hash = seedFixtureHash(plan);

    const bank = await seedAgentRiskAssessmentLibrary(prisma);
    log(`agent risk assessment v${bank.questionSetVersion}: ${bank.questions} questions`);

    const tenants: Record<string, InspectSeedTenantManifest> = {};
    const keys: Record<string, Record<string, string>> = {};
    for (const t of plan.tenants) {
        const people = await ensureTenantAndPeople(t, log);
        await ensureSettings(t, people.owner, log);
        await ensureFixtures(t, people.owner, log);

        const agentIds = new Map<AgentDefinition, string>();
        for (const def of t.agents) agentIds.set(def, await ensureAgent(t, people.owner, def, log));

        const profiles: Record<string, string> = {};
        const profileAgents: Record<string, string> = {};
        for (const p of t.profiles) {
            const def = t.agents.find((a) => a.profileFixture === p.fixture);
            if (!def) throw new Error(`${t.slug}: no eval agent runs profile ${p.fixture}`);
            const agentId = agentIds.get(def)!;
            profiles[p.fixture] = await ensureProfile(t, people, agentId, p, log);
            profileAgents[p.fixture] = agentId;
        }

        keys[t.slug] = {};
        for (const [def, agentId] of agentIds) keys[t.slug][agentId] = await mintAgentKey(t, people.owner, agentId, def);

        tenants[t.slug] = {
            agentId: t.engine === 'flue' ? agentIds.get(t.agents[0])! : null,
            profiles,
            profileAgents,
            markers: { ...t.markers },
            ownerEmail: t.ownerEmail,
        };
        log(`${t.slug}: ready (${t.agents.length} agent(s), ${t.profiles.length} profile(s), ${t.fixtures.length} fixture(s))`);
    }
    return { seedFixtureHash: hash, seedVersion: plan.version, tenants, keys };
}

/** Write both files. The keys file is 0600 and holds nothing but the keys. */
export function writeSeedOutputs(result: InspectSeedResult, paths: { manifestPath: string; agentKeysPath: string }): void {
    writeFileSync(paths.agentKeysPath, `${JSON.stringify(result.keys)}\n`, { mode: 0o600 });
    chmodSync(paths.agentKeysPath, 0o600);
    writeFileSync(paths.manifestPath, manifestJson(result));
}

export function parseArgs(argv: readonly string[]): { manifestPath: string; agentKeysPath: string } | null {
    const value = (flag: string): string | undefined => {
        const i = argv.indexOf(flag);
        return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
    };
    const manifestPath = value('--manifest');
    const agentKeysPath = value('--agent-keys');
    if (!manifestPath || !agentKeysPath) return null;
    if (path.resolve(manifestPath) === path.resolve(agentKeysPath)) return null;
    return { manifestPath, agentKeysPath };
}

async function main(): Promise<void> {
    const paths = parseArgs(process.argv.slice(2));
    if (!paths) {
        process.stderr.write('usage: inspect-seed --manifest <manifest.json> --agent-keys <keys.json> (two different files)\n');
        process.exitCode = 2;
        return;
    }
    const result = await seedInspectTenants();
    writeSeedOutputs(result, paths);
    console.info(`inspect-seed: ${Object.keys(result.tenants).length} tenants seeded; manifest ${paths.manifestPath} (${result.seedFixtureHash})`);
}

if (require.main === module) {
    main()
        .then(async () => {
            await prisma.$disconnect();
            process.exit(process.exitCode ?? 0);
        })
        .catch(async (err: unknown) => {
            process.stderr.write(`[inspect-seed] FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
            await prisma.$disconnect().catch(() => undefined);
            process.exit(1);
        });
}
