/**
 * #4686 — every registration refusal carries a code the sign-in page
 * translates; #4689 — an invitee registers an account without a workspace.
 */
import { NextRequest } from 'next/server';

const mockHibp = jest.fn();
jest.mock('@/lib/security/password-check', () => ({
    checkPasswordAgainstHIBP: (pw: string) => mockHibp(pw),
}));
jest.mock('@/lib/auth/passwords', () => ({
    ...jest.requireActual('@/lib/auth/passwords'),
    hashPassword: async () => 'hashed',
}));
jest.mock('@/lib/auth/email-verification', () => ({ issueEmailVerification: async () => undefined }));
jest.mock('@/lib/security/encryption', () => ({ hashForLookup: (v: string) => `h:${v}` }));
jest.mock('@/lib/security/tenant-keys', () => ({
    generateAndWrapDek: () => ({ dek: Buffer.alloc(32), wrapped: 'wrapped-dek' }),
}));
jest.mock('@/lib/observability/business-metrics', () => ({
    recordTenantCreated: jest.fn(),
    recordUserSignup: jest.fn(),
}));

const mockFindUser = jest.fn();
const mockCreateUser = jest.fn();
const mockCreateMembership = jest.fn();
const mockCreateTenant = jest.fn();
/**
 * Rows a transaction wrote, kept only when its callback resolves — so a
 * test can tell a write that was rolled back from one that stayed (#5303).
 */
const committedTenants: unknown[] = [];
jest.mock('@/lib/prisma', () => {
    const client = {
        user: { findUnique: (a: unknown) => mockFindUser(a), create: (a: unknown) => mockCreateUser(a) },
        tenantMembership: { create: (a: unknown) => mockCreateMembership(a) },
        tenant: {
            create: async (a: unknown) => {
                const row = await mockCreateTenant(a);
                committedTenants.push(row);
                return row;
            },
        },
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
            const pending: unknown[] = [];
            const tx = {
                ...client,
                tenant: {
                    create: async (a: unknown) => {
                        const row = await mockCreateTenant(a);
                        pending.push(row);
                        return row;
                    },
                },
            };
            const out = await fn(tx);
            committedTenants.push(...pending);
            return out;
        },
    };
    return { __esModule: true, default: client };
});

const cookie = { value: undefined as string | undefined };
jest.mock('next/headers', () => ({
    cookies: async () => ({
        get: (name: string) => (name === 'inflect_invite_token' && cookie.value ? { value: cookie.value } : undefined),
    }),
}));
const mockPreview = jest.fn();
jest.mock('@/app-layer/usecases/tenant-invites', () => ({
    previewInviteByToken: (...a: unknown[]) => mockPreview(...a),
}));

import { POST } from '@/app/api/auth/register/route';
import { REGISTER_REFUSALS } from '@/lib/auth/register-refusals';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '@/lib/auth/passwords';

const en = jest.requireActual('../../messages/en.json');
const bg = jest.requireActual('../../messages/bg.json');

function post(body: Record<string, unknown>) {
    return POST(
        new NextRequest('http://localhost/api/auth/register', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'register', ...body }),
        }),
        { params: Promise.resolve({}) } as never,
    );
}

async function refusal(body: Record<string, unknown>, status = 400) {
    const res = await post(body);
    expect(res.status).toBe(status);
    const json = (await res.json()) as { error: string; code: string };
    expect(typeof json.error).toBe('string');
    expect(json.error.length).toBeGreaterThan(0);
    return json.code;
}

const base = { email: 'Ana@Example.com', password: 'pass-ok-1234', name: 'Ana' };

beforeEach(() => {
    cookie.value = undefined;
    committedTenants.length = 0;
    mockHibp.mockReset().mockResolvedValue({ breached: false });
    mockFindUser.mockReset().mockResolvedValue(null);
    mockCreateUser.mockReset().mockImplementation(async ({ data }: { data: { email: string; name: string } }) => ({
        id: 'u-1', email: data.email, name: data.name,
    }));
    mockCreateMembership.mockReset().mockResolvedValue({ role: 'OWNER' });
    mockCreateTenant.mockReset().mockResolvedValue({ id: 't-1', name: 'Acme', slug: 'acme-x' });
    mockPreview.mockReset();
});

describe('POST /api/auth/register refusal codes', () => {
    it('names each password and account refusal', async () => {
        expect(await refusal({ ...base, orgName: 'Acme', password: 'short' })).toBe('PASSWORD_TOO_SHORT');
        expect(await refusal({ ...base, orgName: 'Acme', password: 'x'.repeat(MAX_PASSWORD_LENGTH + 1) })).toBe('PASSWORD_TOO_LONG');
        mockHibp.mockResolvedValueOnce({ breached: true });
        expect(await refusal({ ...base, orgName: 'Acme' })).toBe('PASSWORD_BREACHED');
        mockFindUser.mockResolvedValueOnce({ id: 'u-0' });
        expect(await refusal({ ...base, orgName: 'Acme' }, 409)).toBe('EMAIL_ALREADY_REGISTERED');
        expect(mockCreateTenant).not.toHaveBeenCalled();
    });

    it('creates a workspace and its Owner when given a workspace name', async () => {
        const res = await post({ ...base, orgName: 'Acme' });
        expect(res.status).toBe(200);
        expect(mockCreateTenant).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ name: 'Acme', encryptedDek: 'wrapped-dek' }) }),
        );
        expect(mockCreateMembership).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ role: 'OWNER' }) }));
        expect((await res.json()).tenant).toEqual({ id: 't-1', name: 'Acme', slug: 'acme-x' });
    });

    it('every code has a sentence in each catalogue', () => {
        for (const catalogue of [en, bg]) {
            for (const code of REGISTER_REFUSALS) {
                expect(typeof catalogue.login.refused[code]).toBe('string');
            }
            expect(catalogue.login.refused.PASSWORD_TOO_SHORT).toContain(String(MIN_PASSWORD_LENGTH));
            expect(catalogue.login.refused.PASSWORD_TOO_LONG).toContain(String(MAX_PASSWORD_LENGTH));
        }
    });
});

describe('POST /api/auth/register without a workspace name (#4689)', () => {
    it('is refused with no invitation to register for', async () => {
        expect(await refusal(base)).toBe('WORKSPACE_NAME_REQUIRED');
        expect(await refusal({ ...base, orgName: '   ' })).toBe('WORKSPACE_NAME_REQUIRED');
        expect(mockCreateUser).not.toHaveBeenCalled();
    });

    it('is refused for an invitation that is no longer live', async () => {
        cookie.value = 'tok-1';
        mockPreview.mockResolvedValue(null);
        expect(await refusal(base)).toBe('INVITE_UNAVAILABLE');
        expect(mockCreateUser).not.toHaveBeenCalled();
    });

    it('is refused for an email the invitation was not sent to, before redemption could burn it', async () => {
        cookie.value = 'tok-1';
        mockPreview.mockResolvedValue({ matchesSession: false });
        expect(await refusal(base)).toBe('INVITE_EMAIL_MISMATCH');
        expect(mockPreview).toHaveBeenCalledWith('tok-1', 'ana@example.com');
        expect(mockCreateUser).not.toHaveBeenCalled();
    });

    it('creates the account only, with no workspace and no membership', async () => {
        cookie.value = 'tok-1';
        mockPreview.mockResolvedValue({ matchesSession: true });
        const res = await post(base);
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.tenant).toBeNull();
        expect(json.user).toMatchObject({ id: 'u-1', email: 'ana@example.com', role: null });
        expect(mockCreateUser).toHaveBeenCalledTimes(1);
        expect(mockCreateTenant).not.toHaveBeenCalled();
        expect(mockCreateMembership).not.toHaveBeenCalled();
    });
});

/** The unique violation the losing half of a racing duplicate registration gets. */
function emailHashTaken() {
    const { Prisma } = jest.requireActual('@prisma/client') as typeof import('@prisma/client');
    return new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`emailHash`)', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['emailHash'] },
    });
}

describe('POST /api/auth/register — a racing duplicate leaves no workspace behind (#5303)', () => {
    it('the loser of the emailHash race is told the email is registered, and its tenant is rolled back', async () => {
        // Both registrations passed the `existing` check; this one loses the insert.
        mockCreateUser.mockRejectedValueOnce(emailHashTaken());
        expect(await refusal({ ...base, orgName: 'Acme' }, 409)).toBe('EMAIL_ALREADY_REGISTERED');
        expect(mockCreateTenant).toHaveBeenCalledTimes(1);
        expect(committedTenants).toEqual([]);
        expect(mockCreateMembership).not.toHaveBeenCalled();
    });

    it('any other failure after the tenant insert rolls the tenant back too', async () => {
        mockCreateMembership.mockRejectedValueOnce(new Error('db blip'));
        const res = await post({ ...base, orgName: 'Acme' });
        expect(res.status).toBe(500);
        expect(committedTenants).toEqual([]);
    });

    it('a successful registration commits its tenant', async () => {
        const res = await post({ ...base, orgName: 'Acme' });
        expect(res.status).toBe(200);
        expect(committedTenants).toEqual([{ id: 't-1', name: 'Acme', slug: 'acme-x' }]);
    });

    it('an invitee who loses the same race is told the email is registered, not a 500', async () => {
        cookie.value = 'tok-1';
        mockPreview.mockResolvedValue({ matchesSession: true });
        mockCreateUser.mockRejectedValueOnce(emailHashTaken());
        expect(await refusal(base, 409)).toBe('EMAIL_ALREADY_REGISTERED');
    });
});
