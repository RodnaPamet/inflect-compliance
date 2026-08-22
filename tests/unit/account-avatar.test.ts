/**
 * Unit — `src/lib/account/avatar.ts` (avatar roadmap P3).
 *
 * Covers the server-side validation that is the trust boundary for
 * the upload: the magic-number webp sniff, the size cap, and the
 * empty-payload guard — plus the deterministic key/URL helpers.
 */
jest.mock('@/lib/storage', () => ({ getStorageProvider: jest.fn() }));
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        user: { update: jest.fn() },
        tenantMembership: { findFirst: jest.fn() },
    },
}));

import {
    isWebp,
    avatarStorageKey,
    avatarServeUrl,
    uploadOwnAvatar,
    removeOwnAvatar,
    getAvatarStream,
    canViewAvatar,
    AVATAR_MAX_BYTES,
} from '@/lib/account/avatar';
import { getStorageProvider } from '@/lib/storage';
import prisma from '@/lib/prisma';

const mockGetStorageProvider = getStorageProvider as jest.Mock;
const mockUserUpdate = (prisma as unknown as {
    user: { update: jest.Mock };
}).user.update;
const mockMembershipFindFirst = (prisma as unknown as {
    tenantMembership: { findFirst: jest.Mock };
}).tenantMembership.findFirst;

/** A minimal byte buffer carrying the RIFF/WEBP magic number. */
function webpBuffer(extraBytes = 32): Buffer {
    return Buffer.concat([
        Buffer.from('RIFF', 'ascii'),
        Buffer.from([0, 0, 0, 0]), // RIFF chunk size (unchecked)
        Buffer.from('WEBP', 'ascii'),
        Buffer.alloc(extraBytes),
    ]);
}

describe('isWebp — magic-number sniff', () => {
    it('accepts a RIFF/WEBP buffer', () => {
        expect(isWebp(webpBuffer())).toBe(true);
    });

    it('rejects a PNG buffer', () => {
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]);
        expect(isWebp(png)).toBe(false);
    });

    it('rejects a JPEG buffer', () => {
        const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
        expect(isWebp(jpeg)).toBe(false);
    });

    it('rejects a buffer shorter than the 12-byte header', () => {
        expect(isWebp(Buffer.from('RIFF', 'ascii'))).toBe(false);
        expect(isWebp(Buffer.alloc(0))).toBe(false);
    });

    it('rejects RIFF without the WEBP form-type', () => {
        // RIFF container, but a WAVE payload — not an image.
        const wav = Buffer.concat([
            Buffer.from('RIFF', 'ascii'),
            Buffer.from([0, 0, 0, 0]),
            Buffer.from('WAVE', 'ascii'),
            Buffer.alloc(8),
        ]);
        expect(isWebp(wav)).toBe(false);
    });
});

describe('storage key / serve URL helpers', () => {
    it('avatarStorageKey is deterministic + webp-suffixed per user', () => {
        expect(avatarStorageKey('user-123')).toBe('avatars/user-123.webp');
    });

    it('avatarServeUrl points at the per-user serve route', () => {
        expect(avatarServeUrl('user-123')).toBe(
            '/api/account/avatar/user-123',
        );
    });
});

describe('uploadOwnAvatar — validation branches', () => {
    const write = jest.fn();

    beforeEach(() => {
        write.mockReset();
        mockUserUpdate.mockReset();
        mockGetStorageProvider.mockReturnValue({ write });
    });

    it('rejects an empty upload', async () => {
        await expect(uploadOwnAvatar('u1', Buffer.alloc(0))).rejects.toThrow(
            /empty/i,
        );
        expect(write).not.toHaveBeenCalled();
        expect(mockUserUpdate).not.toHaveBeenCalled();
    });

    it('rejects a payload over the size cap', async () => {
        const tooBig = Buffer.concat([
            webpBuffer(),
            Buffer.alloc(AVATAR_MAX_BYTES + 1),
        ]);
        await expect(uploadOwnAvatar('u1', tooBig)).rejects.toThrow(
            /too large/i,
        );
        expect(write).not.toHaveBeenCalled();
    });

    it('rejects a non-webp payload (canvas step bypassed)', async () => {
        const png = Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47]),
            Buffer.alloc(32),
        ]);
        await expect(uploadOwnAvatar('u1', png)).rejects.toThrow(/WebP/i);
        expect(write).not.toHaveBeenCalled();
        expect(mockUserUpdate).not.toHaveBeenCalled();
    });

    it('stores a valid webp and points User.image at the serve URL', async () => {
        const result = await uploadOwnAvatar('u1', webpBuffer());
        expect(write).toHaveBeenCalledWith(
            'avatars/u1.webp',
            expect.any(Buffer),
            expect.objectContaining({ mimeType: 'image/webp' }),
        );
        expect(mockUserUpdate).toHaveBeenCalledWith({
            where: { id: 'u1' },
            data: { image: '/api/account/avatar/u1' },
        });
        expect(result).toEqual({ imageUrl: '/api/account/avatar/u1' });
    });
});

describe('removeOwnAvatar', () => {
    it('deletes the stored object and clears User.image', async () => {
        const del = jest.fn().mockResolvedValue(undefined);
        mockGetStorageProvider.mockReturnValue({ delete: del });
        mockUserUpdate.mockReset();

        await removeOwnAvatar('u1');

        expect(del).toHaveBeenCalledWith('avatars/u1.webp');
        expect(mockUserUpdate).toHaveBeenCalledWith({
            where: { id: 'u1' },
            data: { image: null },
        });
    });

    it('still clears User.image when the stored object is already gone', async () => {
        const del = jest.fn().mockRejectedValue(new Error('not found'));
        mockGetStorageProvider.mockReturnValue({ delete: del });
        mockUserUpdate.mockReset();

        await expect(removeOwnAvatar('u1')).resolves.toBeUndefined();
        expect(mockUserUpdate).toHaveBeenCalledWith({
            where: { id: 'u1' },
            data: { image: null },
        });
    });
});

describe('getAvatarStream — serve-route resolution', () => {
    it('returns the stream when the stored object exists', async () => {
        const fakeStream = { id: 'stream' };
        const head = jest.fn().mockResolvedValue({ sizeBytes: 1 });
        const readStream = jest.fn().mockReturnValue(fakeStream);
        mockGetStorageProvider.mockReturnValue({ head, readStream });

        const result = await getAvatarStream('u1');

        expect(head).toHaveBeenCalledWith('avatars/u1.webp');
        expect(readStream).toHaveBeenCalledWith('avatars/u1.webp');
        expect(result).toBe(fakeStream);
    });

    it('returns null when the user has no stored avatar', async () => {
        const head = jest.fn().mockRejectedValue(new Error('not found'));
        const readStream = jest.fn();
        mockGetStorageProvider.mockReturnValue({ head, readStream });

        expect(await getAvatarStream('u1')).toBeNull();
        expect(readStream).not.toHaveBeenCalled();
    });
});

/**
 * #2104 — the avatar audience gate. The route-level behaviour (which
 * status code a refusal wears) lives in
 * `tests/unit/account-avatar-serve-authz.test.ts`; this block pins the
 * decision itself and the shape of the single query it costs.
 */
describe('canViewAvatar — shared-tenant audience gate', () => {
    beforeEach(() => {
        mockMembershipFindFirst.mockReset();
    });

    it('allows the caller their own avatar without a round trip', async () => {
        // No mockResolvedValue: a query here would return `undefined`,
        // and `undefined !== null` would make this pass for the WRONG
        // reason. The call-count assertion below is what proves the
        // short-circuit, and the sibling case proves the counter moves.
        expect(await canViewAvatar('u1', 'u1')).toBe(true);
        expect(mockMembershipFindFirst).not.toHaveBeenCalled();
    });

    it('asks the database once for a subject who is not the caller', async () => {
        mockMembershipFindFirst.mockResolvedValue({ id: 'm1' });

        expect(await canViewAvatar('viewer', 'subject')).toBe(true);
        expect(mockMembershipFindFirst).toHaveBeenCalledTimes(1);
    });

    it('denies when no shared ACTIVE membership row comes back', async () => {
        mockMembershipFindFirst.mockResolvedValue(null);

        expect(await canViewAvatar('viewer', 'subject')).toBe(false);
        expect(mockMembershipFindFirst).toHaveBeenCalledTimes(1);
    });

    it('requires ACTIVE on BOTH sides, in a live tenant, in one query', async () => {
        mockMembershipFindFirst.mockResolvedValue(null);

        await canViewAvatar('viewer', 'subject');

        // The whole authorization rule is this `where`. Asserted
        // exactly (not `objectContaining`) because every clause is
        // load-bearing: drop `status` on either side and a removed
        // employee keeps reading their ex-colleagues' avatars; drop
        // `deletedAt` and a soft-deleted tenant still grants an
        // audience; widen either userId and the gate is gone.
        expect(mockMembershipFindFirst).toHaveBeenCalledWith({
            where: {
                userId: 'subject',
                status: 'ACTIVE',
                tenant: {
                    deletedAt: null,
                    memberships: {
                        some: { userId: 'viewer', status: 'ACTIVE' },
                    },
                },
            },
            select: { id: true },
        });
    });

    it('never fans out per tenant — one call regardless of membership count', async () => {
        // The N+1 shape this forbids: resolve the viewer's tenants,
        // then probe the subject once per tenant. `findFirst` with a
        // correlated `some` keeps it at one round trip, so the count
        // cannot grow with the size of either membership set.
        mockMembershipFindFirst.mockResolvedValue(null);

        await canViewAvatar('viewer', 'subject');
        await canViewAvatar('viewer', 'other-subject');

        expect(mockMembershipFindFirst).toHaveBeenCalledTimes(2);
    });
});
