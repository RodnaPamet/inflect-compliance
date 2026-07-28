/**
 * Unit coverage for the antivirus scanner entrypoints that the existing
 * `av-scan.test.ts` (download-gate only) leaves untested:
 *   - `scanBuffer` with no host (disabled → CLEAN, otherwise ERROR)
 *   - `scanBuffer` against an unreachable host (socket error → ERROR)
 *   - `scanStream` collect + too-large bound
 *   - `isClamavAvailable` (no host + unreachable host)
 *
 * The ClamAV INSTREAM success / infected parse branches need a live
 * clamd daemon and are intentionally not exercised.
 *
 * `@/env` is mocked because the env snapshot is captured at import
 * time; the mock object is mutated per test.
 */
import net from 'net';
import { Readable } from 'stream';

// Mutated per test; the factory reads the live reference.
const mockEnv: { AV_SCAN_MODE: string; CLAMAV_HOST: string | undefined } = {
    AV_SCAN_MODE: 'strict',
    CLAMAV_HOST: undefined,
};
jest.mock('@/env', () => ({ env: mockEnv }));

import {
    scanBuffer,
    scanStream,
    isClamavAvailable,
} from '@/lib/storage/av-scan';

beforeEach(() => {
    mockEnv.AV_SCAN_MODE = 'strict';
    mockEnv.CLAMAV_HOST = undefined;
});

describe('scanBuffer — ClamAV not configured', () => {
    it('returns CLEAN/disabled when scanning is disabled', async () => {
        mockEnv.AV_SCAN_MODE = 'disabled';
        const result = await scanBuffer(Buffer.from('hello'));
        expect(result.status).toBe('CLEAN');
        expect(result.engine).toBe('disabled');
        expect(result.durationMs).toBe(0);
        expect(result.rawOutput).toMatch(/disabled/i);
    });

    it('returns ERROR/none when not configured but scanning is required', async () => {
        mockEnv.AV_SCAN_MODE = 'strict';
        const result = await scanBuffer(Buffer.from('hello'));
        expect(result.status).toBe('ERROR');
        expect(result.engine).toBe('none');
        expect(result.rawOutput).toMatch(/not configured/i);
    });
});

describe('scanBuffer — unreachable ClamAV host', () => {
    it('dials the default port for a bare host, and resolves ERROR on socket error', async () => {
        // Bare host (no port) exercises the default-port branch in
        // parseClamavHost.
        //
        // This used to assert ONLY that the scan resolved ERROR, and relied
        // on nothing listening on 127.0.0.1:3310 to produce that error. That
        // assumption is false on any dev machine following the repo's own
        // setup: docker-compose.yml runs clamav/clamav:1.4 on 3310, so a real
        // daemon answered and the scan came back CLEAN. It passed in CI only
        // because the CI test job declares no clamav service.
        //
        // Stubbing `connect` fixes the dependency AND tightens the test: the
        // dialled port is now asserted directly (3310), which is what the
        // "default port path" in the name actually claims. The old version
        // never checked the port at all.
        const connectSpy = jest
            .spyOn(net.Socket.prototype, 'connect')
            .mockImplementation(function (this: net.Socket) {
                process.nextTick(() => {
                    this.emit('error', new Error('connect ECONNREFUSED (stubbed)'));
                    this.destroy();
                });
                return this;
            });

        try {
            mockEnv.CLAMAV_HOST = '127.0.0.1';
            const result = await scanBuffer(Buffer.from('payload-bytes'));

            expect(connectSpy).toHaveBeenCalledWith(3310, '127.0.0.1', expect.any(Function));
            expect(result.status).toBe('ERROR');
            expect(result.engine).toBe('clamav');
        } finally {
            connectSpy.mockRestore();
        }
    });

    it('resolves ERROR on socket error (explicit port path)', async () => {
        // 127.0.0.1:1 — nothing listening → ECONNREFUSED → error handler.
        mockEnv.CLAMAV_HOST = '127.0.0.1:1';
        const result = await scanBuffer(Buffer.alloc(64, 7));
        expect(result.status).toBe('ERROR');
        expect(result.engine).toBe('clamav');
    });
});

describe('scanStream', () => {
    it('collects a small stream and delegates to scanBuffer', async () => {
        mockEnv.AV_SCAN_MODE = 'disabled';
        const stream = Readable.from([Buffer.from('ab'), Buffer.from('cd')]);
        const result = await scanStream(stream);
        expect(result.status).toBe('CLEAN');
        expect(result.engine).toBe('disabled');
    });

    it('coerces non-buffer chunks then delegates', async () => {
        mockEnv.AV_SCAN_MODE = 'disabled';
        // string chunks → Buffer.from path inside scanStream.
        const stream = Readable.from(['ab', 'cd']);
        const result = await scanStream(stream);
        expect(result.status).toBe('CLEAN');
    });

    it('returns ERROR when the stream exceeds maxBytes', async () => {
        const stream = Readable.from([Buffer.alloc(10), Buffer.alloc(10)]);
        const result = await scanStream(stream, 5);
        expect(result.status).toBe('ERROR');
        expect(result.rawOutput).toMatch(/too large/i);
    });
});

describe('isClamavAvailable', () => {
    it('returns false when no host is configured', async () => {
        mockEnv.CLAMAV_HOST = undefined;
        await expect(isClamavAvailable()).resolves.toBe(false);
    });

    it('returns false when the host is unreachable', async () => {
        mockEnv.CLAMAV_HOST = '127.0.0.1:1';
        await expect(isClamavAvailable()).resolves.toBe(false);
    });
});
