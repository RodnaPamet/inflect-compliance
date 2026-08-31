/**
 * SP-1 — SharePointMapper (Graph DriveItem ↔ Evidence field shape).
 *
 * ── Reachability note ──────────────────────────────────────────────
 * This class is registered in `bootstrap.ts` as the `sharepoint` bundle's
 * `mapperClass`, but NOTHING instantiates it today: `createMapper('sharepoint')`
 * has no call site in `src/`, SharePoint has no `orchestratorClass`, and the
 * SP-3 import path is file-oriented (download → uploadEvidenceFile) rather than
 * field-mapped. The registry's bundle type makes `mapperClass` mandatory, which
 * is why it exists at all.
 *
 * So these are contract assertions for the day SP-4's content sync wires it up,
 * not coverage of a live path. They are cheap and they are real behaviour — the
 * dot-path resolution and the ISO→Date normalisation are both easy to break —
 * but they should not be read as evidence that this module runs in production.
 */
import { SharePointMapper } from '@/app-layer/integrations/providers/sharepoint/mapper';

describe('SharePointMapper — Graph DriveItem → Evidence', () => {
    const item = {
        name: 'soc2.pdf',
        webUrl: 'https://contoso/sites/x/soc2.pdf',
        eTag: '"{GUID},3"',
        size: 4096,
        lastModifiedDateTime: '2026-01-02T03:04:05Z',
        file: { mimeType: 'application/pdf' },
    };

    it('resolves the nested Graph mime type through its dot path', () => {
        expect(new SharePointMapper().toLocal(item)).toMatchObject({
            title: 'soc2.pdf',
            sourceUrl: 'https://contoso/sites/x/soc2.pdf',
            eTag: '"{GUID},3"',
            sizeBytes: 4096,
            mimeType: 'application/pdf',
        });
    });

    it('normalises the ISO timestamp to a Date for recency compares', () => {
        // A string here would make every `remoteUpdatedAt > lastSyncedAt`
        // comparison a lexicographic one.
        const local = new SharePointMapper().toLocal(item);
        expect(local.remoteUpdatedAt).toEqual(new Date('2026-01-02T03:04:05Z'));
    });

    it('leaves a non-string timestamp alone rather than producing Invalid Date', () => {
        const local = new SharePointMapper().toLocal({ ...item, lastModifiedDateTime: 1735780000 });
        expect(local.remoteUpdatedAt).toBe(1735780000);
    });

    it('omits fields Graph did not send', () => {
        const local = new SharePointMapper().toLocal({ name: 'only-a-name' });
        expect(local).toEqual({ title: 'only-a-name' });
    });

    it('passes local values through unchanged in the remote direction', () => {
        // SP-4 uploads raw content; the remote direction is an identity
        // pass-through and must not, say, re-serialise the Date.
        const when = new Date('2026-01-02T03:04:05Z');
        expect(new SharePointMapper().toRemote({ title: 'a.pdf', remoteUpdatedAt: when })).toEqual({
            name: 'a.pdf',
            lastModifiedDateTime: when,
        });
    });

    it('honours per-tenant custom mappings passed to the constructor', () => {
        const mapper = new SharePointMapper({ customMappings: { title: 'parentReference.path' } });
        expect(mapper.toLocal({ ...item, parentReference: { path: '/drive/root:/Policies' } })).toMatchObject({
            title: '/drive/root:/Policies',
        });
    });
});
