/**
 * R2-P4 — control-area polish sweep (structural ratchet).
 *
 * Six small consistency fixes; this locks them so they don't regress:
 *   1. The list evidence count = links + direct Evidence (matches the detail
 *      badge, which counts both).
 *   2. ControlRoiCard + ControlBiaSurface surface a load failure (retry)
 *      instead of returning null (a silent disappearance).
 *   3. The Checks tab humanizes the raw status enum.
 *   5. The Coverage view uses client navigation, not window.location.href.
 *   6. The applicability column shows three states (Applicable / Not
 *      applicable / Not assessed).
 * (Item 4 — evidence deep-link — landed in R2-P2.)
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const APP = 'src/app/t/[tenantSlug]/(app)';
const CONTROLS_CLIENT = `${APP}/controls/ControlsClient.tsx`;
const CONTROL_REPO = 'src/app-layer/repositories/ControlRepository.ts';
const ROI_CARD = `${APP}/controls/[controlId]/_components/ControlRoiCard.tsx`;
const BIA_SURFACE = 'src/components/bia/ControlBiaSurface.tsx';
const CHECKS_TAB = `${APP}/controls/[controlId]/_tabs/ControlChecksTab.tsx`;
const COVERAGE_CLIENT = `${APP}/coverage/CoverageClient.tsx`;

describe('R2-P4 (1) evidence count = links + Evidence-entity links', () => {
    it('the list select counts evidence too and the column sums both', () => {
        // EP-3 — `Evidence.controlId` (direct) → the `EvidenceControlLink`
        // join, so the second summed count is `evidenceControlLinks`.
        expect(read(CONTROL_REPO)).toMatch(/evidenceLinks: true, evidenceControlLinks: true/);
        expect(read(CONTROLS_CLIENT)).toMatch(/evidenceLinks \?\? 0\) \+ \(c\._count\?\.evidenceControlLinks \?\? 0\)/);
    });
});

describe('R2-P4 (2) load failures surfaced with retry', () => {
    it('ControlRoiCard shows an error+retry instead of returning null', () => {
        const src = read(ROI_CARD);
        expect(src).toMatch(/control-roi-card-error/);
        expect(src).toMatch(/roi\.retry/);
    });
    it('ControlBiaSurface reads error and offers retry', () => {
        const src = read(BIA_SURFACE);
        expect(src).toMatch(/error, mutate/);
        expect(src).toMatch(/control-bia-error/);
    });
});

describe('R2-P4 (3) checks status humanized', () => {
    it('the Checks tab maps the raw enum to a localized label', () => {
        const src = read(CHECKS_TAB);
        expect(src).toMatch(/humanizeStatus/);
        expect(src).not.toMatch(/\{row\.original\.status\}/);
        expect(src).not.toMatch(/\{latest\.status\}/);
    });
});

describe('R2-P4 (5) coverage uses client navigation', () => {
    it('CoverageClient navigates through the client router, not window.location.href', () => {
        const src = read(COVERAGE_CLIENT);
        // #3099 moved every row navigation onto `useGuardedPush`, which IS
        // `router.push` plus a one-shot retry for the transition the client
        // router silently drops during hydration. The invariant this locks is
        // "client navigation, not a full document load", and the hook satisfies
        // it strictly more than the raw call did — so both spellings count and
        // the negative half below is untouched. (`guardedPush(` cannot be
        // satisfied by `useGuardedPush(`: the hook's name capitalises the G.)
        expect(src).toMatch(/guardedPush\(|router\.push\(/);
        expect(src).not.toMatch(/window\.location\.href\s*=/);
    });
});

describe('R2-P4 (6) applicability three states', () => {
    it('the list select carries applicabilityDecidedAt and the column shows Not assessed', () => {
        expect(read(CONTROL_REPO)).toMatch(/applicabilityDecidedAt: true/);
        expect(read(CONTROLS_CLIENT)).toMatch(/list\.notAssessed/);
        expect(read(CONTROLS_CLIENT)).toMatch(/applicabilityDecidedAt/);
    });
});

describe('R2-P4 i18n parity', () => {
    const en = JSON.parse(read('messages/en.json'));
    const bg = JSON.parse(read('messages/bg.json'));
    it('new keys exist in both locales', () => {
        for (const l of [en, bg]) {
            expect(l.controls.list.notAssessed).toBeTruthy();
            expect(l.controls.roi.loadError).toBeTruthy();
            expect(l.panels.bia.loadError).toBeTruthy();
        }
    });
});
