/**
 * The asset domain shapes, in a module both client and server can import.
 *
 * WHY THIS FILE AND NOT `asset.dto.ts`
 * -----------------------------------
 * `AssetDetail` used to live in `assets/[id]/page.tsx`, and
 * `EditAssetModal.tsx` + `_form/useEditAssetForm.ts` imported it FROM the
 * page — the only two imports of a type from a Next.js page module in the
 * repo, and a cycle: page → modal → hook → page.
 *
 * The obvious home looks like `asset.dto.ts`, which already defines
 * `AssetListItemDTOSchema` / `AssetDetailDTOSchema`. It is the wrong one for
 * these consumers, for two reasons:
 *
 *  1. **Bundle.** `asset.dto.ts` imports `@/lib/openapi/zod`, whose whole
 *     job is the runtime side effect `extendZodWithOpenApi(z)`. Today it is
 *     reached only from the server-side spec builder. Importing it from
 *     `'use client'` code would pull zod + the OpenAPI extension into the
 *     browser bundle to obtain a type that is erased at compile time.
 *  2. **Precision.** Those schemas are `.passthrough()` with nearly every
 *     field `.optional()`, because they describe what an API response may
 *     contain. That is right for a wire contract and wrong for a UI
 *     contract — a component that has fetched an asset detail should not
 *     have to null-check `status` on every read.
 *
 * So the shapes live here as pure types with no runtime imports at all.
 * `import type` from `@prisma/client` is erased at build time (the same
 * pattern `admin/roles/page.tsx` already uses under `'use client'`), which
 * buys the real enum unions instead of hand-copied string literals that
 * drift from the schema.
 *
 * `asset.dto.ts` keeps describing the wire format for OpenAPI. This
 * describes the shape the UI works with. They are related but not the same
 * contract, and collapsing them would make one of the two wrong.
 */
import type { AssetStatus, AssetType, Criticality } from '@prisma/client';

/** Resolved assignee — the one Owner concept. */
export interface AssetOwnerRef {
    id: string;
    name: string | null;
    email: string | null;
}

/** 360° relationship roll-ups computed server-side by the `getAsset` usecase. */
export interface AssetRollups {
    risks: { count: number };
    controls: { count: number };
    vulnerabilities: { openCount: number; maxSeverity: string | null; maxScore: number | null };
    tasks: { openCount: number; total: number };
}

/**
 * The fields shared by the list row and the detail view. Keeping this
 * explicit is what stops `AssetListRow` from re-declaring 26 of the same
 * fields with its own subtly different nullability.
 */
export interface AssetCore {
    id: string;
    name: string;
    type: AssetType;
    classification: string | null;
    /** Legacy free-text owner — import-only fallback, distinct from the assignee. */
    owner: string | null;
    ownerUserId: string | null;
    ownerUser: AssetOwnerRef | null;
    location: string | null;
    /**
     * Derived on WRITE from the C/I/A triad and stored, so the SQL list
     * filter and the dashboard KPI can query it. Read surfaces render this
     * value — they must not recompute it from the triad. See
     * `src/lib/asset-criticality.ts`.
     */
    criticality: Criticality | null;
    status: AssetStatus;
    dataResidency: string | null;
    externalRef: string | null;
    dependencies: string | null;
    businessProcesses: string | null;
    retention: string | null;
    retentionUntil: string | null;
    confidentiality: number | null;
    integrity: number | null;
    availability: number | null;
    // Product-identity fields — power CVE→asset matching.
    cpe: string | null;
    vendor: string | null;
    product: string | null;
    version: string | null;
    createdAt: string;
    updatedAt: string;
}

/** An asset as the detail page works with it. */
export interface AssetDetail extends AssetCore {
    rollups?: AssetRollups;
}
