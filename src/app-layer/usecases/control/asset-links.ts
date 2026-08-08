/**
 * Control ⇄ asset links. Split out of `evidence.ts` (roadmap P3.3), which had
 * grown three unrelated relationship graphs behind one filename.
 */
import { RequestContext } from '../../types';
import { ControlRepository } from '../../repositories/ControlRepository';
import { assertCanUpdateControl } from '../../policies/control.policies';
import { notFound } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';

// ─── Asset Linking ───

export async function linkAssetToControl(ctx: RequestContext, controlId: string, assetId: string) {
    assertCanUpdateControl(ctx);
    return runInTenantContext(ctx, async (db) => {
        const link = await ControlRepository.linkAsset(db, ctx, controlId, assetId);
        if (!link) throw notFound('Control not found');
        return link;
    });
}

export async function unlinkAssetFromControl(ctx: RequestContext, controlId: string, assetId: string) {
    assertCanUpdateControl(ctx);
    return runInTenantContext(ctx, async (db) => {
        const result = await ControlRepository.unlinkAsset(db, ctx, controlId, assetId);
        if (!result) throw notFound('Control or asset link not found');
        return { success: true };
    });
}
