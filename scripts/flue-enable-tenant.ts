/**
 * Wire the Flue engine for ONE tenant, in stages.
 *
 * COMMITTED as the record of a sequence that was actually run (2026-09-24,
 * `inflect-ltd-mo94mi34`), and as the shape the next one should take. The
 * ANSWERS below are that tenant's, approved once by its owner — they are not a
 * default and must be re-approved per agent. `assess` refuses outright if the
 * seeded instrument no longer matches the sheet, because an unanswered
 * question scores as NO and would move the tier silently.
 *
 * Runs in the prod image via `esbuild` bundle + `docker cp` (the image has no
 * TS runner). `docker cp` lands in the container's WRITABLE LAYER, which
 * Watchtower destroys on recreate — so a deploy mid-sequence deletes it and
 * the next step fails at module load. That is a clean failure, not a partial
 * write, and every step is idempotent so re-copying and re-running resumes.
 *
 * Runs the REAL usecases — registration authors the EU AI Act entry, the
 * assessment runs the real scorer, activation applies the real refusal — so
 * every step leaves the audit row and the evidence a hand-written SQL UPDATE
 * would not. Not committed: the answers below are one tenant's, approved once.
 *
 * Staged deliberately. Each subcommand does ONE thing and prints what it did,
 * so a prod sequence is a series of reviewable steps rather than one script
 * that either worked or did not.
 *
 * THE KEY PLAINTEXT IS NEVER PRINTED. `key` writes it to a 0600 file and
 * reports only the path — a credential echoed into a terminal is a credential
 * in a transcript.
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync, chmodSync } from 'node:fs';

import prisma from '@/lib/prisma';
import type { RequestContext } from '@/app-layer/types';
import type { Role } from '@prisma/client';
import { getPermissionsForRole } from '@/lib/permissions';
import { registerAgent, activateRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import {
    saveAgentAssessmentAnswer,
    completeAgentRiskAssessment,
    getAgentRiskAssessmentState,
} from '@/app-layer/usecases/agent-risk-assessment';
import { setAgentDriverSetting } from '@/app-layer/usecases/agent-driver-setting';
import { getFlueWiringState } from '@/app-layer/usecases/flue-wiring';
import { createApiKey, revokeApiKey } from '@/app-layer/usecases/api-keys';
import { grantAgentTool, listAgentTools } from '@/app-layer/usecases/agent-tool-exposure';
import { runKillSwitchDrillJob } from '@/app-layer/jobs/agent-kill-switch-drill';

const TENANT_ID = 'cmo94mi360000fvnl1fv9ca9t';   // inflect-ltd-mo94mi34
const AGENT_NAME = 'Posture review (Flue)';

/** The owner-approved sheet. `ara-3-03` is contingent on the drill passing. */
const ANSWERS: Record<string, 'YES' | 'NO' | 'PARTIALLY' | 'NA'> = {
    'ara-1-01': 'YES', 'ara-1-02': 'PARTIALLY', 'ara-1-03': 'YES',
    'ara-1-04': 'PARTIALLY', 'ara-1-05': 'YES',
    'ara-2-01': 'YES', 'ara-2-02': 'YES', 'ara-2-03': 'YES',
    'ara-2-04': 'YES', 'ara-2-05': 'YES', 'ara-2-06': 'NA',
    'ara-3-01': 'PARTIALLY', 'ara-3-02': 'YES', 'ara-3-03': 'YES', 'ara-3-04': 'NA',
    'ara-4-01': 'YES', 'ara-4-02': 'PARTIALLY', 'ara-4-03': 'PARTIALLY',
    'ara-4-04': 'NO', 'ara-4-05': 'PARTIALLY',
};

/**
 * The actor: the tenant's oldest ACTIVE OWNER, by the same ordering
 * `backfill-agent-risk-tiers.ts` uses. `actorType: 'JOB'` because no human
 * clicked anything — the audit trail must not claim one did. OWNER rather than
 * ADMIN because `admin.tenant_lifecycle` is deliberately OWNER-only, which is
 * also why none of this can be done with an API key.
 */
async function ownerContext(): Promise<RequestContext> {
    const owner = await prisma.tenantMembership.findFirst({
        where: { tenantId: TENANT_ID, role: 'OWNER', status: 'ACTIVE' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { userId: true },
    });
    if (!owner) throw new Error(`tenant ${TENANT_ID} has no ACTIVE OWNER to attribute this to`);
    const role: Role = 'OWNER';
    return {
        requestId: `flue-enable-${randomUUID()}`,
        userId: owner.userId,
        actorType: 'JOB',
        tenantId: TENANT_ID,
        role,
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
        appPermissions: getPermissionsForRole(role),
    } as RequestContext;
}

/** The agent this script manages, or null. Keyed by NAME so re-runs are safe. */
async function findAgent() {
    return prisma.registeredAgent.findFirst({
        where: { tenantId: TENANT_ID, name: AGENT_NAME, deletedAt: null },
        select: { id: true, status: true, riskTier: true, autonomyLevel: true },
    });
}

async function status() {
    // WARNING, and it is not a nicety. This bundle INLINES its own copy of
    // `src/`, so the BUILD and WORKFLOW terms below describe THIS BUNDLE, not
    // the image the app container is running. They will read satisfied on a
    // box that has not deployed the workflow yet. The DB-backed terms (TENANT,
    // REGISTERED_AGENT, BOUND_KEY) are shared state and are trustworthy here;
    // for the other two, ask the deployed app — GET /admin/flue-wiring, or the
    // card on Admin -> Integrations.
    console.log('NOTE: BUILD and WORKFLOW below reflect THIS BUNDLE, not the running image.');
    const ctx = await ownerContext();
    const w = await getFlueWiringState(ctx);
    console.log(`wiring: ready=${w.ready} blockedOn=${w.blockedOn ?? '-'} effective=${JSON.stringify(w.effective)}`);
    for (const t of w.terms) {
        console.log(`  [${t.satisfied ? 'x' : ' '}] ${t.key.padEnd(17)} ${t.actor}${t.count === undefined ? '' : ` count=${t.count}`}`);
    }
    const a = await findAgent();
    console.log(`agent: ${a ? `${a.id} status=${a.status} tier=${a.riskTier ?? 'UNSCORED'} autonomy=${a.autonomyLevel}` : 'not registered'}`);
}

async function drill() {
    // Explicit tenantId: the nightly sweep DISCOVERS tenants that have a
    // non-placeholder RegisteredAgent, and until this agent exists that list
    // is empty — which is why `AgentKillSwitchDrill` has 0 rows in this
    // deployment despite the job running every night since it shipped.
    const r = await runKillSwitchDrillJob({ tenantId: TENANT_ID }, `flue-enable-${randomUUID()}`);
    console.log(`drill: ${JSON.stringify(r)}`);
    const rows = await prisma.agentKillSwitchDrill.findMany({
        where: { tenantId: TENANT_ID },
        orderBy: { createdAt: 'desc' },
        take: 3,
        select: { id: true, outcome: true, detail: true, createdAt: true },
    });
    for (const row of rows) console.log(`  ${row.createdAt.toISOString()} ${row.outcome} ${JSON.stringify(row.detail)?.slice(0, 200)}`);
}

async function register() {
    if (await findAgent()) { console.log('register: already exists, nothing to do'); return; }
    const ctx = await ownerContext();
    const agent = await registerAgent(ctx, {
        name: AGENT_NAME,
        description:
            'Runs the read-only posture-review workflow on the Flue reasoning engine. '
            + 'No PROPOSE step: it reads compliance posture, expiring evidence, open '
            + 'findings and overdue tasks, and writes a summary. It cannot queue a '
            + 'proposal, and propose-not-commit means it could not commit one.',
        autonomyLevel: 2,
        dataAccessScope: 'EXTERNAL_EGRESS',
        reversibility: 'REVERSIBLE',
        provenance: 'FIRST_PARTY',
        modelRef: null,
        ownerUserId: ctx.userId,
        purpose: 'Summarise what needs attention across the workspace for the compliance team.',
        useContext: 'Internal compliance operations. Read-only; no automated decisions about people.',
        provider: 'Inflect',
        deploymentRole: 'DEPLOYER',
        classification: {},
    });
    console.log(`register: ${JSON.stringify(agent).slice(0, 400)}`);
}

async function assess() {
    const ctx = await ownerContext();
    const a = await findAgent();
    if (!a) throw new Error('assess: register first');
    const before = await getAgentRiskAssessmentState(ctx, a.id);
    const known = new Set(before.questions.map((q) => q.id));
    const unknown = Object.keys(ANSWERS).filter((id) => !known.has(id));
    const unanswered = [...known].filter((id) => !(id in ANSWERS));
    // The instrument is seeded data and could have moved. Refusing on a
    // mismatch beats silently scoring a sheet that no longer covers it —
    // an unanswered question counts as NO and would quietly change the tier.
    if (unknown.length || unanswered.length) {
        throw new Error(`assess: sheet does not match the instrument. unknown=${unknown} unanswered=${unanswered}`);
    }
    for (const [questionId, answer] of Object.entries(ANSWERS)) {
        await saveAgentAssessmentAnswer(ctx, a.id, { questionId, answer });
    }
    const done = await completeAgentRiskAssessment(ctx, a.id);
    console.log(`assess: ${JSON.stringify(done).slice(0, 600)}`);
}

async function activate() {
    const ctx = await ownerContext();
    const a = await findAgent();
    if (!a) throw new Error('activate: register first');
    if (a.status === 'ACTIVE') { console.log('activate: already ACTIVE'); return; }
    console.log(`activate: ${JSON.stringify(await activateRegisteredAgent(ctx, a.id)).slice(0, 300)}`);
}

async function key() {
    const ctx = await ownerContext();
    const a = await findAgent();
    if (!a) throw new Error('key: register first');
    // Idempotent on the NARROW key, not on "any key". Checking for any live
    // bound credential would make this step refuse to mint the replacement
    // for an over-broad one, which is exactly the case it was first needed
    // for — a guard that blocks its own remedy.
    const live = await prisma.tenantApiKey.findMany({
        where: { tenantId: TENANT_ID, agentId: a.id, revokedAt: null },
        select: { id: true, scopes: true },
    });
    const narrow = live.filter((k) => !JSON.stringify(k.scopes).includes('"*"'));
    if (narrow.length > 0) {
        console.log(`key: ${narrow.length} live NARROW key(s) already bound, not minting another`);
        return;
    }
    const created = await createApiKey(ctx, {
        name: 'Posture review (Flue) runner',
        // THE NARROWEST SET THAT STARTS THIS RUN AND READS ITS FOUR TOOLS.
        //
        // `['*']` was minted first and was the wrong shape. Agent-binding
        // narrows an agent-bound credential to its principal at context mint
        // — REST and MCP alike, since #2224 — so a `*` key was not
        // exploitable here; it was a credential whose written authority bore
        // no relation to its job, and the binding is the only thing that made
        // that safe. Defence in depth means not relying on one term.
        //
        // `mcp:orchestrate` is what STARTS the run: `startWorkflowRun` gates
        // an API-key caller on that capability and takes `assertCanWrite`
        // only on the session branch, so no write scope is needed at all.
        // `mcp:read` is the "may talk to MCP" gate; the four resource scopes
        // are exactly the `resourceScope` each granted tool declares.
        scopes: [
            'mcp:orchestrate',
            'mcp:read',
            'controls:read',   // get_compliance_posture
            'evidence:read',   // list_evidence_expiring
            'audits:read',     // list_findings
            'tasks:read',      // list_tasks
        ],
        agentId: a.id,
        // min(key, agent) — the key cannot drive the agent past its own rung.
        maxAutonomyLevel: a.autonomyLevel,
    });
    const path = '/tmp/flue-runner.key';
    writeFileSync(path, (created as { plaintext: string }).plaintext, { mode: 0o600 });
    chmodSync(path, 0o600);
    console.log(`key: minted and written to ${path} (0600). NOT printed.`);
}

/**
 * THE STEP THE SIX TERMS DO NOT COVER.
 *
 * Tool access is DENY-BY-DEFAULT (`RegisteredAgentTool`), and the six wiring
 * terms decide only which ENGINE runs — not whether the agent can reach
 * anything once it does. An agent with zero grants is handed an empty
 * catalogue, makes one model call with nothing to call, and the run settles
 * COMPLETED having read nothing and written no summary. That is what the
 * first production run did, and it is indistinguishable in the run list from
 * a posture review that worked.
 *
 * The tools are exactly what `posture-review` declares, and no more: the
 * grant is the narrowest set that lets it do its job.
 */
const POSTURE_REVIEW_TOOLS = [
    'get_compliance_posture',
    'list_evidence_expiring',
    'list_findings',
    'list_tasks',
];

async function grant() {
    const ctx = await ownerContext();
    const a = await findAgent();
    if (!a) throw new Error('grant: register first');
    for (const toolName of POSTURE_REVIEW_TOOLS) {
        try {
            await grantAgentTool(ctx, a.id, { toolName });
            console.log(`  granted ${toolName}`);
        } catch (e) {
            // Named, not swallowed: `assertGrantWithinTier` and
            // `assertGrantWithinDeclaredDataScope` can legitimately refuse a
            // grant, and a refusal is information about the register rather
            // than a failure of this script.
            console.log(`  REFUSED ${toolName}: ${e instanceof Error ? e.message : e}`);
        }
    }
    const tools = await listAgentTools(ctx, a.id);
    console.log(`grant: agent now holds ${JSON.stringify(tools).slice(0, 400)}`);
}

/**
 * Retire any live agent-bound key that carries `*`.
 *
 * Separate from `key` and run AFTER the narrow one is proven, so the tenant
 * is never left with no way to start a run. Revocation is by id through the
 * usecase, so it lands an audit row.
 */
async function revokeBroadKeys() {
    const ctx = await ownerContext();
    const a = await findAgent();
    if (!a) throw new Error('revoke: register first');
    const keys = await prisma.tenantApiKey.findMany({
        where: { tenantId: TENANT_ID, agentId: a.id, revokedAt: null },
        select: { id: true, name: true, scopes: true },
    });
    const broad = keys.filter((k) => JSON.stringify(k.scopes).includes('"*"'));
    const narrow = keys.length - broad.length;
    if (narrow === 0) {
        throw new Error(`revoke: refusing — ${broad.length} broad key(s) and NO narrow replacement live`);
    }
    for (const k of broad) {
        await revokeApiKey(ctx, k.id);
        console.log(`  revoked ${k.id} (${k.name})`);
    }
    console.log(`revoke: ${broad.length} broad revoked, ${narrow} narrow key(s) remain live`);
}

async function toggle() {
    const ctx = await ownerContext();
    console.log(`toggle: ${JSON.stringify(await setAgentDriverSetting(ctx, 'FLUE'))}`);
}

const STEPS: Record<string, () => Promise<void>> = {
    status, drill, register, assess, activate, key, grant, toggle,
    'revoke-broad-keys': revokeBroadKeys,
};

const step = process.argv[2] ?? '';
const fn = STEPS[step];
if (!fn) {
    console.error(`usage: node flue-enable.mjs <${Object.keys(STEPS).join('|')}>`);
    process.exit(2);
}
fn()
    .then(() => prisma.$disconnect())
    .then(() => process.exit(0))
    .catch(async (e) => {
        console.error(`FAILED ${step}:`, e instanceof Error ? e.message : e);
        await prisma.$disconnect().catch(() => {});
        process.exit(1);
    });
