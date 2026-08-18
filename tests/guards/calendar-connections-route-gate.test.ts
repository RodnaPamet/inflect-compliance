/**
 * The calendar-connections route is gated, audited, and takes no userId.
 *
 * Three properties, each of which fails silently if it regresses:
 *
 *   GATED     `calendar` is not one of the 13 PRIVILEGED_ROOTS, so the
 *             api-permission-coverage guardrail does not scan this file. An
 *             ungated route here would ship with CI green.
 *   AUDITED   `requireAnyPermission` delegates to `requirePermission`, which
 *             writes AUTHZ_DENIED. A hand-rolled check would refuse the request
 *             and leave no record — an UNLOGGED gate, which is worse than a
 *             lenient one because nothing shows it fired.
 *   SELF-ONLY the route must have no way to NAME another user. Keying off
 *             `ctx.userId` is not a policy that can be got wrong later; a
 *             `userId` parameter is.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const ROUTE = 'src/app/api/t/[tenantSlug]/calendar/connections/route.ts';
const src = fs.readFileSync(path.join(ROOT, ROUTE), 'utf8');
const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('both verbs are gated', () => {
    it.each(['GET', 'DELETE'])('%s is wrapped in requireAnyPermission', (verb) => {
        // Comments stripped — a docblock promising a gate must not satisfy this.
        const decl = codeOnly.slice(codeOnly.indexOf(`export const ${verb}`));
        expect(decl.slice(0, 300)).toMatch(/requireAnyPermission[\s\S]{0,80}CALENDAR_BASELINE_PERMISSIONS/);
    });

    it('uses the DERIVED baseline, not a hand-written key list', () => {
        // CALENDAR_BASELINE_PERMISSIONS is computed from the 19 sources' own
        // per-source keys, so it cannot drift from what the calendar shows. An
        // inline array here would be a second list to maintain, and the way it
        // rots is by staying green while a source is added.
        expect(codeOnly).toMatch(/CALENDAR_BASELINE_PERMISSIONS/);
        expect(codeOnly).not.toMatch(/requireAnyPermission\s*(<[^>]*>)?\s*\(\s*\[/);
    });

    it('introduces no bespoke calendar.* permission key', () => {
        // A separate key would let a role be granted "connect" while holding
        // none of the view permissions — i.e. nothing to connect ABOUT — and
        // costs edits across PermissionSet, all five role branches, a
        // duplicated schema in the admin roles page, and five test files.
        expect(codeOnly).not.toMatch(/'calendar\.(connect|disconnect|manage)'/);
    });

    it('is wrapped in withApiErrorHandling, so a throw becomes a typed response', () => {
        expect(codeOnly).toMatch(/withApiErrorHandling\(/);
    });
});

describe('the route cannot act on another user', () => {
    it('takes no userId from the request', () => {
        // Not "does not use it" — has no way to obtain it. searchParams is read
        // exactly once, for `provider`.
        expect(codeOnly).not.toMatch(/searchParams\.get\(\s*['"]userId['"]/);
        expect(codeOnly).not.toMatch(/params\.userId|body\.userId|\buserId\b\s*[:=]/);
    });

    it('passes ctx straight through to the usecase', () => {
        // The usecases key off ctx.userId internally; the route never names a
        // user at all.
        expect(codeOnly).toMatch(/listCalendarConnections\(ctx\)/);
        expect(codeOnly).toMatch(/revokeCalendarConnection\(ctx,/);
    });

    it('validates the provider rather than forwarding whatever arrived', () => {
        expect(codeOnly).toMatch(/isCalendarProviderId\(provider\)/);
        expect(codeOnly).toMatch(/throw badRequest/);
    });
});

describe('the guardrail interaction is respected', () => {
    it('calendar is NOT a privileged root — so this file is unscanned, which is why the test above exists', () => {
        // Stated as an assertion so that if `calendar` is ever ADDED to
        // PRIVILEGED_ROOTS, this fails and whoever did it is told to check
        // whether the ROUTE_PERMISSIONS half was added in the same diff.
        const guard = fs.readFileSync(
            path.join(ROOT, 'tests/guardrails/api-permission-coverage.test.ts'),
            'utf8',
        );
        const roots = [...guard.matchAll(/relPath:\s*'([^']+)'/g)].map((m) => m[1]);
        expect(roots.length).toBeGreaterThan(10);
        expect(roots).not.toContain('src/app/api/t/[tenantSlug]/calendar');
    });

    it('adds no ROUTE_PERMISSIONS rule', () => {
        // A rule without `calendar` in PRIVILEGED_ROOTS is an ORPHAN: the
        // guardrail iterates its rules and requires each to match a file
        // discovered from those roots, so the rule alone turns CI red. The two
        // edits must land together or neither.
        const rules = fs.readFileSync(path.join(ROOT, 'src/lib/security/route-permissions.ts'), 'utf8');
        expect(rules).not.toMatch(/calendar\/connections/);
    });
});

describe('the disconnect ordering is written down where it will be read', () => {
    it('the file records that remote events must be deleted BEFORE revoking', () => {
        // Revoking first destroys the token, and the pushed events are then
        // stranded in the user's personal calendar with no credential left to
        // remove them. C5 lands the event mapping; this is the note it needs.
        expect(src).toMatch(/deleted BEFORE this call|BEFORE this call/);
    });
});
