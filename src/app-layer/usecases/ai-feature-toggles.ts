/**
 * The four AI switches as a tenant setting an owner can flip.
 *
 * ═══ WHAT AN ADMIN CAN AND CANNOT CHANGE ═══
 *
 * There are TWO layers, and only one of them has a UI:
 *
 *     effective = env_global AND env_feature AND tenant_master AND tenant_feature
 *                 └──────── the deploy ────────┘ └──────── this file ─────────┘
 *
 * `AI_RISK_ENABLED`, `AI_RISK_SUGGESTIONS_ENABLED`, `AI_ASSISTANT_ENABLED` and
 * `AI_QUESTIONNAIRE_ENABLED` are read into module constants at import time
 * (`feature-gate.ts`), so they are fixed for the life of the process. No page
 * can change them, and one that appeared to would be lying: the running
 * container would keep its old answer until it was recreated.
 *
 * So the UI flips the TENANT layer, and the env keeps the power to force off.
 * That asymmetry is the whole point of an env kill switch — a tenant row able
 * to override an env `false` would leave an operator no way to stop AI without
 * a deploy.
 *
 * ═══ WHICH MEANS THE UI OWES THE READER A DISTINCTION ═══
 *
 * A toggle can be off for two unrelated reasons: this tenant turned it off, or
 * the platform did. `AiToggleState` carries both, separately, plus the
 * `effective` answer — because collapsing them to one boolean produces exactly
 * the bug #3909 fixed in the assistant launcher, where a control looked
 * available and every use of it was refused.
 *
 * `forcedOffByEnv` is therefore not a convenience field. It is the one the
 * client needs in order to say "turned off for the whole platform" rather than
 * rendering an on-looking switch over a feature that cannot run.
 *
 * ═══ WHY THE TENANT DEFAULT IS ON ═══
 *
 * Opposite of `process-canvas-module`, deliberately. Granting that module is a
 * commercial act, so its default is off and an absent row reads as off. These
 * are not a module: AI is part of the product every tenant already has, and the
 * env flags are what decide whether the platform offers it at all. A default of
 * off here would mean enabling AI in the environment changed nothing for anyone
 * until every tenant was visited one at a time.
 *
 * Hence: an ABSENT settings row reads as ALL ON (`@default(true)` on all four
 * columns says the same thing), and these toggles exist to let a tenant opt
 * OUT — which is the direction a tenant with a contractual no-AI position
 * actually needs.
 *
 * @module usecases/ai-feature-toggles
 */
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { logEvent } from '../events/audit';
import { logger } from '@/lib/observability/logger';
import { isAiFeatureEnabled, isAIRiskEnabled } from '@/app-layer/ai/risk-assessment/feature-gate';
import {
    AI_TOGGLE_COLUMN,
    AI_TOGGLE_KEYS,
    type AiToggleKey,
} from '@/app-layer/ai/risk-assessment/tenant-toggle-columns';

export { AI_TOGGLE_COLUMN, AI_TOGGLE_KEYS };
export type { AiToggleKey };


export interface AiToggleState {
    key: AiToggleKey;
    /** The stored column — what this tenant chose. */
    tenantEnabled: boolean;
    /** What the deploy permits. False here cannot be changed from any UI. */
    envEnabled: boolean;
    /** `envEnabled AND tenantEnabled`, and for a feature also the two masters. */
    effective: boolean;
    /** The env is the reason this is off. The UI must SAY so, not hide it. */
    forcedOffByEnv: boolean;
}

/**
 * What the deploy permits for one key.
 *
 * The master key answers for `AI_RISK_ENABLED` alone. A FEATURE key answers for
 * the master AND its own flag, because that is exactly predicates 1 and 2 of
 * the allowlist — `isAiFeatureEnabled` deliberately does not fold the master in
 * (a layout asking about one feature still has to ask about the kill switch
 * separately, which is the omission #3909 fixed).
 */
function envAllows(key: AiToggleKey): boolean {
    if (key === 'ai') return isAIRiskEnabled();
    return isAIRiskEnabled() && isAiFeatureEnabled(key);
}

/** Map a settings row (or its absence) to the four states. */
export function toggleStatesFrom(row: Readonly<Record<string, boolean>> | null): AiToggleState[] {
    // ABSENT ROW READS AS ALL ON — see the module docblock. `?? true` rather
    // than `=== true` (which is what process-canvas uses) is the whole
    // difference between an opt-out setting and an opt-in module.
    const tenantMaster = row?.[AI_TOGGLE_COLUMN.ai] ?? true;

    return AI_TOGGLE_KEYS.map((key) => {
        const tenantEnabled = row?.[AI_TOGGLE_COLUMN[key]] ?? true;
        const envEnabled = envAllows(key);
        // A feature is only effective if the tenant master is on too, mirroring
        // the gate: `aiEnabled === false` refuses every feature there.
        const tenantAllows = key === 'ai' ? tenantEnabled : tenantEnabled && tenantMaster;
        return {
            key,
            tenantEnabled,
            envEnabled,
            effective: envEnabled && tenantAllows,
            // Reported even when the tenant ALSO turned it off: the client needs
            // to know the switch is inert before it renders it as actionable.
            forcedOffByEnv: !envEnabled,
        };
    });
}

/** Read the four toggles for this tenant. */
export async function readAiFeatureToggles(ctx: RequestContext): Promise<AiToggleState[]> {
    const row = await runInTenantContext(ctx, (db) =>
        db.tenantSecuritySettings.findUnique({
            where: { tenantId: ctx.tenantId },
            select: {
                aiEnabled: true,
                aiRiskSuggestionsEnabled: true,
                aiAssistantEnabled: true,
                aiQuestionnaireEnabled: true,
            },
        }),
    );
    return toggleStatesFrom(row as Readonly<Record<string, boolean>> | null);
}

/**
 * Flip one or more toggles.
 *
 * A PARTIAL patch, not the whole set: two owners editing different switches at
 * once should not have one silently restore the other's value because its form
 * posted every field.
 *
 * OWNER-only at the route via `requirePermission('admin.tenant_lifecycle')`,
 * matching `setProcessCanvasEnabled` and `setIdentityWriteMode`. The check is
 * NOT repeated here as a second, weaker gate.
 *
 * ENV IS NOT VALIDATED AGAINST. Storing `aiAssistantEnabled = true` while the
 * env forces it off is allowed and correct: it records what the tenant wants
 * for when the platform permits it, and refusing the write would make the
 * stored intent depend on a deploy that may be reversed an hour later. The
 * effective answer is computed, never stored.
 */
export async function setAiFeatureToggles(
    ctx: RequestContext,
    patch: Readonly<Partial<Record<AiToggleKey, boolean>>>,
): Promise<{ states: AiToggleState[]; changed: AiToggleKey[] }> {
    // ONE TRANSACTION over read + write + audit, for the reason
    // `process-canvas-module` states at length — a failure in the audit append
    // must take the flag change with it, or the product misreports its own
    // state. `appendAuditEntry` takes a per-tenant advisory lock, so this is a
    // real failure mode and not a hypothetical one.
    const outcome = await runInTenantContext(ctx, async (db) => {
        // Read INSIDE the transaction so the audit row's `fromStatus` describes
        // what the database actually held, not what an earlier transaction saw.
        const before = (await db.tenantSecuritySettings.findUnique({
            where: { tenantId: ctx.tenantId },
            select: {
                aiEnabled: true,
                aiRiskSuggestionsEnabled: true,
                aiAssistantEnabled: true,
                aiQuestionnaireEnabled: true,
            },
        })) as Record<string, boolean> | null;

        const current = (key: AiToggleKey): boolean => before?.[AI_TOGGLE_COLUMN[key]] ?? true;

        const changed = AI_TOGGLE_KEYS.filter(
            (key) => patch[key] !== undefined && patch[key] !== current(key),
        );

        // A no-op write is not an event — the same rule as the module toggle.
        // Note this returns the states computed from `before`, which is correct
        // precisely because nothing changed.
        if (changed.length === 0) {
            return { row: before, changed: [] as AiToggleKey[] };
        }

        const columns = Object.fromEntries(
            changed.map((key) => [AI_TOGGLE_COLUMN[key], patch[key] as boolean]),
        );

        const row = (await db.tenantSecuritySettings.upsert({
            where: { tenantId: ctx.tenantId },
            create: { tenantId: ctx.tenantId, ...columns },
            update: columns,
            select: {
                aiEnabled: true,
                aiRiskSuggestionsEnabled: true,
                aiAssistantEnabled: true,
                aiQuestionnaireEnabled: true,
            },
        })) as Record<string, boolean>;

        const summary = changed
            .map((key) => `${key}: ${current(key) ? 'on' : 'off'} → ${patch[key] ? 'on' : 'off'}`)
            .join(', ');

        // `status_change`, not `configuration` (which is not in the schema enum
        // and 400'd the module route — #3170) and not `access`: flipping these
        // grants nobody any authority. Every permission check on every AI
        // surface is identical whether they are on or off; what changes is
        // whether the product offers the surface. Comment ABOVE the call, not
        // inside the object, so `audit-structured-events` still finds
        // `detailsJson` inside its scan window.
        await logEvent(db, ctx, {
            action: 'AI_FEATURE_TOGGLES_CHANGED',
            entityType: 'Tenant',
            entityId: ctx.tenantId,
            details: `AI feature toggles — ${summary}`,
            detailsJson: {
                category: 'status_change',
                // One row can carry several flips, so a single `operation` of
                // enable/disable would describe only part of it. `update` names
                // the event; `summary` and `metadata` carry which switches moved.
                operation: 'update',
                fromStatus: changed.map((k) => `${k}=${current(k) ? 'on' : 'off'}`).join(' '),
                toStatus: changed.map((k) => `${k}=${patch[k] ? 'on' : 'off'}`).join(' '),
                summary: `AI feature toggles changed (${changed.join(', ')})`,
            },
            metadata: {
                changed,
                from: Object.fromEntries(changed.map((k) => [k, current(k)])),
                to: Object.fromEntries(changed.map((k) => [k, patch[k]])),
            },
        });

        return { row, changed };
    });

    // AFTER the commit: a line emitted inside the transaction claims a change a
    // rollback would undo.
    if (outcome.changed.length > 0) {
        logger.info('ai feature toggles changed', {
            component: 'ai-feature-toggles',
            tenantId: ctx.tenantId,
            changed: outcome.changed,
        });
    }

    return {
        states: toggleStatesFrom(outcome.row as Readonly<Record<string, boolean>> | null),
        changed: outcome.changed,
    };
}
