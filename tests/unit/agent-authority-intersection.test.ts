/**
 * The authority arithmetic: a credential holds its principal's permissions
 * intersected with its own scopes, and never more than either.
 *
 * These are the two functions the whole confused-deputy fix rests on, and both
 * have a plausible-looking wrong implementation that the integration suite would
 * not distinguish from the right one on the fixtures it happens to seed:
 *
 *   • `intersectPermissionSets` could walk one side's keys instead of the
 *     schema. A set missing a domain would then contribute NOTHING for it —
 *     the domain would survive from the other side untouched, which reads as
 *     "not restricted" to every consumer that checks `?.[action] === true`.
 *   • `intersectPermissions` could be `computePermissions(lowerRole(a, b))`,
 *     which is a DIFFERENT function: `canAudit` is `role === 'AUDITOR' ||
 *     level >= 4`, so the lower of AUDITOR and EDITOR is AUDITOR, which grants
 *     an audit flag EDITOR does not hold. The conjunction cannot invent a flag;
 *     the role-ladder shortcut can.
 */
import {
    intersectPermissionSets,
    intersectPermissions,
    lowerRole,
} from '@/lib/agentic/agent-authority';
import { getPermissionsForRole, PERMISSION_SCHEMA, type PermissionSet } from '@/lib/permissions';
import { computePermissions } from '@/lib/tenant-context';

describe('intersectPermissionSets', () => {
    it('grants an action only when BOTH sides grant it', () => {
        const owner = getPermissionsForRole('OWNER');
        const reader = getPermissionsForRole('READER');
        const out = intersectPermissionSets(owner, reader);

        // READER may view a risk, so the intersection may too.
        expect(out.risks.view).toBe(true);
        // READER may not create one, so an OWNER-minted credential may not
        // either — this single flag is the confused deputy in one line.
        expect(out.risks.create).toBe(false);
        expect(out.admin.manage).toBe(false);
    });

    it('is commutative — neither side is privileged', () => {
        const a = getPermissionsForRole('EDITOR');
        const b = getPermissionsForRole('AUDITOR');
        expect(intersectPermissionSets(a, b)).toEqual(intersectPermissionSets(b, a));
    });

    it('never grants what neither side had', () => {
        const a = getPermissionsForRole('READER');
        const b = getPermissionsForRole('AUDITOR');
        const out = intersectPermissionSets(a, b) as unknown as Record<
            string,
            Record<string, boolean>
        >;
        const left = a as unknown as Record<string, Record<string, boolean>>;
        const right = b as unknown as Record<string, Record<string, boolean>>;
        for (const [domain, actions] of Object.entries(PERMISSION_SCHEMA)) {
            for (const action of actions) {
                if (out[domain][action]) {
                    expect(left[domain][action] && right[domain][action]).toBe(true);
                }
            }
        }
    });

    it('a MISSING domain contributes deny, not silence', () => {
        // The failure mode a key-walking implementation ships: an input that
        // does not mention `risks` at all must deny it, not let the other
        // side's `true` through. An older-shaped or hand-built permission blob
        // is exactly this input.
        const owner = getPermissionsForRole('OWNER');
        const partial = { controls: { view: true } } as unknown as PermissionSet;
        const out = intersectPermissionSets(owner, partial);
        expect(out.risks.view).toBe(false);
        expect(out.controls.view).toBe(true);
        expect(out.controls.create).toBe(false);
    });

    it('produces every domain and action the schema declares', () => {
        // A set with holes in it is worse than a restrictive one: consumers
        // read a missing key as undefined, and `undefined !== true` only
        // protects the ones that check for `=== true`.
        const out = intersectPermissionSets(
            getPermissionsForRole('OWNER'),
            getPermissionsForRole('OWNER'),
        ) as unknown as Record<string, Record<string, boolean>>;
        for (const [domain, actions] of Object.entries(PERMISSION_SCHEMA)) {
            expect(out[domain]).toBeDefined();
            for (const action of actions) {
                expect(typeof out[domain][action]).toBe('boolean');
            }
        }
    });
});

describe('intersectPermissions', () => {
    it('ANDs each flag', () => {
        const editor = computePermissions('EDITOR');
        const reader = computePermissions('READER');
        const out = intersectPermissions(editor, reader);
        expect(out.canRead).toBe(true);
        expect(out.canWrite).toBe(false);
        expect(out.canAdmin).toBe(false);
    });

    it('is NOT computePermissions(lowerRole(...)) — the shortcut invents canAudit', () => {
        // AUDITOR ranks BELOW EDITOR, so the role shortcut would return
        // AUDITOR's flags, which include canAudit. EDITOR does not hold it, so
        // the intersection must not either.
        const auditor = computePermissions('AUDITOR');
        const editor = computePermissions('EDITOR');
        expect(auditor.canAudit).toBe(true);
        expect(editor.canAudit).toBe(false);

        expect(intersectPermissions(auditor, editor).canAudit).toBe(false);
        expect(computePermissions(lowerRole('AUDITOR', 'EDITOR')).canAudit).toBe(true);
    });
});

describe('lowerRole', () => {
    it.each([
        ['OWNER', 'READER', 'READER'],
        ['READER', 'OWNER', 'READER'],
        ['ADMIN', 'EDITOR', 'EDITOR'],
        ['AUDITOR', 'EDITOR', 'AUDITOR'],
        ['EDITOR', 'EDITOR', 'EDITOR'],
    ] as const)('lowerRole(%s, %s) === %s', (a, b, expected) => {
        expect(lowerRole(a, b)).toBe(expected);
    });
});
