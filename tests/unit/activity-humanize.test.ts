/**
 * `src/lib/audit/activity-humanize.ts` — the pure layer that turns raw audit
 * rows into the dashboard's Recent Activity feed.
 *
 * WHAT BREAKS IF THIS IS WRONG
 * ----------------------------
 * `RecentActivityCard` renders `t('verb.' + verb.token)` and
 * `t('entity.' + meta.nounKey)`. A token this module invents that has no
 * message key renders as the raw key — `dashboard.activity.verb.FROBNICATED`
 * on a customer's dashboard — and a wrong `path()` sends the operator to a
 * 404 while looking at the audit trail. Both are silent: the feed still
 * renders, so nothing fails until someone reads it.
 *
 * The module was written for that card and had no test. Every assertion here
 * is about behaviour the card depends on: the token/fallback contract, the
 * link surface per entity type, and the two-word-suffix precedence that makes
 * a status change read as one.
 */
import {
    ACTIVITY_ENTITY_META,
    KNOWN_ACTIVITY_VERBS,
    activityEntityMeta,
    activityVerbToken,
    humanizeSnakeCase,
    normalizeActivityEntity,
} from '@/lib/audit/activity-humanize';

describe('normalizeActivityEntity', () => {
    it('collapses the casing each logEvent caller happens to use', () => {
        // The three spellings that actually occur in the audit table.
        expect(normalizeActivityEntity('Risk')).toBe('RISK');
        expect(normalizeActivityEntity('RISK')).toBe('RISK');
        expect(normalizeActivityEntity('risk')).toBe('RISK');
    });

    it('trims surrounding whitespace so a padded entity still resolves', () => {
        expect(normalizeActivityEntity('  control \n')).toBe('CONTROL');
    });
});

describe('humanizeSnakeCase', () => {
    it('de-snakes an action into readable words', () => {
        expect(humanizeSnakeCase('RISK_STATUS_CHANGED')).toBe('risk status changed');
    });

    it('collapses repeated underscores rather than emitting double spaces', () => {
        expect(humanizeSnakeCase('POLICY__APPROVED')).toBe('policy approved');
    });

    it('leaves a single word alone', () => {
        expect(humanizeSnakeCase('CREATED')).toBe('created');
    });

    it('returns an empty string for an empty action instead of throwing', () => {
        // The card calls this unconditionally as the fallback branch.
        expect(humanizeSnakeCase('   ')).toBe('');
    });
});

describe('ACTIVITY_ENTITY_META — the link surface', () => {
    /**
     * Every entry's `path` is exercised, because a wrong route here is a 404
     * the feed happily renders as a working link.
     */
    it.each([
        ['RISK', 'risk', '/risks/abc'],
        ['CONTROL', 'control', '/controls/abc'],
        ['POLICY', 'policy', '/policies/abc'],
        ['TASK', 'task', '/tasks/abc'],
        ['VENDOR', 'vendor', '/vendors/abc'],
        ['ASSET', 'asset', '/assets/abc'],
        ['INCIDENT', 'incident', '/incidents/abc'],
        ['ISSUE', 'issue', '/issues/abc'],
    ])('%s links to its detail route', (entity, nounKey, expected) => {
        const meta = ACTIVITY_ENTITY_META[entity];
        expect(meta.nounKey).toBe(nounKey);
        expect(meta.path).not.toBeNull();
        expect(meta.path!('abc')).toBe(expected);
    });

    it('links evidence to the detail SHEET, since it has no [id] route', () => {
        expect(ACTIVITY_ENTITY_META.EVIDENCE.path!('ev1')).toBe('/evidence?ev=ev1');
    });

    it('gives finding no path at all — it has no per-item surface', () => {
        expect(ACTIVITY_ENTITY_META.FINDING.path).toBeNull();
        expect(ACTIVITY_ENTITY_META.FINDING.nounKey).toBe('finding');
    });

    it('builds tenant-RELATIVE paths — the caller prefixes /t/<slug>', () => {
        for (const meta of Object.values(ACTIVITY_ENTITY_META)) {
            if (meta.path === null) continue;
            const built = meta.path('x');
            expect(built.startsWith('/')).toBe(true);
            expect(built.startsWith('/t/')).toBe(false);
        }
    });
});

describe('activityEntityMeta', () => {
    it('resolves whatever casing the audit row carries', () => {
        expect(activityEntityMeta('Risk')?.nounKey).toBe('risk');
        expect(activityEntityMeta('  VENDOR  ')?.nounKey).toBe('vendor');
    });

    it('returns null for an entity with no entry, so the card can fall back', () => {
        // RecentActivityCard renders humanizeSnakeCase(entity) on null.
        expect(activityEntityMeta('TENANT_SECURITY_SETTINGS')).toBeNull();
        expect(activityEntityMeta('')).toBeNull();
    });
});

describe('activityVerbToken', () => {
    it('matches the trailing verb of a namespaced action', () => {
        expect(activityVerbToken('RISK_CREATED')).toEqual({
            token: 'CREATED',
            fallback: 'risk created',
        });
    });

    it('prefers the two-word STATUS_CHANGED suffix over the trailing token', () => {
        // Without the precedence rule this resolves to 'CHANGED' and the feed
        // reads "changed the risk" instead of "changed the status of the risk".
        expect(activityVerbToken('CONTROL_STATUS_CHANGED')).toEqual({
            token: 'STATUS_CHANGED',
            fallback: 'control status changed',
        });
    });

    it('treats a bare STATUS_CHANGED action the same way', () => {
        expect(activityVerbToken('STATUS_CHANGED').token).toBe('STATUS_CHANGED');
    });

    it('returns a null token plus a readable fallback for an unknown verb', () => {
        expect(activityVerbToken('RISK_FROBNICATED')).toEqual({
            token: null,
            fallback: 'risk frobnicated',
        });
    });

    it('carries the fallback even when a token IS resolved', () => {
        // The card picks one or the other; both must always be present.
        const verb = activityVerbToken('POLICY_APPROVED');
        expect(verb.token).toBe('APPROVED');
        expect(verb.fallback).toBe('policy approved');
    });

    it('resolves an action written in lower case', () => {
        expect(activityVerbToken('task_completed').token).toBe('COMPLETED');
    });

    it('resolves every verb in KNOWN_ACTIVITY_VERBS to itself', () => {
        // The list and the matcher must not drift apart: a verb added to the
        // list but not matchable is a message key nothing ever requests.
        for (const verb of KNOWN_ACTIVITY_VERBS) {
            expect(activityVerbToken(`RISK_${verb}`).token).toBe(verb);
        }
    });

    it('never resolves a token that is not in the known list', () => {
        // The inverse guarantee: a token here IS a message key that exists.
        const known = new Set<string>(KNOWN_ACTIVITY_VERBS);
        for (const action of [
            'RISK_FROBNICATED',
            'WEIRD',
            '',
            'SOMETHING_ENTIRELY_ELSE',
        ]) {
            const { token } = activityVerbToken(action);
            if (token !== null) expect(known.has(token)).toBe(true);
        }
    });
});
