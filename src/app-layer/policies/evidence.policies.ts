/**
 * Evidence authorization gates — custom-role aware (R5-P2 #6).
 *
 * The generic assertCanRead/Write from `common.ts` read `ctx.permissions`,
 * which `tenant-context` computes from a custom role's BASE role — so a custom
 * role that restricts evidence (`evidence.edit:false` on an ADMIN base) still
 * passed the coarse gate. These consult `ctx.appPermissions.evidence.*`, the
 * custom-role-resolved grants (the same shape the imports route already reads).
 *
 * Note: the evidence PermissionSet is `{ view, upload, edit, download }`. There
 * is no evidence-level `approve`/`delete` sub-grant, so REVIEW (approve/reject)
 * stays on the coarse ADMIN tier (`assertCanAdmin`) — the finest grain available.
 */
import { RequestContext } from '../types';
import { forbidden } from '@/lib/errors/types';

export function assertCanReadEvidence(ctx: RequestContext): void {
    if (!ctx.appPermissions.evidence.view) {
        throw forbidden('You do not have permission to view evidence.');
    }
}

/** Create / edit an evidence record (TEXT/LINK body, metadata, owner, tags). */
export function assertCanEditEvidence(ctx: RequestContext): void {
    if (!ctx.appPermissions.evidence.edit) {
        throw forbidden('You do not have permission to edit evidence.');
    }
}

/** Upload / replace the bytes behind a FILE evidence. */
export function assertCanUploadEvidence(ctx: RequestContext): void {
    if (!ctx.appPermissions.evidence.upload) {
        throw forbidden('You do not have permission to upload evidence.');
    }
}
