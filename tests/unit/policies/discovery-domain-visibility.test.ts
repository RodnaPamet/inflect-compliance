/**
 * `canViewDomain` / `assertAnyDomainViewable` — the per-domain gate the
 * unified search and the traceability graph share.
 *
 * Both usecases used to open with `if (!ctx.role) throw forbidden(…)`, a
 * branch `getTenantCtx` makes unreachable. The layer-2 guardrail
 * (`tests/guardrails/api-route-has-some-authorization.test.ts`) proves the
 * SHAPE is gone. These prove the BEHAVIOUR, in both directions:
 *
 *   - every built-in role is still admitted, on every domain — the half that
 *     matters more, because a gate that refuses everyone would satisfy the
 *     refusal tests below on its own and would be an outage, not a fix;
 *   - a custom role that zeroes a domain is denied THAT domain and nothing
 *     else.
 *
 * The built-in-role assertions read `getPermissionsForRole` directly rather
 * than trusting the fixture, so this file is also the check that no future
 * edit to `permissions.ts` quietly drops a `view` flag out from under these
 * two surfaces.
 */
import type { Role } from '@prisma/client';
import type { RequestContext } from '@/app-layer/types';
import {
    assertAnyDomainViewable,
    canViewDomain,
    type ViewableDomain,
} from '@/app-layer/policies/discovery.policies';
import { getPermissionsForRole, type PermissionSet } from '@/lib/permissions';
import { makeRequestContext } from '../../helpers/make-context';

const BUILT_IN_ROLES: Role[] = ['OWNER', 'ADMIN', 'EDITOR', 'AUDITOR', 'READER'];

/** Every domain the two discovery surfaces read between them. */
const ALL_DISCOVERY_DOMAINS: ViewableDomain[] = [
    'controls',
    'risks',
    'policies',
    'evidence',
    'assets',
    'tasks',
    'tests',
    'frameworks',
];

function customRole(mutate: (p: PermissionSet) => void): RequestContext {
    // A custom role always sits on top of a real base role — model it that
    // way rather than inventing a context shape no caller produces.
    const appPermissions = structuredClone(getPermissionsForRole('READER'));
    mutate(appPermissions);
    return makeRequestContext('READER', { appPermissions });
}

describe('canViewDomain', () => {
    it.each(BUILT_IN_ROLES)(
        '%s can view every discovery domain — no built-in role loses access',
        (role) => {
            const ctx = makeRequestContext(role);
            for (const domain of ALL_DISCOVERY_DOMAINS) {
                expect(canViewDomain(ctx, domain)).toBe(true);
                // Read the source of truth too, not just the fixture: if
                // `permissions.ts` ever drops one of these flags, a READER who
                // can still reach the rows through a list page would start
                // being skipped in search. That is the regression this catches.
                expect(getPermissionsForRole(role)[domain].view).toBe(true);
            }
        },
    );

    it('denies exactly the domain a custom role zeroed, and no other', () => {
        const ctx = customRole((p) => {
            p.evidence.view = false;
        });
        expect(canViewDomain(ctx, 'evidence')).toBe(false);
        for (const domain of ALL_DISCOVERY_DOMAINS.filter((d) => d !== 'evidence')) {
            expect(canViewDomain(ctx, domain)).toBe(true);
        }
    });

    it('reads the permission, not the role — an OWNER with the flag zeroed is denied', () => {
        const appPermissions = structuredClone(getPermissionsForRole('OWNER'));
        appPermissions.risks.view = false;
        const ctx = makeRequestContext('OWNER', { appPermissions });
        expect(ctx.role).toBe('OWNER');
        expect(canViewDomain(ctx, 'risks')).toBe(false);
    });
});

describe('assertAnyDomainViewable', () => {
    it.each(BUILT_IN_ROLES)('admits %s across the full discovery domain list', (role) => {
        expect(() =>
            assertAnyDomainViewable(makeRequestContext(role), ALL_DISCOVERY_DOMAINS, 'records'),
        ).not.toThrow();
    });

    it('still admits a caller who retains just ONE domain', () => {
        // The partial case must NOT throw — skipping is the design, and a
        // refusal here would turn a narrowed custom role into a broken app.
        const ctx = customRole((p) => {
            for (const domain of ALL_DISCOVERY_DOMAINS) {
                p[domain].view = false;
            }
            p.controls.view = true;
        });
        expect(() =>
            assertAnyDomainViewable(ctx, ALL_DISCOVERY_DOMAINS, 'records'),
        ).not.toThrow();
    });

    it('refuses a caller who can view none of the domains', () => {
        const ctx = customRole((p) => {
            for (const domain of ALL_DISCOVERY_DOMAINS) {
                p[domain].view = false;
            }
        });
        // `ctx.role` is populated — the old role-presence check passed this
        // exact context. This is the regression proof for the actual change.
        expect(ctx.role).toBeTruthy();
        expect(() => assertAnyDomainViewable(ctx, ALL_DISCOVERY_DOMAINS, 'records')).toThrow(
            /permission to view any records/i,
        );
    });

    it('only consults the domains it was handed', () => {
        // The graph passes five domains, search passes eight. A caller who
        // keeps only `tasks` — which the graph does not read — must still be
        // refused by the graph's list.
        const ctx = customRole((p) => {
            for (const domain of ALL_DISCOVERY_DOMAINS) {
                p[domain].view = false;
            }
            p.tasks.view = true;
        });
        const graphDomains: ViewableDomain[] = [
            'controls',
            'risks',
            'assets',
            'frameworks',
            'policies',
        ];
        expect(() => assertAnyDomainViewable(ctx, graphDomains, 'graph entities')).toThrow();
        expect(() =>
            assertAnyDomainViewable(ctx, ALL_DISCOVERY_DOMAINS, 'records'),
        ).not.toThrow();
    });
});
