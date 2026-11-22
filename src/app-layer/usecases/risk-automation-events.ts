import type { RequestContext } from '../types';
import { emitAutomationEvent } from '../automation';

/**
 * The automation bus's RISK_CREATED, for every path that creates a risk
 * (the form, a template, the CSV import, accepted AI suggestions, onboarding).
 * Emitted after the creating transaction commits. Until 2026-11-22 no path
 * emitted it, so a "Risk created" rule never fired.
 */
export async function emitRiskCreatedEvent(
    ctx: RequestContext,
    risk: { id: string; title: string; score: number; category: string | null; status: string },
): Promise<void> {
    await emitAutomationEvent(ctx, {
        event: 'RISK_CREATED',
        entityType: 'Risk',
        entityId: risk.id,
        actorUserId: ctx.userId,
        stableKey: risk.id,
        data: {
            title: risk.title,
            score: risk.score,
            category: risk.category ?? null,
            status: risk.status,
        },
    });
}
