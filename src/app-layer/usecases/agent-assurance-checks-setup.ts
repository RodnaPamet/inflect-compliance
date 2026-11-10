/**
 * SCHEDULE THE FOUR AGENT ASSURANCE CHECKS (#5014).
 *
 * The agent register's Assurance section lists four checks — policy cards,
 * pinned tool manifests, automation bias in proposal review, and the latest
 * kill-switch drill — and reads each one's result from the newest run of a
 * control-test plan configured with that check (`AGENTIC_CHECK_IDS`,
 * `services/agent-control-tests.ts`). Nothing in the product could create such
 * a plan: the test-plan editor never sets `automationConfig`, so every tenant
 * read "never run" for all four, however much agent governance it ran.
 *
 * This is the setup that closes that gap, modelled on the audit pilot's
 * (`audit-pilot-setup.ts`):
 *
 *   - DRY RUN BY DEFAULT. `apply: false` reports, per check, the plan it would
 *     create and the control it would sit on, and writes nothing.
 *   - EVERY WRITE IS AN EXISTING USECASE under the caller's own context —
 *     `createTestPlan`, then `scheduleTestPlan` — so each meets the same
 *     refusals and writes the same audit rows as the test-plan editor.
 *   - IDEMPOTENT. A check that already has a plan (any plan whose config names
 *     it) is UNCHANGED when it matches, and DIFFERS when somebody has since
 *     changed its schedule; a plan somebody changed is reported, never
 *     overwritten. A plan a crash left created but unscheduled (same name, on
 *     the target control, MANUAL, no config) is scheduled rather than doubled.
 *   - Every named refusal is decided BEFORE the first write.
 *
 * ## The cadence
 *
 * Daily at 06:40 UTC (owner decision, 2026-11-10). After the 06:00
 * `agent-kill-switch-drill`, so the drill check reads that morning's drill,
 * and daily rather than hourly because `AGENTIC_REVIEW_QUALITY` is the
 * expensive one (`agent-control-tests.ts` asks for a daily cron).
 *
 * ## Which control each plan is on
 *
 * A check's evidence is filed against its plan's control, so the control must
 * be one that discharges the risk the check evidences. Each check declares the
 * OWASP Agentic Top 10 requirements it covers (`AGENTIC_CHECKS[id].covers`, in
 * order). The first of those the tenant has a LIVE control linked to decides:
 * exactly one control and the plan goes there; more than one is
 * `CONTROL_AMBIGUOUS` unless `controls` names one; none for any requirement is
 * `CONTROL_MISSING`. The framework is matched by FAMILY (`frameworkFamilyId`),
 * not by key, for the reason `agentic-evidence-emission.ts` gives: a tenant's
 * controls hang off whichever of the two OWASP Agentic representations its
 * database got.
 */
import { runInTenantContext } from '@/lib/db-context';
import type { RequestContext } from '@/app-layer/types';
import { meetsAgentGovernanceWrite } from '@/app-layer/policies/agent-governance.policies';
import { createTestPlan } from '@/app-layer/usecases/control';
import { scheduleTestPlan } from '@/app-layer/usecases/test-scheduling';
import {
    AGENTIC_CHECKS,
    AGENTIC_CHECK_IDS,
    parseAgenticCheckConfig,
    type AgenticCheckId,
} from '@/app-layer/services/agent-control-tests';
import { frameworkFamilyId, requirementCodeSpellings } from '@/app-layer/domain/framework-representation';
import { ASI_LIBRARY_URN } from '@/lib/agentic/evidence-artefact';

/** Daily at 06:40 UTC: after the 06:00 kill-switch drill (owner decision, 2026-11-10). */
export const ASSURANCE_CHECK_CRON = '40 6 * * *';
export const ASSURANCE_CHECK_TIMEZONE = 'UTC';

/** The `Framework.key`s of the OWASP Agentic representations that predate `sourceUrn`. */
const ASI_LEGACY_KEYS: readonly string[] = ['OWASP-ASI', 'OWASP-ASI-TOP10'];
const FRAMEWORK_CATALOGUE_CAP = 500;

export type AssuranceSetupRefusal =
    | 'LACKS_PERMISSION'
    | 'UNKNOWN_CHECK'
    | 'CONTROL_MISSING'
    | 'CONTROL_AMBIGUOUS';

export type AssuranceStepOutcome = 'UNCHANGED' | 'DIFFERS' | 'WOULD_CHANGE' | 'CHANGED';

export interface AssuranceStepControl {
    readonly id: string;
    readonly code: string | null;
    readonly name: string;
}

export interface AssuranceStep {
    readonly check: AgenticCheckId;
    readonly title: string;
    readonly outcome: AssuranceStepOutcome;
    /** The plan this step found or wrote; null on a dry run that would create one. */
    readonly planId: string | null;
    /** The control the plan is, or would be, on. */
    readonly control: AssuranceStepControl | null;
    /** For a DIFFERS step: the schedule somebody set instead. */
    readonly schedule?: string | null;
}

export type AssuranceSetupResult =
    | {
          readonly ok: false;
          readonly refusal: AssuranceSetupRefusal;
          readonly detail: string;
          /** Which check the refusal is about, when it is about one. */
          readonly check?: AgenticCheckId;
          /** For CONTROL_AMBIGUOUS: the controls the check maps to. */
          readonly candidates?: readonly AssuranceStepControl[];
      }
    | { readonly ok: true; readonly applied: boolean; readonly steps: readonly AssuranceStep[] };

export interface AssuranceSetupOptions {
    readonly apply: boolean;
    /** Explicit control per check; a check not named here is mapped. */
    readonly controls?: Readonly<Record<string, string>>;
}

class AssuranceSetupRefused extends Error {
    constructor(
        readonly refusal: AssuranceSetupRefusal,
        detail: string,
        readonly about: { check?: AgenticCheckId; candidates?: readonly AssuranceStepControl[] } = {},
    ) {
        super(detail);
    }
}

/** The plan name, which is also how a crash-orphaned plan is recognised. */
export function assurancePlanName(check: AgenticCheckId): string {
    return `Agent assurance: ${AGENTIC_CHECKS[check].title}`;
}

function isAgenticCheckId(value: string): value is AgenticCheckId {
    return (AGENTIC_CHECK_IDS as readonly string[]).includes(value);
}

/** The config a plan this setup writes carries: the check, and the check's own defaults. */
function desiredConfig(check: AgenticCheckId): Record<string, unknown> {
    return { check };
}

/**
 * Schedule (or, without `apply`, report) one daily control-test plan per agent
 * assurance check. A named refusal is returned, never thrown; anything a
 * usecase refuses at apply is thrown as that usecase's error.
 */
export async function setUpAgentAssuranceChecks(
    ctx: RequestContext,
    opts: AssuranceSetupOptions,
): Promise<AssuranceSetupResult> {
    try {
        return await setUp(ctx, opts);
    } catch (err) {
        if (err instanceof AssuranceSetupRefused) {
            return { ok: false, refusal: err.refusal, detail: err.message, ...err.about };
        }
        throw err;
    }
}

async function setUp(ctx: RequestContext, opts: AssuranceSetupOptions): Promise<AssuranceSetupResult> {
    const explicit = new Map<AgenticCheckId, string>();
    for (const [check, controlId] of Object.entries(opts.controls ?? {})) {
        if (!isAgenticCheckId(check)) {
            throw new AssuranceSetupRefused(
                'UNKNOWN_CHECK',
                `"${check}" is not an agent assurance check (${AGENTIC_CHECK_IDS.join(', ')}).`,
            );
        }
        explicit.set(check, controlId);
    }

    // The register's key (the route's), and the test-plan key both writes take.
    const missing = [
        meetsAgentGovernanceWrite(ctx, 'agent_registry') ? null : 'admin.agent_registry',
        ctx.appPermissions.tests.create ? null : 'tests.create',
    ].filter((k): k is string => k !== null);
    if (missing.length > 0) {
        throw new AssuranceSetupRefused('LACKS_PERMISSION', `Scheduling these checks needs ${missing.join(' and ')}.`);
    }

    const state = await runInTenantContext(ctx, async (db) => {
        // ── The plans that already run a check ──────────────────────────────
        const plans = await db.controlTestPlan.findMany({
            where: { tenantId: ctx.tenantId, deletedAt: null, automationType: 'INTEGRATION' },
            select: { id: true, controlId: true, schedule: true, scheduleTimezone: true, automationConfig: true },
            orderBy: { createdAt: 'asc' },
            take: 200,
        });
        const existing = new Map<AgenticCheckId, (typeof plans)[number]>();
        for (const p of plans) {
            const cfg = parseAgenticCheckConfig(p.automationConfig);
            if (cfg && !existing.has(cfg.check)) existing.set(cfg.check, p);
        }
        const wanted = AGENTIC_CHECK_IDS.filter((c) => !existing.has(c));

        // ── The controls the wanted checks map to ───────────────────────────
        const catalogue = await db.framework.findMany({
            select: { id: true, key: true, sourceUrn: true },
            take: FRAMEWORK_CATALOGUE_CAP,
        });
        const asiFrameworkIds = catalogue
            .filter((f) => frameworkFamilyId(f) === ASI_LIBRARY_URN || ASI_LEGACY_KEYS.includes(f.key))
            .map((f) => f.id);
        const codes = [
            ...new Set(
                wanted
                    .filter((c) => !explicit.has(c))
                    .flatMap((c) => AGENTIC_CHECKS[c].covers)
                    .flatMap((code) => requirementCodeSpellings(ASI_LIBRARY_URN, code)),
            ),
        ];
        const requirements =
            asiFrameworkIds.length > 0 && codes.length > 0
                ? await db.frameworkRequirement.findMany({
                      where: { frameworkId: { in: asiFrameworkIds }, code: { in: codes }, deprecatedAt: null },
                      select: { id: true, code: true },
                      take: 200,
                  })
                : [];
        const links =
            requirements.length > 0
                ? await db.controlRequirementLink.findMany({
                      where: {
                          tenantId: ctx.tenantId,
                          requirementId: { in: requirements.map((r) => r.id) },
                          control: { deletedAt: null },
                      },
                      select: { requirementId: true, control: { select: { id: true, code: true, name: true } } },
                      take: 500,
                  })
                : [];
        const explicitIds = [...explicit.values()];
        const named =
            explicitIds.length > 0
                ? await db.control.findMany({
                      where: { tenantId: ctx.tenantId, deletedAt: null, id: { in: explicitIds } },
                      select: { id: true, code: true, name: true },
                      take: 50,
                  })
                : [];

        // A plan a crash left created but never scheduled.
        const orphans =
            wanted.length > 0
                ? await db.controlTestPlan.findMany({
                      where: {
                          tenantId: ctx.tenantId,
                          deletedAt: null,
                          automationType: 'MANUAL',
                          name: { in: wanted.map(assurancePlanName) },
                      },
                      select: { id: true, name: true, controlId: true, automationConfig: true },
                      take: 50,
                  })
                : [];

        const codeOf = new Map(requirements.map((r) => [r.id, r.code]));
        const controlsByCode = new Map<string, Map<string, AssuranceStepControl>>();
        for (const link of links) {
            const code = codeOf.get(link.requirementId);
            if (!code) continue;
            const byId = controlsByCode.get(code) ?? new Map<string, AssuranceStepControl>();
            byId.set(link.control.id, link.control);
            controlsByCode.set(code, byId);
        }
        return {
            existing,
            wanted,
            controlsByCode,
            named,
            orphans: orphans.filter((o) => o.automationConfig === null),
        };
    });

    // ── Resolve every wanted check's control before anything is written ─────
    const targets = new Map<AgenticCheckId, AssuranceStepControl>();
    for (const check of state.wanted) {
        const namedId = explicit.get(check);
        if (namedId !== undefined) {
            const control = state.named.find((c) => c.id === namedId);
            if (!control) {
                throw new AssuranceSetupRefused(
                    'CONTROL_MISSING',
                    `The control named for ${check}, "${namedId}", is not a live control of this workspace.`,
                    { check },
                );
            }
            targets.set(check, control);
            continue;
        }
        const covers = AGENTIC_CHECKS[check].covers;
        let chosen: AssuranceStepControl | null = null;
        for (const code of covers) {
            const hits = [...(state.controlsByCode.get(code)?.values() ?? [])];
            if (hits.length === 0) continue;
            if (hits.length > 1) {
                throw new AssuranceSetupRefused(
                    'CONTROL_AMBIGUOUS',
                    `${AGENTIC_CHECKS[check].title}: ${code} is discharged by ${hits.length} controls; name the one this check's plan should run on.`,
                    { check, candidates: hits },
                );
            }
            chosen = hits[0];
            break;
        }
        if (!chosen) {
            throw new AssuranceSetupRefused(
                'CONTROL_MISSING',
                `${AGENTIC_CHECKS[check].title}: no live control of this workspace is linked to ${covers.join(' or ')} ` +
                    'in the OWASP Agentic Top 10. Install that framework and map a control to it, or name the control.',
                { check },
            );
        }
        targets.set(check, chosen);
    }

    // ── Report, then (with apply) act ───────────────────────────────────────
    const steps: AssuranceStep[] = [];
    for (const check of AGENTIC_CHECK_IDS) {
        const title = AGENTIC_CHECKS[check].title;
        const found = state.existing.get(check);
        if (found) {
            const same =
                found.schedule === ASSURANCE_CHECK_CRON &&
                (found.scheduleTimezone ?? ASSURANCE_CHECK_TIMEZONE) === ASSURANCE_CHECK_TIMEZONE;
            steps.push({
                check,
                title,
                outcome: same ? 'UNCHANGED' : 'DIFFERS',
                planId: found.id,
                control: null,
                ...(same ? {} : { schedule: found.schedule }),
            });
            continue;
        }
        const control = targets.get(check)!;
        const orphan = state.orphans.find((o) => o.name === assurancePlanName(check) && o.controlId === control.id);
        if (!opts.apply) {
            steps.push({ check, title, outcome: 'WOULD_CHANGE', planId: orphan?.id ?? null, control });
            continue;
        }
        const planId =
            orphan?.id ??
            (
                await createTestPlan(ctx, control.id, {
                    name: assurancePlanName(check),
                    description:
                        `Runs the ${check} agent assurance check daily at 06:40 UTC and files its result as ` +
                        'evidence on this control; a failure raises a finding. Scheduled from the agent register.',
                    frequency: 'DAILY',
                    ownerUserId: ctx.userId,
                })
            ).id;
        await scheduleTestPlan(ctx, planId, {
            schedule: ASSURANCE_CHECK_CRON,
            scheduleTimezone: ASSURANCE_CHECK_TIMEZONE,
            automationType: 'INTEGRATION',
            automationConfig: desiredConfig(check),
        });
        steps.push({ check, title, outcome: 'CHANGED', planId, control });
    }

    return { ok: true, applied: opts.apply, steps };
}

