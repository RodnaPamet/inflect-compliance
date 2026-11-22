/* eslint-disable @typescript-eslint/no-explicit-any -- test-mock pattern. */
/**
 * SP-4 — bidirectional policy ↔ SharePoint sync. DB, the Graph client,
 * createPolicyVersion, audit + env are mocked; this locks link/unlink (incl.
 * subscription create/delete), push (upload + eTag), pull (new version + eTag),
 * and conflict detection.
 */
const mockDb = { policy: { findFirst: jest.fn(), update: jest.fn() } };
const mockClient = {
    getItem: jest.fn(),
    createSubscription: jest.fn(),
    deleteSubscription: jest.fn(),
    uploadItemContent: jest.fn(),
    downloadItemContent: jest.fn(),
};
const mockCreateVersion = jest.fn();

jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: (_ctx: any, fn: (db: any) => any) => fn(mockDb),
}));
jest.mock('@/app-layer/integrations/providers/sharepoint', () => ({
    __esModule: true,
    getSharePointClient: jest.fn(async () => mockClient),
    listSharePointConnections: jest.fn(async () => [{ id: 'c1' }]),
}));
jest.mock('@/app-layer/usecases/policy', () => ({
    __esModule: true,
    createPolicyVersion: (...a: unknown[]) => mockCreateVersion(...a),
}));
jest.mock('@/app-layer/integrations/providers/sharepoint/docx', () => ({
    __esModule: true,
    isDocxItem: (name?: string) => !!name && /\.docx$/i.test(name),
    docxToPolicyHtml: jest.fn(async () => '<h1>from docx</h1>'),
}));
jest.mock('@/app-layer/events/audit', () => ({ __esModule: true, logEvent: jest.fn() }));
jest.mock('@/env', () => ({ __esModule: true, env: { APP_URL: 'https://ic.example' } }));
jest.mock('@/lib/observability/edge-logger', () => ({
    __esModule: true,
    edgeLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { getSharePointClient } from '@/app-layer/integrations/providers/sharepoint';
import {
    linkPolicyToSharePoint,
    unlinkPolicyFromSharePoint,
    pushPolicyToSharePoint,
    pullPolicyFromSharePoint,
    getPolicySharePointConflict,
    policyClientState,
} from '@/app-layer/usecases/policy-sharepoint-sync';

const ctx = { tenantId: 't1', userId: 'u1', permissions: { canWrite: true } } as any;

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.policy.findFirst.mockResolvedValue({ id: 'p1' });
    mockDb.policy.update.mockResolvedValue({});
    mockClient.getItem.mockResolvedValue({ eTag: 'etag-1', webUrl: 'https://sp/doc' });
    mockClient.createSubscription.mockResolvedValue({ id: 'sub-1' });
    mockClient.uploadItemContent.mockResolvedValue({ eTag: 'etag-2' });
    mockClient.downloadItemContent.mockResolvedValue(new TextEncoder().encode('# Policy body').buffer);
});

describe('policyClientState', () => {
    it('encodes tenantId:policyId', () => {
        expect(policyClientState('t1', 'p1')).toBe('t1:p1');
    });
});

describe('linkPolicyToSharePoint', () => {
    it('stores the link + registers a subscription with the right clientState', async () => {
        const r = await linkPolicyToSharePoint(ctx, 'p1', { connectionId: 'c1', driveId: 'd1', itemId: 'i1' });
        expect(r.webUrl).toBe('https://sp/doc');
        expect(mockClient.createSubscription).toHaveBeenCalledWith(
            expect.objectContaining({
                driveId: 'd1',
                notificationUrl: 'https://ic.example/api/webhooks/sharepoint',
                clientState: 't1:p1',
            }),
        );
        const data = mockDb.policy.update.mock.calls[0][0].data;
        expect(data).toMatchObject({ spDriveId: 'd1', spItemId: 'i1', spItemETag: 'etag-1', spSubscriptionId: 'sub-1', spConnectionId: 'c1' });
    });

    it('still links if subscription creation fails (manual sync remains)', async () => {
        mockClient.createSubscription.mockRejectedValueOnce(new Error('no public url'));
        await linkPolicyToSharePoint(ctx, 'p1', { connectionId: 'c1', driveId: 'd1', itemId: 'i1' });
        const data = mockDb.policy.update.mock.calls[0][0].data;
        expect(data.spSubscriptionId).toBeNull();
        expect(data.spDriveId).toBe('d1');
    });
});

describe('pushPolicyToSharePoint', () => {
    it('uploads the current content + records the new eTag', async () => {
        mockDb.policy.findFirst.mockResolvedValueOnce({
            spDriveId: 'd1',
            spItemId: 'i1',
            spConnectionId: 'conn-X',
            currentVersion: { contentText: '# body' },
        });
        await pushPolicyToSharePoint(ctx, 'p1');
        expect(mockClient.uploadItemContent).toHaveBeenCalledWith('d1', 'i1', '# body', 'text/markdown');
        // SP-F1 — resolves the policy's OWN connection, not just the first.
        expect(getSharePointClient).toHaveBeenCalledWith(ctx, 'conn-X');
        expect(mockDb.policy.update.mock.calls[0][0].data.spItemETag).toBe('etag-2');
    });

    it('is a no-op when the policy is not linked', async () => {
        mockDb.policy.findFirst.mockResolvedValueOnce({ spDriveId: null, spItemId: null, currentVersion: null });
        await pushPolicyToSharePoint(ctx, 'p1');
        expect(mockClient.uploadItemContent).not.toHaveBeenCalled();
    });

    it('SP-F3 — skips push for a Word-linked policy (SharePoint-authoritative)', async () => {
        mockDb.policy.findFirst.mockResolvedValueOnce({
            spDriveId: 'd1', spItemId: 'i1', spConnectionId: 'c1', currentVersion: { contentText: '# body' },
        });
        mockClient.getItem.mockResolvedValueOnce({ name: 'Policy.docx', eTag: 'e1' });
        await pushPolicyToSharePoint(ctx, 'p1');
        expect(mockClient.uploadItemContent).not.toHaveBeenCalled();
    });
});

describe('pullPolicyFromSharePoint', () => {
    it('creates a new MARKDOWN version from the SP content', async () => {
        mockDb.policy.findFirst.mockResolvedValueOnce({ id: 'p1' });
        const r = await pullPolicyFromSharePoint(ctx, { driveId: 'd1', itemId: 'i1' });
        expect(r.pulled).toBe(true);
        expect(mockCreateVersion).toHaveBeenCalledWith(
            ctx,
            'p1',
            expect.objectContaining({ contentType: 'MARKDOWN', changeSummary: 'Synced from SharePoint' }),
            { proposeOnly: true },
        );
    });

    it('skips an item whose eTag is the one already synced — the echo of our own push (#5148)', async () => {
        mockDb.policy.findFirst.mockResolvedValueOnce({ id: 'p1', spItemETag: 'etag-1' });
        const r = await pullPolicyFromSharePoint(ctx, { driveId: 'd1', itemId: 'i1' });
        expect(r.pulled).toBe(false);
        expect(mockClient.downloadItemContent).not.toHaveBeenCalled();
        expect(mockCreateVersion).not.toHaveBeenCalled();
    });

    it('pulls when the eTag moved since the last sync', async () => {
        mockDb.policy.findFirst.mockResolvedValueOnce({ id: 'p1', spItemETag: 'etag-0' });
        const r = await pullPolicyFromSharePoint(ctx, { driveId: 'd1', itemId: 'i1' });
        expect(r.pulled).toBe(true);
        expect(mockCreateVersion).toHaveBeenCalledTimes(1);
    });

    it('no-ops when no policy matches the drive/item', async () => {
        mockDb.policy.findFirst.mockResolvedValueOnce(null);
        const r = await pullPolicyFromSharePoint(ctx, { driveId: 'd1', itemId: 'i1' });
        expect(r.pulled).toBe(false);
        expect(mockCreateVersion).not.toHaveBeenCalled();
    });

    it('SP-F3 — a Word file pulls as an HTML version (mammoth)', async () => {
        mockDb.policy.findFirst.mockResolvedValueOnce({ id: 'p1' });
        mockClient.getItem.mockResolvedValueOnce({ name: 'Policy.docx', eTag: 'e1' });
        const r = await pullPolicyFromSharePoint(ctx, { driveId: 'd1', itemId: 'i1' });
        expect(r.pulled).toBe(true);
        expect(mockCreateVersion).toHaveBeenCalledWith(
            ctx,
            'p1',
            expect.objectContaining({ contentType: 'HTML', changeSummary: 'Synced from SharePoint (Word)' }),
            { proposeOnly: true },
        );
    });
});

describe('unlinkPolicyFromSharePoint', () => {
    it('deletes the subscription + clears the fields', async () => {
        mockDb.policy.findFirst.mockResolvedValueOnce({ id: 'p1', spSubscriptionId: 'sub-1' });
        await unlinkPolicyFromSharePoint(ctx, 'p1');
        expect(mockClient.deleteSubscription).toHaveBeenCalledWith('sub-1');
        const data = mockDb.policy.update.mock.calls[0][0].data;
        expect(data).toMatchObject({ spDriveId: null, spSubscriptionId: null });
    });
});

describe('getPolicySharePointConflict', () => {
    it('true when the live eTag differs from the stored one', async () => {
        mockDb.policy.findFirst.mockResolvedValueOnce({ spDriveId: 'd1', spItemId: 'i1', spItemETag: 'old' });
        mockClient.getItem.mockResolvedValueOnce({ eTag: 'new' });
        expect(await getPolicySharePointConflict(ctx, 'p1')).toBe(true);
    });
    it('false when not linked', async () => {
        mockDb.policy.findFirst.mockResolvedValueOnce({ spDriveId: null, spItemId: null, spItemETag: null });
        expect(await getPolicySharePointConflict(ctx, 'p1')).toBe(false);
    });
});
