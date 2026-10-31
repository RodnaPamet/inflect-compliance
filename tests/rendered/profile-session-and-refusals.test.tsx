/** @jest-environment jsdom */

/**
 * #4644 — a saved name or photo reaches the session, a refusal says why, and
 * the account pages have a way back into the app.
 *
 * The JWT took `name` / `picture` at sign-in and never again, so after a save
 * the top bar and this page's own form kept the old values until the next
 * sign-in. A refused photo upload printed "[object Object]" (the error body is
 * `{ error: { code, message } }`), and the name form read only a string
 * `error`, so a thrown refusal showed its generic sentence.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';

const mockRefresh = jest.fn();
jest.mock('next/navigation', () => ({
    useRouter: () => ({ refresh: mockRefresh, push: jest.fn(), replace: jest.fn() }),
}));
const mockRefreshClaims = jest.fn(async () => undefined);
jest.mock('@/lib/auth/refresh-session-claims', () => ({
    refreshSessionClaims: () => mockRefreshClaims(),
}));

const en = jest.requireActual('../../messages/en.json');
jest.mock('next-intl/server', () => ({
    getTranslations: async (ns: string) => (key: string) =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            jest.requireActual('../../messages/en.json'),
        ),
}));

import { AvatarUploadField } from '@/app/account/profile/AvatarUploadField';
import { NameEditField } from '@/app/account/profile/NameEditField';
import { AccountBackLink } from '@/app/account/AccountBackLink';

const P = en.account.profile;
const fetchMock = jest.fn();

beforeEach(() => {
    fetchMock.mockReset();
    mockRefresh.mockReset();
    mockRefreshClaims.mockClear();
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});
afterEach(() => {
    delete (global as unknown as { fetch?: unknown }).fetch;
});

const refusal = (status: number, message: string) => ({
    ok: false, status, json: async () => ({ error: { code: 'VALIDATION_ERROR', message } }),
});

/** jsdom has no image decoding or WebP encoding; stand them in so the upload reaches the server. */
function stubImagePipeline() {
    (global as unknown as { createImageBitmap: unknown }).createImageBitmap = jest.fn(async () => ({
        width: 512, height: 512, close: jest.fn(),
    }));
    jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: jest.fn() } as never);
    jest.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb: BlobCallback) {
        cb(new Blob(['x'], { type: 'image/webp' }));
    });
}

describe('the photo (#4644)', () => {
    afterEach(() => jest.restoreAllMocks());

    it("shows the server's reason when an upload is refused, not [object Object]", async () => {
        stubImagePipeline();
        fetchMock.mockResolvedValue(refusal(400, 'The image is larger than 2 MB.'));
        const { container } = render(<AvatarUploadField name="Ada" email="ada@example.com" initialImage={null} />);
        const input = container.querySelector('input[type="file"]') as HTMLInputElement;
        await act(async () => {
            fireEvent.change(input, { target: { files: [new File(['x'], 'me.png', { type: 'image/png' })] } });
        });
        const error = await screen.findByTestId('avatar-upload-error');
        expect(error.textContent).toBe('The image is larger than 2 MB.');
        expect(error.textContent).not.toContain('[object Object]');
        expect(mockRefreshClaims).not.toHaveBeenCalled();
    });

    it('re-mints the session and refreshes the route after an upload', async () => {
        stubImagePipeline();
        fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ imageUrl: '/api/account/avatar/u1' }) });
        const { container } = render(<AvatarUploadField name="Ada" email="ada@example.com" initialImage={null} />);
        const input = container.querySelector('input[type="file"]') as HTMLInputElement;
        await act(async () => {
            fireEvent.change(input, { target: { files: [new File(['x'], 'me.png', { type: 'image/png' })] } });
        });
        await waitFor(() => expect(mockRefreshClaims).toHaveBeenCalledTimes(1));
        expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    it("re-mints the session after a removal, and shows the server's reason when one is refused", async () => {
        fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true }) });
        const { unmount } = render(<AvatarUploadField name="Ada" email="ada@example.com" initialImage="/api/account/avatar/u1" />);
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: P.remove })); });
        await waitFor(() => expect(mockRefreshClaims).toHaveBeenCalledTimes(1));
        expect(mockRefresh).toHaveBeenCalledTimes(1);
        unmount();

        fetchMock.mockResolvedValueOnce(refusal(500, 'The photo could not be deleted from storage.'));
        render(<AvatarUploadField name="Ada" email="ada@example.com" initialImage="/api/account/avatar/u1" />);
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: P.remove })); });
        expect((await screen.findByTestId('avatar-upload-error')).textContent).toBe('The photo could not be deleted from storage.');
    });
});

describe('the name (#4644)', () => {
    async function save(first: string) {
        render(<NameEditField initialName="Ada Lovelace" />);
        fireEvent.change(document.getElementById('profile-first-name') as HTMLInputElement, { target: { value: first } });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: P.saveName })); });
    }

    it('re-mints the session before refreshing the route, so the top bar reads the new name', async () => {
        fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ name: 'Augusta Lovelace' }) });
        await save('Augusta');
        await screen.findByText(P.nameSaved);
        expect(mockRefreshClaims).toHaveBeenCalledTimes(1);
        expect(mockRefresh).toHaveBeenCalledTimes(1);
        expect(mockRefreshClaims.mock.invocationCallOrder[0]).toBeLessThan(mockRefresh.mock.invocationCallOrder[0]);
    });

    it("shows a thrown refusal's message rather than the generic sentence", async () => {
        fetchMock.mockResolvedValue(refusal(400, 'Invalid profile payload.'));
        await save('A'.repeat(10));
        expect(await screen.findByText('Invalid profile payload.')).toBeTruthy();
        expect(screen.queryByText(P.couldNotSaveName)).toBeNull();
        expect(mockRefreshClaims).not.toHaveBeenCalled();
    });
});

describe('the way back (#4644)', () => {
    it('links the account pages back to the workspaces', async () => {
        render(await AccountBackLink());
        const link = screen.getByRole('link', { name: en.account.backToWorkspaces });
        expect(link.getAttribute('href')).toBe('/tenants');
    });
});
