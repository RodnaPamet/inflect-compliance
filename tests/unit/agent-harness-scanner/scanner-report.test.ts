/**
 * The scanner end to end, over the fixture estate (#3678): config → both
 * sources → a signed `inflect-agent-harness/2` report (#3754) → the ingest.
 *
 *   1. The report verifies with the ingest's own verifier, under the key the
 *      tenant would register, and merges what the two sources saw.
 *   2. An unreadable source is IN the report, INCOMPLETE with its reason —
 *      never omitted — and the scan derives as incomplete.
 *   3. No credential reaches the report or a log line, and the scanner refuses
 *      to sign a body the ingest would refuse.
 *   4. The whole run's request log stays on the declared surface: GETs to the
 *      sources, one token exchange, one POST of the unchanged report.
 *   5. Caps are reported, not absorbed.
 */
import { generateKeyPairSync } from 'crypto';

import {
    AZURE_CLIENT_ID,
    AZURE_TENANT,
    createSourceFakes,
    INGEST,
    NEVER_REPORTED,
    OKTA_ORG,
    OKTA_TOKEN_VALUE,
    AZURE_CLIENT_SECRET_VALUE,
    SCANNER_OKTA_TOKEN_ID,
    VAULT,
} from '../../helpers/agent-harness-source-fakes';
import {
    HARNESS_CONTRACT_V2,
    isScanComplete,
    MAX_CREDENTIALS_PER_AGENT,
    MAX_UNBOUND_CREDENTIALS,
    verifyAndParseHarnessReport,
} from '@/lib/agentic/harness-contract';
import { parseScannerConfig, type ScannerConfig } from '../../../packages/agent-harness-scanner/src/config';
import { jsonLineLog } from '../../../packages/agent-harness-scanner/src/log';
import { buildReportBody, rawPublicKeyHex, ReportRefusedLocally, signReport } from '../../../packages/agent-harness-scanner/src/report';
import { loadSigningKey, runScan, scanAndPost } from '../../../packages/agent-harness-scanner/src/scan';
import { isDeclaredRequest, scannerManifestHash } from '../../../packages/agent-harness-scanner/src/scanner-surface';

const NOW = Date.parse('2026-10-19T03:00:00.000Z');
const API_KEY_VALUE = 'iflk_fake-ingest-key-4a';

function signingPem(): { pem: string; publicKeyHex: string } {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKeyHex: rawPublicKeyHex(publicKey) };
}

function config(): ScannerConfig {
    return parseScannerConfig({
        estate: 'acme-prod',
        scanner: { agentId: 'agt_scanner_acme', signingKeyEnv: 'SCANNER_SIGNING_KEY' },
        inflect: { baseUrl: INGEST, tenantSlug: 'acme', apiKeyEnv: 'INFLECT_INGEST_KEY' },
        schedule: { everyHours: 24 },
        sources: [
            { kind: 'okta-app', orgUrl: OKTA_ORG, apiTokenEnv: 'OKTA_API_TOKEN' },
            {
                kind: 'vault',
                product: 'azure-key-vault',
                vaultUrls: [VAULT],
                directoryTenantId: AZURE_TENANT,
                clientId: AZURE_CLIENT_ID,
                clientSecretEnv: 'AZURE_CLIENT_SECRET',
            },
        ],
    });
}

function setup(envOverrides: Record<string, string | undefined> = {}) {
    const key = signingPem();
    const lines: string[] = [];
    const env = {
        SCANNER_SIGNING_KEY: key.pem,
        INFLECT_INGEST_KEY: API_KEY_VALUE,
        OKTA_API_TOKEN: OKTA_TOKEN_VALUE,
        AZURE_CLIENT_SECRET: AZURE_CLIENT_SECRET_VALUE,
        ...envOverrides,
    };
    const fakes = createSourceFakes();
    const log = jsonLineLog((l) => lines.push(l));
    return { key, lines, env, fakes, deps: { config: config(), env, log, fetchImpl: fakes.fetchImpl, now: () => NOW } };
}

describe('1. a report the ingest verifies', () => {
    it('verifies under the registered key, and merges the two sources by principal', async () => {
        const { key, deps } = setup();
        const { raw, body } = await runScan(deps);

        const verdict = verifyAndParseHarnessReport(raw, [key.publicKeyHex]);
        expect(verdict).toMatchObject({ ok: true, complete: true, body: { contract: HARNESS_CONTRACT_V2 } });
        // Both sources report every credential against the principal it
        // belongs to, so neither sees one bound to no principal.
        expect(body.unboundCredentials).toEqual([]);
        expect(body.scan).toMatchObject({
            asOf: '2026-10-19T03:00:00.000Z',
            scanner: { agentId: 'agt_scanner_acme', manifestHash: scannerManifestHash() },
        });
        expect(body.scan.id).toMatch(/^acme-prod-20261019T030000Z-[0-9a-f]{8}$/);
        expect(body.population.sources).toEqual([
            { kind: 'okta-app', status: 'COMPLETE', rows: 6 },
            { kind: 'vault', status: 'COMPLETE', rows: 6 },
        ]);

        const agents = new Map(body.agents.map((a) => [a.discoveredId, a]));
        expect([...agents.keys()]).toEqual([
            'entra:sp:cert-bot',
            'entra:sp:sales-bot',
            'okta:api-token:00TToken1',
            'okta:api-token:00TToken2',
            'okta:app:0oaService1',
            'okta:app:0oaService2',
        ]);
        // The scanner's own Okta token is not among them (`/api-tokens/current`).
        expect(agents.has(`okta:api-token:${SCANNER_OKTA_TOKEN_ID}`)).toBe(false);
        // Seen by both: the identity source's owner, both sources' credentials.
        expect(agents.get('okta:app:0oaService1')).toMatchObject({
            discoveredVia: ['okta-app', 'vault'],
            owner: { id: 'jane.doe@acme.example', source: 'okta-app-profile' },
            credentials: [
                { ref: 'azure-kv://acme-agents.vault.azure.net/secrets/okta-service1' },
                { ref: 'okta://acme.okta.com/apps/0oaService1/oauth-client' },
            ],
        });
        // Seen only by the vault: still reported — that is what a shadow agent looks like from there.
        expect(agents.get('entra:sp:sales-bot')).toMatchObject({ discoveredVia: ['vault'], owner: { id: 'bob@acme.example' } });
        expect(body.agents.every((a) => a.registeredAgentId === null)).toBe(true);
        expect(body.findings).toEqual([]);
    });

    it('is refused by a tenant that trusts another key', async () => {
        const { deps } = setup();
        const { raw } = await runScan(deps);
        expect(verifyAndParseHarnessReport(raw, [signingPem().publicKeyHex])).toMatchObject({ ok: false, reason: 'UNTRUSTED_SIGNER' });
    });
});

describe('2. an unreadable source is in the report, INCOMPLETE with its reason', () => {
    it('a credential missing from the environment: AUTH_FAILED, the source still listed, the scan incomplete', async () => {
        const { key, deps, fakes } = setup({ OKTA_API_TOKEN: undefined });
        const { raw, body } = await runScan(deps);

        expect(body.population.sources).toEqual([
            { kind: 'okta-app', status: 'INCOMPLETE', reason: 'AUTH_FAILED', rows: 0 },
            { kind: 'vault', status: 'COMPLETE', rows: 6 },
        ]);
        expect(isScanComplete(body)).toBe(false);
        expect(verifyAndParseHarnessReport(raw, [key.publicKeyHex])).toMatchObject({ ok: true, complete: false });
        expect(body.findings).toEqual([
            { code: 'INCOMPLETE_SOURCE', discoveredId: null, severity: 'MEDIUM', evidence: 'source:okta-app#AUTH_FAILED' },
        ]);
        // Nothing was sent to the org whose credential was missing.
        expect(fakes.log.some((r) => r.host === 'acme.okta.com')).toBe(false);
    });

    it('an org that is down: UNREACHABLE, and the vault is still read', async () => {
        const { deps, fakes } = setup();
        fakes.override = (r) => (r.host === 'acme.okta.com' ? 'throw' : undefined);
        const { body } = await runScan(deps);
        expect(body.population.sources[0]).toEqual({ kind: 'okta-app', status: 'INCOMPLETE', reason: 'UNREACHABLE', rows: 0 });
        expect(body.population.sources[1]).toMatchObject({ kind: 'vault', status: 'COMPLETE' });
    });
});

describe('3. no credential in the report or the log, and nothing unsignable is signed', () => {
    it('no credential value reaches the report or a log line', async () => {
        const { deps, lines } = setup();
        const { raw } = await scanAndPost(deps).then(async () => runScan(deps));
        const logs = lines.join('');
        for (const secret of [...NEVER_REPORTED, API_KEY_VALUE]) {
            expect(raw).not.toContain(secret);
            expect(logs).not.toContain(secret);
        }
        expect(lines.length).toBeGreaterThan(0);
    });

    it('refuses to sign a body with a secret-shaped string, naming the path and not the value', () => {
        const { key } = setup();
        const keys = loadSigningKey(key.pem);
        const body = buildReportBody({ scanId: 's1', asOf: new Date(NOW), scannerAgentId: 'agt_scanner_acme' }, [
            {
                kind: 'vault',
                status: 'COMPLETE',
                rows: 1,
                observations: [
                    {
                        discoveredId: 'entra:sp:x',
                        // A token pasted into an owner tag. Built from fragments.
                        owner: { kind: 'user', id: ['gh', 'p_', 'Q'.repeat(36)].join(''), source: 'azure-key-vault-tag' },
                        credentials: [],
                        verdicts: [],
                    },
                ],
            },
        ]);
        let thrown: unknown;
        try {
            signReport(body, keys);
        } catch (err) {
            thrown = err;
        }
        expect(thrown).toBeInstanceOf(ReportRefusedLocally);
        expect((thrown as Error).message).toContain('agents[0].owner.id');
        expect((thrown as Error).message).not.toContain('Q'.repeat(36));
    });
});

describe('4. the whole run stays on the declared surface', () => {
    it('GETs to the sources, one token exchange, and one POST of the unchanged report', async () => {
        const { deps, fakes } = setup();
        const result = await scanAndPost(deps);
        expect(result).toMatchObject({ ok: true, status: 201 });

        for (const r of fakes.log) expect(isDeclaredRequest(r.method, `https://${r.host}${r.path}${r.query}`)).toBe(true);
        expect(fakes.log.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.host}${r.path}`)).toEqual([
            `POST login.microsoftonline.com/${AZURE_TENANT}/oauth2/v2.0/token`,
            'POST inflect.example.com/api/t/acme/admin/agents/harness-scans',
        ]);
        expect(fakes.ingestAuth).toEqual([`Bearer ${API_KEY_VALUE}`]);
        // Posted unchanged: the bytes that were signed.
        expect(fakes.posted).toHaveLength(1);
        expect(JSON.parse(fakes.posted[0]).signature.alg).toBe('ed25519');
    });

    it('reports an ingest refusal by its code', async () => {
        const { deps, fakes } = setup();
        fakes.ingest = () => ({ status: 409, body: { error: { message: 'harness_report_refused: REPLAY: scan x is already ingested' } } });
        expect(await scanAndPost(deps)).toEqual({ ok: false, status: 409, refusal: 'REPLAY', complete: null, agentCount: null });
    });
});

describe('5. caps are reported, not absorbed', () => {
    it('credentials past the per-agent cap are cut and their source marked BYTE_CAP', () => {
        const credentials = Array.from({ length: MAX_CREDENTIALS_PER_AGENT + 1 }, (_, i) => ({
            ref: `azure-kv://v.vault.azure.net/secrets/c${String(i).padStart(3, '0')}`,
            ageDays: 1,
            expires: true,
            boundToAgent: true,
            grant: 'unknown' as const,
        }));
        const body = buildReportBody({ scanId: 's1', asOf: new Date(NOW), scannerAgentId: 'agt' }, [
            { kind: 'vault', status: 'COMPLETE', rows: 101, observations: [{ discoveredId: 'entra:sp:many', owner: null, credentials, verdicts: [] }] },
        ]);
        expect(body.agents[0].credentials).toHaveLength(MAX_CREDENTIALS_PER_AGENT);
        expect(body.population.sources).toEqual([{ kind: 'vault', status: 'INCOMPLETE', reason: 'BYTE_CAP', rows: 101 }]);
    });

    it('verdicts collapse to the least favourable answer per criterion', () => {
        const body = buildReportBody({ scanId: 's1', asOf: new Date(NOW), scannerAgentId: 'agt' }, [
            {
                kind: 'okta-app',
                status: 'COMPLETE',
                rows: 1,
                observations: [
                    { discoveredId: 'okta:app:a', owner: null, credentials: [], verdicts: [{ criterion: 'H2.credential_bound', met: true, evidence: 'x' }] },
                ],
            },
            {
                kind: 'vault',
                status: 'COMPLETE',
                rows: 1,
                observations: [
                    { discoveredId: 'okta:app:a', owner: null, credentials: [], verdicts: [{ criterion: 'H2.credential_bound', met: false, evidence: 'y' }] },
                ],
            },
        ]);
        expect(body.agents[0].verdicts).toEqual([{ criterion: 'H2.credential_bound', met: false, evidence: 'y' }]);
    });
});

describe('6. unbound credentials: what a source saw bound to no principal, and held by none', () => {
    const identity = { scanId: 's1', asOf: new Date(NOW), scannerAgentId: 'agt' };
    const credential = (ref: string) => ({ ref, ageDays: 1, expires: true, boundToAgent: true, grant: 'unknown' as const });

    it('lists each once per source, sorted, minus any reference a principal holds — and the report verifies', () => {
        const body = buildReportBody(identity, [
            {
                kind: 'vault',
                status: 'COMPLETE',
                rows: 4,
                observations: [{ discoveredId: 'entra:sp:a', owner: null, credentials: [credential('azure-kv://v/secrets/held')], verdicts: [] }],
                unboundCredentials: ['azure-kv://v/secrets/zeta', 'azure-kv://v/secrets/alpha', 'azure-kv://v/secrets/alpha'],
            },
            {
                kind: 'okta-app',
                status: 'COMPLETE',
                rows: 1,
                observations: [],
                // Untagged in one source, an agent's in another: it is that agent's.
                unboundCredentials: ['azure-kv://v/secrets/held', 'okta://acme.okta.com/apps/0oa/oauth-client'],
            },
        ]);
        expect(body.unboundCredentials).toEqual([
            { ref: 'okta://acme.okta.com/apps/0oa/oauth-client', sourceKind: 'okta-app' },
            { ref: 'azure-kv://v/secrets/alpha', sourceKind: 'vault' },
            { ref: 'azure-kv://v/secrets/zeta', sourceKind: 'vault' },
        ]);
        const { privateKey, publicKey } = generateKeyPairSync('ed25519');
        const raw = signReport(body, { privateKey, publicKey });
        expect(verifyAndParseHarnessReport(raw, [rawPublicKeyHex(publicKey)])).toMatchObject({ ok: true, complete: true });
    });

    it('a credential cut from an agent by the per-agent cap is still that agent\'s, never unbound', () => {
        const many = Array.from({ length: MAX_CREDENTIALS_PER_AGENT + 1 }, (_, i) =>
            credential(`azure-kv://v/secrets/c${String(i).padStart(3, '0')}`),
        );
        const cut = many[many.length - 1].ref;
        const body = buildReportBody(identity, [
            { kind: 'vault', status: 'COMPLETE', rows: 101, observations: [{ discoveredId: 'entra:sp:many', owner: null, credentials: many, verdicts: [] }], unboundCredentials: [cut] },
        ]);
        expect(body.agents[0].credentials.map((c) => c.ref)).not.toContain(cut);
        expect(body.unboundCredentials).toEqual([]);
    });

    it('past the cap the overflow is cut and its source marked BYTE_CAP', () => {
        const refs = Array.from({ length: MAX_UNBOUND_CREDENTIALS + 1 }, (_, i) => `azure-kv://v/secrets/u${String(i).padStart(5, '0')}`);
        const body = buildReportBody(identity, [
            { kind: 'vault', status: 'COMPLETE', rows: refs.length, observations: [], unboundCredentials: refs },
        ]);
        expect(body.unboundCredentials).toHaveLength(MAX_UNBOUND_CREDENTIALS);
        expect(body.population.sources).toEqual([{ kind: 'vault', status: 'INCOMPLETE', reason: 'BYTE_CAP', rows: refs.length }]);
    });
});
