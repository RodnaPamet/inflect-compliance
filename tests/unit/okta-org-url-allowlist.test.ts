/**
 * An Okta connection cannot redirect its own API token.
 *
 * `orgUrl` comes from configJson, which `upsertIntegrationConnection` stores
 * VERBATIM — no zod, no validation, for any provider — and FOUR credentialed
 * call sites send `SSWS <apiToken>` to whatever it says: validateConnection,
 * the user enumeration, the resume path, and the per-user enrichment.
 *
 * THE INTERESTING PART IS THAT THE DEFENCE ALREADY EXISTED. The resume cursor
 * is checked against `orgUrl` with a comment saying, correctly, that otherwise
 * "a tampered stored cursor would point our credentialed request at an
 * arbitrary host". Someone reasoned about exactly this threat and then anchored
 * the check to a value nobody validated — so the cursor was bound to `orgUrl`
 * and `orgUrl` was bound to nothing.
 *
 * That reads as covered in review, which is why it survived. Found by the
 * concurrent session sweeping configJson reads after the same class turned up
 * in Workday and ServiceNow.
 */
import { OktaProvider } from '@/app-layer/integrations/providers/okta';

const TOKEN = 'ssws-token';
const base = { apiToken: TOKEN };

const ok = () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => [] }) as unknown as Response;

/**
 * `jest.fn(async () => …)` infers a ZERO-length parameter tuple, so
 * `mock.calls[0][0]` will not compile — and WHICH URL was requested is the
 * assertion this file exists for. Typing the double as `fetch` is what makes
 * the argument inspectable.
 */
type FetchFn = jest.Mock<ReturnType<typeof fetch>, Parameters<typeof fetch>>;
const okFetch = (): FetchFn => jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(async () => ok());
const noFetch = (): FetchFn => jest.fn();

describe('the org URL is validated before the token is sent', () => {
    it.each([
        ['https://evil.example.com', 'unrelated domain'],
        ['https://okta.com.attacker.net', 'contains the domain, is not under it'],
        ['https://evil-okta.com', 'defeats a naive endsWith'],
        ['https://acme.okta.com@evil.example', 'userinfo — the real host is evil.example'],
    ])('validateConnection refuses %s (%s) WITHOUT making a request', async (orgUrl) => {
        const fetchImpl = noFetch();
        const p = new OktaProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });
        const r = await p.validateConnection({ orgUrl }, base);
        expect(r.valid).toBe(false);
        // The assertion that matters — a guard that throws after the request
        // has already handed over the token is not a guard.
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('the enumeration refuses an off-domain org too, not just the Test button', async () => {
        // Four call sites, one helper. A fix applied only to validateConnection
        // would leave the nightly sync shipping the token every night while the
        // Test button looked hardened.
        const fetchImpl = noFetch();
        const p = new OktaProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });
        await expect(p.listAccounts({ orgUrl: 'https://evil.example.com', ...base })).rejects.toThrow(/not a recognised Okta host/i);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it.each(['https://acme.okta.com', 'acme.okta.com', 'https://ACME.Okta.com/', 'https://dev-1.oktapreview.com'])(
        'accepts %s',
        async (orgUrl) => {
            const fetchImpl = okFetch();
            const p = new OktaProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });
            expect((await p.validateConnection({ orgUrl }, base)).valid).toBe(true);
        },
    );

    it('forces https, so config cannot downgrade the token to clear text', async () => {
        // `http://acme.okta.com` is in the allowed domain and would otherwise
        // send `SSWS <token>` unencrypted.
        const fetchImpl = okFetch();
        const p = new OktaProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });
        await p.validateConnection({ orgUrl: 'http://acme.okta.com' }, base);
        expect(String(fetchImpl.mock.calls[0][0])).toMatch(/^https:\/\/acme\.okta\.com\//);
    });

    it('still reports the friendly error when the field is simply empty', async () => {
        const p = new OktaProvider({ fetchImpl: (async () => ok()) as unknown as typeof fetch });
        expect((await p.validateConnection({ orgUrl: '' }, base)).error).toMatch(/required/i);
    });
});

describe('the resume cursor guard now has a validated anchor', () => {
    it('a cursor pointing off-domain is refused even though it is a full URL', async () => {
        // The pre-existing check: the cursor must start with the org URL. It
        // was correct in form and anchored to an unvalidated string.
        const fetchImpl = okFetch();
        const p = new OktaProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });
        await p.listAccounts({ orgUrl: 'https://acme.okta.com', ...base }, 'https://evil.example.com/api/v1/users?after=x');
        // Falls back to the org's own first page rather than following it.
        expect(String(fetchImpl.mock.calls[0][0])).toMatch(/^https:\/\/acme\.okta\.com\/api\/v1\/users/);
    });

    it('a cursor under the validated org IS followed', async () => {
        const fetchImpl = okFetch();
        const p = new OktaProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });
        const cursor = 'https://acme.okta.com/api/v1/users?after=abc';
        await p.listAccounts({ orgUrl: 'https://acme.okta.com', ...base }, cursor);
        expect(String(fetchImpl.mock.calls[0][0])).toBe(cursor);
    });
});
