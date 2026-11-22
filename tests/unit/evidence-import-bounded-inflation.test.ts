/**
 * The evidence import inflates each entry through `inflateEntryBounded`,
 * which counts bytes as they arrive and stops past a limit. The limit is the
 * entry's declared size, so an archive that understates an entry's size is
 * caught while inflating, not after the whole entry is in memory. JSZip reads
 * compressed input in 16 KiB blocks, so the most that is ever held is the
 * limit plus what one block inflates to.
 */
import JSZip from 'jszip';

import {
    ArchiveSizeClaimError,
    inflateEntryBounded,
    type JSZipEntryStream,
} from '@/app-layer/jobs/evidence-import';
import { understateUncompressedSize } from '../helpers/zip-size-lie';

// Large enough that its compressed bytes span several of JSZip's 16 KiB read
// blocks: one block of zeros can inflate to about 16 MiB, so stopping after the
// first block that crosses the limit is what bounds memory.
const REAL_SIZE = 96 * 1024 * 1024;

async function archive(): Promise<Buffer> {
    const zip = new JSZip();
    zip.file('big.pdf', Buffer.alloc(REAL_SIZE));
    zip.file('small.pdf', '%PDF-1.5\nsmall');
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

describe('inflateEntryBounded', () => {
    it('returns an honest entry whole', async () => {
        const zip = await JSZip.loadAsync(await archive());
        const buf = await inflateEntryBounded(zip.file('small.pdf')!, 1000, 'small.pdf');
        expect(buf.toString()).toBe('%PDF-1.5\nsmall');
    });

    it('stops an entry that inflates past the limit, long before its real size', async () => {
        const lying = understateUncompressedSize(await archive(), 'big.pdf', 1000);
        const zip = await JSZip.loadAsync(lying);
        const obj = zip.file('big.pdf')!;

        // Count every byte the decompressor emits, including any after the
        // refusal, to show the stream really stopped.
        let emitted = 0;
        const streamable = obj as unknown as { internalStream(type: 'nodebuffer'): JSZipEntryStream };
        const real = streamable.internalStream.bind(obj);
        streamable.internalStream = (type) => {
            const s = real(type);
            s.on('data', (c) => {
                emitted += c.length;
            });
            return s;
        };

        await expect(inflateEntryBounded(obj, 1064, 'big.pdf')).rejects.toBeInstanceOf(ArchiveSizeClaimError);
        await new Promise((r) => setTimeout(r, 200));
        expect(emitted).toBeLessThan(REAL_SIZE / 2);
    });
});
