/**
 * A refused request is a warning; only a server failure is an error.
 *
 * `withApiErrorHandling` logs one `request failed …` line per failed request.
 * It logged every one at error level, so production's error stream was mostly
 * correct refusals (401/403/404) and a real 500 was buried among them. A 4xx
 * now logs at warn and a 5xx at error. Sentry already captured 5xx only.
 */
import { NextRequest } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { badRequest, forbidden, notFound, unauthorized, conflict, internal } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';

const request = () => new NextRequest('http://localhost/api/test', { method: 'GET' });

function failedLines(spy: jest.SpyInstance): string[] {
    return spy.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith('request failed'));
}

describe('the level a failed request is logged at', () => {
    let error: jest.SpyInstance;
    let warn: jest.SpyInstance;

    beforeEach(() => {
        error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
        warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => jest.restoreAllMocks());

    it.each([
        ['400', () => badRequest('bad input'), 400],
        ['401', () => unauthorized('no session'), 401],
        ['403', () => forbidden('no permission'), 403],
        ['404', () => notFound('no such row'), 404],
        ['409', () => conflict('already exists'), 409],
    ])('a %s is a warning, not an error', async (_label, make, status) => {
        const res = await withApiErrorHandling(async () => {
            throw make();
        })(request(), {});

        expect(res.status).toBe(status);
        expect(failedLines(warn)).toEqual([`request failed ${status} GET /api/test`]);
        expect(failedLines(error)).toEqual([]);
    });

    it('a 500 is an error', async () => {
        const res = await withApiErrorHandling(async () => {
            throw internal('the server failed');
        })(request(), {});

        expect(res.status).toBe(500);
        expect(failedLines(error)).toEqual(['request failed 500 GET /api/test']);
        expect(failedLines(warn)).toEqual([]);
    });

    it('an unknown throw, which maps to 500, is an error', async () => {
        const res = await withApiErrorHandling(async () => {
            throw new Error('boom');
        })(request(), {});

        expect(res.status).toBe(500);
        expect(failedLines(error)).toEqual(['request failed 500 GET /api/test']);
    });

    it('a refusal still carries its status and code on the line', async () => {
        await withApiErrorHandling(async () => {
            throw forbidden('no permission');
        })(request(), {});

        expect(warn.mock.calls.find((c) => String(c[0]).startsWith('request failed'))?.[1]).toMatchObject({
            component: 'api',
            status: 403,
            errorCode: 'FORBIDDEN',
        });
    });
});
