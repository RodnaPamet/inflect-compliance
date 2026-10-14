/**
 * The byte formatter's locale form (projectZ #428). The plain form keeps its
 * coverage in `evidence-upload-limits.test.ts`, through the re-export every
 * evidence surface imports.
 */
import { formatBytes } from '@/lib/format-bytes';

describe('formatBytes with a locale', () => {
    it("writes the number the language's way", () => {
        expect(formatBytes(1572864, 'bg')).toBe('1,5 MB');
        expect(formatBytes(1572864, 'en')).toBe('1.5 MB');
    });

    it('never groups thousands, like the plain form', () => {
        // 1048575 bytes is 1023.999… KB; grouped it would read "1,024.0 KB"
        // in English, which is also how Bulgarian writes 1.024.
        expect(formatBytes(1048575, 'en')).toBe('1024.0 KB');
        expect(formatBytes(1048575)).toBe('1024.0 KB');
    });

    it('leaves bytes and the absent size alone', () => {
        expect(formatBytes(500, 'bg')).toBe('500 B');
        expect(formatBytes(null, 'bg')).toBe('—');
    });
});
