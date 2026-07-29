/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
import {
    assertCanReadVendors, assertCanManageVendors, assertCanManageVendorDocs,
    assertCanRunAssessment, assertCanApproveAssessment, assertCanExportVendors,
    assertCanManageVendorAssessmentTemplates,
} from '../../src/app-layer/policies/vendor.policies';
import { getPermissionsForRole } from '../../src/lib/permissions';
import { computePermissions } from '../../src/lib/tenant-context';
import type { Role } from '@prisma/client';

/**
 * Contexts are DERIVED from the real permission sources rather than
 * hand-written, so these fixtures cannot drift from production:
 *   - `appPermissions` ← `getPermissionsForRole(role)` (custom-role-aware set)
 *   - `permissions`    ← `computePermissions(role)`    (coarse role tiers)
 *
 * The previous version hand-rolled `{ permissions: {...} }` only, which is why
 * it passed while the granular `vendors.*` keys were unenforceable — the mock
 * asserted the same coarse flags the implementation read.
 */
function ctxFor(role: Role): any {
    return {
        role,
        permissions: computePermissions(role),
        appPermissions: getPermissionsForRole(role),
    };
}

const adminCtx = ctxFor('ADMIN');
const editorCtx = ctxFor('EDITOR');
const readerCtx = ctxFor('READER');
const auditorCtx = ctxFor('AUDITOR');
const ownerCtx = ctxFor('OWNER');

describe('Vendor Policies', () => {
    describe('assertCanReadVendors', () => {
        it.each([
            ['OWNER', ownerCtx], ['ADMIN', adminCtx], ['EDITOR', editorCtx],
            ['READER', readerCtx], ['AUDITOR', auditorCtx],
        ])('allows %s', (_role, ctx) => {
            expect(() => assertCanReadVendors(ctx)).not.toThrow();
        });
    });

    describe('assertCanManageVendors', () => {
        it('allows ADMIN', () => expect(() => assertCanManageVendors(adminCtx)).not.toThrow());
        it('allows EDITOR', () => expect(() => assertCanManageVendors(editorCtx)).not.toThrow());
        it('denies READER', () => expect(() => assertCanManageVendors(readerCtx)).toThrow());
        it('denies AUDITOR', () => expect(() => assertCanManageVendors(auditorCtx)).toThrow());
    });

    describe('assertCanManageVendorDocs', () => {
        it('allows ADMIN', () => expect(() => assertCanManageVendorDocs(adminCtx)).not.toThrow());
        it('allows EDITOR', () => expect(() => assertCanManageVendorDocs(editorCtx)).not.toThrow());
        it('denies READER', () => expect(() => assertCanManageVendorDocs(readerCtx)).toThrow());
        it('denies AUDITOR', () => expect(() => assertCanManageVendorDocs(auditorCtx)).toThrow());
    });

    describe('assertCanRunAssessment', () => {
        it('allows ADMIN', () => expect(() => assertCanRunAssessment(adminCtx)).not.toThrow());
        it('allows EDITOR', () => expect(() => assertCanRunAssessment(editorCtx)).not.toThrow());
        it('denies READER', () => expect(() => assertCanRunAssessment(readerCtx)).toThrow());
        it('denies AUDITOR', () => expect(() => assertCanRunAssessment(auditorCtx)).toThrow());
    });

    describe('assertCanApproveAssessment', () => {
        it('allows ADMIN', () => expect(() => assertCanApproveAssessment(adminCtx)).not.toThrow());
        it('denies EDITOR', () => expect(() => assertCanApproveAssessment(editorCtx)).toThrow());
        it('denies READER', () => expect(() => assertCanApproveAssessment(readerCtx)).toThrow());
        it('denies AUDITOR', () => expect(() => assertCanApproveAssessment(auditorCtx)).toThrow());
    });

    // ─── Custom-role enforcement (the actual gap this closes) ───────────
    //
    // `computePermissions(role)` takes ONLY the Role enum, so it is
    // structurally blind to a custom role's permissionsJson. While the
    // helpers read it, a custom role that revoked `vendors.edit` was
    // silently ignored and the holder could still rewire the GDPR Art.28
    // sub-processor register.
    //
    // Each case below keeps the COARSE tier intact (canWrite/canRead still
    // true, exactly as an EDITOR-based custom role resolves) and flips only
    // the granular key — so a regression to `ctx.permissions.*` makes these
    // fail, and nothing else does.
    describe('custom-role overrides are enforced', () => {
        function customCtx(base: Role, vendors: Partial<{ view: boolean; create: boolean; edit: boolean }>): any {
            const resolved = getPermissionsForRole(base);
            return {
                role: base,
                permissions: computePermissions(base),
                appPermissions: { ...resolved, vendors: { ...resolved.vendors, ...vendors } },
            };
        }

        it('denies manage when a custom role revokes vendors.edit on an EDITOR base', () => {
            const ctx = customCtx('EDITOR', { edit: false });
            expect(ctx.permissions.canWrite).toBe(true); // coarse tier unchanged
            expect(() => assertCanManageVendors(ctx)).toThrow();
        });

        it('denies vendor-doc management when vendors.edit is revoked', () => {
            expect(() => assertCanManageVendorDocs(customCtx('EDITOR', { edit: false }))).toThrow();
        });

        it('denies running an assessment when vendors.edit is revoked', () => {
            expect(() => assertCanRunAssessment(customCtx('EDITOR', { edit: false }))).toThrow();
        });

        it('denies template authoring when vendors.edit is revoked', () => {
            expect(() => assertCanManageVendorAssessmentTemplates(customCtx('EDITOR', { edit: false }))).toThrow();
        });

        it('denies reads when a custom role revokes vendors.view', () => {
            const ctx = customCtx('READER', { view: false });
            expect(ctx.permissions.canRead).toBe(true); // coarse tier unchanged
            expect(() => assertCanReadVendors(ctx)).toThrow();
        });

        it('still allows manage when a custom role GRANTS vendors.edit on a READER base', () => {
            const ctx = customCtx('READER', { edit: true });
            expect(ctx.permissions.canWrite).toBe(false); // coarse tier would have denied
            expect(() => assertCanManageVendors(ctx)).not.toThrow();
        });
    });
});

// ═══════════════════════════════════════════════════════════════════
// Bulk export is a distinct authority from read
// ═══════════════════════════════════════════════════════════════════
//
// The export endpoint gated on assertCanReadVendors, which is true for
// EVERY role — so a read-only member could pull the entire vendor register,
// every assessment and all document metadata in one request. Reading one
// vendor's detail page and exfiltrating the whole register are different
// acts.

describe('assertCanExportVendors', () => {
    it('refuses a role that can read but not export', () => {
        expect(readerCtx.permissions.canRead).toBe(true);
        expect(readerCtx.permissions.canExport).toBe(false);
        expect(() => assertCanExportVendors(readerCtx)).toThrow();
    });

    it('allows ADMIN and OWNER', () => {
        expect(() => assertCanExportVendors(adminCtx)).not.toThrow();
        expect(() => assertCanExportVendors(ownerCtx)).not.toThrow();
    });

    it('allows AUDITOR — export is core to the audit role', () => {
        expect(() => assertCanExportVendors(auditorCtx)).not.toThrow();
    });

    it('refuses a role that cannot see vendors at all', () => {
        // Layered on the read check, not parallel to it: no visibility must
        // mean no export, whatever canExport says.
        const blind = {
            ...editorCtx,
            appPermissions: {
                ...editorCtx.appPermissions,
                vendors: { ...editorCtx.appPermissions.vendors, view: false },
            },
        };
        expect(() => assertCanExportVendors(blind)).toThrow();
    });
});
