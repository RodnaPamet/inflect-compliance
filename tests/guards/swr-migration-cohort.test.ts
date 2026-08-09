/**
 * SWR migration cohort ratchet.
 *
 * The codebase is finishing the migration off TanStack React Query onto the
 * in-house `useTenantSWR` / `useTenantMutation` seam (keys in `@/lib/swr-keys`).
 * Dual-cache state is the risk the migration exists to retire.
 *
 * MIGRATED_FILES is the source of truth: every file listed here has been moved
 * off `@tanstack/react-query` and MUST NOT import it again. Each migration wave
 * appends its files. The final wave (removing the package) flips
 * `EXPECT_ZERO_TANSTACK_REPO_WIDE` to true, at which point this guard asserts no
 * `@tanstack/react-query` import survives anywhere under `src/`.
 *
 * Sibling pattern: `tests/guards/no-explicit-any-ratchet.test.ts`.
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC_DIR = path.resolve(__dirname, '../../src');

const TANSTACK = /from\s+['"]@tanstack\/react-query['"]/;

// ── Migrated files — append per wave; never remove (it's a ratchet) ──
const MIGRATED_FILES: string[] = [
    // Wave 1 — assets
    'app/t/[tenantSlug]/(app)/assets/AssetsClient.tsx',
    'app/t/[tenantSlug]/(app)/assets/NewAssetModal.tsx',
    // Wave 2 — controls
    'app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx',
    'app/t/[tenantSlug]/(app)/controls/NewControlModal.tsx',
    // Wave 3 — audits + findings
    'app/t/[tenantSlug]/(app)/audits/AuditsClient.tsx',
    'app/t/[tenantSlug]/(app)/audits/NewAuditModal.tsx',
    'app/t/[tenantSlug]/(app)/findings/FindingsClient.tsx',
    'app/t/[tenantSlug]/(app)/findings/CreateFindingModal.tsx',
    // Wave 4a — calendar + access-reviews
    'app/t/[tenantSlug]/(app)/calendar/CalendarClient.tsx',
    'app/t/[tenantSlug]/(app)/access-reviews/AccessReviewsClient.tsx',
    'app/t/[tenantSlug]/(app)/access-reviews/[reviewId]/AccessReviewDetailClient.tsx',
    // Wave 4b — evidence + risk modal
    'app/t/[tenantSlug]/(app)/evidence/EvidenceBulkImportModal.tsx',
    'app/t/[tenantSlug]/(app)/evidence/EvidenceDetailSheet.tsx',
    'app/t/[tenantSlug]/(app)/evidence/NewEvidenceTextModal.tsx',
    'app/t/[tenantSlug]/(app)/risks/NewRiskModal.tsx',
    // Wave 5a — shared hooks (user-combobox + kpi-trends)
    'components/ui/user-combobox.tsx',
    'lib/charts/kpi-trends.ts',
    // Wave 5b — TraceabilityPanel (optimistic link/unlink)
    'components/TraceabilityPanel.tsx',
    // Wave 5c — ControlExceptionsPanel + RiskTreatmentPlanCard
    'components/ControlExceptionsPanel.tsx',
    'components/risks/RiskTreatmentPlanCard.tsx',
];

// Flipped to true by the final cleanup wave (after @tanstack/react-query is
// uninstalled and the QueryClient/provider are removed). Until then the three
// "KEEP for now" infra files (ClientProviders, query-client, mutations) and the
// not-yet-migrated cohort files may still import it.
const EXPECT_ZERO_TANSTACK_REPO_WIDE = true;

function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '.next') continue;
            out.push(...walk(full));
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

describe('SWR migration cohort', () => {
    test.each(MIGRATED_FILES)('%s no longer imports @tanstack/react-query', (rel) => {
        const abs = path.join(SRC_DIR, rel);
        expect(fs.existsSync(abs)).toBe(true);
        const src = fs.readFileSync(abs, 'utf-8');
        if (TANSTACK.test(src)) {
            throw new Error(
                `${rel} is a migrated SWR-cohort file but still imports ` +
                    `@tanstack/react-query. Use useTenantSWR / useTenantMutation ` +
                    `(keys in @/lib/swr-keys) and revalidate the same list key.`,
            );
        }
        expect(TANSTACK.test(src)).toBe(false);
    });

    it('migrated list is unique and non-empty', () => {
        expect(MIGRATED_FILES.length).toBeGreaterThan(0);
        expect(new Set(MIGRATED_FILES).size).toBe(MIGRATED_FILES.length);
    });

    (EXPECT_ZERO_TANSTACK_REPO_WIDE ? it : it.skip)(
        'no file under src/ imports @tanstack/react-query (final wave)',
        () => {
            const offenders = walk(SRC_DIR).filter((f) =>
                TANSTACK.test(fs.readFileSync(f, 'utf-8')),
            );
            expect(offenders).toEqual([]);
        },
    );
});
