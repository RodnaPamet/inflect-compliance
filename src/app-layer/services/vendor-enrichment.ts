/**
 * Vendor Enrichment Provider Interface + Test Implementation
 *
 * Clean interface for swapping real enrichment later (Clearbit, etc.).
 * TestModeProvider returns deterministic data for CI-safe tests.
 */

export interface EnrichmentResult {
    companyName?: string;
    country?: string;
    privacyPolicyUrl?: string;
    securityPageUrl?: string;
    certifications?: string[];
    description?: string;
}

export interface EnrichmentProvider {
    name: string;
    enrich(domain: string): Promise<EnrichmentResult>;
}

/**
 * Deterministic test provider — always returns predictable data based on domain hash.
 */
export class TestModeEnrichmentProvider implements EnrichmentProvider {
    name = 'TEST_MODE';

    async enrich(domain: string): Promise<EnrichmentResult> {
        const hash = simpleHash(domain);
        const hasSoc2 = hash % 3 !== 0;
        const hasIso = hash % 2 === 0;

        return {
            companyName: `${capitalize(domain.split('.')[0])} Inc.`,
            country: ['US', 'UK', 'DE', 'JP', 'AU'][hash % 5],
            privacyPolicyUrl: `https://${domain}/privacy`,
            securityPageUrl: `https://${domain}/security`,
            certifications: [
                ...(hasSoc2 ? ['SOC2'] : []),
                ...(hasIso ? ['ISO27001'] : []),
            ],
            description: `${capitalize(domain.split('.')[0])} provides enterprise services.`,
        };
    }
}

/**
 * Get the enrichment provider. Only the test provider exists.
 *
 * A homepage-scraping provider (`SimpleMetadataProvider`) used to live here.
 * Nothing selected it, and it requested the tenant-entered vendor domain with
 * a bare `fetch` that followed redirects, under a User-Agent posing as a
 * browser. It was deleted rather than kept as an SSRF sink waiting for a
 * caller (docs/ai-architecture/web-bot-auth.md, Phase 0.6). A real provider
 * that fetches vendor sites goes through `safeFetch`, as the TLS grade does.
 */
export function getEnrichmentProvider(): EnrichmentProvider {
    return new TestModeEnrichmentProvider();
}

function simpleHash(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return Math.abs(h);
}

function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}
