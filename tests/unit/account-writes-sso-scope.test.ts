/**
 * A display name and an avatar are the account's, seen in every workspace and
 * organisation it belongs to. A session opened by one workspace's single
 * sign-on is vouched for in that workspace only, so it may change them only
 * while the account belongs to nothing else (`src/lib/account/sso-scope.ts`).
 */
const getServerSessionMock = jest.fn();
const tenantMembershipCount = jest.fn();
const orgMembershipCount = jest.fn();
const updateOwnDisplayName = jest.fn();
const uploadOwnAvatar = jest.fn();
const removeOwnAvatar = jest.fn();

jest.mock('@/auth', () => ({ authOptions: {} }));
jest.mock('next-auth', () => ({ getServerSession: () => getServerSessionMock() }));
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        tenantMembership: { count: (a: unknown) => tenantMembershipCount(a) },
        orgMembership: { count: (a: unknown) => orgMembershipCount(a) },
    },
}));
jest.mock('@/lib/account/profile', () => ({
    DISPLAY_NAME_MAX: 100,
    updateOwnDisplayName: (...a: unknown[]) => updateOwnDisplayName(...a),
}));
jest.mock('@/lib/account/avatar', () => ({
    AVATAR_MAX_BYTES: 1024 * 1024,
    uploadOwnAvatar: (...a: unknown[]) => uploadOwnAvatar(...a),
    removeOwnAvatar: (...a: unknown[]) => removeOwnAvatar(...a),
}));

import { NextRequest } from 'next/server';
import { PATCH as patchProfile } from '@/app/api/account/profile/route';
import { DELETE as deleteAvatar, POST as postAvatar } from '@/app/api/account/avatar/route';

function profileRequest() {
    return new NextRequest('http://localhost/api/account/profile', {
        method: 'PATCH',
        body: JSON.stringify({ firstName: 'Ada' }),
        headers: { 'content-type': 'application/json' },
    });
}
function avatarRequest() {
    const form = new FormData();
    form.append('file', new File([new Uint8Array([1, 2, 3])], 'a.webp', { type: 'image/webp' }));
    return new NextRequest('http://localhost/api/account/avatar', { method: 'POST', body: form });
}

const WRITES: Array<[string, () => Promise<Response>, jest.Mock]> = [
    ['PATCH /account/profile', () => patchProfile(profileRequest(), { params: Promise.resolve({}) } as never), updateOwnDisplayName],
    ['POST /account/avatar', () => postAvatar(avatarRequest(), { params: Promise.resolve({}) } as never), uploadOwnAvatar],
    [
        'DELETE /account/avatar',
        () =>
            (deleteAvatar as unknown as (req: NextRequest, args: unknown) => Promise<Response>)(
                new NextRequest('http://localhost/api/account/avatar', { method: 'DELETE' }),
                { params: Promise.resolve({}) },
            ),
        removeOwnAvatar,
    ],
];

beforeEach(() => {
    jest.clearAllMocks();
    for (const m of [updateOwnDisplayName, uploadOwnAvatar, removeOwnAvatar]) m.mockResolvedValue({ ok: true });
    tenantMembershipCount.mockResolvedValue(0);
    orgMembershipCount.mockResolvedValue(0);
});

describe.each(WRITES)('%s', (_name, call, write) => {
    it('an ordinary session writes, without asking about memberships', async () => {
        getServerSessionMock.mockResolvedValue({ user: { id: 'u1', ssoTenantId: null } });
        expect((await call()).status).toBe(200);
        expect(write).toHaveBeenCalled();
        expect(tenantMembershipCount).not.toHaveBeenCalled();
    });

    it('an SSO session writes when the account belongs to nothing else', async () => {
        getServerSessionMock.mockResolvedValue({ user: { id: 'u1', ssoTenantId: 't-sso' } });
        expect((await call()).status).toBe(200);
        expect(write).toHaveBeenCalled();
        expect(tenantMembershipCount).toHaveBeenCalledWith({ where: { userId: 'u1', tenantId: { not: 't-sso' } } });
    });

    it('an SSO session is refused when the account belongs to another workspace', async () => {
        getServerSessionMock.mockResolvedValue({ user: { id: 'u1', ssoTenantId: 't-sso' } });
        tenantMembershipCount.mockResolvedValue(1);
        expect((await call()).status).toBe(403);
        expect(write).not.toHaveBeenCalled();
    });

    it('an SSO session is refused when the account belongs to an organisation', async () => {
        getServerSessionMock.mockResolvedValue({ user: { id: 'u1', ssoTenantId: 't-sso' } });
        orgMembershipCount.mockResolvedValue(1);
        expect((await call()).status).toBe(403);
        expect(write).not.toHaveBeenCalled();
    });
});
