/**
 * Epic 69 pilot wave #3 — structural pins for the evidence + risks
 * SWR-first migration.
 *
 * Mirrors the dashboard / control-detail ratchet pattern. Three
 * components migrated:
 *
 *   - `RisksClient.tsx` — read-only swap from React Query →
 *     `useTenantSWR(CACHE_KEYS.risks.list())` with a filter-aware
 *     query-string suffix on the key.
 *   - `EvidenceClient.tsx` — read swap + review-mutation conversion
 *     to `useTenantMutation`.
 *   - `UploadEvidenceModal.tsx` — upload flow converted to
 *     `useTenantMutation` with `optimisticUpdate` that prepends a
 *     `PENDING_UPLOAD` row.
 *
 * Each pin protects against a future PR re-introducing
 * `@tanstack/react-query` symbols on these specific files. The
 * other 17+ React-Query consumers across the codebase still run
 * on RQ — the registry stays narrow.
 */

import * as fs from 'fs';
import * as path from 'path';

import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');

const RISKS_CLIENT = path.join(
    ROOT,
    'src/app/t/[tenantSlug]/(app)/risks/RisksClient.tsx',
);
const EVIDENCE_CLIENT = path.join(
    ROOT,
    'src/app/t/[tenantSlug]/(app)/evidence/EvidenceClient.tsx',
);
const UPLOAD_MODAL = path.join(
    ROOT,
    'src/app/t/[tenantSlug]/(app)/evidence/UploadEvidenceModal.tsx',
);

// Masked at the READ seam (#2246 Class A): comments blanked, string
// literals kept, offsets preserved — so a token that survives only in
// a comment can no longer satisfy an assertion below.
// This file used to hand-roll a `stripComments()` for its three
// negative assertions and read RAW everywhere else — the shape #2246
// names as the defect. The local stripper is gone: one masked seam
// covers every assertion in the file, including ones added later.
const read = (p: string) => codeOf(fs.readFileSync(p, 'utf-8'));

// ─── Risks list ────────────────────────────────────────────────────

describe('RisksClient — Epic 69 SWR migration', () => {
    it('reads via useTenantSWR keyed at CACHE_KEYS.risks.list()', () => {
        const src = read(RISKS_CLIENT);
        expect(src).toContain("from '@/lib/hooks/use-tenant-swr'");
        expect(src).toContain('useTenantSWR');
        expect(src).toContain('CACHE_KEYS.risks.list()');
    });

    it('threads filters into the SWR key via a query-string suffix (per-filter cache entries)', () => {
        // The key derivation builds `${list()}?${qs}` so each filter
        // combo gets its own cache entry. Locking this protects the
        // server-side filtering contract — if someone collapsed the
        // key to a static string, all filter views would share one
        // entry and revalidate against each other.
        const src = read(RISKS_CLIENT);
        expect(src).toMatch(/CACHE_KEYS\.risks\.list\(\)\}\?\$\{qs\}/);
    });

    it('passes server-rendered data as fallbackData (no loading flash on first paint)', () => {
        const src = read(RISKS_CLIENT);
        expect(src).toContain('fallbackData');
        // The flag that gates fallbackData against filter divergence
        // (mirroring the prior React-Query "skip initialData" path).
        expect(src).toContain('filtersMatchInitial');
    });

    it('does NOT use TanStack React Query', () => {
        const code = read(RISKS_CLIENT);
        expect(code).not.toMatch(/from\s+['"]@tanstack\/react-query['"]/);
        expect(code).not.toMatch(/\bqueryKeys\b/);
        expect(code).not.toMatch(/\buseQuery\b/);
    });
});

// ─── Evidence client ───────────────────────────────────────────────

describe('EvidenceClient — Epic 69 SWR migration', () => {
    it('reads via useTenantSWR keyed at CACHE_KEYS.evidence.list()', () => {
        const src = read(EVIDENCE_CLIENT);
        expect(src).toContain("from '@/lib/hooks/use-tenant-swr'");
        expect(src).toContain('useTenantSWR');
        expect(src).toContain('CACHE_KEYS.evidence.list()');
    });

    it('writes review actions via useTenantMutation with optimistic status update', () => {
        const src = read(EVIDENCE_CLIENT);
        expect(src).toContain("from '@/lib/hooks/use-tenant-mutation'");
        expect(src).toContain('useTenantMutation');
        expect(src).toContain('optimisticUpdate');
    });

    it('invalidates every evidence filter variant via swrMutate prefix matcher', () => {
        // The filter-aware cache key model means a mutation has to
        // invalidate ALL `/api/t/{slug}/evidence?…` entries to
        // refresh the expiring/archived tabs + active filter views.
        // The matcher is a function-form prefix matcher — either inline
        // (`swrMutate((key) => key.startsWith(prefix), …)`) or a named
        // callback (`evidenceKeyMatcher`) reused by invalidate +
        // optimistic updates.
        const src = read(EVIDENCE_CLIENT);
        expect(src).toContain('swrMutate');
        // Function-form matcher (named or inline), NOT a single-key mutate…
        expect(src).toMatch(/swrMutate\(\s*(\(key|evidenceKeyMatcher\b)/);
        // …and it matches by URL prefix so every `?…` variant refreshes.
        expect(src).toMatch(/\.startsWith\(/);
    });

    it('does NOT use TanStack React Query', () => {
        const code = read(EVIDENCE_CLIENT);
        expect(code).not.toMatch(/from\s+['"]@tanstack\/react-query['"]/);
        expect(code).not.toMatch(/\bqueryKeys\b/);
        expect(code).not.toMatch(/\buseQuery\b/);
        expect(code).not.toMatch(/\buseQueryClient\b/);
        expect(code).not.toMatch(/\.invalidateQueries\b/);
    });
});

// ─── Upload modal ──────────────────────────────────────────────────

describe('UploadEvidenceModal — Epic 69 optimistic-append migration', () => {
    it('writes uploads via useTenantMutation', () => {
        const src = read(UPLOAD_MODAL);
        expect(src).toContain("from '@/lib/hooks/use-tenant-mutation'");
        expect(src).toContain('useTenantMutation');
    });

    it('declares an optimisticUpdate that prepends a PENDING_UPLOAD row', () => {
        const src = read(UPLOAD_MODAL);
        // The closure can be in many shapes; pin the two
        // load-bearing strings: the marker status the EvidenceClient
        // renderer recognises, and a temp-id prefix that signals
        // "row not yet on server". Both must be in source code for
        // the optimistic append behaviour to actually paint.
        expect(src).toContain('optimisticUpdate:');
        expect(src).toContain('PENDING_UPLOAD');
        expect(src).toContain('temp:');
    });

    it('fans out to sibling filter variants via swrMutate prefix matcher', () => {
        // Same matcher contract as the evidence client. After
        // success, every `/evidence?…` cache entry refetches so the
        // expiring/archived tabs reflect the new row.
        const src = read(UPLOAD_MODAL);
        expect(src).toContain('swrMutate');
        expect(src).toMatch(/swrMutate\(\s*\(key\)/);
    });

    it('keys the mutation against CACHE_KEYS.evidence.list()', () => {
        const src = read(UPLOAD_MODAL);
        expect(src).toContain('CACHE_KEYS.evidence.list()');
    });

    it('does NOT use TanStack React Query', () => {
        const code = read(UPLOAD_MODAL);
        expect(code).not.toMatch(/from\s+['"]@tanstack\/react-query['"]/);
        expect(code).not.toMatch(/\bqueryKeys\b/);
        expect(code).not.toMatch(/\buseQueryClient\b/);
        expect(code).not.toMatch(/\.invalidateQueries\b/);
    });
});
