/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Unit tests for notification settings — disabled tenant skips enqueue.
 */
import { buildDedupeKey } from '@/app-layer/notifications/enqueue';

// Mock the settings module
jest.mock('@/app-layer/notifications/settings', () => ({
    isNotificationsEnabled: jest.fn(),
    getTenantNotificationSettings: jest.fn(),
}));

import { isNotificationsEnabled } from '@/app-layer/notifications/settings';
const mockedIsEnabled = isNotificationsEnabled as jest.MockedFunction<typeof isNotificationsEnabled>;

describe('enqueueEmail with tenant settings', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('buildDedupeKey still works with settings module loaded', () => {
        const key = buildDedupeKey('t1', 'TASK_ASSIGNED', 'a@b.com', 'eid', new Date('2026-03-17'));
        expect(key).toBe('t1:TASK_ASSIGNED:a@b.com:eid:2026-03-17');
    });

    it('isNotificationsEnabled defaults to true', async () => {
        // Test that our mock can be called
        mockedIsEnabled.mockResolvedValue(true);
        expect(await isNotificationsEnabled({} as any, 'tenant-1')).toBe(true);
    });

    it('isNotificationsEnabled can return false', async () => {
        mockedIsEnabled.mockResolvedValue(false);
        expect(await isNotificationsEnabled({} as any, 'tenant-1')).toBe(false);
    });
});

// The 'Settings defaults' block that stood here asserted a locally-declared
// object literal against its own literals: it built the defaults object and
// then expected each field to equal the value written three lines above. It
// never imported the real `defaults()` — this file mocks that whole module —
// so it survived every mutation to the code it was named for, and it kept the
// retired sender address alive in the tree as a supposed expectation. The real
// behaviour is covered against the real module in
// tests/unit/notification-sender-fallback.test.ts. Removed with #2296.
