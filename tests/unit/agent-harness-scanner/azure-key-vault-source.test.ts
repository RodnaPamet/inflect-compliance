/**
 * The scanner's Azure Key Vault source over a fixture vault (#3678).
 *
 *   1. It reports each TAGGED, live credential against the principal its tag
 *      names, with the owner tag, and reports nothing for the rest — while
 *      counting every row it read.
 *   2. READ-ONLY and METADATA-ONLY, by its request log (DPIA condition 3): one
 *      POST, the token exchange to the identity platform; every other request a
 *      GET to a declared LIST path on a configured vault. It never requests a
 *      secret by name, which is the endpoint that returns the value — and the
 *      fake would return it.
 *   3. A vault it cannot read is INCOMPLETE with the contract's reason.
 */
import {
    AZURE_ACCESS_TOKEN_VALUE,
    AZURE_CLIENT_ID,
    AZURE_CLIENT_SECRET_VALUE,
    AZURE_TENANT,
    createSourceFakes,
    VAULT,
    VAULT_SECRET_VALUE,
    vaultFixture,
    type Fakes,
} from '../../helpers/agent-harness-source-fakes';
import { createSourceWire } from '../../../packages/agent-harness-scanner/src/http';
import { isDeclaredRequest } from '../../../packages/agent-harness-scanner/src/scanner-surface';
import { azureKeyVaultSource } from '../../../packages/agent-harness-scanner/src/sources/azure-key-vault';
import type { SourceRead } from '../../../packages/agent-harness-scanner/src/source';

const ASOF = new Date('2026-10-19T03:00:00.000Z');
const SECOND_VAULT = 'https://acme-legacy.vault.azure.net';

async function read(fakes: Fakes, opts: { secret?: string; vaultUrls?: string[] } = {}): Promise<SourceRead> {
    const wire = createSourceWire({ fetchImpl: fakes.fetchImpl, deadline: ASOF.getTime() + 60_000, now: () => ASOF.getTime() });
    const source = azureKeyVaultSource({
        vaultUrls: opts.vaultUrls ?? [VAULT],
        directoryTenantId: AZURE_TENANT,
        clientId: AZURE_CLIENT_ID,
        clientSecret: opts.secret ?? AZURE_CLIENT_SECRET_VALUE,
        principalTag: 'inflect-principal',
        ownerTag: 'owner',
    });
    return source.read({ asOf: ASOF, deadline: Number.MAX_SAFE_INTEGER, now: Date.now, ...wire });
}

describe('1. what the vault source reports', () => {
    it('one credential per tagged, live object, against the principal the tag names', async () => {
        const result = await read(createSourceFakes());

        // Five secrets and one certificate were read; three objects are reported.
        expect(result).toMatchObject({ kind: 'vault', status: 'COMPLETE', rows: 6 });
        expect(result.observations.map((o) => [o.discoveredId, o.credentials[0].ref])).toEqual([
            ['entra:sp:sales-bot', 'azure-kv://acme-agents.vault.azure.net/secrets/sales-bot-client'],
            ['okta:app:0oaService1', 'azure-kv://acme-agents.vault.azure.net/secrets/okta-service1'],
            ['entra:sp:cert-bot', 'azure-kv://acme-agents.vault.azure.net/certificates/cert-bot'],
        ]);
        const [sales, okta] = result.observations;
        expect(sales.owner).toEqual({ kind: 'user', id: 'bob@acme.example', source: 'azure-key-vault-tag' });
        // The current version's creation is the last rotation.
        expect(sales.credentials[0]).toMatchObject({ ageDays: 201, expires: false, boundToAgent: true, grant: 'unknown' });
        expect(okta.owner).toBeNull();
        expect(okta.credentials[0]).toMatchObject({ ageDays: 9, expires: true });
    });

    it('reads every configured vault as one source', async () => {
        const fakes = createSourceFakes({ vaults: { [VAULT]: vaultFixture(), [SECOND_VAULT]: vaultFixture(SECOND_VAULT) } });
        const result = await read(fakes, { vaultUrls: [VAULT, SECOND_VAULT] });
        expect(result).toMatchObject({ status: 'COMPLETE', rows: 12 });
        expect(result.observations.filter((o) => o.credentials[0].ref.includes('acme-legacy'))).toHaveLength(3);
    });
});

describe('2. read-only and metadata-only, by the request log', () => {
    it('one token exchange, then only GETs of the list paths — never a secret by name', async () => {
        const fakes = createSourceFakes();
        const result = await read(fakes);

        const [token, ...reads] = fakes.log;
        expect(token).toMatchObject({ method: 'POST', host: 'login.microsoftonline.com', path: `/${AZURE_TENANT}/oauth2/v2.0/token` });
        // Two pages of secrets, one of certificates.
        expect(reads.map((r) => `${r.method} ${r.host}${r.path}`)).toEqual([
            'GET acme-agents.vault.azure.net/secrets',
            'GET acme-agents.vault.azure.net/secrets',
            'GET acme-agents.vault.azure.net/certificates',
        ]);
        for (const r of fakes.log) expect(isDeclaredRequest(r.method, `https://${r.host}${r.path}${r.query}`)).toBe(true);
        expect(fakes.log.some((r) => /^\/secrets\/./.test(r.path))).toBe(false);

        const text = JSON.stringify(result);
        for (const secret of [VAULT_SECRET_VALUE, AZURE_CLIENT_SECRET_VALUE, AZURE_ACCESS_TOKEN_VALUE]) expect(text).not.toContain(secret);
    });
});

describe('3. a vault it cannot read is INCOMPLETE with a reason', () => {
    it('a rejected client secret is AUTH_FAILED, and no vault is asked anything', async () => {
        const fakes = createSourceFakes();
        expect(await read(fakes, { secret: 'wrong' })).toMatchObject({ status: 'INCOMPLETE', reason: 'AUTH_FAILED', rows: 0 });
        expect(fakes.log.map((r) => r.host)).toEqual(['login.microsoftonline.com']);
    });

    it('an identity without Key Vault Reader is AUTH_FAILED', async () => {
        const fakes = createSourceFakes();
        fakes.override = (r) => (r.host === 'acme-agents.vault.azure.net' ? { status: 403, body: { error: { code: 'Forbidden' } } } : undefined);
        expect(await read(fakes)).toMatchObject({ status: 'INCOMPLETE', reason: 'AUTH_FAILED' });
    });

    it('a second vault that fails makes the whole source INCOMPLETE, keeping the first vault\'s credentials', async () => {
        const fakes = createSourceFakes({ vaults: { [VAULT]: vaultFixture() } });
        const result = await read(fakes, { vaultUrls: [VAULT, SECOND_VAULT] });
        expect(result).toMatchObject({ status: 'INCOMPLETE', reason: 'UNREACHABLE', rows: 6 });
        expect(result.observations).toHaveLength(3);
    });

    it('a nextLink off the vault is not followed: PAGINATION_TORN', async () => {
        const fakes = createSourceFakes();
        fakes.override = (r) =>
            r.path === '/secrets'
                ? { status: 200, body: { value: [], nextLink: 'https://evil.example/secrets?$skiptoken=1' } }
                : undefined;
        expect(await read(fakes)).toMatchObject({ status: 'INCOMPLETE', reason: 'PAGINATION_TORN' });
        expect(fakes.log.some((r) => r.host === 'evil.example')).toBe(false);
    });

    it('an item whose id is not on this vault is a torn page', async () => {
        const fixture = vaultFixture();
        fixture.secrets[0].push({ id: 'https://other.vault.azure.net/secrets/x', attributes: { enabled: true } });
        expect(await read(createSourceFakes({ vaults: { [VAULT]: fixture } }))).toMatchObject({
            status: 'INCOMPLETE',
            reason: 'PAGINATION_TORN',
        });
    });

    it('a token endpoint that is rate limiting is RATE_LIMITED', async () => {
        const fakes = createSourceFakes();
        fakes.override = (r) => (r.host === 'login.microsoftonline.com' ? { status: 429 } : undefined);
        expect(await read(fakes)).toMatchObject({ status: 'INCOMPLETE', reason: 'RATE_LIMITED' });
    });
});
