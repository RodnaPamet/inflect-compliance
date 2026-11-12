/**
 * The `nemo` guard provider — an HTTP client for a NeMo Guardrails server.
 *
 * The invariant this file exists for: **a NeMo outage degrades to flag, in
 * both directions, never to allow** (roadmap 1.1). Every way the server can
 * fail to give a usable verdict is enumerated below and each one is asserted
 * to reach the caller as review-required — and not blocked — under the
 * default mode. Also: the server is asked for a verdict and nothing else,
 * the content never reaches a log line, and a stopped rail is a block.
 */
const appendAuditEntry = jest.fn(async (_entry: Record<string, unknown>) => undefined);
const warn = jest.fn();
const db = { tenantSecuritySettings: { findUnique: jest.fn(async () => ({ aiGuardMode: 'BALANCED' })) } };

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, fn: (d: unknown) => unknown) => fn(db),
}));
jest.mock('@/lib/audit', () => ({
    appendAuditEntry: (...a: unknown[]) => appendAuditEntry(a[0] as Record<string, unknown>),
}));
jest.mock('@/lib/observability/logger', () => ({
    logger: { error: jest.fn(), warn: (...a: unknown[]) => warn(...a), info: jest.fn(), debug: jest.fn() },
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
const BASE = 'https://nemo.example.com/guard/';
const UNAVAILABLE = `${GUARD_PROVIDER_UNAVAILABLE_RULE}.nemo`;
const SENSITIVE = 'the board minutes for the acquisition of Northwind';

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

function json(body: unknown, init?: ResponseInit): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
}

function rails(...entries: { type: string; name: string; stop?: boolean }[]): Response {
    return json({ messages: [{ role: 'assistant', content: 'I cannot help with that.' }], log: { activated_rails: entries } });
}

function nemoWith(fetchImpl: FetchImpl, extra: { timeoutMs?: number; baseUrl?: string } = {}): GuardProvider {
    return createNemoGuardProvider({ baseUrl: extra.baseUrl ?? BASE, fetchImpl, timeoutMs: extra.timeoutMs });
}

async function both(nemo: GuardProvider) {
    const input = await guardUntrustedInput(ctx, SENSITIVE, { source: 'nemo-test', providers: [patternsProvider, nemo] });
    const egress = await guardEgress(ctx, { note: SENSITIVE }, { source: 'nemo-test', providers: [patternsProvider, nemo] });
    return { input, egress };
}

beforeEach(() => {
    appendAuditEntry.mockClear();
    warn.mockClear();
});

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

    it('a base URL that is not https is refused before any request, and fails closed', async () => {
        const fetchImpl = jest.fn<Promise<Response>, [string, RequestInit]>();
        const { input, egress } = await both(nemoWith(fetchImpl, { baseUrl: 'http://nemo-guardrails:8000' }));
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(input.action).toBe('flag');
        expect(egress.action).toBe('flag');
        expect(warn.mock.calls.map((c) => (c[1] as { reason: string }).reason)).toEqual(['SCHEME_REFUSED', 'SCHEME_REFUSED']);
    });

    it('without the test seam the request goes through safeFetch, which refuses a private address — and that fails closed', async () => {
        const provider = createNemoGuardProvider({ baseUrl: 'https://10.0.0.5:8000' });
        const { input, egress } = await both(provider);
        expect(input.action).toBe('flag');
        expect(egress.action).toBe('flag');
        expect(warn.mock.calls.map((c) => (c[1] as { reason: string }).reason)).toEqual(['EGRESS_REFUSED', 'EGRESS_REFUSED']);
    });

    it('content too large to send is unscanned, not clean', async () => {
        const fetchImpl = jest.fn<Promise<Response>, [string, RequestInit]>(async () => rails());
        const nemo = nemoWith(fetchImpl);
        // Over the cap in bytes, not characters: 'é' is two bytes in UTF-8. The
        // nemo provider is asked alone, because the patterns scanner's own cost
        // on a megabyte is not what this asserts.
        const huge = 'é'.repeat(NEMO_MAX_REQUEST_BYTES / 2 + 1);
        const input = await guardUntrustedInput(ctx, huge, { source: 'nemo-test', providers: [nemo] });
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(input.action).toBe('flag');
        expect(input.ruleIds).toContain(UNAVAILABLE);
    });

    it('a payload that cannot be serialised is unscanned, not clean', async () => {
        const fetchImpl = jest.fn<Promise<Response>, [string, RequestInit]>(async () => rails());
        const big = { n: BigInt(1) };
        const egress = await guardEgress(ctx, big, { source: 'nemo-test', providers: [patternsProvider, nemoWith(fetchImpl)] });
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(egress.action).toBe('flag');
        expect(egress.ruleIds).toContain(UNAVAILABLE);
    });

    it('logs the reason and never the content or the URL', async () => {
        await both(nemoWith(async () => new Response('down', { status: 503 })));
        const logged = JSON.stringify(warn.mock.calls);
        expect(logged).not.toContain('Northwind');
        expect(logged).not.toContain('nemo.example.com');
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
        const fetchImpl = jest.fn<Promise<Response>, [string, RequestInit]>(async () => rails());
        const nemo = nemoWith(fetchImpl);
        await guardUntrustedInput(ctx, SENSITIVE, { source: 'nemo-test', providers: [patternsProvider, nemo] });
        await guardEgress(ctx, { note: SENSITIVE }, { source: 'nemo-test', providers: [patternsProvider, nemo] });

        expect(fetchImpl).toHaveBeenCalledTimes(2);
        const [inputUrl, inputInit] = fetchImpl.mock.calls[0];
        expect(inputUrl).toBe('https://nemo.example.com/guard/v1/chat/completions');
        expect(inputInit.method).toBe('POST');
        const inputBody = JSON.parse(String(inputInit.body));
        expect(inputBody).toEqual({
            config_id: NEMO_RAILS_CONFIG_ID,
            messages: [{ role: 'user', content: SENSITIVE }],
            options: { rails: ['input'], log: { activated_rails: true } },
        });
        const egressBody = JSON.parse(String(fetchImpl.mock.calls[1][1].body));
        expect(egressBody.options.rails).toEqual(['output']);
        expect(egressBody.messages[1]).toEqual({ role: 'assistant', content: JSON.stringify({ note: SENSITIVE }) });
    });

    it('nothing to scan makes no request', async () => {
        const fetchImpl = jest.fn<Promise<Response>, [string, RequestInit]>(async () => rails());
        const nemo = nemoWith(fetchImpl);
        for (const text of [null, undefined, '']) {
            const o = await guardUntrustedInput(ctx, text, { source: 'nemo-test', providers: [patternsProvider, nemo] });
            expect(o.verdict).toBe('clean');
        }
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

describe('the endpoint and rule ids carry nothing they should not', () => {
    it('refuses credentials, a query or a fragment in the base URL, and anything but https', () => {
        expect(nemoEndpoint('https://user:pw@nemo.example.com')).toEqual({ ok: false, reason: 'CONFIG_INVALID' });
        expect(nemoEndpoint('https://nemo.example.com/?token=x')).toEqual({ ok: false, reason: 'CONFIG_INVALID' });
        expect(nemoEndpoint('not a url')).toEqual({ ok: false, reason: 'CONFIG_INVALID' });
        expect(nemoEndpoint('http://nemo.example.com')).toEqual({ ok: false, reason: 'SCHEME_REFUSED' });
        expect(nemoEndpoint('https://nemo.example.com')).toEqual({ ok: true, url: 'https://nemo.example.com/v1/chat/completions' });
    });

    it('reduces a rail name to a bounded safe token', () => {
        expect(railRuleId('Self Check Input')).toBe('rail.self_check_input');
        expect(railRuleId('<script>alert(1)</script>')).toBe('rail.script_alert_1_script');
        expect(railRuleId('!!!')).toBe('rail.unnamed');
        expect(railRuleId('x'.repeat(500)).length).toBe('rail.'.length + 48);
    });
});
