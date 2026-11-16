/**
 * Dated deferrals for stale override FLOORS (#5652).
 *
 * `overrides` in `package.json` exists to enforce a MINIMUM. A floor below the
 * first version an advisory excludes enforces nothing, and the weekly
 * `Override Freshness` job detects exactly that: `ESCALATES` contains `floor`,
 * and the job opens a tracking issue naming the package and the version to
 * raise to.
 *
 * THE DETECTOR WORKED AND NOBODY ACTED. #5652 is that job's own output. It sat
 * open with seven floor findings against two packages while the tracking issue
 * described the one-line fix. Nothing was broken: the weekly report is
 * non-blocking BY DESIGN (its header says so, and `npm audit` is the gate that
 * blocks merges on evidence of a real advisory rather than version
 * arithmetic). What was missing was any bound on how long an acknowledged
 * stale floor may stay acknowledged.
 *
 * So this guard does NOT make that job blocking, and deliberately pins nothing
 * about its blocking-ness. It governs the OTHER half: if somebody decides not
 * to raise a floor yet, that decision is written down as a dated marker, and
 * the deadline is enforced here — offline, at PR time, failing the day after it
 * lapses.
 *
 *   FLOOR-STALE-UNTIL: YYYY-MM-DD <package> — <reason>
 *
 * Borrowed wholesale from `dast-workflow-pinning.test.ts`, including the two
 * properties that make it work rather than decorate:
 *
 *   1. An UNPARSEABLE date is EXPIRED, never an open deferral. A marker that
 *      cannot be read is not permission.
 *   2. The arithmetic is exercised against FIXED CLOCKS below. The live
 *      population is empty today — no floor is stale, which is the state #5726
 *      restored — and an empty population passing every assertion is
 *      indistinguishable from a comparison that never runs. The fixed-clock
 *      cases are what prove the mechanism is live; the population check is what
 *      binds it to reality once somebody writes a marker.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const WORKFLOW = '.github/workflows/override-freshness.yml';
const PACKAGE_JSON = 'package.json';

/**
 * A REAL date is required, so the prose placeholder in the workflow header —
 * which documents the convention rather than invoking it — does not match.
 * Same deliberate asymmetry as the DAST marker.
 */
const MARKER_RE = /FLOOR-STALE-UNTIL:\s*(\d{4}-\d{2}-\d{2})\s+(\S+)\s*—\s*(\S[^\n]*)/g;

/**
 * Shorter than DAST's 180 days on purpose. Raising a floor is a ONE-LINE edit
 * that re-resolves nothing when the lockfile already sits above it (#5726
 * measured exactly that: package.json only, no lockfile change, no resolved
 * version moved). A quarter is already generous for work that size; longer is a
 * way of never deciding.
 */
const MAX_DEFERRAL_DAYS = 90;

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

interface Marker {
    date: string;
    pkg: string;
    reason: string;
}

function markers(): Marker[] {
    return [...read(WORKFLOW).matchAll(MARKER_RE)].map((m) => ({
        date: m[1],
        pkg: m[2],
        reason: m[3].trim(),
    }));
}

type Verdict = 'active' | 'expired' | 'unreasonable';

/**
 * The live half. `now` is injected so the arithmetic can be pinned; the real
 * assertion passes `new Date()`. The deadline day itself is still active
 * (end-of-day UTC), so a marker dated today does not fail until tomorrow.
 */
function verdict(dateStr: string, now: Date): Verdict {
    const deadline = Date.parse(`${dateStr}T23:59:59Z`);
    if (Number.isNaN(deadline)) return 'expired'; // unreadable is not permission
    if (now.getTime() > deadline) return 'expired';
    if (deadline > now.getTime() + MAX_DEFERRAL_DAYS * 24 * 60 * 60 * 1000) return 'unreasonable';
    return 'active';
}

describe('the floor-deferral clock', () => {
    // Without these, a population whose markers all sit in the future — or an
    // empty one, which is today's state — is indistinguishable from a
    // comparison that never happens. That is how the DAST sunset check stayed
    // green for 36 days past its own deadline.
    const now = new Date('2026-11-16T08:00:00Z');

    it('treats a passed date as expired', () => {
        expect(verdict('2026-11-15', now)).toBe('expired');
        expect(verdict('2026-01-01', now)).toBe('expired');
    });

    it('keeps the deadline day itself active, and expires the day after', () => {
        expect(verdict('2026-11-16', now)).toBe('active');
        expect(verdict('2026-11-16', new Date('2026-11-17T00:00:01Z'))).toBe('expired');
    });

    it('treats an unparseable date as expired, never as an open deferral', () => {
        expect(verdict('not-a-date', now)).toBe('expired');
        expect(verdict('2026-13-45', now)).toBe('expired');
    });

    it('refuses a deferral further out than the cap', () => {
        expect(verdict('2027-06-01', now)).toBe('unreasonable');
        expect(verdict('2026-12-31', now)).toBe('active');
    });
});

describe('the declared floor deferrals', () => {
    it('are all in date, and none is a way of never deciding', () => {
        const now = new Date();
        const bad = markers()
            .map((m) => ({ ...m, v: verdict(m.date, now) }))
            .filter((m) => m.v !== 'active');
        expect(bad.map((m) => `${m.pkg} ${m.date} (${m.v})`)).toEqual([]);
    });

    it('name a package the overrides block actually pins', () => {
        // A marker for a package no override governs defers nothing. It would
        // read as coverage of a floor that does not exist.
        const overrides = JSON.parse(read(PACKAGE_JSON)).overrides ?? {};
        const unknown = markers().filter((m) => !(m.pkg in overrides));
        expect(unknown.map((m) => m.pkg)).toEqual([]);
    });

    it('each carry a reason, because a bare date records no decision', () => {
        const silent = markers().filter((m) => m.reason.length < 12);
        expect(silent.map((m) => `${m.pkg}: ${m.reason}`)).toEqual([]);
    });
});

describe('the detector this defers against stays wired', () => {
    // The deferral is only meaningful while something still FINDS stale
    // floors. These pin the output path that produced #5652 — not the job's
    // blocking-ness, which its header decides and this guard leaves alone.
    const wf = () => read(WORKFLOW);

    it('still runs the freshness script and captures its findings as JSON', () => {
        expect(wf()).toContain('node scripts/check-override-freshness.mjs --json > findings.json');
    });

    it('still self-tests the comparators, blockingly', () => {
        // A broken comparator reports a clean bill of health for ever, so this
        // step is the one thing in that job that must fail loudly.
        expect(wf()).toContain('node scripts/check-override-freshness.mjs --self-test');
    });

    it('still counts floor findings and opens a tracking issue from them', () => {
        expect(wf()).toMatch(/x\.level===?'floor'|x\.level === 'floor'/);
        expect(wf()).toContain('Open or update the tracking issue');
    });

    it('documents the marker convention, and the placeholder does not invoke it', () => {
        expect(wf()).toContain('FLOOR-STALE-UNTIL: <YYYY-MM-DD>');
        // Asserted against the placeholder STRING, not against the current
        // population: pinning "no deferrals exist" would fail the day somebody
        // legitimately writes one, which is the opposite of the intent.
        const placeholder = 'FLOOR-STALE-UNTIL: <YYYY-MM-DD> <package> — <why, and who is waiting on what>';
        expect([...placeholder.matchAll(MARKER_RE)]).toEqual([]);
    });
});
