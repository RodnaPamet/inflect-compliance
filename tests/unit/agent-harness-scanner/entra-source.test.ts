/**
 * The scanner's Entra source over a fixture directory (#3686).
 *
 *   1. WHICH PRINCIPALS (owner decision 1, 2026-10-19): an application service
 *      principal of an app registered in this directory, and every managed
 *      identity — never Microsoft's own, a third-party app only when the
 *      estate opts in, a disabled one never.
 *   2. WHAT IS REPORTED: credentials by reference from the registration and
 *      the principal (a SAML signing certificate is not one), the owner, and
 *      `H2.credential_bound` only where it holds.
 *   3. UNBOUND: a credential on a registration with no principal here.
 *   4. READ-ONLY, by the request log: one token exchange for the Graph
 *      audience, then GETs of the two declared listings — and the members Graph
 *      adds (a secret's hint, display names, notes) never leave the page.
 *   5. A read that stops is INCOMPLETE with the contract's reason, and claims
 *      no unbound credential.
 *   6. Through the runner: a signed report the ingest's verifier accepts.
 */
import { generateKeyPairSync } from 'crypto';

import {
    AZURE_CLIENT_ID,
    AZURE_CLIENT_SECRET_VALUE,
    createSourceFakes,
    ENTRA,
    ENTRA_DIRECTORY_ID,
    ENTRA_MARKERS,
    GRAPH,
    graphFixture,
    INGEST,
    NEVER_REPORTED,
    type Fakes,
} from '../../helpers/agent-harness-source-fakes';
import { verifyAndParseHarnessReport } from '@/lib/agentic/harness-contract';
import { ConfigError, credentialEnvNames, parseScannerConfig } from '../../../packages/agent-harness-scanner/src/config';
import { createSourceWire } from '../../../packages/agent-harness-scanner/src/http';
import { jsonLineLog } from '../../../packages/agent-harness-scanner/src/log';
import { rawPublicKeyHex } from '../../../packages/agent-harness-scanner/src/report';
import { runScan } from '../../../packages/agent-harness-scanner/src/scan';
import { isDeclaredRequest } from '../../../packages/agent-harness-scanner/src/scanner-surface';
import { entraSource } from '../../../packages/agent-harness-scanner/src/sources/entra';
import type { SourceRead } from '../../../packages/agent-harness-scanner/src/source';

const ASOF = new Date('2026-10-19T03:00:00.000Z');

async function read(fakes: Fakes, opts: { thirdParty?: boolean; secret?: string } = {}): Promise<SourceRead> {
    const wire = createSourceWire({ fetchImpl: fakes.fetchImpl, deadline: ASOF.getTime() + 60_000, now: () => ASOF.getTime() });
    const source = entraSource({
        directoryId: ENTRA_DIRECTORY_ID,
        clientId: AZURE_CLIENT_ID,
        clientSecret: opts.secret ?? AZURE_CLIENT_SECRET_VALUE,
        includeThirdPartyApplications: opts.thirdParty ?? false,
    });
    return source.read({ asOf: ASOF, deadline: Number.MAX_SAFE_INTEGER, now: Date.now, ...wire });
}

const sp = (id: string) => `entra:sp:${id}`;
const appRef = (appId: string, kind: 'password' | 'certificate', keyId: string) =>
    `entra://${ENTRA_DIRECTORY_ID}/applications/${appId}/${kind}/${keyId}`;

describe('1. which service principals are agents', () => {
    it('own-directory applications and managed identities; never Microsoft, a third party, or a disabled one', async () => {
        const result = await read(createSourceFakes());
        // Four registrations and six principals were read.
        expect(result).toMatchObject({ kind: 'entra-sp', status: 'COMPLETE', rows: 10 });
        expect(result.observations.map((o) => o.discoveredId)).toEqual([sp(ENTRA.spSupport), sp(ENTRA.spReporting), sp(ENTRA.spManaged)]);
    });

    it('a third-party application is reported only when the estate opts in, and Microsoft\'s still never is', async () => {
        const result = await read(createSourceFakes(), { thirdParty: true });
        const ids = result.observations.map((o) => o.discoveredId);
        expect(ids).toContain(sp(ENTRA.spThirdParty));
        expect(ids).not.toContain(sp(ENTRA.spGraph));
        expect(ids).not.toContain(sp(ENTRA.spDisabled));
        const third = result.observations.find((o) => o.discoveredId === sp(ENTRA.spThirdParty));
        expect(third?.credentials.map((c) => c.ref)).toEqual([
            `entra://${ENTRA_DIRECTORY_ID}/servicePrincipals/${ENTRA.spThirdParty}/password/${ENTRA.keyThirdPartyPasswordCred}`,
        ]);
    });
});

describe('2. what is reported for each', () => {
    it('credentials by reference from the registration, never a signing certificate, with the first user owner', async () => {
        const result = await read(createSourceFakes());
        const support = result.observations.find((o) => o.discoveredId === sp(ENTRA.spSupport));
        expect(support?.credentials).toEqual([
            {
                ref: appRef('e0000001-0000-4000-8000-000000003686', 'password', ENTRA.keySupportPasswordCred),
                ageDays: 110,
                expires: true,
                boundToAgent: true,
                grant: 'unknown',
            },
            {
                ref: appRef('e0000001-0000-4000-8000-000000003686', 'certificate', ENTRA.keySupportCert),
                ageDays: 48,
                expires: true,
                boundToAgent: true,
                grant: 'unknown',
            },
        ]);
        expect(JSON.stringify(support)).not.toContain(ENTRA.keySupportSaml);
        // The registration's owners: a principal is not a person, and the lower user id stands.
        expect(support?.owner).toEqual({ kind: 'user', id: ENTRA.userJane, source: 'entra-owner' });
        expect(support?.verdicts).toEqual([
            { criterion: 'H2.credential_bound', met: true, evidence: `entra-sp:servicePrincipals/${ENTRA.spSupport}#credentials` },
        ]);
    });

    it('no credential: no verdict; a registration with no owner falls back to the principal\'s', async () => {
        const result = await read(createSourceFakes());
        const reporting = result.observations.find((o) => o.discoveredId === sp(ENTRA.spReporting));
        expect(reporting).toMatchObject({ credentials: [], verdicts: [], owner: { kind: 'user', id: ENTRA.userZed } });
    });

    it('a managed identity: no listed credential, bound by construction', async () => {
        const result = await read(createSourceFakes());
        const managed = result.observations.find((o) => o.discoveredId === sp(ENTRA.spManaged));
        expect(managed).toMatchObject({ credentials: [], owner: null });
        expect(managed?.verdicts).toEqual([
            { criterion: 'H2.credential_bound', met: true, evidence: `entra-sp:servicePrincipals/${ENTRA.spManaged}#servicePrincipalType` },
        ]);
        // The grant kind is never claimed: the source does not read permissions.
        expect(result.observations.flatMap((o) => o.verdicts).some((v) => v.criterion === 'H2.grant_kind_declared')).toBe(false);
    });
});

describe('3. unbound credentials', () => {
    it('a credential on a registration with no principal in this directory, and nothing else', async () => {
        const result = await read(createSourceFakes());
        // The disabled principal's registration has a principal: its secret is that principal's, not unbound.
        expect(result.unboundCredentials).toEqual([appRef('e0000007-0000-4000-8000-000000003686', 'password', ENTRA.keyOrphanPasswordCred)]);
    });
});

describe('4. read-only, by the request log', () => {
    it('one token exchange for the Graph audience, then GETs of the two declared listings', async () => {
        const fakes = createSourceFakes();
        const result = await read(fakes);
        expect(result.status).toBe('COMPLETE');

        const [token, ...reads] = fakes.log;
        expect(token).toMatchObject({ method: 'POST', host: 'login.microsoftonline.com', path: `/${ENTRA_DIRECTORY_ID}/oauth2/v2.0/token` });
        expect(reads.map((r) => `${r.method} ${r.host}${r.path}`)).toEqual([
            'GET graph.microsoft.com/v1.0/applications',
            'GET graph.microsoft.com/v1.0/applications',
            'GET graph.microsoft.com/v1.0/servicePrincipals',
            'GET graph.microsoft.com/v1.0/servicePrincipals',
        ]);
        for (const r of fakes.log) expect(isDeclaredRequest(r.method, `https://${r.host}${r.path}`)).toBe(true);
        // The first page of each asks for the members it reads and the owners' ids, nothing wider.
        expect(decodeURIComponent(reads[0].query)).toContain('$select=id,appId,passwordCredentials,keyCredentials');
        expect(decodeURIComponent(reads[0].query)).toContain('$expand=owners($select=id)');
    });

    it('a secret\'s hint, display names and notes are dropped with the page', async () => {
        const result = await read(createSourceFakes(), { thirdParty: true });
        const text = JSON.stringify(result);
        for (const marker of Object.values(ENTRA_MARKERS)) expect(text).not.toContain(marker);
    });

    it('the declared surface holds a Graph path to Graph\'s host', () => {
        expect(isDeclaredRequest('GET', `${GRAPH}/v1.0/servicePrincipals`)).toBe(true);
        expect(isDeclaredRequest('GET', 'https://graph.example.com/v1.0/servicePrincipals')).toBe(false);
        expect(isDeclaredRequest('GET', `${GRAPH}/v1.0/applications/x/addPassword`)).toBe(false);
    });
});

describe('5. a read that stops is INCOMPLETE, with its reason, and claims no unbound credential', () => {
    it('a refused client secret is AUTH_FAILED before any listing', async () => {
        const fakes = createSourceFakes();
        const result = await read(fakes, { secret: 'not-the-secret' });
        expect(result).toMatchObject({ status: 'INCOMPLETE', reason: 'AUTH_FAILED', rows: 0, observations: [] });
        expect(fakes.log.filter((r) => r.host === 'graph.microsoft.com')).toHaveLength(0);
    });

    it('throttled on the principals: RATE_LIMITED, and no registration is called unbound', async () => {
        const fakes = createSourceFakes();
        fakes.override = (r) => (r.path === '/v1.0/servicePrincipals' ? { status: 429 } : undefined);
        const result = await read(fakes);
        expect(result).toMatchObject({ status: 'INCOMPLETE', reason: 'RATE_LIMITED', observations: [], unboundCredentials: [] });
    });

    it('a next link off Graph\'s host is PAGINATION_TORN, and is not followed', async () => {
        const fakes = createSourceFakes();
        fakes.override = (r) =>
            r.path === '/v1.0/applications'
                ? { status: 200, headers: { 'content-type': 'application/json' }, raw: JSON.stringify({ value: [], '@odata.nextLink': 'https://evil.example/v1.0/applications' }) }
                : undefined;
        const result = await read(fakes);
        expect(result).toMatchObject({ status: 'INCOMPLETE', reason: 'PAGINATION_TORN' });
        expect(fakes.log.some((r) => r.host === 'evil.example')).toBe(false);
    });

    it('a credential without a key id tears the page rather than being skipped', async () => {
        const graph = graphFixture();
        (graph.applications[0][0] as { passwordCredentials: unknown[] }).passwordCredentials = [{ startDateTime: '2026-01-01T00:00:00Z' }];
        const result = await read(createSourceFakes({ graph }));
        expect(result).toMatchObject({ status: 'INCOMPLETE', reason: 'PAGINATION_TORN' });
    });
});

describe('6. through the runner', () => {
    function entraConfig(extra: Record<string, unknown> = {}) {
        return {
            estate: 'contoso',
            scanner: { agentId: 'agt_scanner_contoso', signingKeyEnv: 'SCANNER_SIGNING_KEY' },
            inflect: { baseUrl: INGEST, tenantSlug: 'contoso', apiKeyEnv: 'INFLECT_INGEST_KEY' },
            schedule: { everyHours: 24 },
            sources: [
                { kind: 'entra-sp', directoryId: ENTRA_DIRECTORY_ID, clientId: AZURE_CLIENT_ID, clientSecretEnv: 'ENTRA_CLIENT_SECRET', ...extra },
            ],
        };
    }

    it('a signed report the ingest verifies, carrying the unbound credential, and nothing it must not', async () => {
        const { privateKey, publicKey } = generateKeyPairSync('ed25519');
        const fakes = createSourceFakes();
        const lines: string[] = [];
        const { raw, body } = await runScan({
            config: parseScannerConfig(entraConfig()),
            env: {
                SCANNER_SIGNING_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
                INFLECT_INGEST_KEY: 'iflk_fake-ingest-key-3686',
                ENTRA_CLIENT_SECRET: AZURE_CLIENT_SECRET_VALUE,
            },
            log: jsonLineLog((l) => lines.push(l)),
            fetchImpl: fakes.fetchImpl,
            now: () => ASOF.getTime(),
        });

        const verdict = verifyAndParseHarnessReport(raw, [rawPublicKeyHex(publicKey)]);
        expect(verdict).toMatchObject({ ok: true, complete: true });
        expect(body.population.sources).toEqual([{ kind: 'entra-sp', status: 'COMPLETE', rows: 10 }]);
        expect(body.agents.map((a) => [a.discoveredId, a.discoveredVia, a.registeredAgentId])).toEqual([
            [sp(ENTRA.spSupport), ['entra-sp'], null],
            [sp(ENTRA.spReporting), ['entra-sp'], null],
            [sp(ENTRA.spManaged), ['entra-sp'], null],
        ]);
        expect(body.unboundCredentials).toEqual([
            { ref: appRef('e0000007-0000-4000-8000-000000003686', 'password', ENTRA.keyOrphanPasswordCred), sourceKind: 'entra-sp' },
        ]);
        const logText = lines.join('\n');
        for (const never of NEVER_REPORTED) {
            expect(raw).not.toContain(never);
            expect(logText).not.toContain(never);
        }
    });

    it('the configuration takes a directory GUID, never a domain, and has no field for anything but a read', () => {
        expect(credentialEnvNames(parseScannerConfig(entraConfig()))).toContain('ENTRA_CLIENT_SECRET');
        expect(() => parseScannerConfig({ ...entraConfig(), sources: [{ ...entraConfig().sources[0], directoryId: 'contoso.onmicrosoft.com' }] })).toThrow(ConfigError);
        expect(() => parseScannerConfig(entraConfig({ writeScope: 'Application.ReadWrite.All' }))).toThrow(ConfigError);
        expect(parseScannerConfig(entraConfig()).sources[0]).toMatchObject({ includeThirdPartyApplications: false });
    });
});
