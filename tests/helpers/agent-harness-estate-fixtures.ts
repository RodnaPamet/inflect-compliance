/**
 * Three fixture client estates (#3678).
 *
 * The owner's decision of 2026-10-18 on #3678: client estates are scheduled
 * when they are named in step 0e, and until then the per-estate schedule
 * health is built and tested on fixture estates. These are those. Each is
 * what an operator would write twice — once as the scanner's configuration in
 * the client's estate, once as the estate declared in the tenant — and the
 * tests hold the two together: the same cadence, the same source kinds, and an
 * owner for every source.
 *
 * Hosts are the fakes' (`agent-harness-source-fakes.ts`). No value here is a
 * credential: every secret is named by an environment variable.
 */
import { AZURE_CLIENT_ID, AZURE_TENANT, INGEST, OKTA_ORG, VAULT } from './agent-harness-source-fakes';

export const GLOBEX_OKTA_ORG = 'https://globex.okta.com';
export const INITECH_VAULT = 'https://initech-agents.vault.azure.net';

export interface EstateFixture {
    /** The estate's name in the tenant. */
    readonly name: string;
    readonly cadenceHours: number;
    /** Which person owns each source: the tests seed one member per role. */
    readonly sources: readonly { readonly kind: 'okta-app' | 'vault'; readonly ownerRole: 'identity' | 'secrets' }[];
    /** The scanner's configuration file, as the operator writes it. `scanner.agentId` is replaced per tenant. */
    readonly scannerConfig: Readonly<Record<string, unknown>>;
}

const okta = (orgUrl: string, apiTokenEnv: string) => ({ kind: 'okta-app', orgUrl, apiTokenEnv });
const vault = (vaultUrl: string, clientSecretEnv: string) => ({
    kind: 'vault',
    product: 'azure-key-vault',
    vaultUrls: [vaultUrl],
    directoryTenantId: AZURE_TENANT,
    clientId: AZURE_CLIENT_ID,
    clientSecretEnv,
});
const config = (estate: string, everyHours: number, sources: unknown[]) => ({
    estate,
    scanner: { agentId: 'agt_placeholder', signingKeyEnv: 'SCANNER_SIGNING_KEY' },
    inflect: { baseUrl: INGEST, tenantSlug: 'acme', apiKeyEnv: 'INFLECT_INGEST_KEY' },
    schedule: { everyHours },
    sources,
});

export const CLIENT_ESTATES: readonly EstateFixture[] = [
    {
        name: 'Acme production',
        cadenceHours: 24,
        sources: [
            { kind: 'okta-app', ownerRole: 'identity' },
            { kind: 'vault', ownerRole: 'secrets' },
        ],
        scannerConfig: config('acme-prod', 24, [okta(OKTA_ORG, 'ACME_OKTA_API_TOKEN'), vault(VAULT, 'ACME_AZURE_CLIENT_SECRET')]),
    },
    {
        name: 'Globex identity',
        cadenceHours: 12,
        sources: [{ kind: 'okta-app', ownerRole: 'identity' }],
        scannerConfig: config('globex-idp', 12, [okta(GLOBEX_OKTA_ORG, 'GLOBEX_OKTA_API_TOKEN')]),
    },
    {
        name: 'Initech secrets',
        cadenceHours: 24,
        sources: [{ kind: 'vault', ownerRole: 'secrets' }],
        scannerConfig: config('initech-vault', 24, [vault(INITECH_VAULT, 'INITECH_AZURE_CLIENT_SECRET')]),
    },
];
