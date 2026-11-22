import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';
import { logEvent } from './audit';
import { emitAutomationEvent } from '../automation';

/**
 * Typed risk event emitters.
 *
 * Two fan-outs per business action:
 *   1. Audit log — durable, hash-chained trail for compliance.
 *   2. Automation bus — in-process event stream the automation
 *      dispatcher subscribes to. Decoupled from audit so automation
 *      rules don't see every audit entry (and vice versa).
 */

export async function emitRiskCreated(
    db: PrismaTx,
    ctx: RequestContext,
    risk: { id: string; title: string; score: number; category?: string | null; status?: string }
): Promise<void> {
    await logEvent(db, ctx, {
        action: 'RISK_CREATED',
        entityType: 'Risk',
        entityId: risk.id,
        details: `Created risk: ${risk.title} (score: ${risk.score})`,
    });
    await emitAutomationEvent(ctx, {
        event: 'RISK_CREATED',
        entityType: 'Risk',
        entityId: risk.id,
        actorUserId: ctx.userId,
        data: {
            title: risk.title,
            score: risk.score,
            category: risk.category ?? null,
            status: risk.status ?? 'OPEN',
        },
    });
}

export async function emitRiskUpdated(
    db: PrismaTx,
    ctx: RequestContext,
    riskId: string,
    changes: Record<string, unknown>
): Promise<void> {
    await logEvent(db, ctx, {
        action: 'RISK_UPDATED',
        entityType: 'Risk',
        entityId: riskId,
        details: `Updated risk fields: ${Object.keys(changes).join(', ')}`,
    });
    await emitAutomationEvent(ctx, {
        event: 'RISK_UPDATED',
        entityType: 'Risk',
        entityId: riskId,
        actorUserId: ctx.userId,
        data: { changedFields: Object.keys(changes) },
    });
}

export async function emitRiskStatusChanged(
    db: PrismaTx,
    ctx: RequestContext,
    riskId: string,
    oldStatus: string,
    newStatus: string
): Promise<void> {
    await logEvent(db, ctx, {
        action: 'RISK_STATUS_CHANGED',
        entityType: 'Risk',
        entityId: riskId,
        details: `Status changed from ${oldStatus} to ${newStatus}`,
    });
    await emitAutomationEvent(ctx, {
        event: 'RISK_STATUS_CHANGED',
        entityType: 'Risk',
        entityId: riskId,
        actorUserId: ctx.userId,
        data: { fromStatus: oldStatus, toStatus: newStatus },
    });
}

export async function emitRiskControlsMapped(
    db: PrismaTx,
    ctx: RequestContext,
    riskId: string,
    controlId: string,
    action: 'LINKED' | 'UNLINKED'
): Promise<void> {
    await logEvent(db, ctx, {
        action: 'RISK_CONTROLS_MAPPED',
        entityType: 'RiskControl',
        entityId: riskId,
        details: `Control ${controlId} ${action.toLowerCase()} ${action === 'LINKED' ? 'to' : 'from'} risk`,
    });
    await emitAutomationEvent(ctx, {
        event: 'RISK_CONTROLS_MAPPED',
        entityType: 'RiskControl',
        entityId: riskId,
        actorUserId: ctx.userId,
        data: { controlId, action },
    });
}
