#!/usr/bin/env npx tsx
/**
 * migrate-files-to-cloud.ts
 *
 * Migrates locally stored files to cloud storage (S3/R2/MinIO).
 *
 * Behavior:
 * 1. Queries all FileRecord rows where storageProvider = 'local' and status = 'STORED'
 * 2. For each file:
 *    a. Reads from local filesystem
 *    b. Writes to cloud storage under original pathKey
 *    c. Verifies via headObject
 *    d. Updates FileRecord: storageProvider → 's3', bucket → configured bucket
 * 3. Logs progress and failures clearly
 * 4. Does NOT delete local files (keep for rollback safety)
 *
 * Usage:
 *   npx tsx scripts/migrate-files-to-cloud.ts [--dry-run] [--tenant=<id>] [--batch=50] [--delete-local]
 *
 * Environment:
 *   DATABASE_URL          — Postgres connection
 *   STORAGE_PROVIDER=s3   — Must be 's3' to migrate
 *   S3_BUCKET             — Target bucket
 *   S3_REGION             — AWS region
 *   FILE_STORAGE_ROOT     — Local storage root
 */

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { createReadStream, existsSync } from 'fs';
import { unlink } from 'fs/promises';
import path from 'path';

// ─── Parse CLI args ───

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const DELETE_LOCAL = args.includes('--delete-local');
const TENANT_FLAG = args.find(a => a.startsWith('--tenant='));
const TENANT_FILTER = TENANT_FLAG ? TENANT_FLAG.split('=')[1] : null;
const BATCH_FLAG = args.find(a => a.startsWith('--batch='));
const BATCH_SIZE = BATCH_FLAG ? parseInt(BATCH_FLAG.split('=')[1], 10) : 50;

// ─── Setup ───

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }) });
const FILE_STORAGE_ROOT = process.env.FILE_STORAGE_ROOT || process.env.UPLOAD_DIR || '/data/uploads';

// Stats
let totalProcessed = 0;
let totalMigrated = 0;
let totalSkipped = 0;
let totalFailed = 0;

function log(level: 'INFO' | 'WARN' | 'ERROR', msg: string, data?: Record<string, unknown>) {
    const ts = new Date().toISOString();
    const dataStr = data ? ' ' + JSON.stringify(data) : '';
    console.log(`[${ts}] [${level}] ${msg}${dataStr}`);
}

function resolveLocalPath(pathKey: string): string {
    return path.resolve(FILE_STORAGE_ROOT, pathKey);
}

async function main() {
    log('INFO', '═══════════════════════════════════════════════════');
    log('INFO', '  File Migration: Local → Cloud Storage');
    log('INFO', '═══════════════════════════════════════════════════');
    log('INFO', `Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE'}`);
    log('INFO', `Batch size: ${BATCH_SIZE}`);
    log('INFO', `Delete local after migration: ${DELETE_LOCAL}`);
    if (TENANT_FILTER) log('INFO', `Tenant filter: ${TENANT_FILTER}`);

    // Validate environment
    if (!DRY_RUN) {
        if (!process.env.S3_BUCKET) {
            log('ERROR', 'S3_BUCKET is required for live migration');
            process.exit(1);
        }
    }

    // Lazy-load cloud provider only for live runs
    let cloudProvider: Awaited<ReturnType<typeof getCloudProvider>> | null = null;
    if (!DRY_RUN) {
        cloudProvider = await getCloudProvider();
        log('INFO', `Cloud provider: ${cloudProvider.name}, bucket: ${process.env.S3_BUCKET}`);
    }

    // Query local files
    const where: Record<string, unknown> = {
        storageProvider: 'local',
        status: 'STORED',
    };
    if (TENANT_FILTER) where.tenantId = TENANT_FILTER;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const totalCount = await (prisma as any).fileRecord.count({ where });
    log('INFO', `Found ${totalCount} local files to migrate`);

    if (totalCount === 0) {
        log('INFO', 'Nothing to migrate. Exiting.');
        return;
    }

    // Process in batches
    let cursor: string | undefined;

    while (true) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const batch = await (prisma as any).fileRecord.findMany({
            where,
            take: BATCH_SIZE,
            orderBy: { createdAt: 'asc' },
            ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        });

        if (batch.length === 0) break;

        for (const record of batch) {
            totalProcessed++;
            cursor = record.id;

            try {
                await migrateFile(record, cloudProvider);
            } catch (err) {
                totalFailed++;
                log('ERROR', `Failed to migrate file`, {
                    id: record.id,
                    pathKey: record.pathKey,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }

        log('INFO', `Progress: ${totalProcessed}/${totalCount} (migrated: ${totalMigrated}, skipped: ${totalSkipped}, failed: ${totalFailed})`);
    }

    // Summary
    log('INFO', '═══════════════════════════════════════════════════');
    log('INFO', '  Migration Complete');
    log('INFO', `  Total processed: ${totalProcessed}`);
    log('INFO', `  Migrated:        ${totalMigrated}`);
    log('INFO', `  Skipped:         ${totalSkipped}`);
    log('INFO', `  Failed:          ${totalFailed}`);
    log('INFO', '═══════════════════════════════════════════════════');

    if (totalFailed > 0) {
        log('WARN', `${totalFailed} files failed migration. Run again to retry.`);
        process.exit(1);
    }
}

interface FileRecord {
    id: string;
    tenantId: string;
    pathKey: string;
    originalName: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function migrateFile(record: FileRecord, cloudProvider: any) {
    const localPath = resolveLocalPath(record.pathKey);

    // Check if local file exists
    if (!existsSync(localPath)) {
        log('WARN', `Local file not found, skipping`, {
            id: record.id,
            pathKey: record.pathKey,
            localPath,
        });
        totalSkipped++;
        return;
    }

    if (DRY_RUN) {
        log('INFO', `[DRY RUN] Would migrate`, {
            id: record.id,
            pathKey: record.pathKey,
            size: record.sizeBytes,
        });
        totalMigrated++;
        return;
    }

    // Upload to cloud
    const readStream = createReadStream(localPath);
    const result = await cloudProvider.write(record.pathKey, readStream, {
        mimeType: record.mimeType,
    });

    // Verify SHA-256 matches
    if (result.sha256 !== record.sha256) {
        throw new Error(
            `SHA-256 mismatch after upload: expected ${record.sha256}, got ${result.sha256}`
        );
    }

    // Verify via headObject
    const headResult = await cloudProvider.head(record.pathKey);
    if (headResult.sizeBytes !== record.sizeBytes) {
        log('WARN', `Size mismatch after upload (may be compression)`, {
            id: record.id,
            expected: record.sizeBytes,
            actual: headResult.sizeBytes,
        });
    }

    // Update FileRecord
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (prisma as any).fileRecord.update({
        where: { id: record.id },
        data: {
            storageProvider: 's3',
            bucket: process.env.S3_BUCKET || null,
        },
    });

    log('INFO', `Migrated`, {
        id: record.id,
        pathKey: record.pathKey,
        size: result.sizeBytes,
    });

    // Optionally delete local file
    if (DELETE_LOCAL) {
        try {
            await unlink(localPath);
            log('INFO', `Deleted local file`, { localPath });
        } catch (err) {
            log('WARN', `Failed to delete local file (non-fatal)`, {
                localPath,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    totalMigrated++;
}

async function getCloudProvider() {
    // Dynamic import to avoid env validation at parse time
    const { S3StorageProvider } = await import('../src/lib/storage/s3-provider');
    return new S3StorageProvider();
}

// ─── Run ───

main()
    .catch((err) => {
        log('ERROR', 'Migration failed', { error: err.message });
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
