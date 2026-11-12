/**
 * AI Guard — composing providers WORST-OF (NeMo Guardrails roadmap, Phase 1.1).
 *
 * Every provider scans the same content and the composed verdict is the worst
 * any of them returned: `malicious` beats `suspicious` beats `clean`. Because
 * `resolveEnforcement` is monotone in the verdict for a fixed mode and
 * direction, the worst verdict is also the worst ACTION — block beats flag
 * beats allow — so a second slice can only ever tighten the guard (G4). There
 * is no vote, no weighting and no "the other provider was confident": one
 * provider's block is the guard's block.
 *
 * Four rules here are each one careless edit from being undone:
 *
 *   - **One provider is passed through untouched.** The composed result for a
 *     single provider is that provider's own `ScanResult` object, so the
 *     patterns-only guard (every deployment without `AI_GUARD_NEMO_BASE_URL`)
 *     is byte-identical to the guard before the seam.
 *   - **A provider that fails is unavailable, never clean.** A throw, a
 *     rejection or a result whose verdict is not in the vocabulary becomes
 *     `providerUnavailable(...)`: `suspicious` on input (the policy turns that
 *     into `flag`) and `malicious` on egress (`block`). Unscanned is not clean
 *     (G9) — the same rule `egr.unscanned.depth_exceeded` holds one layer down.
 *   - **No providers is no scan.** An empty provider list composes to the
 *     unavailable verdict, not to `clean`: a guard that consulted nobody has
 *     vouched for nothing (zero is never complete).
 *   - **Rule ids say who decided.** A non-patterns provider's rule ids are
 *     namespaced by its id (`nemo.rail.jailbreak_heuristics`), so the ids the
 *     decision log already records name the provider, with no schema change.
 *     `decidedBy` names the provider(s) whose verdict the composed verdict is.
 */
import type { GuardSeverity } from '../patterns';
import type { GuardVerdict, ScanResult } from '../injection-scanner';
import { PATTERNS_PROVIDER_ID } from './patterns-provider';
import { GUARD_VERDICTS, type GuardProvider, type GuardProviderContext, type GuardScanKind } from './types';

/** Rule-id prefix for "this provider could not give a verdict". The provider id follows. */
export const GUARD_PROVIDER_UNAVAILABLE_RULE = 'guard.provider_unavailable';

/** The provider "id" an empty provider list is recorded under. */
export const NO_GUARD_PROVIDER_ID = 'none';

const VERDICT_RANK: Record<GuardVerdict, number> = { clean: 0, suspicious: 1, malicious: 2 };
const SEVERITY_RANK: Record<GuardSeverity, number> = { low: 0, medium: 1, high: 2 };

/**
 * The verdict for a provider that could not scan.
 *
 * Input: `suspicious` — the policy resolves it to `flag` under strict and
 * balanced, so the content forces human review and is never auto-committed.
 * Egress: `malicious` — resolves to `block` under strict and balanced, because
 * content that might carry a secret must not leave on the strength of a check
 * that never ran. Audit mode still records rather than enforces, as it does
 * for every verdict: that mode is the tenant's deliberate opt-in, and the
 * verdict itself is never `clean`.
 */
export function providerUnavailable(providerId: string, kind: GuardScanKind): ScanResult {
    const ruleIds = [`${GUARD_PROVIDER_UNAVAILABLE_RULE}.${providerId}`];
    return kind === 'egress'
        ? { verdict: 'malicious', ruleIds, maxSeverity: 'high' }
        : { verdict: 'suspicious', ruleIds, maxSeverity: 'medium' };
}

export interface ComposedScan {
    /** The worst-of result, in the scanner's own shape. */
    readonly scan: ScanResult;
    /** Ids of the providers whose verdict IS the composed verdict, in list order. */
    readonly decidedBy: readonly string[];
    /** How many providers were consulted. `GuardOutcome.decidedBy` is recorded only above one. */
    readonly providerCount: number;
}

function isScanResult(value: unknown): value is ScanResult {
    if (!value || typeof value !== 'object') return false;
    const v = value as { verdict?: unknown; ruleIds?: unknown };
    return (
        typeof v.verdict === 'string' &&
        (GUARD_VERDICTS as readonly string[]).includes(v.verdict) &&
        Array.isArray(v.ruleIds) &&
        v.ruleIds.every((id) => typeof id === 'string')
    );
}

async function scanOne(
    provider: GuardProvider,
    kind: GuardScanKind,
    content: unknown,
    ctx: GuardProviderContext,
): Promise<ScanResult> {
    try {
        const result: unknown = await provider.scan(kind, content, ctx);
        return isScanResult(result) ? result : providerUnavailable(provider.id, kind);
    } catch {
        return providerUnavailable(provider.id, kind);
    }
}

function namespaced(providerId: string, ruleIds: readonly string[]): string[] {
    if (providerId === PATTERNS_PROVIDER_ID) return [...ruleIds];
    const prefix = `${providerId}.`;
    return ruleIds.map((id) =>
        id.startsWith(prefix) || id.startsWith(`${GUARD_PROVIDER_UNAVAILABLE_RULE}.`) ? id : `${prefix}${id}`,
    );
}

/**
 * Worst-of over already-collected provider results. Pure; exported so the
 * composition table can be tested without a provider.
 */
export function worstOf(results: readonly { providerId: string; scan: ScanResult }[]): ComposedScan {
    if (results.length === 1) {
        // Passed through untouched — the byte-identity rule.
        const only = results[0];
        const scan =
            only.providerId === PATTERNS_PROVIDER_ID
                ? only.scan
                : { ...only.scan, ruleIds: namespaced(only.providerId, only.scan.ruleIds) };
        return { scan, decidedBy: [only.providerId], providerCount: 1 };
    }

    let verdict: GuardVerdict = 'clean';
    for (const r of results) {
        if (VERDICT_RANK[r.scan.verdict] > VERDICT_RANK[verdict]) verdict = r.scan.verdict;
    }

    const ruleIds: string[] = [];
    let maxSeverity: GuardSeverity | undefined;
    for (const r of results) {
        for (const id of namespaced(r.providerId, r.scan.ruleIds)) {
            if (!ruleIds.includes(id)) ruleIds.push(id);
        }
        const sev = r.scan.maxSeverity;
        if (sev && (maxSeverity === undefined || SEVERITY_RANK[sev] > SEVERITY_RANK[maxSeverity])) {
            maxSeverity = sev;
        }
    }

    const decidedBy = results.filter((r) => r.scan.verdict === verdict).map((r) => r.providerId);
    const scan: ScanResult =
        verdict === 'clean' ? { verdict, ruleIds: [] } : { verdict, ruleIds, maxSeverity };
    return { scan, decidedBy, providerCount: results.length };
}

/**
 * Ask every provider, in parallel, and compose worst-of. Never throws and
 * never returns `clean` for content any provider failed to scan.
 */
export async function scanWithProviders(
    providers: readonly GuardProvider[],
    kind: GuardScanKind,
    content: unknown,
    ctx: GuardProviderContext,
): Promise<ComposedScan> {
    if (providers.length === 0) {
        return {
            scan: providerUnavailable(NO_GUARD_PROVIDER_ID, kind),
            decidedBy: [NO_GUARD_PROVIDER_ID],
            providerCount: 0,
        };
    }
    const scans = await Promise.all(providers.map((p) => scanOne(p, kind, content, ctx)));
    return worstOf(providers.map((p, i) => ({ providerId: p.id, scan: scans[i] })));
}
