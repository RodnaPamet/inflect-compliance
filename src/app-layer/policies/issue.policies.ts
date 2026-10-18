import { RequestContext } from '../types';
import { forbidden } from '@/lib/errors/types';

/**
 * All authenticated roles can read issues.
 */
export function assertCanReadIssues(ctx: RequestContext) {
    if (!ctx.permissions.canRead) {
        throw forbidden('You do not have permission to view issues.');
    }
}

/**
 * ADMIN and EDITOR can create issues.
 */
export function assertCanCreateIssue(ctx: RequestContext) {
    if (!ctx.permissions.canWrite) {
        throw forbidden('You do not have permission to create issues.');
    }
}

/**
 * ADMIN and EDITOR can update issues.
 */
export function assertCanUpdateIssue(ctx: RequestContext) {
    if (!ctx.permissions.canWrite) {
        throw forbidden('You do not have permission to update issues.');
    }
}

/**
 * ADMIN and EDITOR can assign issues.
 */
export function assertCanAssignIssue(ctx: RequestContext) {
    if (!ctx.permissions.canWrite) {
        throw forbidden('You do not have permission to assign issues.');
    }
}

/**
 * ADMIN and EDITOR can resolve/close issues.
 */
export function assertCanResolveIssue(ctx: RequestContext) {
    if (!ctx.permissions.canWrite) {
        throw forbidden('You do not have permission to resolve issues.');
    }
}

/**
 * ADMIN, EDITOR, and AUDITOR can add comments (broader for collaboration).
 * READER cannot comment, and nor can AI_ADMIN (#3699), which reads like one.
 */
export function assertCanComment(ctx: RequestContext) {
    if (ctx.role === 'READER' || ctx.role === 'AI_ADMIN') {
        throw forbidden('You do not have permission to comment on issues.');
    }
}

/**
 * ADMIN and EDITOR can manage links (add/remove).
 */
export function assertCanManageLinks(ctx: RequestContext) {
    if (!ctx.permissions.canWrite) {
        throw forbidden('You do not have permission to manage issue links.');
    }
}

/**
 * ADMIN and EDITOR can create and modify evidence bundles.
 * READER and AUDITOR can only view bundles.
 */
export function assertCanManageBundles(ctx: RequestContext) {
    if (!ctx.permissions.canWrite) {
        throw forbidden('You do not have permission to manage evidence bundles.');
    }
}

/**
 * ADMIN and EDITOR can freeze evidence bundles.
 */
export function assertCanFreeze(ctx: RequestContext) {
    if (!ctx.permissions.canWrite) {
        throw forbidden('You do not have permission to freeze evidence bundles.');
    }
}
