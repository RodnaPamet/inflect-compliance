/**
 * Web Bot Auth Phase 1 — GET /.well-known/http-message-signatures-directory.
 *
 * Invariants: unconfigured serves nothing (404, no rate-limit charge); the
 * served directory is the draft's media type, signed once per published key,
 * bound to the CONFIGURED authority whatever Host the request named; and it is
 * byte-identical whoever asks (D-L1-5 — the identity is the deployment's, so no
 * request property can reach it). The edge opens this exact path and no other.
 */
const mockEnv: Record<string, string | undefined> = {};
jest.mock('@/env', () => ({ env: mockEnv }));
jest.mock('@/lib/observability', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockEnforce = jest.fn((_req: unknown, _scope: unknown) => ({ key: 'k', result: { allowed: true } }));
jest.mock('@/lib/security/rate-limit-middleware', () => ({
    enforceRateLimit: (req: unknown, scope: unknown) => mockEnforce(req, scope),
}));

import { NextRequest } from 'next/server';

import * as route from '@/app/.well-known/http-message-signatures-directory/route';
import { isPublicPath } from '@/lib/auth/guard';
import {
    DIRECTORY_CACHE_MAX_AGE_SECONDS,
    DIRECTORY_MEDIA_TYPE,
    DIRECTORY_PATH,
    DIRECTORY_SIGNATURE_TTL_SECONDS,
} from '@/lib/web-bot-auth/directory';
import { webBotAuthKeyFromSeed } from '@/lib/web-bot-auth/key';

import { verifyDirectoryResponse } from '../../helpers/web-bot-auth-verifier';

// Fixture seeds, not credentials.
const SEED = '4f3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e'; // pragma: allowlist secret
const PREVIOUS = '1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; // pragma: allowlist secret
const NOW_MS = 1_767_225_600_000;

function request(headers: Record<string, string> = {}, host = 'app.example.com'): NextRequest {
    return new NextRequest(`https://${host}${DIRECTORY_PATH}`, { headers });
}

function configure(overrides: Record<string, string | undefined> = {}) {
    for (const k of Object.keys(mockEnv)) delete mockEnv[k];
    Object.assign(mockEnv, {
        NODE_ENV: 'production',
        APP_URL: 'https://app.example.com',
        DATA_ENCRYPTION_KEY: 'a-real-production-key-at-least-32-chars-long-deterministic',
        WEB_BOT_AUTH_SIGNING_KEY: SEED,
        ...overrides,
    });
}

beforeEach(() => {
    mockEnforce.mockClear();
    jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
});
afterEach(() => jest.restoreAllMocks());

describe('absent configuration serves nothing', () => {
    it.each([
        ['no signing key', { WEB_BOT_AUTH_SIGNING_KEY: undefined }],
        ['no public origin', { APP_URL: undefined }],
        ['a refused signing key', { WEB_BOT_AUTH_SIGNING_KEY: 'not-a-seed' }],
    ])('%s: 404, empty, and no rate-limit bucket charged', async (_l, overrides) => {
        configure(overrides);
        const res = await route.GET(request());
        expect(res.status).toBe(404);
        expect(await res.text()).toBe('');
        expect(mockEnforce).not.toHaveBeenCalled();
    });
});

describe('the configured directory', () => {
    it('is the draft media type, short-cached, and signed by every key it publishes', async () => {
        configure({ WEB_BOT_AUTH_PREVIOUS_SIGNING_KEY: PREVIOUS });
        const res = await route.GET(request());
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe(DIRECTORY_MEDIA_TYPE);
        expect(res.headers.get('cache-control')).toBe(`public, max-age=${DIRECTORY_CACHE_MAX_AGE_SECONDS}`);

        const body = await res.text();
        const published = (JSON.parse(body) as { keys: unknown[] }).keys;
        expect(published).toHaveLength(2);
        const verdict = verifyDirectoryResponse({
            body,
            signatureInput: res.headers.get('signature-input')!,
            signature: res.headers.get('signature')!,
            authority: 'app.example.com',
            now: NOW_MS / 1000 + 1,
        });
        expect(verdict.failures).toEqual([]);
        expect([...verdict.verifiedKeyids].sort()).toEqual(
            [webBotAuthKeyFromSeed(SEED)!.keyid, webBotAuthKeyFromSeed(PREVIOUS)!.keyid].sort(),
        );
        expect(mockEnforce).toHaveBeenCalledTimes(1);
    });

    it('stops publishing the previous key when its variable is unset', async () => {
        configure();
        const res = await route.GET(request());
        const body = JSON.parse(await res.text()) as { keys: { x: string }[] };
        expect(body.keys.map((k) => k.x)).toEqual([webBotAuthKeyFromSeed(SEED)!.publicJwk.x]);
    });

    it('a cached copy never outlives its signature', () => {
        expect(DIRECTORY_CACHE_MAX_AGE_SECONDS).toBeLessThan(DIRECTORY_SIGNATURE_TTL_SECONDS);
    });

    it('signs the configured authority, never the Host the request named', async () => {
        configure();
        const res = await route.GET(request({}, 'attacker.example.net'));
        const input = {
            body: await res.text(),
            signatureInput: res.headers.get('signature-input')!,
            signature: res.headers.get('signature')!,
            now: NOW_MS / 1000 + 1,
        };
        expect(verifyDirectoryResponse({ ...input, authority: 'attacker.example.net' }).verifiedKeyids).toEqual([]);
        expect(verifyDirectoryResponse({ ...input, authority: 'app.example.com' }).verifiedKeyids).toHaveLength(1);
    });

    it('answers GET only', () => {
        expect(Object.keys(route).filter((k) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(k))).toEqual(['GET']);
    });
});

describe('the identity is the deployment, never a tenant (D-L1-5)', () => {
    it('body and signature headers are byte-identical whoever asks', async () => {
        configure();
        const askers = [
            request(),
            request({ cookie: 'next-auth.session-token=tenant-a-session', 'x-tenant-slug': 'acme' }),
            request({ cookie: 'next-auth.session-token=tenant-b-session', 'x-tenant-slug': 'globex' }),
            request({ 'x-forwarded-host': 'globex.example.com', referer: 'https://app.example.com/t/globex' }),
            request({}, 'acme.app.example.com'),
        ];
        const seen = await Promise.all(
            askers.map(async (r) => {
                const res = await route.GET(r);
                return JSON.stringify({
                    body: await res.text(),
                    input: res.headers.get('signature-input'),
                    sig: res.headers.get('signature'),
                });
            }),
        );
        expect(new Set(seen).size).toBe(1);
        for (const marker of ['acme', 'globex', 'tenant-']) expect(seen[0]).not.toContain(marker);
    });
});

describe('the edge opens this exact path and no sibling', () => {
    it('is public', () => {
        expect(isPublicPath(DIRECTORY_PATH)).toBe(true);
    });

    it.each([
        '/.well-known/http-message-signatures-directory/extra',
        '/.well-known/http-message-signatures-directoryx',
        '/.well-known/other',
        '/.well-known/',
    ])('%s stays gated', (p) => {
        expect(isPublicPath(p)).toBe(false);
    });
});
