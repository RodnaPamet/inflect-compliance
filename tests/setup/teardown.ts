// Prisma 7 — `new PrismaClient()` requires an adapter. The teardown
// is purely a "close anything that survived" hook; it does not need
// to issue queries. Skip the local construction and just disconnect
// any singletons the parent process has on `globalThis`.

const teardown = async () => {
    type Globals = typeof globalThis & {
        prisma?: { $disconnect?: () => Promise<void> };
        __bullmq_queue?: { close?: () => Promise<void> };
    };
    const g = globalThis as Globals;
    if (g.prisma?.$disconnect) {
        await g.prisma.$disconnect().catch(() => {});
    }
    if (g.__bullmq_queue?.close) {
        await g.__bullmq_queue.close().catch(() => {});
    }

    // Drop the per-worker DBs globalSetup created (best-effort) + clear
    // the marker. All workers have exited by now, so no live connections.
    try {
        const fs = await import('fs');
        const { Client } = await import('pg');
        const { PER_WORKER_MARKER, adminConnectionString, perWorkerDbName } = await import(
            '../helpers/db'
        );
        const marker = JSON.parse(fs.readFileSync(PER_WORKER_MARKER, 'utf8')) as {
            perWorker: boolean; count: number; baseName: string; workerDbs?: string[];
        };
        if (marker.perWorker) {
            // Drop exactly what globalSetup recorded creating. Recomputing
            // is the fallback for markers written before workerDbs existed;
            // preferring the record means a naming change can never leave
            // databases behind that teardown no longer knows how to name.
            const names =
                marker.workerDbs ??
                Array.from({ length: marker.count }, (_, i) =>
                    perWorkerDbName(marker.baseName, i + 1),
                );
            const admin = new Client({ connectionString: adminConnectionString() });
            await admin.connect();
            for (const name of names) {
                await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
            }
            await admin.end();
        }
        fs.unlinkSync(PER_WORKER_MARKER);
    } catch {
        /* marker absent / DB down — nothing to clean */
    }

    // Release the concurrent-run lock LAST. The DROPs above are the most
    // destructive thing this process does, so they belong inside the window
    // the lock protects — a next run that started between the drop and the
    // release would find its own databases being deleted underneath it.
    //
    // If this never runs (a hard-killed run), the lock still frees itself:
    // it is a SESSION lock, so Postgres drops it when the connection dies.
    // That self-cleaning property is the reason this is a lock and not a
    // per-run database name.
    try {
        const { releaseTestDbRunLock } = await import('../helpers/db');
        await releaseTestDbRunLock();
    } catch {
        /* never acquired, or the connection is already gone */
    }
};

export default teardown;
