/* eslint-disable @typescript-eslint/no-explicit-any -- test-mock pattern. */
/**
 * SP-1/SP-4 — SharePointClient branch coverage.
 *
 * Companion to `sharepoint-client.test.ts`, which locks the happy paths and the
 * drive allowlist. This file goes after the branches that only run when Graph
 * answers badly or answers with fields omitted: the fallback arms of the `??`
 * chains, the delta walk's terminating conditions, the write/subscription
 * failure paths, and `deleteSubscription`'s deliberate tolerance of 204/404.
 *
 * Everything is hermetic — an injected fetch, no network.
 */
import {
    SharePointClient,
    deltaQuery,
    extractPageCursor,
    type SharePointConnectionConfig,
} from '@/app-layer/integrations/providers/sharepoint/client';
import { withApprovedDrives } from '../helpers/sharepoint-approved-drives';

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

/** A client whose approved site holds drives `drv1` and `d1` (reads check it). */
const reader = (fetchImpl: any, over: Partial<SharePointConnectionConfig> = {}) =>
    client(withApprovedDrives(fetchImpl), over);

describe('testConnection — the branches Graph reaches when it is unhappy', () => {
    it('reports an unmapped status verbatim rather than swallowing it', async () => {
        // 503 is neither 401/403/404, so it falls through to the generic arm.
        // An operator reading "Graph returned status 503" knows to look at
        // Microsoft; an `ok: false` with no status tells them nothing.
        const f = jest.fn().mockResolvedValue(jsonRes({}, false, 503));
        const r = await client(f).testConnection();
        expect(r).toMatchObject({ ok: false, message: 'Graph returned status 503' });
    });

    it('names the site by webUrl when Graph omits displayName', async () => {
        const f = jest.fn().mockResolvedValue(jsonRes({ id: 's1', webUrl: 'https://contoso/sites/x' }));
        const r = await client(f).testConnection();
        expect(r.message).toBe('Connected to https://contoso/sites/x');
        expect(r.meta).toEqual({ siteId: 's1' });
    });

    it('falls back to a bare product name when Graph gives neither', async () => {
        const f = jest.fn().mockResolvedValue(jsonRes({ id: 's1' }));
        const r = await client(f).testConnection();
        expect(r.message).toBe('Connected to SharePoint');
    });

    it('carries the transport error text into the failure message', async () => {
        const f = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
        expect(await client(f).testConnection()).toEqual({
            ok: false,
            message: 'Connection failed: ECONNRESET',
        });
    });

    it('stringifies a non-Error rejection instead of dropping it', async () => {
        const f = jest.fn().mockRejectedValue('socket hang up');
        const r = await client(f).testConnection();
        expect(r.message).toBe('Connection failed: socket hang up');
    });
});

describe('generic CRUD projection', () => {
    it('listRemoteObjects projects each site onto its remoteId', async () => {
        const f = jest.fn().mockResolvedValue(jsonRes({ value: [{ id: 's1', displayName: 'A' }, { id: 's2' }] }));
        const res = await client(f).listRemoteObjects();
        expect(res.items.map((i) => i.remoteId)).toEqual(['s1', 's2']);
        expect(res.items[0].data).toMatchObject({ displayName: 'A' });
    });

    it('leaves remoteUpdatedAt undefined when Graph omits lastModifiedDateTime', async () => {
        const f = jest.fn().mockResolvedValue(jsonRes({ id: 'i1', name: 'doc.pdf' }));
        const obj = await reader(f).getRemoteObject('drv1:i1');
        expect(obj?.remoteUpdatedAt).toBeUndefined();
    });

    it('parses lastModifiedDateTime into a Date when Graph supplies it', async () => {
        const f = jest.fn().mockResolvedValue(jsonRes({ id: 'i1', lastModifiedDateTime: '2026-01-02T03:04:05Z' }));
        const obj = await reader(f).getRemoteObject('drv1:i1');
        expect(obj?.remoteUpdatedAt).toEqual(new Date('2026-01-02T03:04:05Z'));
    });

    it('propagates a malformed remoteId rather than reporting "no such item"', async () => {
        // decodeRemoteId runs OUTSIDE the try/catch on purpose: a caller that
        // handed over a corrupt id has a bug, and null would hide it as an
        // ordinary miss.
        const f = jest.fn();
        await expect(client(f).getRemoteObject('no-colon')).rejects.toThrow(/Invalid SharePoint remoteId/);
        expect(f).not.toHaveBeenCalled();
    });
});

describe('collection endpoints tolerate an absent `value` array', () => {
    it.each([
        ['listSites', (c: SharePointClient) => c.listSites()],
        ['listDrives', (c: SharePointClient) => c.listDrives('site-1')],
    ])('%s returns [] rather than undefined', async (_n, call) => {
        const f = jest.fn().mockResolvedValue(jsonRes({}));
        await expect(call(client(f))).resolves.toEqual([]);
    });

    it('listChildren returns an empty page with no cursor', async () => {
        const f = jest.fn().mockResolvedValue(jsonRes({}));
        expect(await reader(f).listChildren('drv1')).toEqual({ items: [], nextLink: undefined });
    });
});

describe('listChildren cursor handling', () => {
    it('follows a cursor that belongs to the requested drive, verbatim', async () => {
        const cursor = 'https://graph.microsoft.com/v1.0/drives/drv1/root/children?$skiptoken=abc';
        const f = jest.fn().mockResolvedValue(jsonRes({ value: [{ id: 'z' }] }));
        const page = await reader(f).listChildren('drv1', undefined, cursor);
        // The cursor is used AS the URL — not re-derived, or the skiptoken is lost
        // and the caller pages forever over the first page.
        expect(f.mock.calls[0][0]).toBe(cursor);
        expect(page.items.map((i) => i.id)).toEqual(['z']);
    });

    it('a cursor wins over itemId when both are supplied', async () => {
        const cursor = 'https://graph.microsoft.com/v1.0/drives/drv1/items/f1/children?$skiptoken=abc';
        const f = jest.fn().mockResolvedValue(jsonRes({ value: [] }));
        await reader(f).listChildren('drv1', 'f1', cursor);
        expect(f.mock.calls[0][0]).toBe(cursor);
    });
});

describe('downloadItemContent', () => {
    it('reports the Graph status rather than returning an empty buffer', async () => {
        // A silent empty ArrayBuffer would be AV-scanned, stored, and become a
        // zero-byte Evidence row that looks like a successful import.
        const f = jest.fn().mockResolvedValue(jsonRes({}, false, 404));
        await expect(reader(f).downloadItemContent('drv1', 'item1')).rejects.toThrow('Graph download item1 → 404');
    });
});

describe('getDelta — walk termination', () => {
    it('stops at maxPages and reports NO token, so the next run re-walks', async () => {
        // Returning a token for a walk that never reached the deltaLink would
        // silently skip every change after the cut-off.
        const f = jest.fn().mockResolvedValue(
            jsonRes({ value: [{ id: 'a' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/drives/drv1/root/delta?page=next' }),
        );
        const res = await client(f).getDelta('drv1', undefined, 2);
        expect(f).toHaveBeenCalledTimes(2);
        expect(res.deltaToken).toBeUndefined();
        expect(res.items).toHaveLength(2);
    });

    it('stops when a page carries neither nextLink nor deltaLink', async () => {
        const f = jest.fn().mockResolvedValue(jsonRes({ value: [{ id: 'a' }] }));
        const res = await client(f).getDelta('drv1');
        expect(f).toHaveBeenCalledTimes(1);
        // `truncated: false` is part of the shape since #5555, and it is
        // stated rather than loosened to `toMatchObject`: a walk that ended
        // because Graph offered no further link is COMPLETE, and reporting it
        // truncated would make every quiet drive look partially synced.
        expect(res).toEqual({ items: [{ id: 'a' }], deltaToken: undefined, truncated: false });
    });

    it('tolerates a page with no `value` array', async () => {
        const f = jest.fn().mockResolvedValue(jsonRes({ '@odata.deltaLink': 'https://graph/delta?token=T' }));
        expect(await client(f).getDelta('drv1')).toEqual({ items: [], deltaToken: 'T', truncated: false });
    });

    it('yields no token when the deltaLink has no token param', async () => {
        const f = jest.fn().mockResolvedValue(jsonRes({ value: [], '@odata.deltaLink': 'https://graph/delta' }));
        expect((await client(f).getDelta('drv1')).deltaToken).toBeUndefined();
    });
});

describe('uploads — target URL and failure', () => {
    /** Approved-site drive lookup, then the PUT response. */
    const drivesThen = (then: unknown, ok = true, status = 200) => {
        const f = jest.fn();
        f.mockResolvedValueOnce(jsonRes({ value: [{ id: 'drive-ok' }] }));
        f.mockResolvedValueOnce(jsonRes(then, ok, status));
        return f;
    };

    it('addresses a NON-root parent folder by item id', async () => {
        const f = drivesThen({ id: 'new-1' });
        await client(f).uploadNewFile('drive-ok', 'folder-9', 'r.pdf', new Uint8Array([1]), 'application/pdf');
        expect(f.mock.calls[1][0]).toContain('/drives/drive-ok/items/folder-9:/r.pdf:/content');
    });

    it('reports the Graph status when a new-file PUT fails', async () => {
        const f = drivesThen({}, false, 507);
        await expect(
            client(f).uploadNewFile('drive-ok', 'root', 'r.pdf', new Uint8Array([1]), 'application/pdf'),
        ).rejects.toThrow('Graph upload new file r.pdf → 507');
    });

    it('uploadItemContent PUTs to the item content endpoint with the given content type', async () => {
        const f = drivesThen({ id: 'item-9', eTag: 'E2' });
        const item = await client(f).uploadItemContent('drive-ok', 'item-9', '# hi', 'text/markdown');
        expect(item).toMatchObject({ id: 'item-9', eTag: 'E2' });
        expect(f.mock.calls[1][0]).toContain('/drives/drive-ok/items/item-9/content');
        expect(f.mock.calls[1][1]).toMatchObject({ method: 'PUT', body: '# hi' });
        expect(f.mock.calls[1][1].headers['Content-Type']).toBe('text/markdown');
        expect(f.mock.calls[1][1].headers.Authorization).toBe('Bearer tok');
    });

    it('reports the Graph status when a content PUT fails', async () => {
        const f = drivesThen({}, false, 423);
        await expect(client(f).uploadItemContent('drive-ok', 'item-9', 'x', 'text/plain')).rejects.toThrow(
            'Graph upload item-9 → 423',
        );
    });

    it('refuses a falsy drive id that an id-less Graph drive would otherwise smuggle into the allowlist', async () => {
        // `allowedDriveIds` skips a drive Graph returned without a usable id.
        // Drop that skip and the row still lands in the Set — as `undefined`,
        // or as `''` for a drive whose id came back empty. `assertDriveAllowed`
        // is a plain Set-membership test, so the hole is not cosmetic: any
        // caller arriving with that same falsy id now PASSES authorization and
        // gets a PUT with the tenant's app-only token. Asserting only that the
        // GOOD drive still uploads cannot see that — `has('drive-ok')` is true
        // either way — so this pins the derived set exactly and then the
        // refusal it is supposed to produce.
        const drives = { value: [{ name: 'no id here' }, { id: '' }, { id: 'drive-ok' }] };

        const derived = await client(jest.fn().mockResolvedValue(jsonRes(drives))).allowedDriveIds();
        expect(derived).toEqual(new Set(['drive-ok']));

        // The two falsy shapes are both refused, and refused BEFORE the PUT —
        // one fetch (the drive lookup), never a second.
        for (const smuggled of ['', undefined as unknown as string]) {
            const f = jest.fn();
            f.mockResolvedValueOnce(jsonRes(drives));
            f.mockResolvedValueOnce(jsonRes({ id: 'item-1' }));
            await expect(
                client(f).uploadNewFile(smuggled, 'root', 'r.pdf', new Uint8Array([1]), 'application/pdf'),
            ).rejects.toThrow('is not in an approved site');
            expect(f).toHaveBeenCalledTimes(1);
        }

        // Positive control: the refusals above are the allowlist working, not a
        // fixture that refuses everything.
        const ok = jest.fn();
        ok.mockResolvedValueOnce(jsonRes(drives));
        ok.mockResolvedValueOnce(jsonRes({ id: 'item-1' }));
        await expect(
            client(ok).uploadNewFile('drive-ok', 'root', 'r.pdf', new Uint8Array([1]), 'application/pdf'),
        ).resolves.toMatchObject({ id: 'item-1' });
    });
});

describe('change-notification subscriptions (SP-4)', () => {
    it('creates an `updated` subscription on the drive root with the client state', async () => {
        const f = jest.fn().mockResolvedValue(jsonRes({ id: 'sub-1' }));
        const sub = await client(f).createSubscription({
            driveId: 'drv1',
            notificationUrl: 'https://ic.example/api/webhooks/sharepoint',
            clientState: 'secret-state',
            expirationDateTime: '2026-01-01T00:00:00Z',
        });
        expect(sub.id).toBe('sub-1');
        expect(f.mock.calls[0][0]).toContain('/subscriptions');
        expect(f.mock.calls[0][1].method).toBe('POST');
        expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({
            changeType: 'updated',
            notificationUrl: 'https://ic.example/api/webhooks/sharepoint',
            resource: '/drives/drv1/root',
            expirationDateTime: '2026-01-01T00:00:00Z',
            clientState: 'secret-state',
        });
    });

    it('surfaces a failed subscription create with its status', async () => {
        const f = jest.fn().mockResolvedValue(jsonRes({}, false, 400));
        await expect(
            client(f).createSubscription({
                driveId: 'drv1',
                notificationUrl: 'https://ic/x',
                clientState: 's',
                expirationDateTime: 'e',
            }),
        ).rejects.toThrow('Graph subscription create → 400');
    });

    it('renews by PATCHing only the new expiry', async () => {
        const f = jest.fn().mockResolvedValue(jsonRes({ id: 'sub-1', expirationDateTime: '2026-02-02T00:00:00Z' }));
        const sub = await client(f).renewSubscription('sub-1', '2026-02-02T00:00:00Z');
        expect(sub.expirationDateTime).toBe('2026-02-02T00:00:00Z');
        expect(f.mock.calls[0][0]).toContain('/subscriptions/sub-1');
        expect(f.mock.calls[0][1].method).toBe('PATCH');
        expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ expirationDateTime: '2026-02-02T00:00:00Z' });
    });

    it('surfaces a failed renew with its status', async () => {
        const f = jest.fn().mockResolvedValue(jsonRes({}, false, 404));
        await expect(client(f).renewSubscription('sub-1', 'e')).rejects.toThrow('Graph subscription renew → 404');
    });

    it.each([204, 404])('deletes a subscription and tolerates %i (already gone)', async (status) => {
        // Disconnect must be idempotent: a subscription Graph already expired
        // must not fail the disconnect and strand the connection row.
        const f = jest.fn().mockResolvedValue(jsonRes(null, status === 204, status));
        await expect(client(f).deleteSubscription('sub-1')).resolves.toBeUndefined();
        expect(f.mock.calls[0][1].method).toBe('DELETE');
    });

    it('does NOT swallow a real delete failure', async () => {
        const f = jest.fn().mockResolvedValue(jsonRes({}, false, 500));
        await expect(client(f).deleteSubscription('sub-1')).rejects.toThrow('Graph subscription delete → 500');
    });
});


// ─── A truncated delta walk can be resumed (#5555) ─────────────────────────

describe('the cursor a truncated walk hands back', () => {
    /**
     * WHAT THIS IS ABOUT. `getDelta` set its return token only on the terminal
     * `@odata.deltaLink`. A walk that ran out of pages therefore returned
     * `deltaToken: undefined`, the caller stored nothing, and the drive
     * re-walked from the beginning on every run — stopping at the same page and
     * never checking a single item beyond it for a change or a deletion. The
     * discarded `@odata.nextLink` was the only thing that could have resumed it.
     */
    it('reports truncation and returns the pending cursor, prefixed with its parameter', async () => {
        // Every page offers another, so the walk can only end on the bound.
        const f = jest.fn(async (url: string) =>
            jsonRes({
                value: [{ id: `i-${url.length}` }],
                '@odata.nextLink': 'https://graph.microsoft.com/v1.0/drives/d1/root/delta?$skiptoken=PAGE9',
            }),
        );
        const page = await reader(f).getDelta('d1', undefined, 3);

        expect(page.truncated).toBe(true);
        // PREFIXED: Graph names this parameter `$skiptoken` on a paging link and
        // `token` on a deltaLink, and a bare value resumed under the wrong one
        // is silently ignored — the walk restarts, which is the bug.
        expect(page.deltaToken).toBe('skiptoken:PAGE9');
        expect(f).toHaveBeenCalledTimes(3);
    });

    it('is NOT truncated when the walk reaches the deltaLink, and returns a delta token', async () => {
        // The other side of the boundary: a completed walk must still hand back
        // a plain delta token, or every ordinary sync would be reported partial.
        const f = jest.fn(async () =>
            jsonRes({
                value: [{ id: 'a' }],
                '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=FINAL',
            }),
        );
        const page = await reader(f).getDelta('d1', undefined, 3);

        expect(page.truncated).toBe(false);
        expect(page.deltaToken).toBe('FINAL');
    });

    it('resumes a stored skiptoken cursor under $skiptoken, not token', async () => {
        // The parameter is DECLARED so `mock.calls[0][0]` is typed. A bare
        // `async () => …` gives `mock.calls` an empty tuple, which jest runs
        // happily and tsc refuses — a Typecheck failure, not a test failure.
        const f = jest.fn(async (_url: string) => jsonRes({ value: [], '@odata.deltaLink': 'x?token=T' }));
        await reader(f).getDelta('d1', 'skiptoken:PAGE9', 3);
        const url = f.mock.calls[0][0];
        expect(url).toContain('$skiptoken=PAGE9');
        expect(url).not.toContain('?token=');
    });

    it('still resumes a BARE stored cursor as a delta token — no migration needed', async () => {
        // Every cursor stored before #5555 is a bare delta token. Reading one as
        // a skiptoken would restart the enumeration on every existing
        // connection, which is a worse outage than the bug being fixed.
        const f = jest.fn(async (_url: string) => jsonRes({ value: [], '@odata.deltaLink': 'x?token=T' }));
        await reader(f).getDelta('d1', 'LEGACYTOKEN', 3);
        expect(f.mock.calls[0][0]).toContain('token=LEGACYTOKEN');
    });
});

describe('extractPageCursor / deltaQuery', () => {
    it('reads either parameter Graph may use, and nothing when it uses neither', () => {
        expect(extractPageCursor('https://g/x?$skiptoken=AB%2BC')).toBe('skiptoken:AB+C');
        expect(extractPageCursor('https://g/x?token=XY')).toBe('token:XY');
        // No cursor to store is not a failure — the caller is no worse off.
        expect(extractPageCursor('https://g/x?$top=200')).toBeUndefined();
    });

    it('round-trips a cursor back onto the parameter it came from', () => {
        expect(deltaQuery(extractPageCursor('https://g/x?$skiptoken=P9'))).toBe('?$skiptoken=P9');
        expect(deltaQuery(extractPageCursor('https://g/x?token=T1'))).toBe('?token=T1');
        // Bare = legacy delta token; absent = a first, uncursored walk.
        expect(deltaQuery('LEGACY')).toBe('?token=LEGACY');
        expect(deltaQuery(undefined)).toBe('');
    });
});
