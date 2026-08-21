/**
 * The one rule every HRIS provider shares: dates beat the status string.
 *
 * Each test asserts the ordering AND the fallback in the same body, because a
 * "the string did not win" assertion passes just as well when the string branch
 * is dead code. The pair proves the string is genuinely read when no date
 * contradicts it, so the first assertion is about precedence rather than about a
 * branch that never ran.
 *
 * Both directions carry a distinct harm under the JML leaver pass, which acts on
 * `TERMINATED`:
 *   • string-beats-future-date would disable someone still serving notice;
 *   • string-beats-past-date would leave a departed worker enabled forever.
 */
import { deriveEmploymentStatus } from '@/app-layer/integrations/providers/hris/employment-status';

const NOW = new Date('2026-06-01T00:00:00Z');
const FUTURE = '2026-07-01';
const PAST = '2026-01-01';

describe('deriveEmploymentStatus — dates beat the status string', () => {
    it('a "Terminated" string with a FUTURE last day is OFFBOARDING; with no date it is TERMINATED', () => {
        // The #2012 regression class. "Terminated (Pending)" / "Terminated —
        // Notice" are ordinary administrator-typed values for someone who is
        // still employed and still coming to work.
        expect(
            deriveEmploymentStatus({ statusText: 'Terminated (Pending)', terminationDate: FUTURE }, NOW),
        ).toBe('OFFBOARDING');
        expect(deriveEmploymentStatus({ statusText: 'Terminated (Pending)' }, NOW)).toBe('TERMINATED');
    });

    it('an "Active" string with a PAST last day is TERMINATED; with no date it has no opinion', () => {
        // The mirror direction, and its own harm: believing the string here
        // leaves a departed worker's directory access enabled indefinitely.
        expect(deriveEmploymentStatus({ statusText: 'Active', terminationDate: PAST }, NOW)).toBe('TERMINATED');
        expect(deriveEmploymentStatus({ statusText: 'Active' }, NOW)).toBeNull();
    });

    it('a leaver status nobody tokenised is still retired by the date', () => {
        // "Separated" / "Alumni" match no token here. If the string led, a
        // tenant that names its leaver status this way would never retire
        // anybody — the failure would be total and completely silent.
        expect(deriveEmploymentStatus({ statusText: 'Separated' }, NOW)).toBeNull();
        expect(deriveEmploymentStatus({ statusText: 'Separated', terminationDate: PAST }, NOW)).toBe('TERMINATED');
    });

    it('an "Inactive" string with a FUTURE start date is ONBOARDING; a past start date leaves it to the string', () => {
        expect(deriveEmploymentStatus({ statusText: 'Inactive', hireDate: FUTURE }, NOW)).toBe('ONBOARDING');
        expect(deriveEmploymentStatus({ statusText: 'Inactive', hireDate: PAST }, NOW)).toBeNull();
    });

    it('a worker on leave resolves from the date when there is one, and from the string when there is not', () => {
        // Deliberate consequence, pinned so it reads as a decision: they are
        // leaving, and the date is the actionable fact. For a future date both
        // answers mean "do not disable yet", so this is safe either way — but it
        // must be predictable.
        expect(deriveEmploymentStatus({ statusText: 'On Leave', terminationDate: FUTURE }, NOW)).toBe('OFFBOARDING');
        expect(deriveEmploymentStatus({ statusText: 'On Leave' }, NOW)).toBe('LEAVE');
    });

    it('a termination date outranks a future hire date', () => {
        expect(deriveEmploymentStatus({ hireDate: FUTURE, terminationDate: FUTURE }, NOW)).toBe('OFFBOARDING');
        expect(deriveEmploymentStatus({ hireDate: FUTURE }, NOW)).toBe('ONBOARDING');
    });
});

describe('deriveEmploymentStatus — reading vendor dates', () => {
    it('an unparseable termination date falls THROUGH to the status string rather than being compared', () => {
        // `new Date('nope') > now` is false, so a naive comparison would read
        // garbage as "not in the future" and answer from the wrong branch.
        expect(deriveEmploymentStatus({ statusText: 'On Leave', terminationDate: 'not a date' }, NOW)).toBe('LEAVE');
        expect(deriveEmploymentStatus({ statusText: 'On Leave', terminationDate: FUTURE }, NOW)).toBe('OFFBOARDING');
    });

    it('an empty-string date is absent, not epoch zero', () => {
        // '' is falsy, so it must never be read as 1970 — which would be a past
        // termination date, and would retire every worker whose vendor sends the
        // field blank rather than omitting it.
        expect(deriveEmploymentStatus({ statusText: 'Active', terminationDate: '' }, NOW)).toBeNull();
        expect(deriveEmploymentStatus({ statusText: 'Active', terminationDate: PAST }, NOW)).toBe('TERMINATED');
    });

    it('accepts Date objects as well as vendor date strings', () => {
        expect(deriveEmploymentStatus({ terminationDate: new Date(FUTURE) }, NOW)).toBe('OFFBOARDING');
        expect(deriveEmploymentStatus({ terminationDate: new Date(PAST) }, NOW)).toBe('TERMINATED');
    });
});

describe('deriveEmploymentStatus — no opinion', () => {
    it('returns null when neither dates nor string spoke, so the provider applies its own last resort', () => {
        // null rather than a defaulted ACTIVE: "no signal" and "positively
        // active" are different facts, and only the provider knows which of its
        // own fields could still speak (Workday has `activeStatus`).
        expect(deriveEmploymentStatus({}, NOW)).toBeNull();
        expect(deriveEmploymentStatus({ statusText: 'Full-Time' }, NOW)).toBeNull();
        expect(deriveEmploymentStatus({ statusText: 'On Leave' }, NOW)).toBe('LEAVE');
    });

    it('recognises the pre-hire tokens when no date contradicts them', () => {
        for (const statusText of ['Pre-Hire', 'prehire', 'Onboarding']) {
            expect(deriveEmploymentStatus({ statusText }, NOW)).toBe('ONBOARDING');
        }
        expect(deriveEmploymentStatus({ statusText: 'Pre-Hire', terminationDate: PAST }, NOW)).toBe('TERMINATED');
    });
});
