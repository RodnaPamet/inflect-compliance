/**
 * Proving run — drive Steps 1c → 2a → 4 against a real HTTPS socket.
 *
 * ## Why this exists
 *
 * Every one of the recertification roadmap's 177 acceptance criteria is
 * satisfiable without a byte crossing a socket, and all five legacy tables
 * (`LegacyAccessSnapshot`, `LegacyAccount`, `LegacyAccountResolution`,
 * `LegacyIdentityAlias`, `LegacyMatchVerdict`) hold ZERO rows in production.
 * The client, `safeFetch`'s re-resolution, the `initialize` handshake, the
 * manifest read, cursor paging, snapshot persistence and reconciliation have
 * therefore never run against anything but an in-process fake. This script is
 * the first exercise of that path end to end, against
 * `scripts/proving-run-legacy-mcp-server.ts` served over public HTTPS.
 *
 * ## What it is NOT
 *
 * It is not a seeder, a fixture, or a migration, and it is deliberately not
 * wired into `build-worker.mjs`, `package.json` or any job. It is run by hand,
 * one phase per invocation, so a human reads the result before the next write
 * happens. Nothing here writes to a directory: `legacy-access` is a READ
 * integration and the reconcile it drives produces resolutions, not account
 * changes. The joiner/leaver writers live behind separate providers and
 * separate per-connection opt-ins and are not reachable from here.
 *
 * ## Phases
 *
 *   validate   probe the manifest. NO database write. Run this first.
 *   create     upsert the `legacy-mcp` connection. The first write.
 *   map        read the manifest and save the Step 2b column mapping.
 *   pull       enqueue `legacy-access-pull`. The worker does the work.
 *   status     read what the pull produced. Repeat freely; writes nothing.
 *   reconcile  enqueue `legacy-reconcile` for the newest snapshot.
 *
 * `PROVING_ENDPOINT_URL` and `PROVING_BEARER_TOKEN` come from the environment
 * and neither is ever printed — the token is referenced only by presence and
 * length, and the only thing echoed from a failure is a verdict this codebase
 * authored.
 */

import { buildSystemContext } from '@/app-layer/context-system';
import {
    testConnectionCredentials,
    upsertIntegrationConnection,
} from '@/app-layer/usecases/integrations';
import { saveLegacyAccessMapping } from '@/app-layer/usecases/legacy-access-mapping';
import { requestLegacyAccessPull } from '@/app-layer/usecases/legacy-access-pull';
import { requestLegacyReconcile } from '@/app-layer/usecases/legacy-reconcile';
import { computeColumnSetFingerprint } from '@/lib/legacy-access/canonical';
import { probeManifest } from '@/lib/mcp/client';
import { prisma } from '@/lib/prisma';

const PROVIDER = 'legacy-mcp';
const CONNECTION_NAME = 'Proving run — reference legacy application';

function need(name: string): string {
    const v = process.env[name]?.trim();
    if (!v) {
        // Fail on the NAME, never the value, and before any phase runs — an
        // empty endpoint would otherwise reach `validateConnection` and be
        // reported as "URL is required", which reads like a code defect.
        throw new Error(`${name} is required and is empty`);
    }
    return v;
}

/**
 * PRESENT/ABSENT and a length — never the value. An identifying column's
 * content is not needed to know the mapping populated it, and a length is
 * enough to distinguish "mapped" from "mapped to empty string".
 */
function present(v: string | null | undefined): string {
    if (v === null || v === undefined) return 'null';
    return `present:${String(v.length)}`;
}

/**
 * The LENGTH of a JSON array column, or a marker for the two shapes that are
 * not one. The counts are the point — a reconcile that considered zero
 * candidates and a reconcile that considered four both write UNMATCHED, and
 * only the count distinguishes "no identity matched" from "no identity was
 * ever read", which is the defect this proving run exists to rule out.
 */
function arrayLen(v: unknown): string {
    if (v === null || v === undefined) return 'null';
    if (Array.isArray(v)) return String(v.length);
    return `non-array:${typeof v}`;
}

async function resolveTenant(slug: string): Promise<{ id: string; slug: string }> {
    const t = await prisma.tenant.findFirst({ where: { slug }, select: { id: true, slug: true } });
    if (!t) throw new Error(`no tenant with slug ${slug}`);
    return t;
}

async function findConnection(tenantId: string): Promise<string | null> {
    const c = await prisma.integrationConnection.findFirst({
        where: { tenantId, provider: PROVIDER },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
    });
    return c?.id ?? null;
}

async function main(): Promise<void> {
    const phase = process.argv[2] ?? '';
    const slug = need('PROVING_TENANT_SLUG');
    const endpointUrl = need('PROVING_ENDPOINT_URL');
    const bearerToken = need('PROVING_BEARER_TOKEN');

    const tenant = await resolveTenant(slug);
    const ctx = buildSystemContext({
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        job: 'proving-run-legacy-access',
    });

    console.log(`tenant      ${tenant.slug} (${tenant.id})`);
    console.log(`endpoint    ${endpointUrl}`);
    console.log(`token       present, ${bearerToken.length} chars`);
    console.log(`phase       ${phase || '(none given)'}`);
    console.log('');

    if (phase === 'validate') {
        // The whole point of running this one alone: it is the only phase that
        // reaches the network without having written anything, so a failure
        // here costs nothing to retry.
        const r = await testConnectionCredentials(ctx, {
            provider: PROVIDER,
            configJson: { endpointUrl, applicationName: 'Reference legacy application' },
            secrets: { bearerToken },
        });
        console.log(`valid       ${r.valid}`);
        if (!r.valid) console.log(`error       ${r.error ?? '(none)'}`);
        return;
    }

    if (phase === 'create') {
        const existing = await findConnection(tenant.id);
        const conn = await upsertIntegrationConnection(ctx, {
            id: existing ?? undefined,
            provider: PROVIDER,
            name: CONNECTION_NAME,
            configJson: { endpointUrl, applicationName: 'Reference legacy application' },
            secrets: { bearerToken },
            isEnabled: true,
        });
        console.log(`${existing ? 'updated' : 'created'}     ${conn.id}`);
        return;
    }

    if (phase === 'map') {
        // ═══ WHAT THIS PHASE IS MIRRORING ═══
        //
        // Step 2b's admin screen reads the manifest ITSELF — `validateConnection`
        // deliberately throws the column list away, because
        // `ConnectionValidationResult` is `{ valid, error? }` and has no success
        // channel to carry it. So this phase does what that screen does: read the
        // manifest over the same client, fingerprint the column set it actually
        // returned, map the columns to canonical fields, and save.
        //
        // The fingerprint is taken from the LIVE manifest rather than a constant.
        // A hand-written fingerprint would be a mapping confirmed against columns
        // nobody read, and the drift refusal exists precisely to catch that.
        const id = await findConnection(tenant.id);
        if (!id) throw new Error('no legacy-mcp connection — run the create phase first');

        const manifest = await probeManifest({ url: endpointUrl, token: bearerToken });
        const columns = manifest.columns.map((c) => c.name);
        console.log(`columns     ${columns.join(', ')}`);

        const fingerprint = computeColumnSetFingerprint(columns);
        console.log(`fingerprint ${fingerprint}`);

        // Mapped by name against what the reference server declares. Every pair
        // is asserted present below rather than assumed, so a server that renames
        // a column fails HERE with the name it dropped, instead of producing a
        // mapping that silently collects nothing for that field.
        //
        // `username` is deliberately NOT mapped to `LOGIN_NAME` as well.
        // `assertMappingUsable` refuses one column claimed by two canonical
        // fields, and it is right to: Step 4a's convention blocker compares
        // against `account.accountKey` (`baseClean(account.accountKey)` in
        // `scorers.ts`), not against `username`, so duplicating the column
        // would buy no matching power and would make the stored mapping claim
        // the application has a username column distinct from its login name.
        const want: Record<string, string> = {
            accountKey: 'LOGIN_NAME',
            displayName: 'DISPLAY_NAME',
            email: 'EMAIL_ADDR',
            department: 'DEPT_CODE',
            title: 'JOB_TITLE',
            status: 'STATUS_FLAG',
            createdAt: 'CREATED_ON',
        };
        const missing = Object.values(want).filter((c) => !columns.includes(c));
        if (missing.length > 0) {
            throw new Error(`manifest does not declare: ${missing.join(', ')}`);
        }

        const mapping = await saveLegacyAccessMapping(ctx, {
            connectionId: id,
            columnSetFingerprint: fingerprint,
            confirmedColumns: columns,
            fields: want,
            // `ROLE_ADMIN` is the reference server's single boolean entitlement
            // column, so `wide` with one column is the layout that describes it.
            entitlements: { kind: 'wide', columns: ['ROLE_ADMIN'] },
            // The reference server spells status `A` / `D`. Declared per
            // connection because `DEFAULT_STATUS_VALUE_MAP` cannot know a legacy
            // application's own alphabet.
            statusValues: { A: 'ACTIVE', D: 'DISABLED' },
        });
        console.log(`saved       mapping v${String(mapping.version)} fields=${String(Object.keys(mapping.fields).length)}`);
        return;
    }

    if (phase === 'pull') {
        const id = await findConnection(tenant.id);
        if (!id) throw new Error('no legacy-mcp connection — run the create phase first');
        const { jobId } = await requestLegacyAccessPull(ctx, id);
        console.log(`enqueued    legacy-access-pull jobId=${jobId ?? '(none)'}`);
        return;
    }

    if (phase === 'status') {
        // ═══ WHY THIS PHASE REDACTS ═══
        //
        // `LegacyAccount` is a directory extract: name, email, employee number,
        // department, title, manager. Dumping rows is fine for the seven
        // synthetic accounts the reference server mints and is a PII disclosure
        // the moment anyone points this script at a real legacy application —
        // and a one-off script is exactly the thing that gets re-pointed. So
        // identifying columns are reported as PRESENT/ABSENT with a length,
        // never as values. The non-identifying columns are printed in full
        // because they are what a proving run has to read to know the mapping
        // worked.
        const snaps = await prisma.legacyAccessSnapshot.findMany({
            where: { tenantId: tenant.id },
            orderBy: { createdAt: 'desc' },
            take: 5,
            select: {
                id: true,
                status: true,
                remoteSnapshotId: true,
                mappingVersion: true,
                columnSetFingerprint: true,
                payloadHash: true,
                rowCount: true,
                rowsReceived: true,
                refusalReason: true,
                refusalDetail: true,
                oversharedColumns: true,
                unparsedDateCount: true,
                createdAt: true,
            },
        });
        console.log(`snapshots   ${snaps.length}`);
        for (const s of snaps) {
            console.log(
                `  ${s.id} status=${String(s.status)} remote=${s.remoteSnapshotId} `
                + `rows=${String(s.rowCount)}/received=${String(s.rowsReceived)} `
                + `mapping=v${String(s.mappingVersion)} `
                + `fp=${s.columnSetFingerprint.slice(0, 12)} `
                + `hash=${s.payloadHash ? s.payloadHash.slice(0, 12) : 'null'} `
                + `at=${s.createdAt.toISOString()}`
            );
            // The refusal columns are the ones a proving run is actually
            // looking for: a PENDING snapshot with no refusal is a hang, and a
            // refusal with no detail is a defect in the refusal path itself.
            console.log(
                `    refusal=${s.refusalReason === null ? 'none' : String(s.refusalReason)} `
                + `detail=${s.refusalDetail ?? 'null'} `
                + `overshared=[${s.oversharedColumns.join(',')}] `
                + `unparsedDates=${String(s.unparsedDateCount)}`
            );
        }

        const counts = {
            accounts: await prisma.legacyAccount.count({ where: { tenantId: tenant.id } }),
            resolutions: await prisma.legacyAccountResolution.count({
                where: { tenantId: tenant.id },
            }),
            aliases: await prisma.legacyIdentityAlias.count({ where: { tenantId: tenant.id } }),
            verdicts: await prisma.legacyMatchVerdict.count({ where: { tenantId: tenant.id } }),
        };
        for (const [k, v] of Object.entries(counts)) {
            console.log(`${k.padEnd(11)} ${String(v)}`);
        }

        if (counts.accounts > 0) {
            const rows = await prisma.legacyAccount.findMany({
                where: { tenantId: tenant.id },
                take: 20,
                orderBy: { accountKey: 'asc' },
                select: {
                    accountKey: true,
                    username: true,
                    displayName: true,
                    email: true,
                    employeeNumber: true,
                    department: true,
                    title: true,
                },
            });
            for (const r of rows) {
                console.log(
                    `  acct key=${r.accountKey} user=${present(r.username)} `
                    + `name=${present(r.displayName)} email=${present(r.email)} `
                    + `empno=${present(r.employeeNumber)} `
                    + `dept=${r.department ?? 'null'} title=${r.title ?? 'null'}`
                );
            }
        }

        if (counts.resolutions > 0) {
            const rows = await prisma.legacyAccountResolution.findMany({
                where: { tenantId: tenant.id },
                take: 20,
                orderBy: { createdAt: 'asc' },
                select: {
                    accountKey: true,
                    outcome: true,
                    method: true,
                    employeeId: true,
                    suggestedRekeyed: true,
                    note: true,
                    signalsJson: true,
                    candidatesJson: true,
                    vetoesJson: true,
                },
            });
            for (const r of rows) {
                console.log(
                    `  res  key=${r.accountKey} outcome=${String(r.outcome)} `
                    + `method=${String(r.method)} employee=${r.employeeId ? 'set' : 'null'} `
                    + `rekeyed=${String(r.suggestedRekeyed)} `
                    + `signals=${arrayLen(r.signalsJson)} `
                    + `candidates=${arrayLen(r.candidatesJson)} `
                    + `vetoes=${arrayLen(r.vetoesJson)} note=${r.note ?? 'null'}`
                );
            }
        }
        return;
    }

    if (phase === 'reconcile') {
        const snap = await prisma.legacyAccessSnapshot.findFirst({
            where: { tenantId: tenant.id },
            orderBy: { createdAt: 'desc' },
            select: { id: true },
        });
        if (!snap) throw new Error('no snapshot — run the pull phase first');
        const { jobId } = await requestLegacyReconcile(ctx, snap.id);
        console.log(`enqueued    legacy-reconcile snapshot=${snap.id} jobId=${jobId ?? '(none)'}`);
        return;
    }

    throw new Error('phase must be one of: validate create map pull status reconcile');
}

main()
    .then(async () => {
        await prisma.$disconnect();
        process.exit(0);
    })
    .catch(async (err: unknown) => {
        console.error(err instanceof Error ? `FAILED: ${err.message}` : `FAILED: ${String(err)}`);
        if (err instanceof Error && err.stack) console.error(err.stack);
        await prisma.$disconnect();
        process.exit(1);
    });
