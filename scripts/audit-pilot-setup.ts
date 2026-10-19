/**
 * Set up the pilot auditor agent and its five audit procedure plans in ONE
 * tenant (#3676, step 3c; owner decision 8, 2026-10-19).
 *
 * Step 3c's exit is "the auditor agent re-performs all five procedures for the
 * pilot period and writes a workpaper for each". That needs, in the pilot
 * tenant: a registered auditor agent owned by a second-line member, holding
 * `propose_finding` and nothing outside the auditor's remit, ACTIVE; and one
 * scheduled control-test plan per library v1 procedure, carrying the pilot's
 * parameters. This script is how that state is reached, and how it is checked.
 *
 * ## What it writes, and how
 *
 * Nothing directly. Every write is a call to the usecase a person would reach
 * through the product — `registerAgent`, `grantAgentTool`,
 * `activateRegisteredAgent`, `createTestPlan`, `scheduleTestPlan` — under a
 * RequestContext resolved from the OWNER'S OWN membership
 * (`resolveMemberContext`), so each write meets the same refusals, lands the
 * same audit row and is attributed to the person whose decision it is. The
 * actor is that person, not a job: an audit procedure's plan is set only by a
 * person who owns the auditor (`AUDIT_PROCEDURE_PLAN_OWNER_ONLY`), and the
 * owner agreeing the pilot is that decision. Reads go through the tenant
 * context.
 *
 *   1. Register the auditor (`isAuditor`, autonomy 2, `WRITE_TENANT_DATA`,
 *      reversible, first party), named `--name`, owned by `--owner`.
 *   2. Grant `propose_finding`. No read tool: the five procedures read their
 *      populations through the handler and call none, so the remit's read
 *      tools would be authority the job does not use.
 *   3. Activate it, from DRAFT only, if activation allows. Registration does
 *      not score an agent and activation refuses an unscored one, so on a
 *      fresh tenant this step reports PENDING `UNSCORED`: the owner completes
 *      the agent's risk assessment in the product (this script never answers
 *      it), then re-runs. A SUSPENDED auditor is left suspended.
 *   4. One plan per procedure, INTEGRATION, on the control it audits, with the
 *      pilot's parameters — `leaverWindowHours` 24 and `remediationWindowDays`
 *      14, agreed 2026-10-19 for the pilot (decision 7). The values live HERE
 *      and on each plan; the library has no default and must not grow one.
 *      Monthly procedures run at 06:17 UTC on the 2nd, quarterly ones on the
 *      2nd of Jan/Apr/Jul/Oct, each auditing the period that has just ended:
 *      after the identity chain's 03:00-05:00 jobs and past procedure 3's
 *      24-hour settle margin.
 *
 * ## Which control each plan is on
 *
 * Mapped from the catalogue's identifiers when the mapping is clean: the
 * procedure's ISO/IEC 27001:2022 identifiers, in catalogue order, matched
 * against each live control's `annexId` and `code` (as `A.5.16` or the
 * template spelling `A-5.16`). The first identifier that matches anything
 * decides: exactly one control and the plan goes there; more than one and the
 * mapping is refused `CONTROL_AMBIGUOUS`. No match for any identifier is
 * `CONTROL_MISSING`. `--control=<procedure>=<controlId>` names the control
 * instead, and an id that is not a live control of the tenant is
 * `CONTROL_MISSING` too. A plan that already exists keeps its control.
 *
 * ## Contract
 *
 *   - DRY RUN BY DEFAULT. Prints what it would do and writes nothing;
 *     `--apply` writes.
 *   - Every named refusal is decided BEFORE the first write, in both modes,
 *     and writes nothing: TENANT_NOT_FOUND, OWNER_NOT_A_MEMBER,
 *     OWNER_NOT_ACTIVE, OWNER_NOT_SECOND_LINE, OWNER_NOT_INDEPENDENT,
 *     OWNER_LACKS_PERMISSION, NAME_HELD_BY_NON_AUDITOR,
 *     AUDITOR_OWNED_BY_ANOTHER, AUDITOR_RETIRED, UNKNOWN_PROCEDURE,
 *     CONTROL_MISSING, CONTROL_AMBIGUOUS. A usecase may still refuse at
 *     `--apply` for a reason of its own; the script stops there with that
 *     message, and every step before it is one a re-run recognises.
 *   - IDEMPOTENT. The auditor is found by name, the grant by tool, each plan
 *     by its procedure and auditor (or, for a plan a crash left created but
 *     not scheduled, by its name on its control). A step whose state is
 *     already reached is UNCHANGED, and a re-run on a set-up tenant writes
 *     nothing, not even an audit row. A plan whose schedule or parameters
 *     differ from the pilot's is REPORTED, never overwritten: that is the
 *     second line's later decision, not drift for this script to undo.
 *
 * ## Usage
 *   npx tsx scripts/audit-pilot-setup.ts --tenant=<slug> --owner=<email>            # dry run
 *   npx tsx scripts/audit-pilot-setup.ts --tenant=<slug> --owner=<email> --apply
 *     [--name="Pilot auditor (library v1)"] [--control=iam.leaver_timeliness=<controlId>] …
 *
 * In production it runs as `flue-enable-tenant.ts` does: an esbuild bundle
 * copied into the app container (the image has no TS runner).
 */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { prisma } from '@/lib/prisma';
import { hashForLookup } from '@/lib/security/encryption';
import { runInTenantContext } from '@/lib/db-context';
import type { RequestContext } from '@/app-layer/types';
import { resolveMemberContext } from '@/app-layer/context-system';
import { meetsAgentGovernanceWrite } from '@/app-layer/policies/agent-governance.policies';
import { evaluateOwnerIndependenceInTx } from '@/app-layer/usecases/auditor-independence';
import { registerAgent, activateRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import { grantAgentTool } from '@/app-layer/usecases/agent-tool-exposure';
import { createTestPlan } from '@/app-layer/usecases/control';
import { scheduleTestPlan } from '@/app-layer/usecases/test-scheduling';
import {
    AUDIT_PROCEDURE_LIBRARY_V1,
    AUDITOR_PROPOSE_TOOL,
    LIBRARY_V1_PROCEDURE_IDS,
    LIBRARY_V1_STATUS_SENTENCE,
    isLibraryV1Procedure,
    type LibraryV1ProcedureId,
} from '@/lib/agentic/audit-procedure-library';

export const DEFAULT_AUDITOR_NAME = 'Pilot auditor (library v1)';

/** The pilot's parameters, agreed 2026-10-19 (decision 7). Entered on each plan; never a library default. */
export const PILOT_PARAMETERS: Readonly<Record<LibraryV1ProcedureId, Readonly<Record<string, number>>>> = {
    'iam.leaver_timeliness': { leaverWindowHours: 24 },
    'iam.recertification_completeness': { remediationWindowDays: 14 },
    'iam.time_bounded_access_expiry': {},
    'iam.privileged_access': {},
    'agent.authority_conformance': {},
};

const CRON = { MONTH: '17 6 2 * *', QUARTER: '17 6 2 1,4,7,10 *' } as const;
const FREQUENCY = { MONTH: 'MONTHLY', QUARTER: 'QUARTERLY' } as const;
const TIMEZONE = 'UTC';

export type PilotRefusal =
    | 'TENANT_NOT_FOUND'
    | 'OWNER_NOT_A_MEMBER'
    | 'OWNER_NOT_ACTIVE'
    | 'OWNER_NOT_SECOND_LINE'
    | 'OWNER_NOT_INDEPENDENT'
    | 'OWNER_LACKS_PERMISSION'
    | 'NAME_HELD_BY_NON_AUDITOR'
    | 'AUDITOR_OWNED_BY_ANOTHER'
    | 'AUDITOR_RETIRED'
    | 'UNKNOWN_PROCEDURE'
    | 'CONTROL_MISSING'
    | 'CONTROL_AMBIGUOUS';

export type StepOutcome = 'UNCHANGED' | 'WOULD_CHANGE' | 'CHANGED' | 'PENDING' | 'DIFFERS';

export interface PilotStep {
    readonly step: string;
    readonly outcome: StepOutcome;
    readonly detail: string;
}

export type PilotSetupResult =
    | { readonly ok: false; readonly refusal: PilotRefusal; readonly detail: string }
    | { readonly ok: true; readonly applied: boolean; readonly agentId: string | null; readonly steps: readonly PilotStep[] };

export interface PilotSetupOptions {
    readonly tenantSlug: string;
    readonly ownerEmail: string;
    readonly apply: boolean;
    readonly agentName?: string;
    /** Explicit control per procedure; a procedure not named here is mapped. */
    readonly controls?: Readonly<Record<string, string>>;
    readonly log?: (line: string) => void;
}

class Refused extends Error {
    constructor(readonly refusal: PilotRefusal, detail: string) {
        super(detail);
    }
}

/** The procedure's ISO/IEC 27001:2022 Annex A identifiers, in catalogue order (a bare `A.x` inherits the standard before it). */
export function iso27001Identifiers(procedureId: LibraryV1ProcedureId): string[] {
    const out: string[] = [];
    let standard = '';
    for (const id of AUDIT_PROCEDURE_LIBRARY_V1[procedureId].controls) {
        const m = /^(.*?)\s*(A\.\d+(?:\.\d+)*)$/.exec(id);
        if (!m) {
            standard = ''; // an identifier of another kind ends the run of Annex A references
            continue;
        }
        if (m[1] !== '') standard = m[1];
        if (standard === 'ISO/IEC 27001:2022') out.push(m[2]);
    }
    return out;
}

const spellings = (annex: string) => [annex, annex.replace(/^A\./, 'A-')];

interface DesiredPlan {
    readonly procedure: LibraryV1ProcedureId;
    readonly name: string;
    readonly schedule: string;
    readonly frequency: string;
    readonly config: Record<string, unknown>;
}

function desiredPlan(procedure: LibraryV1ProcedureId, auditorAgentId: string): DesiredPlan {
    const def = AUDIT_PROCEDURE_LIBRARY_V1[procedure];
    const parameters = PILOT_PARAMETERS[procedure];
    return {
        procedure,
        name: `Audit procedure: ${def.title} (${procedure})`,
        schedule: CRON[def.periodKind],
        frequency: FREQUENCY[def.periodKind],
        config: {
            procedure,
            auditorAgentId,
            ...(Object.keys(parameters).length > 0 ? { parameters: { ...parameters } } : {}),
        },
    };
}

/** Is this stored config a procedure config naming exactly what the pilot would write? */
function sameConfig(stored: unknown, wanted: Record<string, unknown>): boolean {
    return isDeepStrictEqual(stored, wanted);
}

export async function setUpAuditPilot(opts: PilotSetupOptions): Promise<PilotSetupResult> {
    const log = opts.log ?? ((line: string) => console.info(line));
    try {
        return await setUp(opts, log);
    } catch (err) {
        if (err instanceof Refused) {
            log(`REFUSED ${err.refusal}: ${err.message}`);
            return { ok: false, refusal: err.refusal, detail: err.message };
        }
        throw err;
    }
}

async function setUp(opts: PilotSetupOptions, log: (line: string) => void): Promise<PilotSetupResult> {
    const agentName = opts.agentName ?? DEFAULT_AUDITOR_NAME;
    const explicit = new Map<LibraryV1ProcedureId, string>();
    for (const [procedure, controlId] of Object.entries(opts.controls ?? {})) {
        if (!isLibraryV1Procedure(procedure)) {
            throw new Refused('UNKNOWN_PROCEDURE', `"${procedure}" is not a library v1 procedure (${LIBRARY_V1_PROCEDURE_IDS.join(', ')}).`);
        }
        explicit.set(procedure, controlId);
    }

    // ── The owner ────────────────────────────────────────────────────────────
    const tenant = await prisma.tenant.findUnique({ where: { slug: opts.tenantSlug }, select: { id: true, slug: true } });
    if (!tenant) throw new Refused('TENANT_NOT_FOUND', `No tenant has the slug "${opts.tenantSlug}".`);
    const user = await prisma.user.findUnique({ where: { emailHash: hashForLookup(opts.ownerEmail) }, select: { id: true } });
    const membership = user
        ? await prisma.tenantMembership.findUnique({
              where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } },
              select: { status: true, lineOfDefence: true, role: true },
          })
        : null;
    if (!user || !membership) {
        throw new Refused('OWNER_NOT_A_MEMBER', `${opts.ownerEmail} is not a member of ${tenant.slug}.`);
    }
    if (membership.status !== 'ACTIVE') {
        throw new Refused('OWNER_NOT_ACTIVE', `${opts.ownerEmail}'s membership of ${tenant.slug} is ${membership.status}, not ACTIVE.`);
    }
    if (membership.lineOfDefence !== 'SECOND') {
        throw new Refused(
            'OWNER_NOT_SECOND_LINE',
            `${opts.ownerEmail}'s line of defence is ${membership.lineOfDefence ?? 'not declared'}; the auditor's owner is ` +
                'second line, which an OWNER declares on the members page.',
        );
    }
    const ctx = await resolveMemberContext({
        tenantId: tenant.id,
        userId: user.id,
        job: 'audit-pilot-setup',
        discriminator: randomUUID(),
    });
    if (!ctx) throw new Refused('OWNER_NOT_ACTIVE', `${opts.ownerEmail}'s membership of ${tenant.slug} is not ACTIVE.`);
    const missing = [
        meetsAgentGovernanceWrite(ctx, 'agent_registry') ? null : 'admin.agent_registry',
        meetsAgentGovernanceWrite(ctx, 'agent_tool_exposure') ? null : 'admin.agent_tool_exposure',
        ctx.appPermissions.tests.create ? null : 'tests.create',
    ].filter((k): k is string => k !== null);
    if (missing.length > 0) {
        throw new Refused('OWNER_LACKS_PERMISSION', `${opts.ownerEmail} does not hold ${missing.join(', ')} in ${tenant.slug}.`);
    }

    // ── What is already there ────────────────────────────────────────────────
    const state = await runInTenantContext(ctx, async (db) => {
        const agents = await db.registeredAgent.findMany({
            where: { tenantId: tenant.id, name: agentName, deletedAt: null },
            select: { id: true, isAuditor: true, ownerUserId: true, status: true, riskTier: true },
            take: 2,
        });
        const agent = agents[0] ?? null;
        const independence = agent ? null : await evaluateOwnerIndependenceInTx(db, ctx, { ownerUserId: user.id, agentId: null });
        const tools = agent
            ? await db.registeredAgentTool.findMany({ where: { tenantId: tenant.id, agentId: agent.id }, select: { toolName: true }, take: 200 })
            : [];
        const plans = agent
            ? await db.controlTestPlan.findMany({
                  where: { tenantId: tenant.id, automationConfig: { path: ['auditorAgentId'], equals: agent.id } },
                  select: {
                      id: true,
                      name: true,
                      controlId: true,
                      status: true,
                      schedule: true,
                      scheduleTimezone: true,
                      automationType: true,
                      automationConfig: true,
                  },
                  take: 50,
              })
            : [];
        return { agent, independence, tools: tools.map((t) => t.toolName), plans };
    });

    if (state.agent && !state.agent.isAuditor) {
        throw new Refused('NAME_HELD_BY_NON_AUDITOR', `An agent named "${agentName}" exists in ${tenant.slug} and is not an auditor.`);
    }
    if (state.agent && state.agent.ownerUserId !== user.id) {
        throw new Refused('AUDITOR_OWNED_BY_ANOTHER', `The auditor "${agentName}" is owned by another member, not ${opts.ownerEmail}.`);
    }
    if (state.agent?.status === 'RETIRED') {
        throw new Refused('AUDITOR_RETIRED', `The auditor "${agentName}" is RETIRED; retirement is permanent, so register under another --name.`);
    }
    if (state.independence && !state.independence.independent) {
        throw new Refused(
            'OWNER_NOT_INDEPENDENT',
            `${opts.ownerEmail} cannot own an auditor: ${state.independence.reasons.join(', ')}.`,
        );
    }

    // ── Which control each procedure's plan is on ────────────────────────────
    const existingPlan = new Map<LibraryV1ProcedureId, (typeof state.plans)[number]>();
    for (const p of state.plans) {
        const procedure = (p.automationConfig as { procedure?: unknown } | null)?.procedure;
        if (typeof procedure === 'string' && isLibraryV1Procedure(procedure) && !existingPlan.has(procedure)) {
            existingPlan.set(procedure, p);
        }
    }
    const targets = await runInTenantContext(ctx, async (db) => {
        const wanted = LIBRARY_V1_PROCEDURE_IDS.filter((p) => !existingPlan.has(p));
        const explicitIds = wanted.map((p) => explicit.get(p)).filter((id): id is string => id !== undefined);
        const annexes = [...new Set(wanted.filter((p) => !explicit.has(p)).flatMap(iso27001Identifiers).flatMap(spellings))];
        const controls = await db.control.findMany({
            where: {
                tenantId: tenant.id,
                deletedAt: null,
                OR: [{ id: { in: explicitIds } }, { annexId: { in: annexes } }, { code: { in: annexes } }],
            },
            select: { id: true, name: true, code: true, annexId: true },
            take: 500,
        });
        const out = new Map<LibraryV1ProcedureId, { id: string; label: string }>();
        for (const procedure of wanted) {
            const named = explicit.get(procedure);
            if (named !== undefined) {
                const c = controls.find((x) => x.id === named);
                if (!c) throw new Refused('CONTROL_MISSING', `--control for ${procedure} names "${named}", which is not a live control of ${tenant.slug}.`);
                out.set(procedure, { id: c.id, label: `${c.code ?? c.annexId ?? c.id} "${c.name}" (named)` });
                continue;
            }
            const identifiers = iso27001Identifiers(procedure);
            let chosen: { id: string; label: string } | null = null;
            for (const annex of identifiers) {
                const forms = spellings(annex);
                const hits = controls.filter((c) => forms.includes(c.annexId ?? '') || forms.includes(c.code ?? ''));
                if (hits.length === 0) continue;
                if (hits.length > 1) {
                    throw new Refused(
                        'CONTROL_AMBIGUOUS',
                        `${procedure} maps by ${annex} to ${hits.length} controls (${hits.map((h) => h.id).join(', ')}); ` +
                            `name one with --control=${procedure}=<controlId>.`,
                    );
                }
                chosen = { id: hits[0].id, label: `${hits[0].code ?? hits[0].annexId} "${hits[0].name}" (mapped by ${annex})` };
                break;
            }
            if (!chosen) {
                throw new Refused(
                    'CONTROL_MISSING',
                    `${procedure} maps to no control of ${tenant.slug} by ${identifiers.join(', ')}; ` +
                        `name one with --control=${procedure}=<controlId>.`,
                );
            }
            out.set(procedure, chosen);
        }
        // A plan a crash left created but never scheduled: same name, on the target, no config.
        const orphans = await db.controlTestPlan.findMany({
            where: {
                tenantId: tenant.id,
                name: { in: wanted.map((p) => desiredPlan(p, '').name) },
                controlId: { in: [...out.values()].map((t) => t.id) },
                automationType: 'MANUAL',
            },
            select: { id: true, name: true, controlId: true, automationConfig: true },
            take: 50,
        });
        return { out, orphans: orphans.filter((o) => o.automationConfig === null) };
    });

    // ── Plan, then (with --apply) act ────────────────────────────────────────
    const steps: PilotStep[] = [];
    const record = (step: string, outcome: StepOutcome, detail: string) => {
        steps.push({ step, outcome, detail });
        log(`  ${step.padEnd(36)} ${outcome.padEnd(12)} ${detail}`);
    };
    log(
        `[audit-pilot-setup] tenant ${tenant.slug} · owner ${opts.ownerEmail} (${membership.role}, line SECOND) · ` +
            (opts.apply ? 'APPLYING' : 'DRY RUN (pass --apply to write)'),
    );
    log(`  ${LIBRARY_V1_STATUS_SENTENCE}`);

    // 1. The auditor.
    let agentId = state.agent?.id ?? null;
    if (state.agent) {
        record('register auditor', 'UNCHANGED', `"${agentName}" ${state.agent.id} is a registered auditor (${state.agent.status})`);
    } else if (!opts.apply) {
        record('register auditor', 'WOULD_CHANGE', `would register "${agentName}" as an auditor: DRAFT, autonomy 2, WRITE_TENANT_DATA`);
    } else {
        const created = await registerAgent(ctx, {
            name: agentName,
            description:
                'The second line\'s auditor agent. Re-performs audit procedure library v1 on the control-test ' +
                'runner from raw rows, writes one workpaper per run and raises every exception as a finding ' +
                `proposal; it closes and resolves nothing. ${LIBRARY_V1_STATUS_SENTENCE}`,
            autonomyLevel: 2,
            dataAccessScope: 'WRITE_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            modelRef: null,
            ownerUserId: user.id,
            isAuditor: true,
            purpose: 'Independent re-performance of identity and agent-authority audit procedures for the second line.',
            useContext: 'Internal assurance. Proposes findings for a person to decide; makes no decision about a person.',
            provider: 'Inflect',
            deploymentRole: 'DEPLOYER',
            classification: {},
        });
        agentId = created.id;
        record('register auditor', 'CHANGED', `registered "${agentName}" ${agentId} (DRAFT)`);
    }

    // 2. The one grant.
    if (state.tools.includes(AUDITOR_PROPOSE_TOOL)) {
        record(`grant ${AUDITOR_PROPOSE_TOOL}`, 'UNCHANGED', 'held');
    } else if (!opts.apply || agentId === null) {
        record(`grant ${AUDITOR_PROPOSE_TOOL}`, 'WOULD_CHANGE', 'would grant (the only tool granted)');
    } else {
        await grantAgentTool(ctx, agentId, { toolName: AUDITOR_PROPOSE_TOOL });
        record(`grant ${AUDITOR_PROPOSE_TOOL}`, 'CHANGED', 'granted');
    }

    // 3. Activation, from DRAFT only.
    const status = state.agent?.status ?? 'DRAFT';
    const scored = state.agent?.riskTier != null;
    if (status === 'ACTIVE') {
        record('activate', 'UNCHANGED', 'ACTIVE');
    } else if (status === 'SUSPENDED') {
        record('activate', 'PENDING', 'SUSPENDED: left as it is; resuming a suspended auditor is its owner\'s act in the product');
    } else if (!scored) {
        record('activate', 'PENDING', 'UNSCORED: complete the agent\'s risk assessment in the product, then re-run with --apply');
    } else if (!opts.apply || agentId === null) {
        record('activate', 'WOULD_CHANGE', 'would activate');
    } else {
        try {
            await activateRegisteredAgent(ctx, agentId);
            record('activate', 'CHANGED', 'ACTIVE');
        } catch (err) {
            const reason = (err as { details?: { reason?: unknown } }).details?.reason;
            if (reason === 'AI_SYSTEM_UNCLASSIFIED' || reason === 'UNSCORED') {
                record('activate', 'PENDING', `${String(reason)}: ${(err as Error).message}`);
            } else {
                throw err;
            }
        }
    }

    // 4. The five plans.
    for (const procedure of LIBRARY_V1_PROCEDURE_IDS) {
        const label = `plan ${procedure}`;
        const want = desiredPlan(procedure, agentId ?? '<auditor id>');
        const params = Object.entries(PILOT_PARAMETERS[procedure]).map(([k, v]) => `${k}=${v}`).join(' ') || 'no parameters';
        const existing = existingPlan.get(procedure);
        if (existing) {
            const same =
                existing.automationType === 'INTEGRATION' &&
                existing.schedule === want.schedule &&
                (existing.scheduleTimezone ?? TIMEZONE) === TIMEZONE &&
                sameConfig(existing.automationConfig, want.config);
            record(
                label,
                same ? 'UNCHANGED' : 'DIFFERS',
                same
                    ? `${existing.id} on control ${existing.controlId}, ${existing.status}, "${want.schedule}" ${TIMEZONE}, ${params}`
                    : `${existing.id} differs from the pilot's (${existing.schedule ?? 'no schedule'}, ` +
                          `${JSON.stringify(existing.automationConfig)}); left as the second line set it`,
            );
            continue;
        }
        const target = targets.out.get(procedure)!;
        const orphan = targets.orphans.find((o) => o.name === want.name && o.controlId === target.id);
        if (!opts.apply || agentId === null) {
            record(
                label,
                'WOULD_CHANGE',
                `would ${orphan ? `schedule ${orphan.id}` : 'create and schedule'} on ${target.label}: "${want.schedule}" ${TIMEZONE}, ${params}`,
            );
            continue;
        }
        const planId =
            orphan?.id ??
            (await createTestPlan(ctx, target.id, {
                name: want.name,
                description:
                    `Runs ${procedure} as the auditor agent and writes one audit workpaper per run. ` +
                    `Parameters agreed for the pilot on 2026-10-19. ${LIBRARY_V1_STATUS_SENTENCE}`,
                frequency: want.frequency,
                ownerUserId: user.id,
            })).id;
        await scheduleTestPlan(ctx, planId, {
            schedule: want.schedule,
            scheduleTimezone: TIMEZONE,
            automationType: 'INTEGRATION',
            automationConfig: want.config,
        });
        record(label, 'CHANGED', `${planId} on ${target.label}: "${want.schedule}" ${TIMEZONE}, ${params}`);
    }

    return { ok: true, applied: opts.apply, agentId, steps };
}

function parseArgs(argv: readonly string[]): PilotSetupOptions | null {
    const value = (flag: string) => argv.find((a) => a.startsWith(`--${flag}=`))?.slice(flag.length + 3);
    const tenantSlug = value('tenant');
    const ownerEmail = value('owner');
    if (!tenantSlug || !ownerEmail) return null;
    const controls: Record<string, string> = {};
    for (const a of argv.filter((x) => x.startsWith('--control='))) {
        const spec = a.slice('--control='.length);
        const at = spec.lastIndexOf('=');
        if (at <= 0) return null;
        controls[spec.slice(0, at)] = spec.slice(at + 1);
    }
    return { tenantSlug, ownerEmail, apply: argv.includes('--apply'), agentName: value('name'), controls };
}

export async function run(argv: readonly string[]): Promise<number> {
    const opts = parseArgs(argv);
    if (!opts) {
        console.error(
            'usage: audit-pilot-setup --tenant=<slug> --owner=<email> [--apply] [--name=<auditor name>] ' +
                '[--control=<procedure>=<controlId> …]',
        );
        return 2;
    }
    const result = await setUpAuditPilot(opts);
    return result.ok ? 0 : 1;
}

if (require.main === module) {
    run(process.argv.slice(2))
        .then(async (code) => {
            await prisma.$disconnect();
            process.exit(code);
        })
        .catch(async (err) => {
            console.error('[audit-pilot-setup] FAILED', err instanceof Error ? err.message : err);
            await prisma.$disconnect();
            process.exit(1);
        });
}
