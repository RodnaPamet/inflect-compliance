/**
 * PR-D — webhook SSRF guard.
 */
import { isPrivateAddress, checkWebhookUrl } from '@/app-layer/automation/webhook-safety';

describe('isPrivateAddress', () => {
    it.each(['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.0.1', '169.254.169.254', '::1', '0.0.0.0'])(
        'flags %s as private',
        (ip) => expect(isPrivateAddress(ip)).toBe(true),
    );
    it.each(['8.8.8.8', '93.184.216.34', '1.1.1.1'])('allows public %s', (ip) =>
        expect(isPrivateAddress(ip)).toBe(false),
    );
});

describe('checkWebhookUrl', () => {
    it('rejects non-https', () => {
        expect(checkWebhookUrl('http://example.com').ok).toBe(false);
    });
    it('rejects localhost + private literals + metadata', () => {
        expect(checkWebhookUrl('https://localhost/h').ok).toBe(false);
        expect(checkWebhookUrl('https://169.254.169.254/').ok).toBe(false);
        expect(checkWebhookUrl('https://10.0.0.1/h').ok).toBe(false);
        expect(checkWebhookUrl('https://foo.internal/h').ok).toBe(false);
    });
    it('accepts a well-formed public https URL', () => {
        const v = checkWebhookUrl('https://hooks.example.com/path');
        expect(v.ok).toBe(true);
        expect(v.host).toBe('hooks.example.com');
    });
    it('rejects a malformed URL', () => {
        expect(checkWebhookUrl('not a url').ok).toBe(false);
    });
});

// ─── Redirect refusal ───────────────────────────────────────────────
//
// The hole this closes: without `redirect: 'manual'`, fetch follows up to 20
// hops while `assertPublicAddress` validated only the FIRST url, and the
// undici IP pin does NOT survive a hop (Node's `net.connect` skips
// `options.lookup` for IP-literal hosts). An attacker-controlled public
// endpoint answering `302 Location: http://169.254.169.254/...` therefore
// reached cloud metadata with the scheme check, the host blocklist AND the pin
// all bypassed on the redirect leg.
//
// There was no redirect test at all before this.

describe('safeFetch — redirect handling', () => {
    const realFetch = global.fetch;
    let lastInit: RequestInit | undefined;

    beforeEach(() => {
        jest.resetModules();
        lastInit = undefined;
    });
    afterEach(() => {
        global.fetch = realFetch;
    });

    /** Stub DNS so the guard resolves to a public address without a network. */
    function mockPublicDns() {
        jest.doMock('node:dns', () => ({
            promises: {
                lookup: jest.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
            },
        }));
    }

    async function loadSafeFetch() {
        mockPublicDns();
        return await import('@/app-layer/automation/webhook-safety');
    }

    it('sends redirect:"manual" so fetch cannot follow a hop unchecked', async () => {
        const { safeFetch } = await loadSafeFetch();
        global.fetch = jest.fn(async (_u: unknown, init?: RequestInit) => {
            lastInit = init;
            return new Response('ok', { status: 200 });
        }) as unknown as typeof fetch;

        await safeFetch('https://hooks.example.com/path', { method: 'POST' });
        expect(lastInit?.redirect).toBe('manual');
    });

    it('applies redirect:"manual" AFTER the caller init — a caller cannot opt back in', async () => {
        const { safeFetch } = await loadSafeFetch();
        global.fetch = jest.fn(async (_u: unknown, init?: RequestInit) => {
            lastInit = init;
            return new Response('ok', { status: 200 });
        }) as unknown as typeof fetch;

        // A caller trying to restore the vulnerable behaviour must not win.
        await safeFetch('https://hooks.example.com/path', {
            method: 'POST',
            redirect: 'follow',
        });
        expect(lastInit?.redirect).toBe('manual');
    });

    it.each([301, 302, 303, 307, 308])('refuses a %s redirect instead of following it', async (status) => {
        const { safeFetch, RedirectNotAllowedError } = await loadSafeFetch();
        global.fetch = jest.fn(async () =>
            new Response(null, {
                status,
                headers: { location: 'http://169.254.169.254/latest/meta-data/' },
            }),
        ) as unknown as typeof fetch;

        await expect(safeFetch('https://hooks.example.com/path')).rejects.toBeInstanceOf(
            RedirectNotAllowedError,
        );
    });

    it('names the refused target so the operator can fix the endpoint', async () => {
        const { safeFetch } = await loadSafeFetch();
        global.fetch = jest.fn(async () =>
            new Response(null, {
                status: 302,
                headers: { location: 'http://169.254.169.254/latest/meta-data/' },
            }),
        ) as unknown as typeof fetch;

        await expect(safeFetch('https://hooks.example.com/path')).rejects.toThrow(
            /169\.254\.169\.254/,
        );
    });

    it('passes a normal 2xx straight through', async () => {
        const { safeFetch } = await loadSafeFetch();
        global.fetch = jest.fn(async () => new Response('body', { status: 201 })) as unknown as typeof fetch;

        const res = await safeFetch('https://hooks.example.com/path');
        expect(res.status).toBe(201);
    });

    it('does NOT treat a 4xx/5xx as a redirect', async () => {
        const { safeFetch } = await loadSafeFetch();
        global.fetch = jest.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;

        const res = await safeFetch('https://hooks.example.com/path');
        expect(res.status).toBe(500);
    });
});
