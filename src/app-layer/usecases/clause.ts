import { z } from 'zod';
import { RequestContext } from '../types';
import { ClauseRepository } from '../repositories/ClauseRepository';
import { assertCanRead, assertCanWrite } from '../policies/common';
import { logEvent } from '../events/audit';
import { runInTenantContext } from '@/lib/db-context';
import { UpdateClauseProgressSchema } from '@/lib/schemas';
import { sanitizePlainText } from '@/lib/security/sanitize';

export async function listClauses(ctx: RequestContext) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) =>
        ClauseRepository.list(db, ctx)
    );
}

export async function updateClauseProgress(ctx: RequestContext, id: string, data: z.infer<typeof UpdateClauseProgressSchema>) {
    assertCanWrite(ctx);

    return runInTenantContext(ctx, async (db) => {
        // Notes are free text a person typed: sanitise before storing, and
        // pass `undefined` through so a status-only save keeps them (#4738).
        const notes = data.notes == null ? data.notes : sanitizePlainText(data.notes);
        const progress = await ClauseRepository.updateProgress(db, ctx, id, {
            status: data.status,
            notes,
        });

        await logEvent(db, ctx, {
            action: 'UPDATE',
            entityType: 'ClauseProgress',
            entityId: progress.id,
            details: `Status: ${data.status}`,
            detailsJson: {
                category: 'status_change',
                entityName: 'ClauseProgress',
                fromStatus: null,
                toStatus: data.status,
            },
        });

        return progress;
    });
}
