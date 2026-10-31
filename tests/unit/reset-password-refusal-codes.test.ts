/**
 * #4688 — every reset-password refusal carries a code the page translates.
 *
 * The route's sentences are English and the reset page showed them verbatim.
 * Each refusal now carries a code from `RESET_PASSWORD_REFUSALS` beside its
 * sentence (kept for API callers), as change-password's do (#4645).
 */
import { NextRequest } from 'next/server';

const mockHibp = jest.fn();
jest.mock('@/lib/security/password-check', () => ({
    checkPasswordAgainstHIBP: (pw: string) => mockHibp(pw),
}));

const mockConsume = jest.fn();
jest.mock('@/lib/auth/password-management', () => ({
    consumePasswordReset: (...a: unknown[]) => mockConsume(...a),
}));

import { POST } from '@/app/api/auth/reset-password/route';
import { RESET_PASSWORD_REFUSALS } from '@/lib/auth/reset-password-refusals';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '@/lib/auth/passwords';
import * as limits from '@/lib/auth/password-limits';

const en = jest.requireActual('../../messages/en.json');
const bg = jest.requireActual('../../messages/bg.json');

function post(body: Record<string, unknown>) {
    return POST(
        new NextRequest('http://localhost/api/auth/reset-password', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        }),
        { params: Promise.resolve({}) } as never,
    );
}

async function refusal(body: Record<string, unknown>) {
    const res = await post(body);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; code: string };
    expect(typeof json.error).toBe('string');
    expect(json.error.length).toBeGreaterThan(0);
    return json.code;
}

beforeEach(() => {
    mockHibp.mockReset().mockResolvedValue({ breached: false });
    mockConsume.mockReset().mockResolvedValue({ ok: true });
});

describe('POST /api/auth/reset-password refusal codes', () => {
    it('names each policy and breach refusal', async () => {
        expect(await refusal({ token: 't', newPassword: 'short' })).toBe('PASSWORD_TOO_SHORT');
        expect(await refusal({ token: 't', newPassword: 'x'.repeat(MAX_PASSWORD_LENGTH + 1) })).toBe('PASSWORD_TOO_LONG');
        mockHibp.mockResolvedValue({ breached: true });
        expect(await refusal({ token: 't', newPassword: 'pass-ok-1234' })).toBe('PASSWORD_BREACHED');
        expect(mockConsume).not.toHaveBeenCalled();
    });

    it('names an expired link apart from an invalid one', async () => {
        mockConsume.mockResolvedValue({ ok: false, reason: 'expired' });
        expect(await refusal({ token: 't', newPassword: 'pass-ok-1234' })).toBe('RESET_LINK_EXPIRED');
        mockConsume.mockResolvedValue({ ok: false, reason: 'invalid' });
        expect(await refusal({ token: 't', newPassword: 'pass-ok-1234' })).toBe('RESET_LINK_INVALID');
    });

    it('still answers ok on success', async () => {
        const res = await post({ token: 't', newPassword: 'pass-ok-1234' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
    });

    it('every code has a sentence in each catalogue, and the limits are the policy’s own', () => {
        for (const catalogue of [en, bg]) {
            for (const code of RESET_PASSWORD_REFUSALS) {
                expect(typeof catalogue.auth.reset.refused[code]).toBe('string');
            }
            expect(catalogue.auth.reset.refused.PASSWORD_TOO_SHORT).toContain(String(MIN_PASSWORD_LENGTH));
            expect(catalogue.auth.reset.refused.PASSWORD_TOO_LONG).toContain(String(MAX_PASSWORD_LENGTH));
            expect(catalogue.auth.reset.tooLong).toContain(String(MAX_PASSWORD_LENGTH));
        }
        // The client-safe limits are the ones the server enforces.
        expect(limits.MIN_PASSWORD_LENGTH).toBe(MIN_PASSWORD_LENGTH);
        expect(limits.MAX_PASSWORD_LENGTH).toBe(MAX_PASSWORD_LENGTH);
    });
});
