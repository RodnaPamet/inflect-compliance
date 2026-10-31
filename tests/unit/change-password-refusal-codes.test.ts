/**
 * #4645 — every change-password refusal carries a code the page translates.
 *
 * The route's sentences are English and the account security page showed them
 * verbatim. Each refusal now carries a code from `CHANGE_PASSWORD_REFUSALS`
 * beside its sentence (kept for API callers), and the page labels the code.
 */
import { NextRequest } from 'next/server';

const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));

const mockHibp = jest.fn();
jest.mock('@/lib/security/password-check', () => ({
    checkPasswordAgainstHIBP: (pw: string) => mockHibp(pw),
}));

const mockChange = jest.fn();
jest.mock('@/lib/auth/password-management', () => ({
    changePassword: (...a: unknown[]) => mockChange(...a),
}));

import { POST } from '@/app/api/auth/change-password/route';
import { CHANGE_PASSWORD_REFUSALS } from '@/lib/auth/change-password-refusals';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '@/lib/auth/passwords';

const en = jest.requireActual('../../messages/en.json');
const bg = jest.requireActual('../../messages/bg.json');

function post(body: Record<string, unknown>) {
    return POST(
        new NextRequest('http://localhost/api/auth/change-password', {
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
    // The English sentence stays for API callers.
    expect(typeof json.error).toBe('string');
    expect(json.error.length).toBeGreaterThan(0);
    return json.code;
}

beforeEach(() => {
    mockAuth.mockResolvedValue({ user: { id: 'u-1' } });
    mockHibp.mockResolvedValue({ breached: false });
    mockChange.mockResolvedValue({ ok: true });
});

describe('POST /api/auth/change-password refusal codes', () => {
    it('names each refusal', async () => {
        expect(await refusal({ currentPassword: 'same-password', newPassword: 'same-password' })).toBe('SAME_AS_CURRENT');
        expect(await refusal({ currentPassword: 'old-password', newPassword: 'short' })).toBe('PASSWORD_TOO_SHORT');
        expect(await refusal({ currentPassword: 'old-password', newPassword: 'x'.repeat(MAX_PASSWORD_LENGTH + 1) })).toBe('PASSWORD_TOO_LONG');

        mockHibp.mockResolvedValueOnce({ breached: true });
        expect(await refusal({ currentPassword: 'old-password', newPassword: 'password123' })).toBe('PASSWORD_BREACHED');

        mockChange.mockResolvedValueOnce({ ok: false, reason: 'no_password' });
        expect(await refusal({ currentPassword: 'old-password', newPassword: 'new-password-1' })).toBe('NO_PASSWORD');

        mockChange.mockResolvedValueOnce({ ok: false, reason: 'wrong_password' });
        expect(await refusal({ currentPassword: 'old-password', newPassword: 'new-password-1' })).toBe('CURRENT_PASSWORD_INCORRECT');
    });

    it('still succeeds with the same body as before', async () => {
        const res = await post({ currentPassword: 'old-password', newPassword: 'new-password-1' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, reauthRequired: true });
    });
});

describe('the page can say every refusal', () => {
    it('has a label for each code in en and bg', () => {
        // The form's REFUSAL_LABEL is exhaustive by type; this pins the keys it names.
        const labels = ['mustDiffer', 'fillAllThree', 'tooShort', 'tooLong', 'breached', 'withoutPassword', 'currentIncorrect'];
        expect(labels).toHaveLength(CHANGE_PASSWORD_REFUSALS.length);
        for (const catalogue of [en, bg]) {
            for (const key of labels) expect(typeof catalogue.account.security[key]).toBe('string');
        }
    });

    it("states the policy's own bounds", () => {
        for (const catalogue of [en, bg]) {
            expect(catalogue.account.security.tooShort).toContain(String(MIN_PASSWORD_LENGTH));
            expect(catalogue.account.security.tooLong).toContain(String(MAX_PASSWORD_LENGTH));
        }
    });
});
