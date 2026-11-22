/**
 * Who sees the organization settings page's "Evaluations" card (owner
 * decisions 2026-11-12). Two gates, both asked on the server:
 *
 *   1. The viewer administers the organization (`isOrgAdminTier`: an owner or
 *      an admin). A reader of the page does not see it.
 *   2. The organization is NOT named in the operator variable
 *      `EVALS_CARD_HIDDEN_ORG_SLUGS` (comma-separated slugs). Every
 *      organization shows the card by default, a new one included; an
 *      organization that opts out is added to the list. Unset or empty hides
 *      it nowhere.
 *
 * The list is an opt-OUT on purpose. The owner's decision is "every
 * organization by default, remove the ones that opt out", and an allowlist of
 * every organization would need editing each time one is created, so the
 * default would silently stop holding for the newest organizations.
 *
 * The page reads the variable from `@/env` and passes the raw string here;
 * this module imports nothing server-only, so the decision is a pure function
 * a unit test can hold, and the client receives only the boolean.
 */
import type { OrgRole } from '@prisma/client';

import { isOrgAdminTier } from '@/lib/org-roles';

/** `" a, b ,,c "` → `{a, b, c}`. Unset or blank → the empty set. */
export function parseEvalsCardOrgSlugs(raw: string | null | undefined): ReadonlySet<string> {
    if (!raw) return new Set();
    return new Set(
        raw
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0),
    );
}

export function evalsCardVisible(input: {
    orgSlug: string;
    orgRole: OrgRole | string | null | undefined;
    hiddenIn: string | null | undefined;
}): boolean {
    if (!isOrgAdminTier(input.orgRole)) return false;
    return !parseEvalsCardOrgSlugs(input.hiddenIn).has(input.orgSlug);
}
