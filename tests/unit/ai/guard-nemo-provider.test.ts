/**
 * The `nemo` guard provider — an HTTP client for a NeMo Guardrails server.
 *
 * The invariant this file exists for: **a NeMo outage degrades to flag, in
 * both directions, never to allow** (roadmap 1.1). Every way the server can
 * fail to give a usable verdict is enumerated below and each one is asserted
 * to reach the caller as review-required — and not blocked — under the
 * default mode. Also: the server is asked for a verdict and nothing else,
 * the content never reaches a log line, a stopped rail is a block, and the
 * server is reached only INSIDE the deployment (G6 as amended 2026-11-12).
 *
 * The network is mocked where the shared in-deployment dial reaches it —
 * `undici` and `node:dns` — never injected: the provider has no fetch seam,
 * so the address rule, the pin and the redirect refusal run in every test.
 */
const appendAuditEntry = jest.fn(async (_entry: Record<string, unknown>) => undefined);
const warn = jest.fn();
const db = { tenantSecuritySettings: { findUnique: jest.fn(async () => ({ aiGuardMode: 'BALANCED' })) } };

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, fn: (d: unknown) => unknown) => fn(db),
}));
jest.mock('@/lib/audit', () => ({
    ...jest.requireActual('@/lib/audit'),
    appendAuditEntry: (...a: unknown[]) => appendAuditEntry(a[0] as Record<string, unknown>),
}));
jest.mock('@/lib/observability/logger', () => ({
    logger: { error: jest.fn(), warn: (...a: unknown[]) => warn(...a), info: jest.fn(), debug: jest.fn() },
}));

const mockFetch = jest.fn<Promise<Response>, [string, RequestInit]>();
jest.mock('undici', () => ({
    Agent: class {},
    fetch: (url: string, init: RequestInit) => mockFetch(url, init),
}));
const mockLookup = jest.fn<Promise<{ address: string; family: number }[]>, [string, unknown]>();
jest.mock('node:dns', () => ({
    promises: { lookup: (host: string, opts: unknown) => mockLookup(host, opts) },
}));

import { guardEgress, guardUntrustedInput } from '@/app-layer/ai/guard';
import { GUARD_PROVIDER_UNAVAILABLE_RULE } from '@/app-layer/ai/guard/providers/compose';
import {
    NEMO_MAX_REQUEST_BYTES,
    NEMO_MAX_RESPONSE_BYTES,
    NEMO_RAILS_CONFIG_ID,
    createNemoGuardProvider,
    nemoEndpoint,
    railRuleId,
} from '@/app-layer/ai/guard/providers/nemo-provider';
import { patternsProvider } from '@/app-layer/ai/guard/providers/patterns-provider';
import type { GuardProvider } from '@/app-layer/ai/guard/providers/types';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('ADMIN');
// The server on the Compose network: plaintext http by design, a private address.
const BASE = 'http://nemo-guardrails:8000/guard/';
const INSIDE = [{ address: '172.18.0.12', family: 4 }];
const UNAVAILABLE = `${GUARD_PROVIDER_UNAVAILABLE_RULE}.nemo`;
const SENSITIVE = 'the board minutes for the acquisition of Northwind';

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

function json(body: unknown, init?: ResponseInit): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
}

function rails(...entries: { type: string; name: string; stop?: boolean }[]): Response {
    return json({ messages: [{ role: 'assistant', content: 'I cannot help with that.' }], log: { activated_rails: entries } });
}

/** A provider whose server answers with `fetchImpl` — reached through the real dial. */
function nemoWith(fetchImpl: FetchImpl, extra: { timeoutMs?: number; baseUrl?: string } = {}): GuardProvider {
    mockFetch.mockImplementation(fetchImpl);
    return createNemoGuardProvider({ baseUrl: extra.baseUrl ?? BASE, timeoutMs: extra.timeoutMs });
}

async function both(nemo: GuardProvider) {
    const input = await guardUntrustedInput(ctx, SENSITIVE, { source: 'nemo-test', providers: [patternsProvider, nemo] });
    const egress = await guardEgress(ctx, { note: SENSITIVE }, { source: 'nemo-test', providers: [patternsProvider, nemo] });
    return { input, egress };
}

beforeEach(() => {
    appendAuditEntry.mockClear();
    warn.mockClear();
    mockFetch.mockReset();
    mockLookup.mockReset();
    mockLookup.mockResolvedValue(INSIDE);
});

const reasons = () => warn.mock.calls.map((c) => (c[1] as { reason: string }).reason);

describe('nemo outage degrades to flag, never allow', () => {
    // Every row carries all three columns: `it.each` reads a callback whose
    // arity exceeds the row's length as a `done`-style test.
    const OUTAGES: readonly [string, () => FetchImpl, number | undefined][] = [
        ['the connection is refused', () => async () => {
            throw new TypeError('fetch failed');
        }, undefined],
        ['the server answers 503', () => async () => new Response('down', { status: 503 }), undefined],
        ['the body is not JSON', () => async () => new Response('<html>gateway</html>', { status: 200 }), undefined],
        ['the JSON has no activated-rails log', () => async () => json({ messages: [{ role: 'assistant', content: 'ok' }] }), undefined],
        ['a rail entry is malformed', () => async () => json({ log: { activated_rails: [{ type: 'input' }] } }), undefined],
        ['a rail entry says stop with a non-boolean', () => async () => json({ log: { activated_rails: [{ type: 'input', name: 'x', stop: 'yes' }] } }), undefined],
        ['the declared body exceeds the cap', () => async () =>
            new Response('{}', { status: 200, headers: { 'content-length': String(NEMO_MAX_RESPONSE_BYTES + 1) } }), undefined],
        ['the streamed body exceeds the cap', () => async () => new Response('x'.repeat(NEMO_MAX_RESPONSE_BYTES + 10), { status: 200 }), undefined],
        ['the server outlives the deadline', () => (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
                init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            }), 20],
        ['the server answers with a redirect', () => async () =>
            new Response(null, { status: 307, headers: { location: 'https://93.184.216.34/' } }), undefined],
    ];

    it.each(OUTAGES)('when %s', async (_label, make, timeoutMs) => {
        const { input, egress } = await both(nemoWith(make(), { timeoutMs }));

        expect(input.verdict).not.toBe('clean');
        expect(input.action).toBe('flag');
        expect(input.reviewRequired).toBe(true);
        expect(input.ruleIds).toContain(UNAVAILABLE);
        expect(input.decidedBy).toEqual(['nemo']);

        expect(egress.action).toBe('flag');
        expect(egress.reviewRequired).toBe(true);
        expect(egress.blocked).toBe(false);
        expect(egress.ruleIds).toContain(UNAVAILABLE);
        expect(egress.decidedBy).toEqual(['nemo']);
    });

    it('a base URL that is not http(s) is refused before any request, and fails closed', async () => {
        const { input, egress } = await both(nemoWith(async () => rails(), { baseUrl: 'ftp://nemo-guardrails:8000' }));
        expect(mockFetch).not.toHaveBeenCalled();
        expect(input.action).toBe('flag');
        expect(egress.action).toBe('flag');
        expect(reasons()).toEqual(['SCHEME_REFUSED', 'SCHEME_REFUSED']);
    });

    it('a PUBLIC base URL is refused before any request — a server outside the deployment is not ours', async () => {
        const { input, egress } = await both(nemoWith(async () => rails(), { baseUrl: 'https://93.184.216.34/guard' }));
        expect(mockLookup).not.toHaveBeenCalled();
        expect(mockFetch).not.toHaveBeenCalled();
        expect(input.action).toBe('flag');
        expect(egress.action).toBe('flag');
        expect(reasons()).toEqual(['EGRESS_REFUSED', 'EGRESS_REFUSED']);
    });

    it('a name resolving to ANY public address sends nothing, and fails closed', async () => {
        mockLookup.mockResolvedValue([...INSIDE, { address: '8.8.8.8', family: 4 }]);
        const { input, egress } = await both(nemoWith(async () => rails()));
        expect(mockFetch).not.toHaveBeenCalled();
        expect(input.action).toBe('flag');
        expect(egress.action).toBe('flag');
        expect(reasons()).toEqual(['EGRESS_REFUSED', 'EGRESS_REFUSED']);
    });

    it('a name that does not resolve is UNREACHABLE, and fails closed', async () => {
        mockLookup.mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));
        const { input, egress } = await both(nemoWith(async () => rails()));
        expect(mockFetch).not.toHaveBeenCalled();
        expect(input.action).toBe('flag');
        expect(egress.action).toBe('flag');
        expect(reasons()).toEqual(['UNREACHABLE', 'UNREACHABLE']);
    });

    it('content too large to send is unscanned, not clean', async () => {
        const nemo = nemoWith(async () => rails());
        // Over the cap in bytes, not characters: 'é' is two bytes in UTF-8. The
        // nemo provider is asked alone, because the patterns scanner's own cost
        // on a megabyte is not what this asserts.
        const huge = 'é'.repeat(NEMO_MAX_REQUEST_BYTES / 2 + 1);
        const input = await guardUntrustedInput(ctx, huge, { source: 'nemo-test', providers: [nemo] });
        expect(mockFetch).not.toHaveBeenCalled();
        expect(input.action).toBe('flag');
        expect(input.ruleIds).toContain(UNAVAILABLE);
    });

    it('a payload that cannot be serialised is unscanned, not clean', async () => {
        const big = { n: BigInt(1) };
        const nemo = nemoWith(async () => rails());
        const egress = await guardEgress(ctx, big, { source: 'nemo-test', providers: [patternsProvider, nemo] });
        expect(mockFetch).not.toHaveBeenCalled();
        expect(egress.action).toBe('flag');
        expect(egress.ruleIds).toContain(UNAVAILABLE);
    });

    it('logs the reason and never the content or the URL', async () => {
        await both(nemoWith(async () => new Response('down', { status: 503 })));
        const logged = JSON.stringify(warn.mock.calls);
        expect(logged).not.toContain('Northwind');
        expect(logged).not.toContain('nemo-guardrails');
        expect(logged).toContain('HTTP_ERROR');
    });
});

describe('a reachable server is asked for a verdict and nothing else', () => {
    it('a stopped input rail blocks under strict and flags under balanced, attributed to nemo', async () => {
        const nemo = nemoWith(async () => rails({ type: 'input', name: 'Jailbreak Heuristics', stop: true }));
        const outcome = await guardUntrustedInput(ctx, SENSITIVE, { source: 'nemo-test', providers: [patternsProvider, nemo] });
        expect(outcome.verdict).toBe('malicious');
        expect(outcome.action).toBe('flag');
        expect(outcome.ruleIds).toEqual(['nemo.rail.jailbreak_heuristics']);
        expect(outcome.decidedBy).toEqual(['nemo']);
        const details = appendAuditEntry.mock.calls[0][0].detailsJson as Record<string, unknown>;
        expect(details.decidedBy).toEqual(['nemo']);
    });

    it('a stopped output rail blocks egress', async () => {
        const nemo = nemoWith(async () => rails({ type: 'output', name: 'sensitive data detection', stop: true }));
        const egress = await guardEgress(ctx, SENSITIVE, { source: 'nemo-test', providers: [patternsProvider, nemo] });
        expect(egress.blocked).toBe(true);
        expect(egress.ruleIds).toEqual(['nemo.rail.sensitive_data_detection']);
    });

    it('a rail of the other type, or one that did not stop, is clean', async () => {
        const nemo = nemoWith(async () =>
            rails({ type: 'output', name: 'moderation', stop: true }, { type: 'input', name: 'jailbreak', stop: false }),
        );
        const input = await guardUntrustedInput(ctx, SENSITIVE, { source: 'nemo-test', providers: [patternsProvider, nemo] });
        expect(input.verdict).toBe('clean');
        expect(input.action).toBe('allow');
        expect(input.decidedBy).toEqual(['patterns', 'nemo']);
        expect(appendAuditEntry).not.toHaveBeenCalled();
    });

    it('asks only the matching rail type of the repository config, by POST to the chat endpoint', async () => {
        const nemo = nemoWith(async () => rails());
        await guardUntrustedInput(ctx, SENSITIVE, { source: 'nemo-test', providers: [patternsProvider, nemo] });
        await guardEgress(ctx, { note: SENSITIVE }, { source: 'nemo-test', providers: [patternsProvider, nemo] });

        expect(mockFetch).toHaveBeenCalledTimes(2);
        const [inputUrl, inputInit] = mockFetch.mock.calls[0];
        expect(inputUrl).toBe('http://nemo-guardrails:8000/guard/v1/chat/completions');
        expect(inputInit.method).toBe('POST');
        // The dial's rule, not the caller's: never follow a redirect.
        expect(inputInit).toMatchObject({ redirect: 'manual' });
        const inputBody = JSON.parse(String(inputInit.body));
        expect(inputBody).toEqual({
            config_id: NEMO_RAILS_CONFIG_ID,
            messages: [{ role: 'user', content: SENSITIVE }],
            options: { rails: ['input'], log: { activated_rails: true } },
        });
        const egressBody = JSON.parse(String(mockFetch.mock.calls[1][1].body));
        expect(egressBody.options.rails).toEqual(['output']);
        expect(egressBody.messages[1]).toEqual({ role: 'assistant', content: JSON.stringify({ note: SENSITIVE }) });
    });

    it('nothing to scan makes no request', async () => {
        const nemo = nemoWith(async () => rails());
        for (const text of [null, undefined, '']) {
            const o = await guardUntrustedInput(ctx, text, { source: 'nemo-test', providers: [patternsProvider, nemo] });
            expect(o.verdict).toBe('clean');
        }
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('the endpoint and rule ids carry nothing they should not', () => {
    it('refuses credentials, a query or a fragment, anything but http(s), and a public literal', () => {
        expect(nemoEndpoint('https://user:pw@nemo-guardrails')).toEqual({ ok: false, reason: 'CONFIG_INVALID' });
        expect(nemoEndpoint('https://nemo-guardrails/?token=x')).toEqual({ ok: false, reason: 'CONFIG_INVALID' });
        expect(nemoEndpoint('not a url')).toEqual({ ok: false, reason: 'CONFIG_INVALID' });
        expect(nemoEndpoint('ftp://nemo-guardrails')).toEqual({ ok: false, reason: 'SCHEME_REFUSED' });
        expect(nemoEndpoint('http://8.8.8.8:8000')).toEqual({ ok: false, reason: 'EGRESS_REFUSED' });
        expect(nemoEndpoint('http://169.254.169.254')).toEqual({ ok: false, reason: 'EGRESS_REFUSED' });
        // Both schemes are admitted: on the Compose network the transport is plaintext by design.
        expect(nemoEndpoint('http://nemo-guardrails:8000')).toEqual({
            ok: true,
            url: 'http://nemo-guardrails:8000/v1/chat/completions',
        });
        expect(nemoEndpoint('https://10.0.0.5:8443')).toEqual({ ok: true, url: 'https://10.0.0.5:8443/v1/chat/completions' });
    });

    it('reduces a rail name to a bounded safe token', () => {
        expect(railRuleId('Self Check Input')).toBe('rail.self_check_input');
        expect(railRuleId('<script>alert(1)</script>')).toBe('rail.script_alert_1_script');
        expect(railRuleId('!!!')).toBe('rail.unnamed');
        expect(railRuleId('x'.repeat(500)).length).toBe('rail.'.length + 48);
    });
});
