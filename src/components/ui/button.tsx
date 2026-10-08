/**
 * Re-export shim — #3046 batch 3a.
 *
 * The implementation moved to `@inflect/ui/components/ui/button`. This file exists
 * only so the ~875 `@/components/ui/*` imports across `src/` keep resolving
 * while they are rewritten in batch 3b, which deletes this file.
 *
 * DO NOT add anything here. A guard that reads this path for CONTENT would
 * read the re-export and pass on nothing — which is why batch 3a repoints
 * every content-reading guard to the real file rather than leaving them
 * pointed here (see the PR body).
 */
export * from '@inflect/ui/components/ui/button';
