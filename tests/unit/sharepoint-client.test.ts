/* eslint-disable @typescript-eslint/no-explicit-any -- test-mock pattern. */
/**
 * SP-1 — SharePointClient Graph wrappers, exercised hermetically with a mocked
 * fetch (no network). Locks the endpoint shapes, pagination, delta-token
 * extraction, and the testConnection status branches.
 */
import {
    SharePointClient,
    encodeRemoteId,
    decodeRemoteId,
    extractDeltaToken,
    type SharePointConnectionConfig,
} from '@/app-layer/integrations/providers/sharepoint/client';

const jsonRes = (body: unknown, ok = true, status = 200): Response =>
    ({ ok, status, json: async () => body, arrayBuffer: async () => new ArrayBuffer(8) }) as unknown as Response;

function client(fetchImpl: any, over: Partial<SharePointConnectionConfig> = {}) {
    const config: SharePointConnectionConfig = {
        aadTenantId: 'tid',
        allowedSiteIds: ['site-1'],
        accessToken: 'tok',
        ...over,
    };
    return new SharePointClient(config, fetchImpl as typeof fetch);
}

describe('remoteId codec + delta token', () => {
    it('encodes/decodes driveId:itemId', () => {
        expect(encodeRemoteId('d1', 'i1')).toBe('d1:i1');
        expect(decodeRemoteId('d1:i1')).toEqual({ driveId: 'd1', itemId: 'i1' });
    });
    it('decode tolerates colons in the itemId', () => {
        expect(decodeRemoteId('d1:a:b')).toEqual({ driveId: 'd1', itemId: 'a:b' });
    });
    it('decode throws on a malformed id', () => {
        expect(() => decodeRemoteId('nope')).toThrow();
    });
    it('extractDeltaToken pulls the token query param', () => {
        expect(extractDeltaToken('https://graph/delta?token=ABC123')).toBe('ABC123');
        expect(extractDeltaToken('https://graph/delta')).toBeUndefined();
    });
});

describe('SharePointClient — auth + endpoints', () => {
    it('sends the bearer token on every Graph call', async () => {
        const f = jest.fn().mockResolvedValue(jsonRes({ value: [] }));
        await client(f).listSites();
        expect(f.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
    });

    it('listSites hits /sites?search=* and returns value[]', async () => {
        const f = jest.fn().mockResolvedValue(jsonRes({ value: [{ id: 's1' }, { id: 's2' }] }));
        const sites = await client(f).listSites();
        expect(f.mock.calls[0][0]).toContain('/sites?search=*');
        expect(sites.map((s) => s.id)).toEqual(['s1', 's2']);
    });

    it('listDrives hits the site drives endpoint', async () => {
        const f = jest.fn().mockResolvedValue(jsonRes({ value: [{ id: 'drv1' }] }));
        await client(f).listDrives('site-1');
        expect(f.mock.calls[0][0]).toContain('/sites/site-1/drives');
    });

    it('listChildren returns items + nextLink for the root and a folder', async () => {
        const f = jest
            .fn()
            .mockResolvedValueOnce(jsonRes({ value: [{ id: 'a' }], '@odata.nextLink': 'https://graph/next' }));
        const page = await client(f).listChildren('drv1');
        expect(f.mock.calls[0][0]).toContain('/drives/drv1/root/children');
        expect(page.items.map((i) => i.id)).toEqual(['a']);
        expect(page.nextLink).toBe('https://graph/next');

        const f2 = jest.fn().mockResolvedValue(jsonRes({ value: [] }));
        await client(f2).listChildren('drv1', 'item9');
        expect(f2.mock.calls[0][0]).toContain('/drives/drv1/items/item9/children');
    });

    it('downloadItemContent returns the file bytes', async () => {
        const f = jest.fn().mockResolvedValue(jsonRes({}, true));
        const buf = await client(f).downloadItemContent('drv1', 'item1');
        expect(f.mock.calls[0][0]).toContain('/drives/drv1/items/item1/content');
        expect(buf.byteLength).toBe(8);
    });

    it('getDelta follows nextLink to the deltaLink and returns the new token', async () => {
        const f = jest
            .fn()
            .mockResolvedValueOnce(jsonRes({ value: [{ id: 'a' }], '@odata.nextLink': 'https://graph/p2' }))
            .mockResolvedValueOnce(jsonRes({ value: [{ id: 'b' }], '@odata.deltaLink': 'https://graph/delta?token=TK9' }));
        const res = await client(f).getDelta('drv1');
        expect(res.items.map((i) => i.id)).toEqual(['a', 'b']);
        expect(res.deltaToken).toBe('TK9');
        expect(f).toHaveBeenCalledTimes(2);
    });

    it('getDelta resumes from a stored token', async () => {
        const f = jest.fn().mockResolvedValue(jsonRes({ value: [], '@odata.deltaLink': 'https://graph/delta?token=NEW' }));
        await client(f).getDelta('drv1', 'OLD');
        expect(f.mock.calls[0][0]).toContain('token=OLD');
    });

    it('listChildren rejects a pageUrl that points at a different drive (cross-drive guard)', async () => {
        const f = jest.fn().mockResolvedValue(jsonRes({ value: [] }));
        await expect(
            client(f).listChildren('drv1', undefined, 'https://graph.microsoft.com/v1.0/drives/OTHER/root/children?$skiptoken=x'),
        ).rejects.toThrow(/does not belong/i);
        expect(f).not.toHaveBeenCalled();
    });

    it('throws on a non-OK Graph GET', async () => {
        const f = jest.fn().mockResolvedValue(jsonRes({}, false, 500));
        await expect(client(f).listSites()).rejects.toThrow(/500/);
    });
});

describe('SharePointClient — testConnection branches', () => {
    it('ok when the configured site resolves', async () => {
        const f = jest.fn().mockResolvedValue(jsonRes({ id: 's1', displayName: 'Compliance' }));
        const r = await client(f).testConnection();
        expect(r.ok).toBe(true);
        expect(r.message).toContain('Compliance');
        expect(f.mock.calls[0][0]).toContain('/sites/site-1');
    });
    it('probes /sites/root when no allowed site is configured', async () => {
        const f = jest.fn().mockResolvedValue(jsonRes({ id: 'root' }));
        await client(f, { allowedSiteIds: [] }).testConnection();
        expect(f.mock.calls[0][0]).toContain('/sites/root');
    });
    it('maps 401/403/404 to actionable messages', async () => {
        for (const [status, re] of [
            [401, /invalid or expired/i],
            [403, /consent/i],
            [404, /not found/i],
        ] as const) {
            const f = jest.fn().mockResolvedValue(jsonRes({}, false, status));
            const r = await client(f).testConnection();
            expect(r.ok).toBe(false);
            expect(r.message).toMatch(re);
        }
    });
    it('fails gracefully on a transport throw', async () => {
        const f = jest.fn().mockRejectedValue(new Error('network'));
        const r = await client(f).testConnection();
        expect(r.ok).toBe(false);
    });
});

describe('SharePointClient — generic CRUD contract', () => {
    it('getRemoteObject resolves a DriveItem and null on failure', async () => {
        const f = jest.fn().mockResolvedValue(jsonRes({ id: 'i1', name: 'doc.pdf', lastModifiedDateTime: '2026-01-01T00:00:00Z' }));
        const obj = await client(f).getRemoteObject('drv1:i1');
        expect(obj?.remoteId).toBe('drv1:i1');
        const bad = jest.fn().mockResolvedValue(jsonRes({}, false, 404));
        expect(await client(bad).getRemoteObject('drv1:i1')).toBeNull();
    });
    it('create/update throw (use SP-4 upload)', async () => {
        const c = client(jest.fn());
        await expect(c.createRemoteObject({})).rejects.toThrow();
        await expect(c.updateRemoteObject('x', {})).rejects.toThrow();
    });
});

// ── Drive allowlist enforcement ───────────────────────────────────────────
//
// `allowedSiteIds` is a list of SITES; every drive write takes a DRIVE id, and
// nothing mapped between the two — so the allowlist was consulted only by
// testConnection and listSites and enforced on ZERO drive operations. A caller
// who could name any drive id had it PUT to with the tenant's app-only token.
//
// The allowed set is DERIVED from the approved sites (a positive allowlist)
// rather than read off the drive resource, because trusting a field on the
// object being validated is the wrong direction of trust for an authz check.
describe('SharePointClient — drive allowlist on writes', () => {
    /** Graph returns the drives of an approved site, then the upload result. */
    const drivesThen = (drives: unknown[], then: unknown) => {
        const f = jest.fn();
        f.mockResolvedValueOnce(jsonRes({ value: drives }));
        f.mockResolvedValueOnce(jsonRes(then));
        return f;
    };

    it('allows an upload to a drive belonging to an approved site', async () => {
        const f = drivesThen([{ id: 'drive-ok' }], { id: 'item-1' });
        const item = await client(f).uploadNewFile('drive-ok', 'root', 'r.pdf', new Uint8Array([1]), 'application/pdf');
        expect(item.id).toBe('item-1');
        // First call resolved the approved site's drives; second did the PUT.
        expect(f.mock.calls[0][0]).toContain('/sites/site-1/drives');
        expect(f.mock.calls[1][1].method).toBe('PUT');
    });

    it('refuses an upload to a drive outside every approved site', async () => {
        const f = drivesThen([{ id: 'drive-ok' }], { id: 'item-1' });
        await expect(
            client(f).uploadNewFile('drive-elsewhere', 'root', 'r.pdf', new Uint8Array([1]), 'application/pdf'),
        ).rejects.toThrow(/not in an approved site/);
        // and it never reached Graph with a PUT
        expect(f.mock.calls.some((c: any[]) => c[1]?.method === 'PUT')).toBe(false);
    });

    it('fails CLOSED when no sites are approved', async () => {
        // "The admin has not chosen any sites yet" and "every site is fine" are
        // opposite statements; the previous code effectively read the first as
        // the second.
        const f = jest.fn().mockResolvedValue(jsonRes({ value: [] }));
        await expect(
            client(f, { allowedSiteIds: [] }).uploadNewFile('any-drive', 'root', 'r.pdf', new Uint8Array([1]), 'application/pdf'),
        ).rejects.toThrow(/no approved sites/);
        expect(f).not.toHaveBeenCalled();
    });

    it('enforces the same rule on uploadItemContent, not just new files', async () => {
        const f = drivesThen([{ id: 'drive-ok' }], { id: 'item-1' });
        await expect(
            client(f).uploadItemContent('drive-elsewhere', 'item-9', 'body', 'text/plain'),
        ).rejects.toThrow(/not in an approved site/);
    });

    it('unions drives across every approved site', async () => {
        const f = jest.fn();
        f.mockResolvedValueOnce(jsonRes({ value: [{ id: 'd-a' }] }));
        f.mockResolvedValueOnce(jsonRes({ value: [{ id: 'd-b' }] }));
        f.mockResolvedValueOnce(jsonRes({ id: 'item-1' }));
        const c = client(f, { allowedSiteIds: ['site-1', 'site-2'] });
        await expect(
            c.uploadNewFile('d-b', 'root', 'r.pdf', new Uint8Array([1]), 'application/pdf'),
        ).resolves.toMatchObject({ id: 'item-1' });
    });

    it('resolves the allowed set once per client, not once per write', async () => {
        // A client is short-lived and the site list is admin-controlled; paying
        // for the lookup on every write would make the guard expensive enough
        // to be worth removing.
        const f = jest.fn();
        f.mockResolvedValueOnce(jsonRes({ value: [{ id: 'drive-ok' }] }));
        f.mockResolvedValue(jsonRes({ id: 'item-1' }));
        const c = client(f);
        await c.uploadNewFile('drive-ok', 'root', 'a.pdf', new Uint8Array([1]), 'application/pdf');
        await c.uploadNewFile('drive-ok', 'root', 'b.pdf', new Uint8Array([1]), 'application/pdf');
        // Match the SITE-drives lookup specifically: an upload URL is also
        // /drives/<id>/... so a bare '/drives' filter counts the writes too.
        const driveLookups = f.mock.calls.filter((cl: any[]) => /\/sites\/[^/]+\/drives$/.test(String(cl[0])));
        expect(driveLookups).toHaveLength(1);
    });

    it('tolerates a site whose drive list is empty', async () => {
        const f = jest.fn().mockResolvedValue(jsonRes({ value: [] }));
        await expect(
            client(f).uploadNewFile('any', 'root', 'r.pdf', new Uint8Array([1]), 'application/pdf'),
        ).rejects.toThrow(/not in an approved site/);
    });
});
