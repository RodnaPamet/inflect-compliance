/**
 * Whether the agent behaviour fingerprint runs for a tenant, and whether it may
 * latch — pure, so the rule is testable without an environment.
 *
 * OFF BY DEFAULT, with two keys (master roadmap G9): the operator's
 * `AGENT_BEHAVIOUR_DETECTOR` AND the tenant named in
 * `AGENT_BEHAVIOUR_DETECTOR_TENANTS`. Either absent is off; a value that is not
 * exactly '1' or 'true' (case-insensitive, trimmed) is off — a typo is a veto,
 * never a start. There is no wildcard: a deployment that wants every tenant
 * names every tenant, which is the record of who it was turned on for.
 *
 * The latch is a THIRD key, `AGENT_BEHAVIOUR_DETECTOR_LATCH`, read only for a
 * tenant the first two already admitted. A threshold-B day without it raises
 * the finding and does not stop the agent.
 */
import { profileTenantAllowlist } from './agent-switches';

export type BehaviourDetectorBasis =
    | 'ON'
    | 'DEPLOYMENT_OFF'
    | 'TENANT_NOT_NAMED';

export interface BehaviourDetectorDecision {
    readonly on: boolean;
    readonly basis: BehaviourDetectorBasis;
    /** Whether threshold B may latch the breaker. Always false when `on` is false. */
    readonly latch: boolean;
}

function strictlyOn(raw: string | null | undefined): boolean {
    if (typeof raw !== 'string') return false;
    const v = raw.trim().toLowerCase();
    return v === '1' || v === 'true';
}

export function behaviourDetectorDecisionFor(input: {
    readonly detector: string | null | undefined;
    readonly tenants: string | null | undefined;
    readonly latch: string | null | undefined;
    readonly tenantSlug: string | null | undefined;
}): BehaviourDetectorDecision {
    if (!strictlyOn(input.detector)) return { on: false, basis: 'DEPLOYMENT_OFF', latch: false };
    const slug = typeof input.tenantSlug === 'string' ? input.tenantSlug.trim().toLowerCase() : '';
    if (slug === '' || !profileTenantAllowlist(input.tenants).has(slug)) {
        return { on: false, basis: 'TENANT_NOT_NAMED', latch: false };
    }
    return { on: true, basis: 'ON', latch: strictlyOn(input.latch) };
}

/** The slugs the operator named — the scheduled sweep's whole population. */
export function behaviourDetectorTenantSlugs(input: {
    readonly detector: string | null | undefined;
    readonly tenants: string | null | undefined;
}): readonly string[] {
    if (!strictlyOn(input.detector)) return [];
    return [...profileTenantAllowlist(input.tenants)].sort();
}
