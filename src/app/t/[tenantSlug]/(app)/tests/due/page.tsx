import { redirect } from 'next/navigation';

/**
 * `/tests/due` compatibility shim — U3 (Tests roadmap).
 *
 * The due QUEUE is now a filter on the `/tests` list. `next7d` mirrors
 * `getDueQueue`'s predicate exactly — ACTIVE, and min(nextDueAt, nextRunAt)
 * at or before now + 7 days — so the same set of plans the standalone page
 * showed is one click away without leaving the register.
 *
 * The page owned two write affordances, and both had to land somewhere before
 * this could be retired:
 *   • the per-row "Run now" is now a row action on the list, offered under the
 *     same conditions (due, no run already open, canWrite);
 *   • the header "Run due planning" is a bulk sweep, not a per-plan action —
 *     see the note in `tests/page.tsx` on where it went.
 *
 * A redirect rather than a deletion, so bookmarks, notification links and E2E
 * `page.goto` keep working. Mirrors the canonical shim pattern
 * (`/tasks/dashboard`, `/audits/new`, `/tasks/new`).
 *
 * The filter is pre-applied: landing on an unfiltered register would silently
 * answer a different question than the one the link was for.
 */
export default async function TestsDueRedirect({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    redirect(`/t/${tenantSlug}/tests?due=next7d`);
}
