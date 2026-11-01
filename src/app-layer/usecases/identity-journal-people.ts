/**
 * Whose account each identity write journal entry is about, and who made it
 * (#4877).
 *
 * The journal named an entry's account by nothing at all — the row carries a
 * `linkId`, and the page printed provider, action, status, time and the actor's
 * raw user id. A history of disabled accounts that does not name the accounts
 * cannot answer "was Jane disabled?", which is the question somebody brings to
 * it. This resolves the entries on the page to the person HR holds and the
 * account the directory holds (through `resolvePassAccounts`, as the leaver
 * passes do), and each actor to the member's name.
 *
 * Read on the journal routes, which are `admin.tenant_lifecycle` (Owner-only):
 * an entry already names a change made to one of a customer's people's
 * accounts, so naming the person is no wider than the entry itself. It writes
 * nothing, and reads no `externalUserId`, `detail` or captured state.
 *
 * An actor who has since left the workspace has no membership to read, and is
 * named as a former member — never guessed from another tenant's records.
 *
 * @module usecases/identity-journal-people
 */
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { resolvePassAccounts, type PassAccount } from './identity-pass-accounts';

/** At most this many distinct actors are resolved for one page. */
export const MAX_RESOLVED_ACTORS = 500;

export interface JournalActor {
    name: string | null;
    email: string | null;
}

export interface JournalPeople {
    /** By `linkId`. */
    accounts: Record<string, PassAccount>;
    /** By `actorUserId`. */
    actors: Record<string, JournalActor>;
}

export async function readJournalPeople(
    ctx: RequestContext,
    entries: ReadonlyArray<{ readonly linkId: string | null; readonly actorUserId: string | null }>,
): Promise<JournalPeople> {
    const linkIds = entries.map((e) => e.linkId).filter((id): id is string => !!id);
    const actorIds = [
        ...new Set(entries.map((e) => e.actorUserId).filter((id): id is string => !!id)),
    ].slice(0, MAX_RESOLVED_ACTORS);

    const [accounts, members] = await Promise.all([
        resolvePassAccounts(ctx, linkIds),
        actorIds.length === 0
            ? Promise.resolve([])
            : runInTenantContext(ctx, (db) =>
                  db.tenantMembership.findMany({
                      where: { tenantId: ctx.tenantId, userId: { in: actorIds } },
                      select: { userId: true, user: { select: { name: true, email: true } } },
                      take: actorIds.length,
                  }),
              ),
    ]);

    const actors: Record<string, JournalActor> = {};
    for (const m of members) {
        actors[m.userId] = { name: m.user?.name || null, email: m.user?.email || null };
    }
    return { accounts, actors };
}
