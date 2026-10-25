/**
 * The asset form's "Retention until" hints describe what the nightly sweep
 * actually does to the asset (#4276).
 *
 * The hints said the asset is "auto-retired" when the date passes (bg:
 * "архивира" — archived). `runRetentionSweep` does neither: it soft-deletes
 * the row, which puts it in the Deleted assets view until the 90-day purge
 * removes it for good, and it never touches `status`. A user who set a date
 * expecting a RETIRED asset that stays in the register got a deleted one.
 *
 * So the test runs the sweep first — the behaviour the copy must describe —
 * and then holds both locales' copy to it: the hint names the place the
 * swept asset goes (the Deleted assets view, by its own label), and claims
 * neither retirement nor archival.
 */
import { runRetentionSweep } from '@/app-layer/jobs/data-lifecycle';

const en = require('../../messages/en.json');
const bg = require('../../messages/bg.json');

const NOW = new Date('2026-10-25T03:00:00.000Z');

describe('the retention sweep, as the hint must describe it', () => {
    it('soft-deletes an expired asset and never sets its status', async () => {
        const update = jest.fn().mockResolvedValue({});
        const db = {
            asset: {
                findMany: jest.fn().mockResolvedValue([{ id: 'as-1', tenantId: 'tenant-1' }]),
                update,
            },
            auditLog: { create: jest.fn().mockResolvedValue({}) },
        };

        await runRetentionSweep({ now: NOW, db: db as never });

        expect(update).toHaveBeenCalledTimes(1);
        const { data } = update.mock.calls[0][0] as { data: Record<string, unknown> };
        expect(data.deletedAt).toEqual(NOW);
        // Not retirement: the register's ACTIVE/RETIRED status is untouched.
        expect(data).not.toHaveProperty('status');
    });
});

describe.each([
    ['en', en],
    ['bg', bg],
] as const)('the %s retention hints', (_locale, messages) => {
    it('say the asset ends up in the Deleted assets view', () => {
        expect(messages.assets.form.retentionUntilNote).toContain(messages.assets.deleted.toggle);
    });
});

describe('the retention hints claim neither retirement nor archival', () => {
    it('en', () => {
        expect(en.assets.form.retentionUntilNote).not.toMatch(/retire/i);
        expect(en.assets.form.retentionNote).not.toMatch(/retire/i);
    });

    it('bg', () => {
        // "архив" — archive, which the old copy said; "изведен / изваден" —
        // retired, which the status labels use.
        expect(bg.assets.form.retentionUntilNote).not.toMatch(/архив|изведен|изваден/i);
        expect(bg.assets.form.retentionNote).not.toMatch(/архив|изведен|изваден/i);
    });
});
