/**
 * THE TARGET POPULATIONS — the named, code-defined sets of rows an agent may
 * address with an external write (#3051 step 5c, part of #2861's ladder).
 *
 * ═══ WHAT A TARGET IS, AND WHY IT IS NOT A VALUE ═══
 *
 * Step 5b opened VALUE fields: the agent chooses an argument within a typed
 * constraint — a regex, an enum, a range, a length. That works because the thing
 * being bounded is a FORMAT, and a reviewer can read a format.
 *
 * A TARGET is the argument that says WHICH ROW the write is about, and a format
 * is the wrong bound for it. Issue #3051's decision 1 says so in the owner's own
 * terms: approving `^[0-9]+$` on an employee number approves EVERY employee, and
 * a reviewer looking at that pattern is unlikely to see it. So the target is
 * bounded by DATA — the agent may address a row only if our own data currently
 * says that row is in a named population.
 *
 * ═══ WHY A CODE-DEFINED REGISTRY AND NOT A SAVED QUERY ═══
 *
 * The owner ruled this on 2026-10-02, and the argument is the one that killed
 * the regex: an operator-authored query has exactly the property that made a
 * pattern unreviewable. A saved query reading "every row in the roster" is one
 * clause away from a narrow-looking one, and it is read by the same reviewer
 * with the same eye. Decision 1's strength is that the bound is a FACT about the
 * data; an authored predicate is a fact about a predicate.
 *
 * A registry entry can be widened only by changing this file, which somebody
 * reviews, so the accepted cost is stated plainly: A NEW POPULATION NEEDS A
 * DEPLOY, NOT A CONSOLE ACTION. That is the whole trade, and it is the same one
 * the identity ladder already made — `identity-leaver-pass.ts` reaches
 * `AUTOMATIC` over `where: { tenantId, status: 'TERMINATED' }`, code-defined,
 * row-capped and deploy-gated, and the rails around it are the protection.
 *
 * ═══ WHAT EVERY ENTRY OWES ═══
 *
 *   · TENANT SCOPE through `runInTenantContext` — never a global read. The whole
 *     claim of a population is "this tenant's data says so", and a read outside
 *     a tenant context is one RLS does not constrain.
 *   · A BOUND, stated in `bound` in words a reviewer can check against the code
 *     beside it. A registry whose resolver can return every row is the
 *     saved-query problem with extra steps.
 *   · THE IDENTIFYING VALUES ONLY. A resolver returns strings, never rows: the
 *     caller needs membership, and a population that handed back records would
 *     invite a second, unreviewed use of them.
 *
 * ═══ WHY THE WHOLE SET AND NOT A MEMBERSHIP PROBE ═══
 *
 * `findFirst({ where: { ...population, workEmail: supplied } })` would answer
 * membership in one indexed read and never materialise anything. It is rejected
 * because it cannot tell the three outcomes apart that the dispatch has to
 * separate: a value outside the population, an EMPTY population, and a
 * population too large to be a bound. The second is the dangerous one — an empty
 * population means the data moved and the template is now inert, which an
 * operator must be TOLD rather than left to infer from a value-shaped refusal.
 *
 * ═══ AND WHY A FULL CAP REFUSES RATHER THAN TRUNCATES ═══
 *
 * At exactly `MAX_POPULATION_ROWS` rows, "the supplied value is not in the set"
 * and "the supplied value is past the cap" are indistinguishable. Returning the
 * truncated set would answer the question with the wrong one of those, so a
 * resolution that hits the cap is `too_large` and the dispatch refuses. A probe
 * that could not look must not report "nothing".
 */
import type { RequestContext } from '@/app-layer/types';
import { runInTenantContext } from '@/lib/db-context';
import { OBSERVATION_FRESHNESS_MS } from '@/app-layer/usecases/identity-write-target';

/**
 * The most rows any population may contain and still be usable as a bound.
 *
 * The leaver pass's number, deliberately: it reads `Employee` with `take: 5000`
 * and says "past this, the roster is not a departure wave". The same reasoning
 * applies to a bound — a set of 5000 identifiers is already far wider than
 * anything a reviewer gauged when they approved the template, and a set larger
 * than that is not functioning as a bound at all.
 *
 * It is a REFUSAL threshold, not a page size. See the header.
 */
export const MAX_POPULATION_ROWS = 5000;

/**
 * The freshness window on an OBSERVED external account.
 *
 * An alias of the identity subsystem's bound rather than a second number, for
 * the reason `LEAVER_MAX_MODE`'s own alias gives: two bounds that both ask "did
 * the daily sync refresh this row recently enough" and disagree would admit a
 * target the write-target rail would then refuse, having done the work.
 */
export const POPULATION_OBSERVATION_FRESHNESS_MS = OBSERVATION_FRESHNESS_MS;

/** One named population. */
export interface TargetPopulationEntry {
    /**
     * The stable key a template stores in `targetPopulation`.
     *
     * STABLE is load-bearing: it is written into rows, so renaming one orphans
     * every template that names it. An orphan fails CLOSED (`unknown_key`), so a
     * rename is safe but not free — it silently disables a template until
     * somebody re-proposes it through four eyes.
     */
    key: string;
    /** What the population IS, for the operator choosing one. */
    description: string;
    /**
     * What BOUNDS it — every clause, in words, so a reviewer can check this
     * sentence against the resolver directly below it. A bound that is not
     * written down is a bound the next reader has to reconstruct.
     */
    bound: string;
    /**
     * The identifying values, for ONE tenant, at most `limit` of them.
     *
     * Returns raw strings including any duplicates: the caller de-duplicates,
     * and the raw length is what says whether the ROW cap was reached.
     */
    resolve(ctx: RequestContext, limit: number): Promise<string[]>;
}

/**
 * THE REGISTRY. Adding an entry is a reviewed code change; that is the point.
 *
 * The three entries here are the populations that ALREADY EXIST — the leaver
 * pass's `TERMINATED` roster, projected onto the three identifiers this product
 * already treats as addressable — rather than invented ones. A fourth is a
 * deploy away and should state its bound the same way.
 */
export const TARGET_POPULATIONS: Readonly<Record<string, TargetPopulationEntry>> = {
    /**
     * The population the leaver pass acts on, addressed by work email.
     *
     * `workEmail` is NOT NULL on `Employee`, so this returns one value per
     * terminated worker and never silently drops rows — which matters, because a
     * population that quietly omitted some of its members would refuse a
     * legitimate target and read as the agent getting the id wrong.
     */
    terminated_employee_work_emails: {
        key: 'terminated_employee_work_emails',
        description:
            'The work email of every worker the HR feed marks TERMINATED in this workspace.',
        bound:
            'Tenant-scoped through runInTenantContext (RLS); status = TERMINATED, which is ' +
            'asserted by the feed and never inferred from absence; at most MAX_POPULATION_ROWS ' +
            'rows, and a resolution that reaches that cap refuses rather than truncating.',
        async resolve(ctx, limit) {
            const rows = await runInTenantContext(ctx, (db) =>
                db.employee.findMany({
                    where: { tenantId: ctx.tenantId, status: 'TERMINATED' },
                    select: { workEmail: true },
                    take: limit,
                }),
            );
            return rows.map((r) => r.workEmail);
        },
    },

    /**
     * The same workers, addressed by the HRIS's OWN row id.
     *
     * `hrisRecordId` is the handle an HRIS update API takes as the subject of a
     * write, and its docstring is emphatic that a reader must treat null as "no
     * handle, refuse" and must NEVER fall back to `externalId` or `workEmail`.
     * So the `not: null` filter is that rule, not a convenience: a terminated
     * worker with no handle is simply NOT in this population, and the agent is
     * refused rather than addressed by the wrong column.
     */
    terminated_employee_hris_record_ids: {
        key: 'terminated_employee_hris_record_ids',
        description:
            "The HRIS record id of every TERMINATED worker that has one — the handle an HRIS " +
            'update API takes as the subject of a write.',
        bound:
            'Tenant-scoped through runInTenantContext (RLS); status = TERMINATED; ' +
            'hrisRecordId IS NOT NULL, because a worker with no handle must be refused rather ' +
            'than addressed by another column; at most MAX_POPULATION_ROWS rows, refusing at ' +
            'the cap.',
        async resolve(ctx, limit) {
            const rows = await runInTenantContext(ctx, (db) =>
                db.employee.findMany({
                    where: {
                        tenantId: ctx.tenantId,
                        status: 'TERMINATED',
                        hrisRecordId: { not: null },
                    },
                    select: { hrisRecordId: true },
                    take: limit,
                }),
            );
            // Narrowed rather than asserted: the `not: null` filter is the
            // control, and a `!` here would be a second claim about it that the
            // compiler cannot check against the query.
            return rows.flatMap((r) => (r.hrisRecordId === null ? [] : [r.hrisRecordId]));
        },
    },

    /**
     * The leaver pass's own CANDIDATE set for Entra, addressed by the directory
     * identifier — the narrowest of the three and the one that shows a bound
     * can be more than a row cap.
     *
     * Four clauses beyond the status, each lifted from `findLeaverCandidates`
     * rather than invented:
     *
     *   · `lastVerifiedAt >= now - freshness` — we have OBSERVED this account
     *     recently. A link is not evidence that a pairing is still true, only a
     *     bound on how long ago it was.
     *   · `contradictedAt: null` — a link the reconciler has DISPROVED is out
     *     regardless of freshness.
     *   · `connectedAccount.isProtected = false` — the account-protection flag,
     *     which exists so a named account is never written to by automation.
     *   · `provider = 'entra-id'` — a population of mixed-provider identifiers
     *     would widen the admissible value set for a tool that addresses one
     *     directory. A second provider is a second ENTRY, not a wider one.
     */
    terminated_employee_entra_account_ids: {
        key: 'terminated_employee_entra_account_ids',
        description:
            'The Entra object id of every recently-observed, unprotected directory account ' +
            'linked to a TERMINATED worker in this workspace.',
        bound:
            'Tenant-scoped through runInTenantContext (RLS); the linked employee is ' +
            'TERMINATED; the link was re-observed within ' +
            'POPULATION_OBSERVATION_FRESHNESS_MS; the link has not been contradicted by the ' +
            'reconciler; the account is not flagged isProtected; the provider is entra-id ' +
            'alone; at most MAX_POPULATION_ROWS rows, refusing at the cap.',
        async resolve(ctx, limit) {
            const freshSince = new Date(Date.now() - POPULATION_OBSERVATION_FRESHNESS_MS);
            const rows = await runInTenantContext(ctx, (db) =>
                db.identityAccountLink.findMany({
                    where: {
                        tenantId: ctx.tenantId,
                        lastVerifiedAt: { gte: freshSince },
                        contradictedAt: null,
                        employee: { status: 'TERMINATED' },
                        connectedAccount: { provider: 'entra-id', isProtected: false },
                    },
                    select: { connectedAccount: { select: { externalUserId: true } } },
                    take: limit,
                }),
            );
            // Optional-chained although the relation is REQUIRED in the schema,
            // for the reason `findStrandedLinkIds` gives about the same two hops:
            // a value that decides whether a write may be addressed should land
            // on "not in the population" if a hop is missing under some RLS
            // configuration, not on a TypeError.
            return rows.flatMap((r) =>
                r.connectedAccount?.externalUserId ? [r.connectedAccount.externalUserId] : [],
            );
        },
    },
};

/** Every key, for an operator-facing list and for the save-time refusal. */
export function targetPopulationKeys(): string[] {
    return Object.keys(TARGET_POPULATIONS).sort();
}

/** Is this a population this build defines? The save-time gate's question. */
export function isTargetPopulationKey(key: unknown): key is string {
    return typeof key === 'string' && Object.hasOwn(TARGET_POPULATIONS, key);
}

/**
 * What a dispatch learns when it asks for a population.
 *
 * FIVE outcomes, not a nullable set, for the same reason `parseOpenFields`
 * returns a discriminated result: every one of these refuses, and they refuse
 * for reasons an operator fixes differently. Collapsing `empty` into "your value
 * is not in the set" would tell the one person who can fix a stale feed that the
 * agent chose badly.
 */
export type TargetPopulationResolution =
    | { state: 'ok'; key: string; values: ReadonlySet<string> }
    /** No entry by that name in THIS build — a renamed or removed population. */
    | { state: 'unknown_key'; key: string }
    /** Resolved, and there is nothing in it. The template is inert. */
    | { state: 'empty'; key: string }
    /** Past the cap, so membership cannot be decided. See the header. */
    | { state: 'too_large'; key: string; cap: number }
    /** The read itself failed. NOT "nothing matched". */
    | { state: 'unresolvable'; key: string; detail: string };

/**
 * Resolve a population AT DISPATCH.
 *
 * At dispatch and never at approval, because a population is DATA and data
 * moves: a set resolved when the template was approved would be a snapshot
 * presented as a live bound, and the first row to leave the population would
 * still be addressable. That is the opposite of what step 5c is for.
 *
 * Every non-`ok` state is a refusal at the caller. Nothing here sends anything,
 * and a resolver that throws becomes `unresolvable` with the cause named rather
 * than an unlabelled rejection — a broken read must not be indistinguishable
 * from a bound that did its job.
 */
export async function resolveTargetPopulation(
    ctx: RequestContext,
    key: string,
): Promise<TargetPopulationResolution> {
    if (!isTargetPopulationKey(key)) return { state: 'unknown_key', key };
    const entry = TARGET_POPULATIONS[key];

    let raw: string[];
    try {
        // `+ 1`, so reaching the cap is DETECTABLE. `take: MAX` returns exactly
        // MAX both when the population is that size and when it is larger, and
        // the two cannot be told apart afterwards.
        raw = await entry.resolve(ctx, MAX_POPULATION_ROWS + 1);
    } catch (err) {
        return {
            state: 'unresolvable',
            key,
            detail: err instanceof Error ? err.message : String(err),
        };
    }

    if (raw.length > MAX_POPULATION_ROWS) {
        return { state: 'too_large', key, cap: MAX_POPULATION_ROWS };
    }
    if (raw.length === 0) return { state: 'empty', key };
    return { state: 'ok', key, values: new Set(raw) };
}
