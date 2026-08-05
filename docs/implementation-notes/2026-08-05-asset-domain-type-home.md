# 2026-08-05 — The asset domain type gets a home

**Commit:** `<pending> refactor(assets): move AssetDetail out of the page module`

`AssetDetail` was a 30-field interface declared in `assets/[id]/page.tsx`.
`EditAssetModal.tsx` and `_form/useEditAssetForm.ts` imported it **from the
page** — the only two imports of a type from a Next.js page module in the
repo, and a cycle: page → modal → hook → page. Separately,
`AssetsClient.tsx` re-declared 26 of the same fields as `AssetListRow`, with
looser types.

## Why not `asset.dto.ts`

That file already defines `AssetListItemDTOSchema` / `AssetDetailDTOSchema`,
so it looks like the obvious home. It is the wrong one for these consumers:

1. **Bundle.** It imports `@/lib/openapi/zod`, whose entire purpose is the
   runtime side effect `extendZodWithOpenApi(z)`. Today it is reached only
   from the server-side spec builder. `EditAssetModal.tsx` is `'use client'`
   — importing the DTO module there would pull zod plus the OpenAPI
   extension into the browser bundle, to obtain a type that is erased at
   compile time anyway.
2. **Precision.** Those schemas are `.passthrough()` with nearly every field
   `.optional()`, because they describe what an API response *may* contain.
   Correct for a wire contract, wrong for a UI contract — a component that
   has already fetched an asset should not null-check `status` on each read.

So `src/lib/dto/asset.types.ts` holds pure types with **no runtime imports**.
`import type { AssetStatus, AssetType, Criticality } from '@prisma/client'`
is erased at build time — the pattern `admin/roles/page.tsx` already uses
under `'use client'` — which buys the real enum unions instead of
hand-copied string literals that drift from the schema.

`asset.dto.ts` keeps describing the wire format for OpenAPI. This describes
the shape the UI works with. Related contracts, not the same one; collapsing
them would make one of the two wrong.

## Shape

`AssetCore` holds the fields the list row and the detail view share.
`AssetDetail = AssetCore + rollups?`. `AssetListRow` is now
`Omit<AssetCore, …detail-only fields> & {…list-only rollups}` instead of 26
hand-copied declarations.

That last change is a real tightening, not just deduplication: the list row
previously typed `type: string` and `criticality: string | null`, so the
table could hold a criticality band the detail page's type would reject.
Both now carry the Prisma enums.

The page re-exports `AssetDetail` / `AssetRollups` so existing
`from './[id]/page'` imports keep working; new code imports the shared
module.

## Decisions

- **A third module, rather than reusing the DTO one.** The bundle and
  precision arguments above are independent, and each alone is sufficient.
  Two contracts that look alike are not one contract.
- **`import type` from `@prisma/client`, not re-declared unions.** Erased at
  build, so client-safe, and it cannot drift from `enums.prisma`.
- **The page keeps a re-export.** Deleting it would have churned unrelated
  call sites in the same diff for no benefit.
