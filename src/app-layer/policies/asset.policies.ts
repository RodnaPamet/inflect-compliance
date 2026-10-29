/**
 * Asset-specific RBAC policies.
 *
 * The asset surface's ROUTES already ask `assets.view` / `assets.create` /
 * `assets.edit` (`/assets`, `/assets/:id`), while `usecases/asset.ts` asserted
 * the coarse tier alone — so the granular keys bound at the door and nowhere
 * else. This file is where the usecase-layer half lives, in the same shape
 * `control.policies.ts` uses, and its first caller is the traceability
 * mappings (#4413, owner decision 2026-10-27: a mapping is governed by the key
 * of the entity you edit FROM).
 */
import { RequestContext } from '../types';
import { forbidden } from '@/lib/errors/types';

/**
 * Custom-role-aware granular gate for the assets domain.
 *
 * Same contract as `control.policies.ts`'s: the coarse role check always
 * applies, and when `appPermissions` is present the matching granular flag must
 * ALSO be granted. A present-but-partial `assets` object fails closed
 * (`!== true` denies); an entirely absent `appPermissions` honours the coarse
 * check alone, which is the only case where this returns `false` blindly.
 *
 * @returns `true` when the granular layer denies the action.
 */
function granularAssetsDenied(
    ctx: RequestContext,
    flag: 'view' | 'create' | 'edit',
): boolean {
    if (!ctx.appPermissions) return false;
    return ctx.appPermissions.assets?.[flag] !== true;
}

/** Editing an asset — including the traceability lines drawn from it. */
export function assertCanEditAsset(ctx: RequestContext) {
    if (!ctx.permissions.canWrite || granularAssetsDenied(ctx, 'edit')) {
        throw forbidden('You do not have permission to edit assets.');
    }
}
