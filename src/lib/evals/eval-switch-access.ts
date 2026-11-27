/**
 * Who may switch the LLM evaluation nightlies (owner decision 2026-11-27).
 * Two conditions, both asked on the server:
 *
 *   1. The caller is an ORG_OWNER of the organization the request names: the
 *      org permission `canSwitchEvalNightlies`, which only ORG_OWNER holds.
 *      The route's `requireOrgPermission` asks it (and audits a refusal); the
 *      usecase asks it again.
 *   2. That organization is an OPERATOR organization, named in the operator
 *      variable `EVALS_SWITCH_ORG_SLUGS` (comma-separated slugs). Unset or
 *      empty names none, so nobody can switch: an ALLOWLIST, the opposite of
 *      the card's visibility list, because a nightly spends the platform's
 *      money and its switch must be granted, never inherited by a new
 *      organization.
 *
 * Everybody else who sees the card reads the state and cannot change it.
 *
 * The usecase reads the variable from `@/env` and passes the raw string here;
 * this module imports nothing server-only, so the decision is a pure function
 * a unit test can hold.
 */
import { parseEvalsCardOrgSlugs } from '@/lib/evals/evals-card-visibility';

/** Why a caller may not switch; `null` when they may. */
export type EvalSwitchRefusal = 'NOT_ORG_OWNER' | 'NOT_OPERATOR_ORG';

/** `" a, b ,,c "` → `{a, b, c}`. Unset or blank → the empty set: nobody switches. */
export function parseEvalsSwitchOrgSlugs(raw: string | null | undefined): ReadonlySet<string> {
    // The same parse as the card's opt-out list, so both variables read alike.
    return parseEvalsCardOrgSlugs(raw);
}

export function evalSwitchRefusal(input: {
    orgSlug: string;
    canSwitchEvalNightlies: boolean;
    operatorOrgs: string | null | undefined;
}): EvalSwitchRefusal | null {
    if (!input.canSwitchEvalNightlies) return 'NOT_ORG_OWNER';
    if (!parseEvalsSwitchOrgSlugs(input.operatorOrgs).has(input.orgSlug)) return 'NOT_OPERATOR_ORG';
    return null;
}
