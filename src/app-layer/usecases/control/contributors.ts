/**
 * Control contributors. Split out of `evidence.ts` (roadmap P3.3), which had
 * grown three unrelated relationship graphs behind one filename.
 */
import { RequestContext } from '../../types';
import { ControlRepository } from '../../repositories/ControlRepository';
import {
    assertCanReadControls, assertCanUpdateControl,
} from '../../policies/control.policies';
import { logEvent } from '../../events/audit';
import { notFound } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';

// ─── Contributors ───

export async function listContributors(ctx: RequestContext, controlId: string) {
    assertCanReadControls(ctx);
    return runInTenantContext(ctx, (db) =>
        ControlRepository.listContributors(db, ctx, controlId)
    );
}

export async function addContributor(ctx: RequestContext, controlId: string, userId: string) {
    assertCanUpdateControl(ctx);
    return runInTenantContext(ctx, async (db) => {
        const result = await ControlRepository.addContributor(db, ctx, controlId, userId);
        if (!result) throw notFound('Control not found');

        await logEvent(db, ctx, {
            action: 'CONTROL_CONTRIBUTOR_ADDED',
            entityType: 'Control',
            entityId: controlId,
            details: `Contributor added: ${userId}`,
            detailsJson: { category: 'relationship', operation: 'linked', sourceEntity: 'Control', sourceId: controlId, targetEntity: 'User', targetId: userId, relation: 'contributor' },
        });
        return result;
    });
}

export async function removeContributor(ctx: RequestContext, controlId: string, userId: string) {
    assertCanUpdateControl(ctx);
    return runInTenantContext(ctx, async (db) => {
        const result = await ControlRepository.removeContributor(db, ctx, controlId, userId);
        if (!result) throw notFound('Control or contributor not found');

        await logEvent(db, ctx, {
            action: 'CONTROL_CONTRIBUTOR_REMOVED',
            entityType: 'Control',
            entityId: controlId,
            details: `Contributor removed: ${userId}`,
            detailsJson: { category: 'relationship', operation: 'unlinked', sourceEntity: 'Control', sourceId: controlId, targetEntity: 'User', targetId: userId, relation: 'contributor' },
        });
        return { success: true };
    });
}
