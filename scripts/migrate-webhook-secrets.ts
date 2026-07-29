/**
 * Move WEBHOOK HMAC keys out of plaintext `actionConfigJson.secretRef` into the
 * encrypted `AutomationRule.webhookSecretEncrypted` column.
 *
 * ── Why this is a script and not SQL ────────────────────────────────
 *
 * The target column is in the Epic B encrypted-field manifest, so its value is
 * produced by the application's Prisma middleware using the per-tenant DEK.
 * SQL cannot generate a valid ciphertext. A SQL backfill would write PLAINTEXT
 * into a column the application then tries to DECRYPT on read — corrupting it.
 * So the migration only adds the column, and this script does the move through
 * the application layer.
 *
 * ── What it does, per rule ──────────────────────────────────────────
 *
 *   1. read `actionConfigJson.secretRef`
 *   2. write it to `webhookSecretEncrypted` (middleware encrypts)
 *   3. strip `secretRef` from the JSON
 *
 * Idempotent: a rule that already has the column set, or no `secretRef`, is
 * skipped. Safe to re-run.
 *
 * ── After it reports zero remaining ─────────────────────────────────
 *
 * Remove the `?? cfg.secretRef` fallback in `action-executor.ts::fireWebhook`
 * and the `secretRef` field from `WebhookActionConfig`.
 *
 * ⚠️ ROTATE. Every value moved by this script has been sitting in clear in the
 * database and in every backup taken since the rule was created. Encrypting it
 * in place does not undo that exposure — the secrets should be rotated at the
 * receiving end.
 *
 * Usage:
 *   npx tsx scripts/migrate-webhook-secrets.ts [--dry-run]
 */
import { prisma } from '@/lib/prisma';
import { runInTenantContext } from '@/lib/db-context';
import { getPermissionsForRole } from '@/lib/permissions';
import { logger } from '@/lib/observability/logger';

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
    // Tenant-by-tenant: the encryption middleware resolves the per-tenant DEK
    // from the ambient context, so the write must happen inside one.
    const tenants = await prisma.tenant.findMany({
        where: { deletedAt: null },
        select: { id: true, slug: true },
    });

    let scanned = 0;
    let migrated = 0;
    let skipped = 0;

    for (const tenant of tenants) {
        const ctx = {
            requestId: 'migrate-webhook-secrets',
            userId: 'system',
            tenantId: tenant.id,
            tenantSlug: tenant.slug,
            role: 'OWNER' as const,
            permissions: {
                canRead: true, canWrite: true, canAdmin: true,
                canAudit: true, canExport: true,
            },
            appPermissions: getPermissionsForRole('OWNER'),
        };

        await runInTenantContext(ctx as never, async (db) => {
            const rules = await db.automationRule.findMany({
                where: { tenantId: tenant.id, actionType: 'WEBHOOK' },
                select: { id: true, actionConfigJson: true, webhookSecretEncrypted: true },
            });

            for (const rule of rules) {
                scanned++;
                const cfg = (rule.actionConfigJson ?? {}) as Record<string, unknown>;
                const legacy = typeof cfg.secretRef === 'string' ? cfg.secretRef : null;

                // Already migrated, or nothing to move.
                if (!legacy || rule.webhookSecretEncrypted) {
                    skipped++;
                    continue;
                }

                if (DRY_RUN) {
                    migrated++;
                    continue;
                }

                const { secretRef: _dropped, ...rest } = cfg;
                await db.automationRule.update({
                    where: { id: rule.id },
                    data: {
                        // Plaintext in — the middleware encrypts on write.
                        webhookSecretEncrypted: legacy,
                        actionConfigJson: rest as never,
                    },
                });
                migrated++;
            }
        });
    }

    logger.info('webhook secret migration complete', {
        component: 'migrate-webhook-secrets',
        dryRun: DRY_RUN,
        tenants: tenants.length,
        scanned,
        migrated,
        skipped,
    });

    if (migrated > 0 && !DRY_RUN) {
        logger.warn(
            'ROTATE THESE SECRETS. Each value moved was stored in clear and is ' +
                'present in every backup taken since the rule was created; ' +
                'encrypting it in place does not undo that exposure.',
            { component: 'migrate-webhook-secrets', rotateCount: migrated },
        );
    }
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        logger.error('webhook secret migration failed', {
            component: 'migrate-webhook-secrets',
            error: err instanceof Error ? err.message : String(err),
        });
        process.exit(1);
    });
