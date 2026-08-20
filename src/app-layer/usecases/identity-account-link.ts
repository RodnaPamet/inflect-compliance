/**
 * Matching workers to their directory accounts, while both sides are healthy.
 *
 * ═══ WHY MATCHING HAPPENS HERE AND NOT AT TERMINATION ═══
 *
 * The leaver flow needs to answer "which directory accounts belong to the
 * person the HR feed just marked terminated?". The only bridge available
 * between `Employee` and `ConnectedIdentityAccount` today is the email address,
 * and email is precisely the attribute that stops being trustworthy at the
 * moment of termination: the mailbox gets converted to shared, the address gets
 * an `-ex` suffix or is released for reuse, the UPN changes, the HR row is
 * scrubbed for privacy.
 *
 * So the pairing is observed continuously, during syncs where nothing is
 * happening, and simply READ at termination. The disable path then acts on a
 * fact recorded when it was verifiable rather than one inferred under time
 * pressure on the unhappy path.
 *
 * ═══ EVERY AMBIGUITY RESOLVES TO NO LINK ═══
 *
 * This module writes a link only for an exact, case-normalised email match
 * against exactly one employee. It does not do fuzzy matching, name matching,
 * or "closest match" scoring, and it will not overwrite a link that points
 * somewhere else.
 *
 * That is not caution for its own sake. An incorrect link, under JML, disables
 * the wrong person's account — and does so with an audit trail asserting the
 * offboarding succeeded. A missing link is a refusal that someone can see and
 * fix. The two failure modes are not remotely symmetric, so every ambiguous
 * case is resolved toward the visible one.
 *
 * The corollary belongs to the caller and is stated here because it is the
 * whole point: the leaver path must treat a MISSING link as a refusal, never as
 * licence to fall back to matching by email in the moment. That fallback would
 * reintroduce the exact failure mode this module removes, on the one path where
 * nobody is watching.
 *
 * @module usecases/identity-account-link
 */
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { logger } from '@/lib/observability/logger';

/** Bound on the employee population read in one matching pass. */
const MAX_EMPLOYEES = 10_000;

/** Why an account could not be linked. Each wants a different response. */
export type UnresolvedReason =
    /** No employee holds this address — often a service or shared account. */
    | 'NO_EMPLOYEE'
    /** Two or more employee rows claim the address, so matching either is a guess. */
    | 'AMBIGUOUS_EMPLOYEE'
    /** The account is already linked to a DIFFERENT worker than the address implies. */
    | 'LINKED_ELSEWHERE';

export interface UnresolvedAccount {
    readonly connectedAccountId: string;
    readonly reason: UnresolvedReason;
}

/** Bound on the sample carried back. Enough to act on, not a second dataset. */
const MAX_UNRESOLVED_REPORTED = 50;

export interface LinkMatchResult {
    /** Links newly created in this pass. */
    readonly created: number;
    /** Existing links re-observed and re-stamped. */
    readonly verified: number;
    /**
     * Accounts that matched no employee, or matched one already linked to a
     * different worker. Reported rather than resolved — see the module note.
     */
    readonly unmatched: number;
    /**
     * WHICH accounts, and why — bounded.
     *
     * The count alone was unactionable: "37 unmatched" tells an operator
     * nothing about which accounts, and the three reasons below want different
     * responses. A leaver rollout is exactly when this matters, because an
     * account with no HR counterpart is one the offboarding will never disable,
     * and nobody would know which.
     *
     * Carries the ACCOUNT ID rather than the email address. The id identifies
     * the row for an operator who can look it up under tenant scope; the email
     * would put a person's address into a log line that is neither encrypted
     * nor tenant-scoped.
     */
    readonly unresolved: readonly UnresolvedAccount[];
    /** Existing links this pass DISPROVED and marked ineligible for writes. */
    readonly contradicted: number;
}

/** Normalised join key. Directory casing and HR casing routinely disagree. */
function emailKey(raw: string | null | undefined): string | null {
    const v = String(raw ?? '').trim().toLowerCase();
    return v.length > 0 ? v : null;
}

/**
 * Observe worker <-> account pairings for one provider and record them.
 *
 * Called after a CONFIRMED-COMPLETE directory enumeration. Running it on a
 * partial one would be harmless for links it creates (each is independently
 * verified) but the `unmatched` count would be meaningless, and that count is
 * the signal an operator uses to notice that half their directory has no HR
 * counterpart.
 */
export async function reconcileIdentityAccountLinks(
    ctx: RequestContext,
    provider: string,
    now: Date = new Date(),
): Promise<LinkMatchResult> {
    return runInTenantContext(ctx, async (db) => {
        // Two bounded reads, then all matching in memory. A per-account lookup
        // here would be an N+1 over the whole directory.
        const [employees, accounts] = await Promise.all([
            db.employee.findMany({
                where: { tenantId: ctx.tenantId },
                select: { id: true, workEmail: true },
                take: MAX_EMPLOYEES,
            }),
            db.connectedIdentityAccount.findMany({
                where: { tenantId: ctx.tenantId, provider },
                select: { id: true, email: true },
                take: MAX_EMPLOYEES,
            }),
        ]);

        // An email shared by two employee rows is not a match, it is a data
        // problem. Mapping it to either row would be a coin flip that later
        // disables someone.
        const byEmail = new Map<string, string | null>();
        for (const e of employees) {
            const key = emailKey(e.workEmail);
            if (!key) continue;
            byEmail.set(key, byEmail.has(key) ? null : e.id);
        }

        const existing = await db.identityAccountLink.findMany({
            where: { tenantId: ctx.tenantId, connectedAccountId: { in: accounts.map((a) => a.id) } },
            select: { connectedAccountId: true, employeeId: true },
            take: MAX_EMPLOYEES,
        });
        const linkedTo = new Map(existing.map((l) => [l.connectedAccountId, l.employeeId]));

        const toCreate: Array<{
            tenantId: string;
            employeeId: string;
            connectedAccountId: string;
            matchMethod: 'EMAIL_EXACT';
            lastVerifiedAt: Date;
        }> = [];
        const toVerify: string[] = [];
        /**
         * Accounts whose link this pass DISPROVED — the email now resolves to a
         * different worker, to none, or ambiguously.
         *
         * Refusing to re-point such a link was always right. Leaving it
         * otherwise untouched was not: `lastVerifiedAt` is only ever set to
         * `now` and never cleared, so a disproven pairing kept a recent stamp
         * and stayed eligible for a leaver disable for the rest of its
         * freshness window. The freshness filter was a bound on how long ago
         * the link was last true, not a witness that it still is.
         */
        const contradicted: string[] = [];
        const unresolved: UnresolvedAccount[] = [];
        let unmatched = 0;
        const noteUnresolved = (connectedAccountId: string, reason: UnresolvedReason): void => {
            unmatched += 1;
            if (unresolved.length < MAX_UNRESOLVED_REPORTED) {
                unresolved.push({ connectedAccountId, reason });
            }
        };

        for (const account of accounts) {
            const key = emailKey(account.email);
            const employeeId = key ? byEmail.get(key) : undefined;

            // No match, or an email claimed by more than one employee row.
            if (!employeeId) {
                // Only a contradiction if a link EXISTS to contradict. An
                // unlinked account matching nothing is just an unlinked
                // account — a service account, most often.
                if (linkedTo.has(account.id)) contradicted.push(account.id);
                // `byEmail` holds null for an address two employees claim, and
                // is simply absent for one nobody holds. The two look identical
                // downstream and are not: one is a data problem to fix, the
                // other is usually a service account to exclude.
                noteUnresolved(account.id, key && byEmail.has(key) ? 'AMBIGUOUS_EMPLOYEE' : 'NO_EMPLOYEE');
                continue;
            }

            const current = linkedTo.get(account.id);
            if (current === employeeId) {
                toVerify.push(account.id);
                continue;
            }
            if (current !== undefined) {
                // Already linked to a DIFFERENT worker. Silently re-pointing it
                // would move a future disable from one person to another, so
                // the link is left pointing where it does — but it is now
                // MARKED, because a pairing this pass actively disproved must
                // not keep driving writes on the strength of an old stamp.
                contradicted.push(account.id);
                noteUnresolved(account.id, 'LINKED_ELSEWHERE');
                continue;
            }
            toCreate.push({
                tenantId: ctx.tenantId,
                employeeId,
                connectedAccountId: account.id,
                matchMethod: 'EMAIL_EXACT',
                lastVerifiedAt: now,
            });
        }

        // `skipDuplicates` covers the race with a concurrent pass for the same
        // tenant: the unique on connectedAccountId is the real arbiter, and
        // losing that race is a no-op rather than an error.
        const created = toCreate.length
            ? (await db.identityAccountLink.createMany({ data: toCreate, skipDuplicates: true })).count
            : 0;

        const verified = toVerify.length
            ? (
                  await db.identityAccountLink.updateMany({
                      where: { tenantId: ctx.tenantId, connectedAccountId: { in: toVerify } },
                      // Re-confirmation CLEARS a previous contradiction: the
                      // evidence that disproved it has itself been superseded.
                      data: { lastVerifiedAt: now, contradictedAt: null },
                  })
              ).count
            : 0;

        // Marked, not deleted. The link is the record of a pairing we once had
        // good reason to believe, and an auditor asking "why was this account
        // treated as this person's?" needs it to still exist.
        const marked = contradicted.length
            ? (
                  await db.identityAccountLink.updateMany({
                      where: {
                          tenantId: ctx.tenantId,
                          connectedAccountId: { in: contradicted },
                          contradictedAt: null,
                      },
                      data: { contradictedAt: now },
                  })
              ).count
            : 0;

        logger.info('identity account links reconciled', {
            component: 'identity-account-link',
            tenantId: ctx.tenantId,
            provider,
            created,
            verified,
            unmatched,
            marked,
            // A breakdown rather than the ids, which would make a routine log
            // line unbounded. The ids travel in the RESULT, for a caller that
            // means to act on them.
            unresolvedByReason: unresolved.reduce<Record<string, number>>((acc, u) => {
                acc[u.reason] = (acc[u.reason] ?? 0) + 1;
                return acc;
            }, {}),
        });

        return { created, verified, unmatched, contradicted: marked, unresolved };
    });
}
