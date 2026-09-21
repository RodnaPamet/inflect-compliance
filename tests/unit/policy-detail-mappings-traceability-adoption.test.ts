/**
 * Structural ratchet — Policy detail Mappings + Traceability tabs.
 *
 * Mirrors the Asset detail page's canonical Mappings + Traceability
 * tabs on the Policy detail page:
 *   - A `mappings` tab rendering `<InheritedMappingsPanel>` against the
 *     policy's `/policies/<id>/mappings` endpoint (framework coverage
 *     inherited from the policy's linked controls).
 *   - A `traceability` tab rendering the lazy-loaded
 *     `<PolicyTraceabilityPanel>` against `/policies/<id>/traceability`
 *     (linked controls + risks/assets inherited via them).
 *
 * Same shape as the other policy-detail adoption ratchets — one
 * canonical pattern, one place to update if the contract changes.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM. Reads whose result
// is JSON.parse'd are left RAW on purpose: a catalogue is parsed as DATA, never
// matched as text, so masking it would only corrupt the parse.
import { codeOf } from '../helpers/source-blocks';

const POLICY_DETAIL = path.resolve(
    __dirname,
    '../../src/app/t/[tenantSlug]/(app)/policies/[policyId]/page.tsx',
);
const source = codeOf(readFileSync(POLICY_DETAIL, 'utf8'));
// Tab labels migrated to next-intl; resolve the keys against the catalog.
const EN_POLICIES = JSON.parse(
    readFileSync(path.resolve(__dirname, '../../messages/en.json'), 'utf8'),
).policies as { detail: Record<string, string> };

describe('Policy detail — Mappings + Traceability tabs', () => {
    it('declares both tabs in the tab bar', () => {
        expect(source).toMatch(/key:\s*'mappings'[\s\S]{0,60}label:\s*t\('detail\.tabMappings'\)/);
        expect(source).toMatch(/key:\s*'traceability'[\s\S]{0,60}label:\s*t\('detail\.tabTraceability'\)/);
        expect(EN_POLICIES.detail.tabMappings).toBe('Mappings');
        expect(EN_POLICIES.detail.tabTraceability).toBe('Traceability');
    });

    it('widens the active-tab union to include mappings + traceability', () => {
        expect(source).toMatch(/'mappings'\s*\|\s*'traceability'/);
    });

    it('renders InheritedMappingsPanel against the policy mappings endpoint', () => {
        expect(source).toMatch(
            /import\s*\{[^}]*\bInheritedMappingsPanel\b[^}]*\}\s*from\s*['"]@\/components\/InheritedMappingsPanel['"]/,
        );
        expect(source).toMatch(
            /tab === 'mappings'[\s\S]{0,200}<InheritedMappingsPanel[\s\S]{0,200}\/policies\/\$\{policyId\}\/mappings/,
        );
        expect(source).toMatch(/entityLabel="policy"/);
    });

    it('lazy-loads PolicyTraceabilityPanel and renders it against the traceability endpoint', () => {
        expect(source).toMatch(
            /dynamic\(\s*\(\)\s*=>\s*import\(['"]@\/components\/PolicyTraceabilityPanel['"]\)[\s\S]{0,120}ssr:\s*false/,
        );
        expect(source).toMatch(
            /tab === 'traceability'[\s\S]{0,200}<PolicyTraceabilityPanel[\s\S]{0,200}\/policies\/\$\{policyId\}\/traceability/,
        );
    });
});
