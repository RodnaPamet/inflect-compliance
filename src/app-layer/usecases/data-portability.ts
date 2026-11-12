/**
 * Data Portability Use Case — Admin-Only Import/Export Operations
 *
 * Exposes safe, audited entrypoints for:
 *   - Exporting tenant data as a versioned JSON bundle
 *   - Validating an import bundle (dry-run)
 *   - Importing a bundle into the current tenant
 *
 * SECURITY:
 *   - Export: requires canExport or canAdmin
 *   - Import: requires canAdmin (destructive)
 *   - Target tenant must match RequestContext
 *   - All operations are audit-logged
 *   - All DB access goes through runInTenantContext (RLS enforced)
 *
 * @module usecases/data-portability
 */

import { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { logEvent } from '../events/audit';
import { logger } from '@/lib/observability/logger';
import {
    assertCanExport,
    assertCanImport,
    assertImportTargetMatchesContext,
} from '../policies/data-portability.policies';
import {
    exportTenantData,
    type ExportServiceResult,
} from '../services/export-service';
import {
    importTenantData,
    validateImportEnvelope,
} from '../services/import-service';
import type {
    ExportDomain,
    ExportEnvelope,
    ImportOptions,
    ImportResult,
    ImportConflictStrategy,
} from '../services/export-schemas';
import {
    serializeBundle,
    deserializeBundle,
    type SerializeResult,
} from '../services/bundle-codec';

// ─── Export Types ───────────────────────────────────────────────────

export interface ExportBundleRequest {
    /** Which domains to include. Defaults to FULL_TENANT. */
    domains?: ExportDomain[];
    /** Optional description for the export. */
    description?: string;
    /** Whether to gzip-compress the output bundle. Default: true. */
    compress?: boolean;
}

export interface ExportBundleResponse {
    /** The typed envelope (for inspection/testing). */
    envelope: ExportEnvelope;
    /** Serialized bundle ready for download (gzip or raw JSON). */
    serialized: SerializeResult;
    /** Export statistics. */
    stats: ExportServiceResult['stats'];
}

// ─── Import Types ───────────────────────────────────────────────────

export interface ImportBundleRequest {
    /** The parsed export envelope JSON. */
    envelope: ExportEnvelope;
    /** Conflict resolution strategy. */
    conflictStrategy: ImportConflictStrategy;
    /** If true, validate only without persisting. */
    dryRun?: boolean;
}

// ─── Export Entrypoint ──────────────────────────────────────────────

/**
 * Export the current tenant's data as a versioned bundle.
 *
 * RBAC: Requires canExport or canAdmin.
 * Audit: Logged as DATA_EXPORT action.
 *
 * @param ctx - Authenticated request context
 * @param request - Export parameters
 * @returns Export envelope and statistics
 */
export async function exportBundle(
    ctx: RequestContext,
    request: ExportBundleRequest,
): Promise<ExportBundleResponse> {
    assertCanExport(ctx);

    const log = logger.child({
        component: 'data-portability',
        operation: 'export',
        tenantId: ctx.tenantId,
        userId: ctx.userId,
    });

    log.info({
        domains: request.domains ?? ['FULL_TENANT'],
        description: request.description,
    }, 'export initiated');

    const result = await exportTenantData({
        tenantId: ctx.tenantId,
        domains: request.domains,
        exportedBy: ctx.userId,
        description: request.description,
    });

    // Serialize to wire format (optionally gzip'd)
    const serialized = serializeBundle(result.envelope, {
        compress: request.compress ?? true,
    });

    // Through `logEvent`, so the row is hash-chained and streamed to the
    // tenant's SIEM (#5262). A direct `auditLog.create` wrote an unchained
    // row that could be altered or removed unseen, for the bulk export a
    // SIEM most needs to see.
    await runInTenantContext(ctx, async (db) => {
        await logEvent(db, ctx, {
            action: 'DATA_EXPORT',
            entityType: 'DataPortability',
            entityId: ctx.tenantId,
            details: `Exported ${result.stats.entityCount} entities across domains: ${result.stats.domains.join(', ')}`,
            detailsJson: {
                category: 'data_lifecycle',
                operation: 'export',
                domains: result.stats.domains,
                entityCount: result.stats.entityCount,
                relationshipCount: result.stats.relationshipCount,
                durationMs: result.stats.durationMs,
                description: request.description,
                compressed: serialized.compressed,
                rawSize: serialized.rawSize,
                outputSize: serialized.outputSize,
                compressionRatio: serialized.compressionRatio,
            },
        });
    });

    log.info({
        entityCount: result.stats.entityCount,
        relationshipCount: result.stats.relationshipCount,
        durationMs: result.stats.durationMs,
        compressed: serialized.compressed,
        rawSize: serialized.rawSize,
        outputSize: serialized.outputSize,
        compressionRatio: serialized.compressionRatio,
    }, 'export completed');

    return {
        envelope: result.envelope,
        serialized,
        stats: result.stats,
    };
}

// ─── Validate Entrypoint ────────────────────────────────────────────

/**
 * Validate an import bundle without persisting anything.
 *
 * RBAC: Requires canAdmin (same as import — validation reveals data shape).
 *
 * @param ctx - Authenticated request context
 * @param envelope - The envelope to validate
 * @returns Validation result with any errors
 */
export async function validateBundle(
    ctx: RequestContext,
    envelope: ExportEnvelope,
): Promise<ImportResult> {
    assertCanImport(ctx);

    return validateImportEnvelope(envelope, ctx.tenantId);
}

// ─── Import Entrypoint ──────────────────────────────────────────────

/**
 * Import a data bundle into the current tenant.
 *
 * RBAC: Requires canAdmin.
 * Audit: Logged as DATA_IMPORT action.
 * Tenant: Target is always the authenticated user's current tenant.
 *
 * @param ctx - Authenticated request context
 * @param request - Import parameters
 * @returns Import result with per-type counts and errors
 */
export async function importBundle(
    ctx: RequestContext,
    request: ImportBundleRequest,
): Promise<ImportResult> {
    assertCanImport(ctx);

    // Enforce: target tenant is always the current context
    const targetTenantId = ctx.tenantId;
    assertImportTargetMatchesContext(ctx, targetTenantId);

    const log = logger.child({
        component: 'data-portability',
        operation: 'import',
        tenantId: targetTenantId,
        userId: ctx.userId,
    });

    const dryRun = request.dryRun ?? false;

    log.info({
        conflictStrategy: request.conflictStrategy,
        dryRun,
        sourceTenant: request.envelope.metadata.tenantId,
        formatVersion: request.envelope.formatVersion,
    }, 'import initiated');

    const options: ImportOptions = {
        targetTenantId,
        conflictStrategy: request.conflictStrategy,
        dryRun,
    };

    const result = await importTenantData(request.envelope, options);

    // Through `logEvent` (even for dry runs), so the row is hash-chained and
    // streamed (#5262).
    await runInTenantContext(ctx, async (db) => {
        await logEvent(db, ctx, {
            action: dryRun ? 'DATA_IMPORT_DRYRUN' : 'DATA_IMPORT',
            entityType: 'DataPortability',
            entityId: targetTenantId,
            details: `${dryRun ? '[DRY RUN] ' : ''}Import from ${request.envelope.metadata.tenantId}: ` +
                `${Object.values(result.imported).reduce((s, n) => s + (n ?? 0), 0)} imported, ` +
                `${Object.values(result.skipped).reduce((s, n) => s + (n ?? 0), 0)} skipped, ` +
                `${result.errors.length} errors`,
            detailsJson: {
                category: 'data_lifecycle',
                operation: dryRun ? 'import_dry_run' : 'import',
                sourceTenant: request.envelope.metadata.tenantId,
                conflictStrategy: request.conflictStrategy,
                dryRun,
                imported: result.imported,
                skipped: result.skipped,
                conflicts: result.conflicts,
                errorCount: result.errors.length,
                durationMs: result.durationMs,
            },
        });
    });

    log.info({
        success: result.success,
        dryRun,
        imported: result.imported,
        skipped: result.skipped,
        errorCount: result.errors.length,
        durationMs: result.durationMs,
    }, 'import completed');

    return result;
}

// ─── Buffer Import Entrypoint ───────────────────────────────────────

/**
 * Import a data bundle from a raw Buffer (auto-detects gzip).
 *
 * Convenience wrapper that deserializes the buffer before delegating
 * to `importBundle`. Accepts both gzip'd and raw JSON input.
 *
 * @param ctx - Authenticated request context
 * @param data - Raw buffer (gzip'd or plain JSON)
 * @param conflictStrategy - How to handle duplicate entities
 * @param dryRun - If true, validate only
 * @returns Import result
 */
export async function importFromBuffer(
    ctx: RequestContext,
    data: Buffer,
    conflictStrategy: ImportConflictStrategy,
    dryRun = false,
): Promise<ImportResult> {
    const envelope = deserializeBundle(data);
    return importBundle(ctx, {
        envelope,
        conflictStrategy,
        dryRun,
    });
}

// ─── Re-exports ─────────────────────────────────────────────────────

/** Re-export codec utilities for API route consumption. */
export { serializeBundle, deserializeBundle, isGzipped } from '../services/bundle-codec';
export type { SerializeOptions, SerializeResult } from '../services/bundle-codec';
