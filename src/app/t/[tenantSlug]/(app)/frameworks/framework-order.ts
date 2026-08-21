/**
 * The frameworks stepper's id extractor — one definition, shared by the
 * PUBLISH side (`FrameworksClient`) and the READ side
 * (`frameworks/[frameworkKey]/page.tsx`).
 *
 * Frameworks are the entity whose detail route is keyed by a SLUG
 * (`/frameworks/ISO27001`), not by `Framework.id`. `useEntityListIds` matches
 * `currentId` against the published order by string equality, so a publisher
 * that emitted `.id` while the detail page passed `params.frameworkKey` would
 * never find the current entry — the stepper would hide itself on every
 * framework, exactly as it did before the order was published at all.
 *
 * Both sides go through this one function, and `use-entity-list-ids` asks for a
 * referentially stable extractor (an inline arrow is a new identity every
 * render and re-walks the list each pass) — which a module-level function is by
 * construction.
 */
export function frameworkOrderKey(row: { key?: string | null }): string | null {
    return row?.key ?? null;
}
