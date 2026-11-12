/**
 * AI Guard — barrel + compose helpers.
 *
 * Two entrypoints wire the scanners + per-tenant policy + audit together:
 *
 *   - `guardUntrustedInput(ctx, text, { source, db? })` — run on tenant-
 *     authored content BEFORE it is assembled into a prompt. Composes WITH
 *     (never replaces) the prompt-builder's `neutralizeUntrustedText` +
 *     `[UNTRUSTED DATA]` delimiting and the privacy-sanitizer.
 *   - `guardEgress(ctx, payload, { source, db? })` — run on OUTBOUND content
 *     (after the privacy-sanitizer, before the provider call) and on agent-
 *     proposed outputs / tool-args BEFORE they can be committed.
 *
 * Both resolve the tenant guard mode (`TenantSecuritySettings.aiGuardMode`),
 * emit a hash-chained AuditLog entry on any non-clean verdict carrying RULE
 * IDS ONLY (never the raw injected text or secret material), and return a
 * `GuardOutcome` with the resolved enforcement `action`. Callers apply the
 * invariant: a `block` outcome must abort the model call / the commit; a
 * `flag` outcome forces human review and NEVER auto-commits.
 *
 * The verdict comes from the `GuardProvider` seam (`providers/`): the
 * deterministic `patterns` provider always, plus `nemo` when the operator sets
 * `AI_GUARD_NEMO_BASE_URL`, composed WORST-OF so a second slice can only
 * tighten. Patterns alone is byte-identical to the guard before the seam. The
 * mode, enforcement and audit stay HERE, decided once over the composed
 * verdict — a provider never sees the tenant's mode.
 */
import type { RequestContext } from '@/app-layer/types';
import type { PrismaTx } from '@/lib/db-context';
import { runInTenantContext } from '@/lib/db-context';
import { appendAuditEntry } from '@/lib/audit';
import { forbidden } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';
import type { GuardVerdict, ScanResult } from './injection-scanner';
import {
    resolveGuardMode,
    resolveEnforcement,
    type GuardMode,
    type GuardAction,
    type GuardDirection,
} from './policy';
import { scanWithProviders, type ComposedScan } from './providers/compose';
import { activeGuardProviders } from './providers/registry';
import type { GuardProvider } from './providers/types';

export { normalizeForScan } from './normalize';
export { scanInjection } from './injection-scanner';
export type { GuardVerdict, ScanResult } from './injection-scanner';
export { scanEgress } from './egress-scanner';
export {
    resolveGuardMode,
    resolveEnforcement,
    DEFAULT_GUARD_MODE,
} from './policy';
export type { GuardMode, GuardAction, GuardDirection } from './policy';
export { INJECTION_RULES, EGRESS_RULES } from './patterns';
export {
    GUARD_PROVIDER_UNAVAILABLE_RULE,
    providerUnavailable,
    scanWithProviders,
    worstOf,
} from './providers/compose';
export type { ComposedScan } from './providers/compose';
export type { GuardProvider, GuardProviderContext, GuardScanKind } from './providers/types';

export interface GuardOutcome {
    verdict: GuardVerdict;
    /** Stable rule ids that fired — safe to surface / log (no user content). */
    ruleIds: string[];
    mode: GuardMode;
    action: GuardAction;
    /** True when enforcement is `block` (abort the call / drop the action). */
    blocked: boolean;
    /** True when enforcement is `flag` or `block` — never auto-commit. */
    reviewRequired: boolean;
    source: string;
    direction: GuardDirection;
    /**
     * The provider(s) whose verdict the outcome's verdict is (NeMo Guardrails
     * roadmap, Phase 1.2). Present ONLY when more than one provider was
     * consulted: a patterns-only guard (no `AI_GUARD_NEMO_BASE_URL`) returns
     * exactly the outcome it returned before the provider seam, field for
     * field. Rule ids say the same thing at finer grain — a non-patterns
     * provider's ids are namespaced by its id (`nemo.rail.…`).
     */
    decidedBy?: readonly string[];
}

export interface GuardOptions {
    /** Where the content came from (e.g. 'risk-assessment', 'vendor-doc'). */
    source: string;
    /** An open tenant tx to reuse for the settings read (avoids nesting). */
    db?: PrismaTx;
    /**
     * The providers to consult, in place of the deployment's
     * (`activeGuardProviders()`). For tests and for a caller that must pin the
     * slice set; no production caller passes it today.
     */
    providers?: readonly GuardProvider[];
}

async function resolveModeForTenant(ctx: RequestContext, db?: PrismaTx): Promise<GuardMode> {
    try {
        const read = async (tx: PrismaTx) =>
            tx.tenantSecuritySettings.findUnique({
                where: { tenantId: ctx.tenantId },
                select: { aiGuardMode: true },
            });
        const settings = db ? await read(db) : await runInTenantContext(ctx, read);
        return resolveGuardMode(settings);
    } catch (err) {
        // Fail-safe: on any read error default to the balanced posture.
        logger.warn('ai-guard: mode read failed, defaulting to balanced', {
            requestId: ctx.requestId,
            tenantId: ctx.tenantId,
            error: err instanceof Error ? err.message : String(err),
        });
        return 'balanced';
    }
}

async function emitGuardAudit(
    ctx: RequestContext,
    outcome: GuardOutcome,
): Promise<void> {
    // Only rule ids + structured decision fields ship — NEVER the raw text.
    const action =
        outcome.direction === 'egress'
            ? outcome.blocked
                ? 'AI_GUARD_EGRESS_BLOCKED'
                : 'AI_GUARD_EGRESS_FLAGGED'
            : outcome.blocked
              ? 'AI_GUARD_INPUT_BLOCKED'
              : 'AI_GUARD_INPUT_FLAGGED';
    await appendAuditEntry({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        actorType: ctx.apiKeyId ? 'API_KEY' : 'USER',
        entity: 'AiGuard',
        entityId: outcome.source,
        action,
        requestId: ctx.requestId,
        // `access` is the canonical security-event category (mirrors AUTHZ_DENIED).
        detailsJson: {
            category: 'access',
            event: 'ai_guard',
            direction: outcome.direction,
            verdict: outcome.verdict,
            enforcement: outcome.action,
            mode: outcome.mode,
            ruleIds: outcome.ruleIds,
            source: outcome.source,
            // Only when more than one provider was asked, so a patterns-only
            // guard writes the same row it wrote before the provider seam.
            ...(outcome.decidedBy ? { decidedBy: [...outcome.decidedBy] } : {}),
        },
        metadataJson: {
            ruleCount: outcome.ruleIds.length,
            blocked: outcome.blocked,
        },
    }).catch((err) => {
        // Fail-safe: never let an audit failure break the guarded path.
        logger.warn('ai-guard: audit write failed', {
            requestId: ctx.requestId,
            tenantId: ctx.tenantId,
            error: err instanceof Error ? err.message : String(err),
        });
    });
}

async function compose(
    ctx: RequestContext,
    content: unknown,
    direction: GuardDirection,
    opts: GuardOptions,
): Promise<GuardOutcome> {
    const mode = await resolveModeForTenant(ctx, opts.db);
    const composed: ComposedScan = await scanWithProviders(
        opts.providers ?? activeGuardProviders(),
        direction,
        content,
        { requestId: ctx.requestId, tenantId: ctx.tenantId },
    );
    const scan: ScanResult = composed.scan;
    const action = resolveEnforcement(mode, scan.verdict, direction);
    const outcome: GuardOutcome = {
        verdict: scan.verdict,
        ruleIds: scan.ruleIds,
        mode,
        action,
        blocked: action === 'block',
        reviewRequired: action === 'flag' || action === 'block',
        source: opts.source,
        direction,
        ...(composed.providerCount > 1 ? { decidedBy: composed.decidedBy } : {}),
    };
    if (scan.verdict !== 'clean') {
        await emitGuardAudit(ctx, outcome);
    }
    return outcome;
}

/**
 * Guard tenant-authored content on its way INTO the model. Scans for prompt-
 * injection, resolves the tenant mode, audits any non-clean verdict, and
 * returns the enforcement outcome. Does NOT throw — the caller applies the
 * invariant (see `assertGuardAllowed`).
 */
export async function guardUntrustedInput(
    ctx: RequestContext,
    text: string | null | undefined,
    opts: GuardOptions,
): Promise<GuardOutcome> {
    return compose(ctx, text, 'input', opts);
}

/**
 * Guard OUTBOUND content / agent-proposed output on its way OUT (to the
 * provider) or before it can be committed. Scans for secret / exfil material,
 * resolves the tenant mode, audits any non-clean verdict, and returns the
 * enforcement outcome.
 */
export async function guardEgress(
    ctx: RequestContext,
    payload: unknown,
    opts: GuardOptions,
): Promise<GuardOutcome> {
    return compose(ctx, payload, 'egress', opts);
}

/**
 * Enforce the block invariant: throw a typed `forbidden` when the guard
 * outcome is `block`. Carries the rule ids (safe) — never the raw content.
 * Use at every model-call / commit site so a malicious input or a secret
 * leak can never proceed.
 */
export function assertGuardAllowed(outcome: GuardOutcome): void {
    if (outcome.blocked) {
        throw forbidden(
            `ai_guard_blocked: ${outcome.direction} ${outcome.verdict} ` +
                `[${outcome.ruleIds.join(',')}]`,
        );
    }
}

/**
 * Stricter gate for AUTO-DRAFT surfaces (questionnaire autofill, assistant)
 * where the model output isn't gated by a separate human accept/approve step
 * before it can influence a decision. H2 — abort the model call on ANY
 * review-required verdict (`flag` OR `block`), not only a hard block: under the
 * default `balanced` mode a `malicious` INPUT resolves to `flag`, so
 * `assertGuardAllowed` alone would let an injected prompt through to the LLM.
 */
export function assertNoReviewRequired(outcome: GuardOutcome): void {
    if (outcome.reviewRequired) {
        throw forbidden(
            `ai_guard_review_required: ${outcome.direction} ${outcome.verdict} ` +
                `[${outcome.ruleIds.join(',')}]`,
        );
    }
}
