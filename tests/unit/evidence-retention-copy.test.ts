/**
 * The Evidence page's retention copy says what happens (#4277).
 *
 *   - The upload form's retention tooltip said "admins can still recover it".
 *     Editors can unarchive too; unarchiving did not bring the evidence back;
 *     and evidence its retention date archived is deleted for good
 *     `DEFAULT_EVIDENCE_PURGE_DAYS` after it expired. It now says so, and
 *     names the way back the product has (#4304): unarchiving, which clears
 *     the retention date that passed.
 *   - The archived notice now says that evidence whose retention date passed
 *     comes back without that date, so a new one may need setting.
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
        expect(text).toMatch(/unarchiving it/);
        // No new date is needed first: unarchive clears the one that passed.
        expect(text).not.toMatch(/new retention date/);
    });
});

describe('the archived notice', () => {
    it('says evidence past its retention date comes back without that date', () => {
        const text: string = EN.evidence.list.archivedNoticeBody;
        expect(text).toMatch(/comes back too, without that date/);
        expect(text).not.toMatch(/Retention date first/);
    });
});
