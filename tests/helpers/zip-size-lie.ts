/**
 * Rewrite a ZIP so the named entry DECLARES a smaller uncompressed size than
 * it really has, in both its local file header and its central-directory
 * record. The compressed bytes are untouched, so the entry still inflates to
 * its real size. That is the archive a size check must not trust.
 */
const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;

export function understateUncompressedSize(zip: Buffer, entryName: string, declared: number): Buffer {
    const out = Buffer.from(zip);
    let patched = 0;
    for (let i = 0; i + 46 <= out.length; i++) {
        const sig = out.readUInt32LE(i);
        if (sig === LOCAL_HEADER) {
            const nameLen = out.readUInt16LE(i + 26);
            if (out.subarray(i + 30, i + 30 + nameLen).toString('utf8') === entryName) {
                out.writeUInt32LE(declared, i + 22);
                patched += 1;
            }
        } else if (sig === CENTRAL_HEADER) {
            const nameLen = out.readUInt16LE(i + 28);
            if (out.subarray(i + 46, i + 46 + nameLen).toString('utf8') === entryName) {
                out.writeUInt32LE(declared, i + 24);
                patched += 1;
            }
        }
    }
    if (patched !== 2) throw new Error(`understateUncompressedSize: patched ${patched} headers for ${entryName}, expected 2`);
    return out;
}
