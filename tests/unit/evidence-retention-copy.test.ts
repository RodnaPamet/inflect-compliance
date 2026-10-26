/**
 * The Evidence page's retention copy says what happens (#4277).
 *
 *   - The upload form's retention tooltip said "admins can still recover it".
 *     Editors can unarchive too; unarchiving did not bring the evidence back;
 *     and evidence its retention date archived is deleted for good
 *     `DEFAULT_EVIDENCE_PURGE_DAYS` after it expired. It now says so, with the
 *     way back the product actually has (option B): a new retention date.
 *   - The archived notice said "Unarchive if you need to reuse this
 *     evidence", which unarchive refuses while the retention date has passed.
 *
 * The purge figure is read from the purge job's own constant, so the tooltip
 * cannot keep a number the job no longer uses.
 */
jest.mock('@/lib/prisma', () => ({ prisma: {}, default: {} }));

import { DEFAULT_EVIDENCE_PURGE_DAYS } from '@/app-layer/jobs/data-lifecycle';

const EN = require('../../messages/en.json');
const BG = require('../../messages/bg.json');

describe('the retention tooltip', () => {
    it.each([
        ['en', EN],
        ['bg', BG],
    ])('%s names the purge the job runs', (_lang, messages) => {
        expect(messages.evidence.upload.retainTooltip).toContain(`${DEFAULT_EVIDENCE_PURGE_DAYS}`);
    });

    it('promises no recovery by admins alone, and names the way back', () => {
        const text: string = EN.evidence.upload.retainTooltip;
        expect(text).not.toMatch(/admins can still recover/i);
        expect(text).toMatch(/Editor or Admin/);
        expect(text).toMatch(/new retention date/);
    });
});

describe('the archived notice', () => {
    it('says a passed retention date needs a new one before unarchiving', () => {
        const text: string = EN.evidence.list.archivedNoticeBody;
        expect(text).toMatch(/Retention date first/);
        expect(text).not.toMatch(/Unarchive if you need to reuse this evidence\./);
    });
});
