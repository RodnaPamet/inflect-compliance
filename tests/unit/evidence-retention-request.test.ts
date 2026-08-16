/**
 * Creating evidence and stamping its retention date are TWO writes.
 *
 * The upload path fired the second one and never read the response:
 *
 *     if (vars.retentionUntil && uploaded?.id) {
 *         await fetch(apiUrl(`/evidence/${uploaded.id}/retention`), { … });
 *     }
 *     return uploaded;
 *
 * So a non-ok reply was swallowed — the dropzone reported success, the modal
 * closed, and the user was left with a row that has no retention on it and no
 * reason given. `EditEvidenceModal` already handled exactly this ("PARTIAL
 * SAVE … the user has to be told which half"); the create paths did not.
 *
 * These cover the contract that makes the difference: a failed second write
 * must be observable to the caller.
 */
import {
    applyEvidenceRetention,
    applyEvidenceRetentionBatch,
    RetentionNotApplied,
} from '@/lib/evidence-retention-request';

const apiUrl = (p: string) => `/api/t/acme${p}`;

const okFetch = () => jest.fn().mockResolvedValue({ ok: true });
const failFetch = () => jest.fn().mockResolvedValue({ ok: false, status: 500 });

afterEach(() => {
    jest.restoreAllMocks();
});

describe('applyEvidenceRetention', () => {
    it('posts the date to the row it was given', async () => {
        const f = okFetch();
        global.fetch = f as unknown as typeof fetch;

        await applyEvidenceRetention(apiUrl, 'ev-1', '2027-01-31');

        expect(f).toHaveBeenCalledTimes(1);
        const [url, init] = f.mock.calls[0];
        expect(url).toBe('/api/t/acme/evidence/ev-1/retention');
        expect(init.method).toBe('POST');
        const body = JSON.parse(init.body);
        expect(body.retentionPolicy).toBe('FIXED_DATE');
        expect(body.retentionUntil).toBe(new Date('2027-01-31').toISOString());
    });

    it('THROWS on a non-ok reply instead of resolving', async () => {
        // The whole defect in one assertion. This used to resolve, and the
        // caller went on to report success.
        global.fetch = failFetch() as unknown as typeof fetch;

        await expect(applyEvidenceRetention(apiUrl, 'ev-1', '2027-01-31'))
            .rejects.toBeInstanceOf(RetentionNotApplied);
    });

    it('names the row that missed the date', async () => {
        global.fetch = failFetch() as unknown as typeof fetch;

        await expect(applyEvidenceRetention(apiUrl, 'ev-9', '2027-01-31'))
            .rejects.toMatchObject({ evidenceIds: ['ev-9'] });
    });
});

describe('applyEvidenceRetentionBatch', () => {
    it('applies the date to every row the import created', async () => {
        const f = okFetch();
        global.fetch = f as unknown as typeof fetch;

        await applyEvidenceRetentionBatch(apiUrl, ['a', 'b', 'c'], '2027-01-31');

        expect(f).toHaveBeenCalledTimes(3);
        expect(f.mock.calls.map((c) => c[0])).toEqual([
            '/api/t/acme/evidence/a/retention',
            '/api/t/acme/evidence/b/retention',
            '/api/t/acme/evidence/c/retention',
        ]);
    });

    it('attempts ALL rows even after one fails, and reports only the failures', async () => {
        // Settling the whole batch is deliberate. Short-circuiting on the
        // first failure would leave the rest unattempted for no benefit, and
        // a half-applied batch is exactly the state the user needs named.
        const f = jest.fn()
            .mockResolvedValueOnce({ ok: true })
            .mockResolvedValueOnce({ ok: false, status: 500 })
            .mockResolvedValueOnce({ ok: true });
        global.fetch = f as unknown as typeof fetch;

        await expect(applyEvidenceRetentionBatch(apiUrl, ['a', 'b', 'c'], '2027-01-31'))
            .rejects.toMatchObject({ evidenceIds: ['b'] });
        expect(f).toHaveBeenCalledTimes(3);
    });

    it('resolves quietly when every row took the date', async () => {
        global.fetch = okFetch() as unknown as typeof fetch;
        await expect(
            applyEvidenceRetentionBatch(apiUrl, ['a', 'b'], '2027-01-31'),
        ).resolves.toBeUndefined();
    });
});
