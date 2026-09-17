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


// ─── In-app mute list (#2564) ───────────────────────────────────────
//
// Against the REAL module, reached through `jest.requireActual` because the
// mock at the top of this file replaces the whole thing. That is the same
// mistake the deleted block above made — asserting against a local literal
// while believing it was testing the code — so these tests import the actual
// implementation and drive it with a fake db, the shape
// `notification-sender-fallback.test.ts` established.
describe('in-app mute list (#2564)', () => {
    const actual = jest.requireActual('@/app-layer/notifications/settings') as
        typeof import('@/app-layer/notifications/settings');

    /** A settings table holding exactly one row (or none). */
    function dbWithRow(row: Record<string, unknown> | null) {
        return {
            tenantNotificationSettings: {
                findUnique: async () => row,
            },
        } as any;
    }

    it('defaults carry an empty list when the tenant has no row', async () => {
        const s = await actual.getTenantNotificationSettings(dbWithRow(null), 't1');
        expect(s.mutedInAppTypes).toEqual([]);
    });

    it('reads a NULL column as an empty list, not as undefined', async () => {
        // The column is nullable so a rolling deploy's old containers can
        // INSERT without it. `undefined` here would reach `.includes(...)` in
        // the emitter and throw, which the fire-and-forget catch would swallow
        // — a bell that silently stops ringing.
        const s = await actual.getTenantNotificationSettings(
            dbWithRow({
                enabled: true,
                defaultFromName: 'N',
                defaultFromEmail: 'a@b.test',
                complianceMailbox: null,
                mutedInAppTypes: null,
            }),
            't1',
        );
        expect(s.mutedInAppTypes).toEqual([]);
    });

    it('a partial update does not clear a stored list', async () => {
        // The `definedOnly` seam: `update` must not carry the key at all.
        // Passing it as `undefined` would ALSO leave the column alone (Prisma
        // drops undefined args), but passing `[]` would wipe it — so the
        // assertion is on the key's ABSENCE, which is what the code guarantees.
        let updateArg: Record<string, unknown> | undefined;
        const db = {
            tenantNotificationSettings: {
                upsert: async (args: any) => {
                    updateArg = args.update;
                    return {
                        enabled: true,
                        defaultFromName: 'Acme',
                        defaultFromEmail: 'a@b.test',
                        complianceMailbox: null,
                        mutedInAppTypes: ['AGENT_KILL_SWITCH_ENGAGED'],
                    };
                },
            },
        } as any;

        const ctx = { tenantId: 't1', userId: 'u1' } as any;
        const out = await actual.updateTenantNotificationSettings(db, ctx, {
            defaultFromName: 'Acme',
        });

        expect(updateArg).toBeDefined();
        expect('mutedInAppTypes' in updateArg!).toBe(false);
        // And the stored list survives into the response the route returns.
        expect(out.mutedInAppTypes).toEqual(['AGENT_KILL_SWITCH_ENGAGED']);
    });

    it('isInAppTypeEnabled is false for a muted type and true for any other', async () => {
        const db = dbWithRow({ mutedInAppTypes: ['AGENT_KILL_SWITCH_ENGAGED'] });
        expect(await actual.isInAppTypeEnabled(db, 't1', 'AGENT_KILL_SWITCH_ENGAGED')).toBe(false);
        // The paired positive: without it, a function that returned false for
        // everything would pass the line above.
        expect(await actual.isInAppTypeEnabled(db, 't1', 'AGENT_PROPOSAL_QUARANTINED')).toBe(true);
    });

    it('isInAppTypeEnabled fails OPEN when the tenant has no settings row', async () => {
        expect(
            await actual.isInAppTypeEnabled(dbWithRow(null), 't1', 'AGENT_KILL_SWITCH_ENGAGED'),
        ).toBe(true);
    });
});
