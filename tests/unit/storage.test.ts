import { validateFile, getFile } from '@/lib/storage';
import fs from 'fs/promises';

// Mock fs/promises so we don't do real disk I/O in tests
jest.mock('fs/promises', () => ({
    access: jest.fn().mockResolvedValue(true),
    mkdir: jest.fn().mockResolvedValue(true),
    writeFile: jest.fn().mockResolvedValue(true),
    readFile: jest.fn().mockResolvedValue(Buffer.from('test data')),
}));

describe('Storage Security & Operations', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('validateFile', () => {
        it('allows valid files', () => {
            const file = new File(['dummy content'], 'test.pdf', { type: 'application/pdf' });
            expect(() => validateFile(file)).not.toThrow();
        });

        it('throws an error if file size exceeds the limit', () => {
            // Mock a large file size
            const file = { size: 15 * 1024 * 1024, type: 'application/pdf', name: 'large.pdf' } as unknown as File;
            expect(() => validateFile(file, { maxSizeMB: 10 })).toThrow(/max size is 10MB/);
        });

        it('throws an error for unapproved mime types', () => {
            const file = new File(['virus'], 'virus.exe', { type: 'application/x-msdownload' });
            expect(() => validateFile(file)).toThrow(/is not allowed/);
        });
    });

    // R5-P1 #2 — the deprecated `uploadFile()` helper was removed (flat,
    // non-tenant-prefixed, never AV-scanned); its path-traversal test went with
    // it. Tenant-prefixed uploads go through getStorageProvider().write().

    describe('getFile (Path Traversal Prevention)', () => {
        it('strips path components and only uses basename', async () => {
            await getFile('../../../etc/secret.txt');

            expect(fs.readFile).toHaveBeenCalled();
            const calledPath = (fs.readFile as jest.Mock).mock.calls[0][0];
            // The read path should NOT contain the traversal attempting
            expect(calledPath).not.toContain('..');
            expect(calledPath).toContain('secret.txt');
        });
    });
});
