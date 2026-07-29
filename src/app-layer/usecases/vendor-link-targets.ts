/**
 * Cross-tenant target validation for vendor associations.
 *
 * Several vendor write paths accept a caller-supplied id and store it
 * verbatim: `VendorLink.entityId`, `Vendor.ownerUserId`,
 * `VendorDocument.fileId`, and the bundle-item `entityId`. The row itself is
 * written with `ctx.tenantId`, so RLS is satisfied — but the id it POINTS AT
 * was never checked, so a caller could attach their vendor to another
 * tenant's Asset, Risk, Issue or Control and the association would persist.
 *
 * That is not a read breach on its own: RLS still hides the foreign row from
 * subsequent reads, which is precisely what makes it insidious — the link
 * renders as a dangling id rather than an error, and the traceability graph
 * quietly carries a reference across a tenant boundary.
 *
 * Fail CLOSED: an unresolvable target is rejected, not silently dropped.
 * `freezeBundle` previously demonstrated the alternative — it tenant-scopes
 * its snapshot lookup, so a foreign id produced an empty snapshot with no
 * error at all.
 */
import type { PrismaTx } from '@/lib/db-context';
import type { RequestContext } from '../types';
import { badRequest } from '@/lib/errors/types';

/** The entity kinds a VendorLink / bundle item may point at. */
export type VendorTargetType = 'ASSET' | 'RISK' | 'ISSUE' | 'CONTROL' | 'EVIDENCE';

/**
 * Resolve a link target within the caller's tenant.
 *
 * @throws badRequest when the id does not resolve inside this tenant —
 *         deliberately the same shape whether the row is absent or foreign,
 *         so the caller learns nothing about other tenants' id space.
 */
export async function assertTargetInTenant(
    db: PrismaTx,
    ctx: RequestContext,
    entityType: string,
    entityId: string,
): Promise<void> {
    const where = { id: entityId, tenantId: ctx.tenantId };
    const select = { id: true };

    let found: { id: string } | null = null;
    switch (entityType.toUpperCase()) {
        case 'ASSET':
            found = await db.asset.findFirst({ where, select });
            break;
        case 'RISK':
            found = await db.risk.findFirst({ where, select });
            break;
        case 'ISSUE':
            // The VendorLinkEntityType enum says ISSUE, but the table behind
            // it is `Finding` — there is no Issue model. Naming drift, not a
            // second concept.
            found = await db.finding.findFirst({ where, select });
            break;
        case 'CONTROL':
            found = await db.control.findFirst({ where, select });
            break;
        case 'EVIDENCE':
            found = await db.evidence.findFirst({ where, select });
            break;
        default:
            throw badRequest(`Unsupported link entity type: ${entityType}`);
    }

    if (!found) {
        throw badRequest(`Link target not found: ${entityType} ${entityId}`);
    }
}

/**
 * Resolve a bundle-item target within the caller's tenant.
 *
 * Bundle items carry their OWN entity vocabulary — `VENDOR_DOCUMENT` and
 * `ASSESSMENT`, stored as a free-form String with no enum — which does not
 * overlap the VendorLink vocabulary at all. They therefore get their own
 * validator rather than being forced through the link one.
 *
 * The stakes are higher here than for a link: `freezeBundle` tenant-scopes
 * its snapshot lookup, so a foreign entityId produced an EMPTY snapshot and
 * no error whatsoever. A frozen bundle is an audit artefact meant to be
 * evidence; silently freezing one with an item that snapshots to nothing is
 * worse than refusing the item outright.
 */
export async function assertBundleTargetInTenant(
    db: PrismaTx,
    ctx: RequestContext,
    entityType: string,
    entityId: string,
): Promise<void> {
    const where = { id: entityId, tenantId: ctx.tenantId };
    const select = { id: true };

    let found: { id: string } | null = null;
    switch (entityType) {
        case 'VENDOR_DOCUMENT':
            found = await db.vendorDocument.findFirst({ where, select });
            break;
        case 'ASSESSMENT':
            found = await db.vendorAssessment.findFirst({ where, select });
            break;
        default:
            throw badRequest(`Unsupported bundle item type: ${entityType}`);
    }

    if (!found) {
        throw badRequest(`Bundle item not found: ${entityType} ${entityId}`);
    }
}

/**
 * Resolve a vendor-owner candidate.
 *
 * Membership must be ACTIVE, not merely present: assigning ownership to a
 * deactivated member silently parks the vendor with nobody accountable,
 * and review-overdue notifications then address a user who cannot sign in.
 */
export async function assertOwnerInTenant(
    db: PrismaTx,
    ctx: RequestContext,
    ownerUserId: string,
): Promise<void> {
    const membership = await db.tenantMembership.findFirst({
        where: {
            userId: ownerUserId,
            tenantId: ctx.tenantId,
            status: 'ACTIVE',
        },
        select: { id: true },
    });
    if (!membership) {
        throw badRequest('Owner must be an active member of this tenant');
    }
}

/**
 * Resolve a FileRecord the caller wants to attach to a vendor document.
 *
 * This id feeds the document text-extraction path, which reads the object
 * out of storage — so an unchecked fileId is the front half of a
 * cross-tenant file read.
 */
export async function assertFileInTenant(
    db: PrismaTx,
    ctx: RequestContext,
    fileId: string,
): Promise<void> {
    const file = await db.fileRecord.findFirst({
        where: { id: fileId, tenantId: ctx.tenantId },
        select: { id: true },
    });
    if (!file) {
        throw badRequest('File not found');
    }
}
