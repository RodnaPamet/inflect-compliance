/**
 * Onboarding framework-catalog ratchet.
 *
 * The Frameworks step of the setup wizard MUST be data-driven off the
 * installable-framework catalog — never a hand-maintained literal list.
 * It once hardcoded exactly two cards (ISO 27001 + NIS2) across three
 * layers (picker, control-install labels, the install pack map), so the
 * picker silently drifted from the catalog as frameworks were added.
 *
 * This locks the dynamic wiring in place:
 *   - the catalog usecase + the onboarding API route exist and are wired,
 *   - the picker fetches the route and carries no hardcoded framework list,
 *   - the installer resolves packs dynamically (no framework→pack literal map),
 *   - framework-key matching is case-insensitive end-to-end.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// Importing through the barrel verifies the export wiring compiles.
import { listInstallableFrameworks } from '@/app-layer/usecases/framework';

import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

describe('onboarding framework catalog — usecase + route', () => {
    it('exposes listInstallableFrameworks from the framework barrel', () => {
        expect(typeof listInstallableFrameworks).toBe('function');
    });

    it('the catalog usecase filters to frameworks that ship a pack', () => {
        const src = read('src/app-layer/usecases/framework/catalog.ts');
        expect(src).toContain('export async function listInstallableFrameworks');
        // Only frameworks with at least one installable pack are returned.
        expect(src).toMatch(/packs:\s*\{\s*some:\s*\{\s*\}\s*\}/);
        // Control count is summed from the packs' template links.
        expect(src).toContain('templateLinks');
    });

    it('the catalog usecase resolves packs per framework, case-insensitively', () => {
        const src = read('src/app-layer/usecases/framework/catalog.ts');
        expect(src).toContain('export async function resolveFrameworkPackKeys');
        expect(src).toMatch(/frameworkPack\.findMany/);
        expect(src).toMatch(/p\.framework\.key\.toLowerCase\(\)/);
    });

    it('the onboarding/frameworks route is wired to the usecase', () => {
        const src = read('src/app/api/t/[tenantSlug]/onboarding/frameworks/route.ts');
        expect(src).toContain('withApiErrorHandling');
        expect(src).toContain('listInstallableFrameworks');
        expect(src).toContain('getTenantCtx');
    });
});

describe('onboarding framework catalog — wizard picker is data-driven', () => {
    const src = read('src/components/onboarding/OnboardingWizard.tsx');

    it('fetches the installable-framework catalog instead of a literal list', () => {
        expect(src).toMatch(/apiFetch<InstallableFramework\[\]>\(apiUrl\(tenantSlug, 'frameworks'\)\)/);
    });

    it('carries no hardcoded framework copy in the picker', () => {
        // The old two-card array embedded these literal strings.
        expect(src).not.toContain('Installs 93 controls across 4 domains');
        expect(src).not.toContain('EU cybersecurity directive for essential and important entities');
    });

    it('matches selection case-insensitively so legacy lowercase keys clear', () => {
        // A pre-catalog onboarding state holds lowercase keys ('nis2'); the
        // card carries the canonical 'NIS2'. The picker must compare
        // case-insensitively (else the legacy selection can't be cleared and
        // the conditional NIS2 step is stuck on).
        expect(src).toMatch(/s\.toLowerCase\(\)\s*===\s*key\.toLowerCase\(\)/);
        expect(src).not.toMatch(/const active = selected\.includes\(fw\.key\)/);
    });

    it('does not relabel frameworks from a hardcoded {iso27001,nis2} map', () => {
        // ControlInstallStep + ReviewStep read frameworkLabels captured at
        // selection time, not a literal map.
        expect(src).not.toMatch(/iso27001:\s*'ISO 27001:2022',\s*nis2:/);
        expect(src).toContain('frameworkLabels');
    });
});

describe('onboarding framework catalog — installer is dynamic', () => {
    const src = read('src/app-layer/usecases/onboarding-automation.ts');

    it('removed the hardcoded framework→pack key map', () => {
        expect(src).not.toContain('FRAMEWORK_PACK_KEYS');
    });

    it('resolves a framework\'s packs via the catalog usecase (no direct prisma)', () => {
        expect(src).toMatch(/resolveFrameworkPackKeys\(ctx, selectedFrameworks\)/);
        // Layering: the installer never reaches for the global prisma client.
        expect(src).not.toContain("from '@/lib/prisma'");
    });

    it('matches starter-risk framework tags case-insensitively', () => {
        expect(src).toMatch(/selectedFrameworks\.map\(f\s*=>\s*f\.toLowerCase\(\)\)/);
    });
});
