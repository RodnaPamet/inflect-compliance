/**
 * The joiner pass as WORK: the IO half that assembles a plan's input, drives the
 * pure planner, and leaves an artefact behind.
 *
 * Issue #2687. Phase 1 (#2638) shipped `planJoinerPass`, and nothing called it —
 * no dispatcher, no executor, no schedule, no route. A sound mechanism that is
 * unreachable is the failure this repo already has a name for, and it has a
 * specific cost here: the seven-day DRY_RUN artefact the write ladder's own
 * refusal text keeps referring to did not exist, because nothing produced one.
 *
 * ═══ WHY THIS IS A SEPARATE MODULE FROM THE PLANNER ═══
 *
 * `identity-joiner-pass.ts` states its own contract — *"It is a pure function.
 * It writes nothing to a directory, nothing to an HRIS, and nothing to our own
 * database; it opens no socket"* — and that is not a style preference. The
 * design's gate-placement rule requires every gate that decides whether a create
 * happens to sit ABOVE the DRY_RUN return, evaluated from data the dry run has;
 * a gate inside a provider writer is by construction one the dry run cannot
 * honour.
 *
 * The property is PROVED rather than asserted: `tests/unit/identity-joiner-pass.test.ts`
 * mocks `@/lib/prisma` and `@/lib/db-context` to THROW ON IMPORT, so if the
 * planner — or anything in its import graph — reached a database, that suite
 * could not load. Putting this file's database reads into that module would take
 * the proof down with it. So the IO lives here and the decisions live there, and
 * the seam between them is `JoinerPlanInput`.
 *
 * ═══ WHAT THE PLAN CANNOT BE GIVEN TODAY, AND WHY THAT IS NOT PAPERED OVER ═══
 *
 * Two of the input fields have no column to read from:
 *
 *   · `departmentGroups` / `defaultGroupId` / `defaultGroupName` — owner
 *     decision 10, REVISED 2026-09-21 (#2713). The rules live in
 *     `IdentityDepartmentGroupRule`, one row each so a rule carries its own
 *     provenance; the singular fallback lives on `TenantSecuritySettings` and
 *     inherits the same OWNER gate as the ladder itself. A tenant with neither
 *     configured still refuses `NO_DEPARTMENT_MAP` / `NO_DEFAULT_GROUP` — but
 *     that refusal is now one an operator can clear.
 *   · `timeZone` — owner decision 9 fires dispatch on the tenant's own zone.
 *     Nothing stores one, so the start-date window is computed in UTC and
 *     `predictionLimits` SAYS SO on every plan.
 *
 * Both are read through `readJoinerEntitlementConfig` below rather than being
 * spelled `null` at the call site, so the day those columns land there is ONE
 * function to change and the shape of what it returns is already right.
 *
 * A `NO_DEPARTMENT_MAP` refusal is NOT an empty pass. The planner computes and
 * carries every per-starter decision on that refusal deliberately — *"a pass
 * that returned early on an unconfigured group map would throw away the identity
 * verdicts, and those verdicts are the whole reason the rung exists"* — so a
 * DRY_RUN today still produces a decision per starter, which is what makes a
 * wrong derivation visible before Phase 2 could act on it.
 *
 * ═══ THE WINDOW IS THE PLANNER'S, NOT A `where` CLAUSE ═══
 *
 * The starter query filters on STATUS and nothing else. It deliberately does not
 * filter on `startDate`, and that is the single most load-bearing line in this
 * file. Decision 6's shape argument applies to every refusal the planner names:
 * a filtered-out row and a refused row look identical from outside — an empty
 * page — and only one of them told anybody why. Move the day window into the
 * query and three live outcomes vanish silently:
 *
 *   · `NOT_IN_WINDOW`            — "starts on another day", the row that proves
 *                                  the pass considered the whole population;
 *   · `REFUSED_NO_START_DATE`    — reachable in real data, because
 *                                  `deriveEmploymentStatus` returns ONBOARDING
 *                                  from the status STRING alone, with no date;
 *   · `START_DATE_UNPARSEABLE`   — the roster writes `new Date(hireDate)`
 *                                  without the vendor-date guard, so a malformed
 *                                  value reaches the column intact.
 *
 * All three are data-quality facts an operator can act on, and a `where` clause
 * turns each of them into the same silence as "nobody starts today".
 *
 * @module usecases/identity-joiner-run
 */
import type { Prisma } from '@prisma/client';

import { buildSystemContext } from '../context-system';
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { logger } from '@/lib/observability/logger';
import { recordJoinerPassOutcome } from '@/lib/observability/integration-metrics';
import { redactDirectoryIdentifiers } from '@/lib/security/redact-directory-identifiers';
import { isAboveClamp } from '@/lib/identity/write-ladder';

import { getIdentityWritePolicy } from './identity-write-policy';
import { OBSERVATION_FRESHNESS_MS } from './identity-write-target';
import {
    JOINER_MAX_MODE,
    planJoinerPass,
    type JoinerCandidate,
    type JoinerDecision,
    type JoinerPassRefusal,
    type JoinerPlan,
} from './identity-joiner-pass';

/**
 * How recently a link must have been re-observed for the worker to count as
 * ALREADY_PROVISIONED.
 *
 * An ALIAS of the leaver's bound, taken from the same source constant rather
 * than from `identity-leaver-pass` (importing that would drag the writer
 * factory, both provider writers and `undici` into this module's graph for one
 * number). Links are stamped `lastVerifiedAt` ONLY by the reconciler, which runs
 * ONLY after a sync that returned PASSED — so requiring freshness IS requiring
 * that a confirmed-complete directory enumeration happened recently.
 */
export const JOINER_LINK_FRESHNESS_MS = OBSERVATION_FRESHNESS_MS;

/**
 * Bound on the starter population one pass assembles.
 *
 * Generous by three orders of magnitude against `MAX_CREATES_PER_RUN` (5), and
 * that asymmetry is the point: the cap is an ANOMALY DETECTOR that refuses the
 * whole batch, so it must see the real number. A query `take` set near the cap
 * would truncate the population BEFORE the detector counted it, and the pass
 * would report a plausible five where the roster actually said four hundred.
 */
export const MAX_STARTERS_PER_PASS = 5000;

/**
 * Bound on the collision read.
 *
 * `observedAddresses` is the whole enumeration for one (tenant, provider), so it
 * is the only large read here. Truncating it is NOT silent: the plan's
 * `namespacesChecked` already refuses to render a clean read as "available", and
 * a truncated read is carried into the execution row as `observedTruncated`, so
 * an `ACCOUNT_OBSERVED` that did not fire cannot be read as one that could not.
 */
export const MAX_OBSERVED_ADDRESSES = 20000;

/** Bound on how many per-starter decisions one row carries. */
export const MAX_REPORTED_JOINER_DECISIONS = 200;

/**
 * The automationKey suffix joiner rows are stored under.
 *
 * A SIBLING of `.leaver_pass`, never the same key. The two passes answer
 * different questions and carry different decision shapes; sharing a key would
 * make `listJoinerPasses` return leaver rows whose decisions are keyed by link
 * id, which a joiner reader would render as starters with no employee.
 */
export const JOINER_PASS_AUTOMATION_SUFFIX = '.joiner_pass';

/** Bound on how many passes one read returns. A daily job over a short window. */
const MAX_LISTED_PASSES = 100;

/** What a run reports to its caller. Never throws; failures are statuses. */
export interface JoinerPassResult {
    readonly status: 'PASSED' | 'NOT_APPLICABLE' | 'ERROR';
    readonly mode: string;
    readonly refusal: JoinerPassRefusal | null;
    readonly detail: string;
    readonly starters: number;
    readonly wouldCreate: number;
    readonly decisions: number;
    readonly errorMessage?: string;
}

/**
 * Decision 10's map, decision 9's zone, and the honest answer that neither
 * exists yet.
 *
 * ONE function rather than three `null`s at the call site, because the fix is
 * one edit and this is where it goes. The shape it returns is already the shape
 * `JoinerPlanInput` wants, so landing the columns is a body change with no
 * caller change.
 *
 * It READS the settings row rather than returning a bare constant, and that is
 * not ceremony: the read proves the row is reachable under this job's system
 * context, so the day the columns land the only new thing in the query is their
 * names.
 */
async function readJoinerEntitlementConfig(ctx: RequestContext): Promise<{
    departmentGroups: Readonly<Record<string, string>> | null;
    defaultGroupId: string | null;
    defaultGroupName: string | null;
    timeZone: string | null;
}> {
    const [rules, settings] = await runInTenantContext(ctx, (db) =>
        Promise.all([
            db.identityDepartmentGroupRule.findMany({
                where: { tenantId: ctx.tenantId },
                select: { department: true, groupId: true },
            }),
            db.tenantSecuritySettings.findUnique({
                where: { tenantId: ctx.tenantId },
                select: {
                    identityDefaultGroupId: true,
                    identityDefaultGroupName: true,
                },
            }),
        ]),
    );

    // AN EMPTY MAP IS NOT AN EMPTY OBJECT. The planner refuses
    // NO_DEPARTMENT_MAP on `!departmentGroups || keys.length === 0`, so `{}`
    // and `null` refuse identically — but they say different things to a
    // reader, and only one of them is true here. No rows configured means the
    // tenant has no map, so `null` is the honest value.
    const departmentGroups =
        rules.length > 0
            ? Object.freeze(
                  Object.fromEntries(rules.map((r) => [r.department, r.groupId])),
              )
            : null;

    // Both halves are read, and NEITHER is defaulted. A missing settings row
    // and a row with a null column are the same state — no fallback — and the
    // planner names it NO_DEFAULT_GROUP rather than choosing a group.
    return {
        departmentGroups,
        defaultGroupId: settings?.identityDefaultGroupId ?? null,
        defaultGroupName: settings?.identityDefaultGroupName ?? null,
        timeZone: null,
    };
}

/**
 * The starters. Employees are read by STATUS alone — see the module docblock for
 * why no date predicate belongs in this query.
 */
async function readStarters(
    ctx: RequestContext,
    provider: string,
    // The pass's OWN clock, never `Date.now()` inside this function. One instant
    // governs the whole pass — the freshness bound here and the day window in
    // the planner — so a run is reproducible and the two bounds cannot be
    // computed milliseconds, or in a backfill hours, apart.
    now: Date,
): Promise<JoinerCandidate[]> {
    const employees = await runInTenantContext(ctx, (db) =>
        db.employee.findMany({
            where: { tenantId: ctx.tenantId, status: 'ONBOARDING' },
            select: {
                id: true,
                fullName: true,
                workEmail: true,
                source: true,
                externalId: true,
                department: true,
                startDate: true,
            },
            orderBy: { id: 'asc' },
            take: MAX_STARTERS_PER_PASS,
        }),
    );
    if (employees.length === 0) return [];

    // `hasFreshLink` is passed IN rather than computed in the planner, because
    // deciding it needs the link table and the freshness bound and the planner
    // holds no database. PROVIDER-SCOPED: a worker holding a fresh Entra link is
    // not provisioned in Active Directory, and an unscoped read would report
    // ALREADY_PROVISIONED for a directory nobody has created them in.
    const staleBefore = new Date(now.getTime() - JOINER_LINK_FRESHNESS_MS);
    const linked = await runInTenantContext(ctx, (db) =>
        db.identityAccountLink.findMany({
            where: {
                tenantId: ctx.tenantId,
                employeeId: { in: employees.map((e) => e.id) },
                lastVerifiedAt: { gte: staleBefore },
                // A link a sync has DISPROVED is excluded outright, exactly as
                // the leaver's candidate read excludes it: freshness alone was
                // never a witness that a pairing is still true.
                contradictedAt: null,
                connectedAccount: { provider },
            },
            select: { employeeId: true },
        }),
    );
    const fresh = new Set(linked.map((l) => l.employeeId));

    return employees.map((e) => ({
        employeeId: e.id,
        fullName: e.fullName,
        workEmail: e.workEmail,
        source: e.source,
        externalId: e.externalId,
        department: e.department,
        startDate: e.startDate,
        hasFreshLink: fresh.has(e.id),
    }));
}

/**
 * Every address the last complete enumeration holds for this (tenant, provider),
 * whatever its status.
 *
 * NOT filtered on ACTIVE, deliberately — the same reasoning `JoinerPlanInput`
 * records: the deprovision reconcile updates rows in place to DEPROVISIONED and
 * nothing deletes them, so an ACTIVE-only read would call FREE a UPN still held
 * by a soft-deleted object in the recycle bin, which is one of the cases a real
 * create rejects.
 */
async function readObservedAddresses(
    ctx: RequestContext,
    provider: string,
): Promise<{ addresses: string[]; truncated: boolean }> {
    const rows = await runInTenantContext(ctx, (db) =>
        db.connectedIdentityAccount.findMany({
            where: { tenantId: ctx.tenantId, provider },
            select: { email: true },
            orderBy: { id: 'asc' },
            take: MAX_OBSERVED_ADDRESSES + 1,
        }),
    );
    const truncated = rows.length > MAX_OBSERVED_ADDRESSES;
    return { addresses: rows.slice(0, MAX_OBSERVED_ADDRESSES).map((r) => r.email), truncated };
}

/**
 * The durable record, and what it may and may not carry.
 *
 * `IntegrationExecution.resultJson` is NOT encrypted at rest and its rows
 * outlive the pass, so the leaver keys its decisions by link id and scrubs every
 * reason. The joiner's boundary sits in a different place, and the difference is
 * worth stating rather than inheriting:
 *
 *   · `employeeId` is our own cuid, tenant-scoped by RLS. Same class as a link
 *     id: it resolves to a person only through an authorised read.
 *   · `intendedAddress` is DERIVED BY US from `Employee.workEmail` — a plain,
 *     unencrypted, RLS-scoped column in this same database that the personnel
 *     page already renders. It is not a directory-sourced identifier, and it is
 *     the one field that makes the artefact answer the question the seven days
 *     exist to ask: WHICH identity would this person have been given. Dropping
 *     it would leave a report that names decisions and no identities.
 *   · `reason` IS scrubbed. It is free text, and one outcome quotes an address
 *     the customer's own ENUMERATION holds (`ACCOUNT_OBSERVED`). A sentence is
 *     exactly the shape that carries an identifier past a field-by-field rule,
 *     which is why the leaver scrubs its reasons too.
 */
function persistableDecisions(decisions: readonly JoinerDecision[]) {
    return decisions.slice(0, MAX_REPORTED_JOINER_DECISIONS).map((d) => ({
        employeeId: d.employeeId,
        outcome: d.outcome,
        ...(d.reason ? { reason: redactDirectoryIdentifiers(d.reason, null) } : {}),
        intendedAddress: d.intendedAddress,
        nameSource: d.nameSource,
        department: d.department,
        groupId: d.groupId,
        groupIsDefaultFallback: d.groupIsDefaultFallback,
        namespacesChecked: [...d.namespacesChecked],
    }));
}

async function writeJoinerExecutionRow(
    ctx: RequestContext,
    provider: string,
    status: 'PASSED' | 'NOT_APPLICABLE' | 'ERROR',
    resultJson: Prisma.InputJsonValue,
): Promise<void> {
    await runInTenantContext(ctx, (db) =>
        db.integrationExecution.create({
            data: {
                tenantId: ctx.tenantId,
                provider,
                automationKey: `${provider}${JOINER_PASS_AUTOMATION_SUFFIX}`,
                status,
                triggeredBy: 'scheduled',
                completedAt: new Date(),
                resultJson,
            },
        }),
    );
}

/**
 * Record what the plan decided, never letting the record's failure become the
 * pass's.
 *
 * Same posture as the leaver: a pass that has already decided must not be
 * reported as broken because a row could not be written. The decisions are made
 * and already in the log line; losing the artefact is worth an alert, not a
 * retry of a pass that ran.
 */
async function safeRecordPlan(
    ctx: RequestContext,
    provider: string,
    plan: JoinerPlan,
    extra: Record<string, unknown>,
): Promise<void> {
    try {
        await writeJoinerExecutionRow(ctx, provider, plan.refusal ? 'NOT_APPLICABLE' : 'PASSED', {
            mode: plan.mode,
            clamp: plan.clamp,
            refusal: plan.refusal,
            detail: plan.detail,
            starters: plan.starters,
            wouldCreate: plan.wouldCreate,
            // VERBATIM, and this is acceptance criterion 3 of #2687. The limits
            // are what stop "would create N accounts" being read as a promise —
            // they say the HRIS write-back has never been attempted, that the
            // collision read covers one namespace and not the ones a create is
            // actually rejected in, and (today, always) that the window was
            // computed in UTC. Summarising them, or dropping them from a REFUSED
            // row, would leave an artefact claiming more than the run checked.
            predictionLimits: [...plan.predictionLimits],
            decisions: persistableDecisions(plan.decisions),
            decisionsTruncated: plan.decisions.length > MAX_REPORTED_JOINER_DECISIONS,
            ...extra,
        });
    } catch (err) {
        logger.error('joiner pass ran but its record could not be written', {
            component: 'identity-joiner-pass',
            tenantId: ctx.tenantId,
            provider,
            error: redactDirectoryIdentifiers(err instanceof Error ? err.message : String(err), null),
        });
    }
}

/**
 * A pass that THREW still ran, and must not read as a pass that never fired.
 *
 * The same argument the leaver makes: until it recorded its crashes, a dead
 * worker and a crashed pass left the identical artefact — none — which is the
 * one ambiguity a proving run exists to rule out.
 */
async function safeRecordErroredPass(
    ctx: RequestContext,
    provider: string,
    detail: string,
): Promise<void> {
    try {
        await writeJoinerExecutionRow(ctx, provider, 'ERROR', {
            mode: 'unknown',
            refusal: null,
            detail: redactDirectoryIdentifiers(detail, null),
        });
    } catch (err) {
        logger.error('joiner pass threw and its record could not be written either', {
            component: 'identity-joiner-pass',
            tenantId: ctx.tenantId,
            provider,
            error: redactDirectoryIdentifiers(err instanceof Error ? err.message : String(err), null),
        });
    }
}

/**
 * Run one joiner pass for one (tenant, provider).
 *
 * Never throws. Every failure is a status on the result, because the caller is a
 * fan-out over tenants and one tenant's broken configuration must not end the
 * run for the rest.
 *
 * ═══ THE LADDER REFUSALS RECORD NO ROW ═══
 *
 * Mirroring the leaver, and for its reason: a tenant with joiner writes switched
 * off is not observing and should not accrue observation rows, and a tenant
 * above the ceiling is a configuration state that already logs a warning. The
 * starter count is still assembled and still reported — on the returned plan and
 * in the log line — because the planner carries it on both ladder refusals
 * deliberately: *"a MODE_DISABLED row carrying starters: 3 is the most
 * actionable row on the page"*, and the morning somebody is sitting at a desk
 * with no account is not the morning to be unable to tell an off switch from a
 * dead worker.
 */
export async function runIdentityJoinerPass(input: {
    tenantId: string;
    provider: string;
    now?: Date;
}): Promise<JoinerPassResult> {
    const now = input.now ?? new Date();
    // `context-system`, never `context` — the latter reaches @/lib/auth -> @/auth
    // and dies in the worker, which has no Next request to hang a session on.
    const ctx = buildSystemContext({ tenantId: input.tenantId, job: 'identity-joiner-pass' });

    try {
        const policy = await getIdentityWritePolicy(ctx);
        const mode = policy.joiner.mode;

        // Assembly comes FIRST, and the planner's docblock argues the ordering:
        // the leaver checks the ladder before assembling because *"a tenant in
        // DISABLED mode must not generate directory traffic to discover that it
        // is in DISABLED mode"* — and joiner assembly generates NO directory
        // traffic at all. Every read below is against our own database.
        const starters = await readStarters(ctx, input.provider, now);
        const observed = await readObservedAddresses(ctx, input.provider);
        const config = await readJoinerEntitlementConfig(ctx);

        const plan = planJoinerPass({
            mode,
            now,
            starters,
            observedAddresses: observed.addresses,
            departmentGroups: config.departmentGroups,
            defaultGroupId: config.defaultGroupId,
            defaultGroupName: config.defaultGroupName,
            timeZone: config.timeZone,
        });

        logger.info('joiner pass complete', {
            component: 'identity-joiner-pass',
            tenantId: ctx.tenantId,
            provider: input.provider,
            mode: plan.mode,
            refusal: plan.refusal,
            starters: plan.starters,
            wouldCreate: plan.wouldCreate,
            decisions: plan.decisions.length,
            observedTruncated: observed.truncated,
        });

        if (mode === 'DISABLED') {
            recordJoinerPassOutcome({ provider: input.provider, outcome: 'mode_disabled' });
            return resultOf(plan);
        }
        if (isAboveClamp(mode, JOINER_MAX_MODE)) {
            // Loud, because a tenant configured above the ceiling and seeing
            // nothing happen deserves to find out why from a log rather than
            // from a starter who quietly never got an account.
            logger.warn('joiner pass held below the tenant’s configured mode', {
                component: 'identity-joiner-pass',
                tenantId: ctx.tenantId,
                provider: input.provider,
                configuredMode: mode,
                ceiling: JOINER_MAX_MODE,
            });
            recordJoinerPassOutcome({ provider: input.provider, outcome: 'mode_above_clamp' });
            return resultOf(plan);
        }

        await safeRecordPlan(ctx, input.provider, plan, {
            observedAddresses: observed.addresses.length,
            observedTruncated: observed.truncated,
            linkFreshnessMs: JOINER_LINK_FRESHNESS_MS,
        });
        recordJoinerPassOutcome({
            provider: input.provider,
            outcome: plan.refusal ? refusalOutcome(plan.refusal) : 'completed',
        });
        return resultOf(plan);
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        logger.error('joiner pass failed', {
            component: 'identity-joiner-pass',
            tenantId: input.tenantId,
            provider: input.provider,
            error: redactDirectoryIdentifiers(detail, null),
        });
        recordJoinerPassOutcome({ provider: input.provider, outcome: 'error' });
        await safeRecordErroredPass(ctx, input.provider, detail);
        return {
            status: 'ERROR',
            mode: 'unknown',
            refusal: null,
            detail,
            starters: 0,
            wouldCreate: 0,
            decisions: 0,
            errorMessage: detail,
        };
    }
}

/** The plan, as the job result. ONE derivation, so the row and the return agree. */
function resultOf(plan: JoinerPlan): JoinerPassResult {
    return {
        status: plan.refusal ? 'NOT_APPLICABLE' : 'PASSED',
        mode: plan.mode,
        refusal: plan.refusal,
        detail: plan.detail,
        starters: plan.starters,
        wouldCreate: plan.wouldCreate,
        decisions: plan.decisions.length,
    };
}

/** The metric label for a plan-level refusal. Exhaustive over the union by type. */
function refusalOutcome(
    refusal: JoinerPassRefusal,
):
    | 'no_starters'
    | 'no_department_map'
    | 'no_default_group'
    | 'batch_over_cap'
    | 'mode_disabled'
    | 'mode_above_clamp' {
    switch (refusal) {
        case 'MODE_DISABLED':
            return 'mode_disabled';
        case 'MODE_ABOVE_CLAMP':
            return 'mode_above_clamp';
        case 'NO_STARTERS':
            return 'no_starters';
        case 'NO_DEPARTMENT_MAP':
            return 'no_department_map';
        case 'NO_DEFAULT_GROUP':
            return 'no_default_group';
        case 'BATCH_OVER_CAP':
            return 'batch_over_cap';
    }
}

/**
 * The joiner passes this tenant has run, most recent first — the read half of
 * the record.
 *
 * Returns `resultJson` verbatim, because the per-starter decision list IS the
 * artefact and a summary of a summary would defeat the point of persisting one.
 */
export async function listJoinerPasses(ctx: RequestContext, options: { limit?: number } = {}) {
    return runInTenantContext(ctx, (db) =>
        db.integrationExecution.findMany({
            where: {
                tenantId: ctx.tenantId,
                automationKey: { endsWith: JOINER_PASS_AUTOMATION_SUFFIX },
            },
            select: {
                id: true,
                provider: true,
                status: true,
                executedAt: true,
                completedAt: true,
                resultJson: true,
            },
            orderBy: { executedAt: 'desc' },
            take: Math.min(options.limit ?? MAX_LISTED_PASSES, MAX_LISTED_PASSES),
        }),
    );
}
