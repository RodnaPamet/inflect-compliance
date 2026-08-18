/**
 * "Test connection" must be able to fail.
 *
 * validateConnection used to parse the service-account JSON, confirm two fields
 * were present, and return `{ valid: true }`. It never contacted Google. So an
 * operator testing a connection whose domain-wide-delegation grant had been
 * REVOKED got a pass, and the failure surfaced later in a background sync —
 * where, until the OAuth-400 classification landed, it also failed to mark the
 * connection. Green test, failing syncs, nothing recorded anywhere.
 *
 * A validateConnection that cannot fail is worse than not having one: it
 * launders an untested connection as verified.
 */
import { GoogleWorkspaceProvider } from '@/app-layer/integrations/providers/google-workspace';
import { IntegrationAuthError } from '@/app-layer/integrations/http-resilience';

const SA_JSON = JSON.stringify({ client_email: 'svc@x.iam.gserviceaccount.com', private_key: 'KEY' });
const CONFIG = { domain: 'acme.com', adminEmail: 'admin@acme.com' };
const SECRETS = { serviceAccountJson: SA_JSON };

const ok = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('validateConnection performs a real authenticated call', () => {
    it('fails when the DWD grant is revoked, instead of passing on a shape check', async () => {
        // The regression this exists for. Previously: valid: true.
        const provider = new GoogleWorkspaceProvider({
            getAccessToken: async () => {
                throw new IntegrationAuthError(400, 'https://oauth2.googleapis.com/token', 'invalid_grant');
            },
        });

        const result = await provider.validateConnection(CONFIG, SECRETS);
        expect(result.valid).toBe(false);
        expect(result.error).toMatch(/invalid_grant/);
    });

    it('fails when the directory read is refused, so a wrong scope is caught too', async () => {
        // A grant can exist with the wrong scopes: the token exchange succeeds
        // and the directory read 403s. Testing only the token would pass this.
        const provider = new GoogleWorkspaceProvider({
            getAccessToken: async () => 'tok',
            fetchImpl: (async () => new Response('{}', { status: 403 })) as unknown as typeof fetch,
        });

        const result = await provider.validateConnection(CONFIG, SECRETS);
        expect(result.valid).toBe(false);
        expect(result.error).toMatch(/403/);
        // Names what to check, since a 403 here is nearly always the scope.
        expect(result.error).toMatch(/admin@acme\.com/);
    });

    it('passes when the credentials genuinely work', async () => {
        // Guard against "fixing" this by making it always fail.
        const provider = new GoogleWorkspaceProvider({
            getAccessToken: async () => 'tok',
            fetchImpl: (async () => ok({ users: [] })) as unknown as typeof fetch,
        });

        await expect(provider.validateConnection(CONFIG, SECRETS)).resolves.toEqual({ valid: true });
    });

    it('does not surface an unclassified error verbatim', async () => {
        // An IntegrationAuthError message is URL-scrubbed by safeUrl and carries
        // only an allowlisted RFC code, so it is safe to show. An arbitrary
        // throw is not — it can carry a URL with a query string, or a key.
        const provider = new GoogleWorkspaceProvider({
            getAccessToken: async () => {
                throw new Error('connect ECONNREFUSED 10.0.0.5:443 while using key AIzaSyLEAKED');
            },
        });

        const result = await provider.validateConnection(CONFIG, SECRETS);
        expect(result.valid).toBe(false);
        expect(result.error).not.toMatch(/AIzaSyLEAKED/);
        expect(result.error).not.toMatch(/10\.0\.0\.5/);
    });

    it('still rejects a malformed key before making any request', async () => {
        const fetchImpl = jest.fn();
        const provider = new GoogleWorkspaceProvider({
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });

        const result = await provider.validateConnection(CONFIG, { serviceAccountJson: '{not json' });
        expect(result.valid).toBe(false);
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
