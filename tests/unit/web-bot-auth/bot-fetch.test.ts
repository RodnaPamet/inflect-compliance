/**
 * Web Bot Auth Phase 2 — `botFetch`, the one bot seam.
 *
 * Invariants:
 *   - every request is `safeFetch` (the SSRF guard), signed or not;
 *   - no key configured ⇒ the request goes out unsigned, exactly as before (G9);
 *   - a key configured ⇒ every request carries the three signature headers
 *     and the honest User-Agent naming the bot page (D-L1-6);
 *   - the caller cannot supply a User-Agent or a signature header, and the
 *     headers are the same whichever tenant's request context is active (D-L1-5);
 *   - the bot sends GET and HEAD only.
 */
const mockEnv: Record<string, string | undefined> = {};
jest.mock('@/env', () => ({ env: mockEnv }));

const mockSafeFetch = jest.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }));
jest.mock('@/app-layer/automation/webhook-safety', () => ({
    ...jest.requireActual('@/app-layer/automation/webhook-safety'),
    safeFetch: (url: string, init?: RequestInit) => mockSafeFetch(url, init),
}));

import { runWithRequestContext } from '@/lib/observability/context';
import {
    botFetch,
    resetDeploymentBotSignerForTests,
    VENDOR_MONITOR_BOT_PAGE_PATH,
    VENDOR_MONITOR_BOT_TOKEN,
    vendorMonitorBotFacts,
    vendorMonitorUserAgent,
} from '@/lib/web-bot-auth/bot-fetch';
import { webBotAuthKeyFromSeed, type WebBotAuthKey } from '@/lib/web-bot-auth/key';

// Fixture seed, not a credential.
const SEED = '4f3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e'; // pragma: allowlist secret
const KEY = webBotAuthKeyFromSeed(SEED) as WebBotAuthKey;

function configure(overrides: Record<string, string | undefined> = {}) {
    for (const k of Object.keys(mockEnv)) delete mockEnv[k];
    Object.assign(mockEnv, {
        NODE_ENV: 'production',
        APP_URL: 'https://app.inflect.example',
        DATA_ENCRYPTION_KEY: 'a-real-production-key-at-least-32-chars-long-deterministic',
        WEB_BOT_AUTH_SIGNING_KEY: SEED,
        ...overrides,
    });
    resetDeploymentBotSignerForTests();
}

const sentHeaders = (call = 0) => (mockSafeFetch.mock.calls[call]?.[1]?.headers ?? {}) as Record<string, string>;

beforeEach(() => mockSafeFetch.mockClear());

describe('every request goes through safeFetch', () => {
    it('hands the URL, the method and the signal to safeFetch unchanged', async () => {
        configure();
        const signal = AbortSignal.timeout(1000);
        await botFetch('https://vendor.example/', { method: 'HEAD', signal });
        expect(mockSafeFetch).toHaveBeenCalledTimes(1);
        expect(mockSafeFetch.mock.calls[0][0]).toBe('https://vendor.example/');
        expect(mockSafeFetch.mock.calls[0][1]).toMatchObject({ method: 'HEAD', signal });
    });

    it('sends GET and HEAD only', async () => {
        configure();
        // @ts-expect-error — POST is not a bot method, and is refused at run time too.
        await expect(botFetch('https://vendor.example/', { method: 'POST' })).rejects.toThrow(/GET and HEAD/);
        expect(mockSafeFetch).not.toHaveBeenCalled();
    });
});

describe('absent key, unsigned as before (G9)', () => {
    it('sends the honest User-Agent and no signature header when no key is configured', async () => {
        configure({ WEB_BOT_AUTH_SIGNING_KEY: undefined });
        await botFetch('https://vendor.example/');
        expect(Object.keys(sentHeaders()).sort()).toEqual(['User-Agent']);
        expect(vendorMonitorBotFacts()).toMatchObject({ directoryUrl: null, keyid: null });
    });

    it('sends unsigned when the key is refused (a published test seed in production)', async () => {
        configure({ WEB_BOT_AUTH_SIGNING_KEY: Buffer.from('n4Ni-HpISpVObnQMW0wOhCKROaIKqKtW_2ZYb2p9KcU', 'base64url').toString('hex') });
        await botFetch('https://vendor.example/');
        expect(sentHeaders()).not.toHaveProperty('Signature');
    });
});

describe('a configured key signs every request', () => {
    it('adds the three signature headers, naming the deployment directory and the current key', async () => {
        configure();
        await botFetch('https://vendor.example/pricing');
        const h = sentHeaders();
        expect(h['Signature-Agent']).toBe('"https://app.inflect.example/.well-known/http-message-signatures-directory"');
        expect(h['Signature-Input']).toContain(`keyid="${KEY.keyid}"`);
        expect(h['Signature-Input']).toContain('tag="web-bot-auth"');
        expect(h.Signature).toMatch(/^sig1=:/);
    });

    it('signs each request on its own (a retry is never a replay)', async () => {
        configure();
        await botFetch('https://vendor.example/');
        await botFetch('https://vendor.example/');
        expect(sentHeaders(0).Signature).not.toBe(sentHeaders(1).Signature);
    });

    it('never signs with the previous key, which is published only for verifiers', async () => {
        configure({ WEB_BOT_AUTH_PREVIOUS_SIGNING_KEY: '1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' }); // pragma: allowlist secret
        await botFetch('https://vendor.example/');
        expect(sentHeaders()['Signature-Input']).toContain(`keyid="${KEY.keyid}"`);
    });
});

describe('an honest User-Agent (D-L1-6)', () => {
    it('names the bot token and links its public page on the operator origin', () => {
        expect(vendorMonitorUserAgent('https://app.inflect.example')).toBe(
            `${VENDOR_MONITOR_BOT_TOKEN}/1.1 (+https://app.inflect.example${VENDOR_MONITOR_BOT_PAGE_PATH})`,
        );
    });

    it('leaves the link off when APP_URL is not a bare https origin, and never looks like a browser', () => {
        expect(vendorMonitorUserAgent('http://localhost:3000')).toBe(`${VENDOR_MONITOR_BOT_TOKEN}/1.1`);
        expect(vendorMonitorUserAgent('https://app.inflect.example')).not.toMatch(/Mozilla|Chrome|Safari|Gecko/);
    });

    it('refuses a caller-supplied User-Agent or signature header rather than sending it', async () => {
        configure();
        for (const name of ['User-Agent', 'user-agent', 'Signature', 'signature-input', 'Signature-Agent']) {
            await expect(botFetch('https://vendor.example/', { headers: { [name]: 'x' } })).rejects.toThrow(/seam/);
        }
        expect(mockSafeFetch).not.toHaveBeenCalled();
    });
});

describe('the identity is the deployment, never a tenant (D-L1-5)', () => {
    it('sends the same header names and the same non-random values under any tenant context', async () => {
        configure();
        const tenants = [
            { tenantId: 'tenant-acme', tenantSlug: 'acme' },
            { tenantId: 'tenant-globex', tenantSlug: 'globex' },
        ];
        for (const t of tenants) {
            await runWithRequestContext(
                { requestId: `req-${t.tenantSlug}`, tenantId: t.tenantId, userId: 'user-1', startTime: Date.now() },
                () => botFetch('https://vendor.example/'),
            );
        }
        await botFetch('https://vendor.example/');
        const stable = (h: Record<string, string>) => ({
            names: Object.keys(h).sort(),
            ua: h['User-Agent'],
            agent: h['Signature-Agent'],
            input: h['Signature-Input'].replace(/;created=\d+;expires=\d+/, '').replace(/nonce="[^"]+"/, 'nonce=_'),
        });
        expect(stable(sentHeaders(0))).toEqual(stable(sentHeaders(2)));
        expect(stable(sentHeaders(1))).toEqual(stable(sentHeaders(2)));
        for (let i = 0; i < 3; i++) {
            const all = JSON.stringify(sentHeaders(i));
            for (const t of tenants) {
                expect(all).not.toContain(t.tenantId);
                expect(all).not.toContain(t.tenantSlug);
            }
        }
    });
});
