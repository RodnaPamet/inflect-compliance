/**
 * Asset-criticality scoring — thin re-export of the server-safe pure module
 * at `src/lib/asset-criticality.ts`. Kept here so existing client-form import
 * paths (`./asset-criticality`) stay stable while the derivation logic lives
 * in a place BOTH the client form and the server usecase can import.
 *
 * See `@/lib/asset-criticality` for the aggregation model + the item-25
 * ratchet reference.
 */
export {
    getAssetCriticality,
    presentCriticality,
    CRITICALITY_PRESENTATION,
    criticalityToEnum,
    CRITICALITY_CEILING,
    ASSET_CRITICALITY_TONE_CLASSES,
} from '@/lib/asset-criticality';
export type { AssetCriticalityTone, CriticalityEnum } from '@/lib/asset-criticality';
