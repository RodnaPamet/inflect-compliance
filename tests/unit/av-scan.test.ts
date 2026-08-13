/**
 * AV Scan — Unit Tests
 *
 * Tests the download gate logic and scan result parsing.
 * ClamAV integration tests are skipped if ClamAV is not running.
 */
import { isDownloadAllowed, getBlockedReason } from '../../src/lib/storage/av-scan';

// ─── Mock env for testing ───
// av-scan reads env.AV_SCAN_MODE — we mock it per test via process.env

describe('AV Scan - Download Gate', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        // Reset module cache to pick up env changes
        jest.resetModules();
        process.env = { ...originalEnv };
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    describe('strict mode', () => {
        beforeEach(() => {
            process.env.AV_SCAN_MODE = 'strict';
        });

        test('CLEAN files are downloadable', () => {
            expect(isDownloadAllowed('CLEAN')).toBe(true);
        });

        test('INFECTED files are blocked', () => {
            expect(isDownloadAllowed('INFECTED')).toBe(false);
        });

        test('PENDING files are blocked in strict mode', () => {
            expect(isDownloadAllowed('PENDING')).toBe(false);
        });

        test('null scan status is blocked in strict mode', () => {
            expect(isDownloadAllowed(null)).toBe(false);
        });

        test('SKIPPED files are downloadable', () => {
            expect(isDownloadAllowed('SKIPPED')).toBe(true);
        });
    });

    describe('permissive mode', () => {
        beforeEach(() => {
            process.env.AV_SCAN_MODE = 'permissive';
        });

        test('CLEAN files are downloadable', () => {
            expect(isDownloadAllowed('CLEAN')).toBe(true);
        });

        test('INFECTED files are still blocked', () => {
            expect(isDownloadAllowed('INFECTED')).toBe(false);
        });

        test('PENDING files are allowed in permissive mode', () => {
            expect(isDownloadAllowed('PENDING')).toBe(true);
        });

        test('null scan status is allowed in permissive mode', () => {
            expect(isDownloadAllowed(null)).toBe(true);
        });
    });

    describe('disabled mode', () => {
        beforeEach(() => {
            process.env.AV_SCAN_MODE = 'disabled';
        });

        test('unscanned statuses are downloadable when disabled', () => {
            expect(isDownloadAllowed('CLEAN')).toBe(true);
            expect(isDownloadAllowed('PENDING')).toBe(true);
            expect(isDownloadAllowed(null)).toBe(true);
            expect(isDownloadAllowed(undefined)).toBe(true);
        });

        test('a file already known INFECTED is STILL refused', () => {
            // Changed deliberately (this assertion used to expect `true`).
            // `disabled` means "do not scan new files" — it cannot un-know a
            // verdict already recorded against an old one. The AV webhook
            // (src/app/api/storage/av-webhook/route.ts) writes INFECTED with no
            // mode check, so a known-malware row genuinely can exist while the
            // mode is disabled; serving it is indefensible whatever the config.
            // This also makes the predicate match its own doc comment, which
            // has always claimed INFECTED is refused "regardless of mode".
            expect(isDownloadAllowed('INFECTED')).toBe(false);
        });
    });
});

describe('AV Scan - Blocked Reasons', () => {
    test('infected reason', () => {
        const reason = getBlockedReason('INFECTED');
        expect(reason).toContain('infected');
    });

    test('pending reason', () => {
        const reason = getBlockedReason('PENDING');
        expect(reason).toContain('pending');
    });

    test('null reason', () => {
        const reason = getBlockedReason(null);
        expect(reason).toContain('pending');
    });
});
