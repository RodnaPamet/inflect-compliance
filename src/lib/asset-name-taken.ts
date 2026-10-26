/**
 * The refusal an asset write gets when its name is already held (#4324).
 *
 * Asset names are unique among LIVE assets only: `Asset_tenantId_name_key` is
 * a partial unique index (`WHERE "deletedAt" IS NULL`, migration
 * 20260312210616_partial_unique_soft_delete), so a name is free again the
 * moment its asset is deleted. Two writes can therefore collide with it — a
 * create, and the restore of a deleted asset whose name has been reused since.
 *
 * Left to the index, both arrived as Prisma's P2002, which the API maps to the
 * generic "A resource with that unique constraint already exists": it does not
 * say the name is the problem, and the page showed it untranslated (create) or
 * not at all (restore). The usecases now check first and refuse with this
 * reason in `error.details.reason`, so the page can show its own sentence.
 *
 * Client-safe: no server imports, so the list page and the create form can
 * read the reason.
 */
export const ASSET_NAME_TAKEN = 'ASSET_NAME_TAKEN' as const;

/** True when a parsed API error body is the asset-name refusal. */
export function isAssetNameTaken(body: unknown): boolean {
    const details = (body as { error?: { details?: { reason?: unknown } } } | null)?.error
        ?.details;
    return details?.reason === ASSET_NAME_TAKEN;
}
