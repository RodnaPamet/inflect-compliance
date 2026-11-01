/**
 * Who each leaver-pass decision is about (#4875).
 *
 * A pass records its decisions by `linkId` — an `IdentityAccountLink` id — and
 * the passes page printed that id, a cuid, in a code font. An Owner reading
 * what a dry run would disable could not tell whose account it was, which is
 * the one thing the dry-run review exists for. This resolves the ids on the
 * page to the person HR holds and the account the directory holds.
 *
 * Read on the passes route, which is `admin.tenant_lifecycle` (Owner-only):
 * the report already names which of a customer's people the product would
 * disable, so naming them is no wider than the report itself.
 *
 * A link that no longer exists resolves to nothing, and the page says so; it
 * is never guessed from the decision's other fields.
 *
 * @module usecases/identity-pass-accounts
 */
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';

/** At most this many distinct links are resolved for one page. */
export const MAX_RESOLVED_LINKS = 5000;

export interface PassAccount {
    /** The person, as HR names them. */
    name: string | null;
    /** The directory account's address, else the person's work email. */
    email: string | null;
}

/** The distinct `linkId`s named by the decisions in these passes' results. */
export function decisionLinkIds(passes: ReadonlyArray<{ resultJson: unknown }>): string[] {
    const ids = new Set<string>();
    for (const pass of passes) {
        const decisions = (pass.resultJson as { decisions?: unknown } | null)?.decisions;
        if (!Array.isArray(decisions)) continue;
        for (const d of decisions) {
            const linkId = (d as { linkId?: unknown } | null)?.linkId;
            if (typeof linkId === 'string' && linkId) ids.add(linkId);
            if (ids.size >= MAX_RESOLVED_LINKS) return [...ids];
        }
    }
    return [...ids];
}

export async function resolvePassAccounts(
    ctx: RequestContext,
    linkIds: readonly string[],
): Promise<Record<string, PassAccount>> {
    const ids = [...new Set(linkIds)].slice(0, MAX_RESOLVED_LINKS);
    if (ids.length === 0) return {};
    const links = await runInTenantContext(ctx, (db) =>
        db.identityAccountLink.findMany({
            where: { tenantId: ctx.tenantId, id: { in: ids } },
            select: {
                id: true,
                employee: { select: { fullName: true, workEmail: true } },
                connectedAccount: { select: { email: true } },
            },
            take: ids.length,
        }),
    );
    const out: Record<string, PassAccount> = {};
    for (const link of links) {
        out[link.id] = {
            name: link.employee?.fullName || null,
            email: link.connectedAccount?.email || link.employee?.workEmail || null,
        };
    }
    return out;
}
