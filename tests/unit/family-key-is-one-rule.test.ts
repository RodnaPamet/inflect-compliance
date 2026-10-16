/**
 * ONE COMPARISON, ONE RULE (#3612).
 *
 * The family-name blocker indexed the roster with `nameParts` and looked
 * accounts up with `normaliseName`. Those disagree:
 *
 *     normaliseName('User 4 Example').family    = 'Example'
 *     nameParts({ fullName: 'User 4 Example' }) = null
 *
 * So an account offered the key `Example` and the index did not contain it,
 * because the employee whose display name is byte-identical had been excluded
 * by a rule the lookup side does not apply. Measured on the first production
 * reconcile: four accounts at zero candidates, one of them exactly this.
 *
 * These tests pin the three things that made it hard to see: that the two
 * sides now agree, that `nameParts` is deliberately NOT changed, and that the
 * resulting candidate is still only a candidate — proposed, not linked.
 */
import { reconcile } from '@/lib/identity/reconcile/engine';
import { familyKeyOf } from '@/lib/identity/reconcile/family-key';
import { nameParts } from '@/lib/identity/reconcile/conventions';
import { normaliseName } from '@/lib/identity/reconcile/normalise';
import { step4aExtensions } from '@/lib/identity/reconcile/scorers';

const NOW = '2026-10-16T00:00:00.000Z';

describe('the two sides of the family-name comparison agree', () => {
    it.each([
        ['User 4 Example', 'Example'],
        ['Ada Nwosu', 'Nwosu'],
        ['Maria del Carmen Rodriguez', 'Rodriguez'],
        ['Jean-Luc Picard', 'Picard'],
    ])('%s -> %s on BOTH sides', (full, expected) => {
        // The lookup side, unchanged, and the index side, now matching it.
        expect(normaliseName(full).family?.toLowerCase()).toBe(expected.toLowerCase());
        expect(familyKeyOf({ fullName: full })?.toLowerCase()).toBe(expected.toLowerCase());
    });

    it('an explicit familyName beats anything derived from a display string', () => {
        expect(familyKeyOf({ familyName: 'Okonkwo', fullName: 'Chidi A. Something Else' }))
            .toBe('Okonkwo');
    });

    it('a one-token name yields NO key, rather than becoming one', () => {
        // Indexing `Cher` as a family name would collide every one-word record
        // in a roster into a single bucket.
        expect(familyKeyOf({ fullName: 'Cher' })).toBeNull();
        expect(familyKeyOf({ fullName: '' })).toBeNull();
        expect(familyKeyOf({})).toBeNull();
    });

    it('nameParts is deliberately UNCHANGED, because it answers a different question', () => {
        // It generates the username a convention expects, where guessing which
        // of three tokens is the family name is a wrong link rather than one
        // extra candidate. Its strictness is right there and wrong in blocking.
        expect(nameParts({ id: 'e', fullName: 'User 4 Example' })).toBeNull();
        expect(nameParts({ id: 'e', fullName: 'Ada Nwosu' }))
            .toEqual({ given: 'Ada', family: 'Nwosu', middle: '' });
    });
});

describe('the case that measured zero candidates in production', () => {
    const account = { accountKey: 'user4', displayName: 'User 4 Example', email: 'user4@example.test' };
    const employee = {
        id: 'e-4',
        fullName: 'User 4 Example',
        status: 'ACTIVE' as const,
        workEmail: 'different.four@example.test',
    };

    it('now produces a candidate, where it produced none', () => {
        const { scorers, blockers, ambiguityMargin } = step4aExtensions([employee], null);
        const r = reconcile({
            accounts: [account],
            roster: [employee],
            directory: [],
            aliases: [],
            now: NOW,
            config: { scorers, blockers, ambiguityMargin },
        });
        const res = r.resolutions[0];
        expect(res.candidates.length).toBeGreaterThan(0);
        expect(r.metrics.blockedAccounts).toBe(1);
        // And the metric says the roster WAS indexable, which is the fact that
        // separates "found nobody" from "could not ask".
        expect(r.metrics.rosterWithoutFamilyKey).toBe(0);
    });

    it('but is NOT auto-linked — the emails still conflict, and a veto still wins', () => {
        // The point of the fix is to let a reviewer SEE the candidate, not to
        // link past evidence of difference. Two different local parts in one
        // domain remain a veto; only a human confirmation may override it
        // (#3613), and none exists here.
        const { scorers, blockers, ambiguityMargin } = step4aExtensions([employee], null);
        const r = reconcile({
            accounts: [account],
            roster: [employee],
            directory: [],
            aliases: [],
            now: NOW,
            config: { scorers, blockers, ambiguityMargin },
        });
        expect(r.resolutions[0].outcome).not.toBe('LINKED');
        expect(r.resolutions[0].vetoes.map((v) => v.kind)).toContain('EMAIL_DOMAIN_CONFLICT');
    });

    it('a roster the blocker cannot index is COUNTED, not silently empty', () => {
        // The other direction: one-token names yield no family key, and the
        // metric says so rather than leaving a reader to blame the accounts.
        const oneWord = { id: 'e-9', fullName: 'Cher', status: 'ACTIVE' as const };
        const { scorers, blockers, ambiguityMargin } = step4aExtensions([oneWord], null);
        const r = reconcile({
            accounts: [account],
            roster: [oneWord],
            directory: [],
            aliases: [],
            now: NOW,
            config: { scorers, blockers, ambiguityMargin },
        });
        expect(r.metrics.rosterWithoutFamilyKey).toBe(1);
        expect(r.metrics.blockedAccounts).toBe(0);
    });
});
