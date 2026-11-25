/**
 * DSAR erasure (GDPR Art. 17) — the operator's entry point (#5802, owner
 * decision 2026-11-25). Operator-only, and deliberately not an HTTP route.
 *
 * ## What it does
 *
 *   1. Reads, writing nothing: `planErasure` (what would refuse the hard
 *      delete) and `readErasureWorkspaces` (every workspace the subject ever
 *      held a membership in, from the audit trail — their own rows AND the
 *      rows SCIM, org provisioning and tenant creation write naming them).
 *      Prints both, ids and counts only.
 *   2. Only with `--confirm`: runs `eraseUser`, which reads the workspaces
 *      again inside its own transaction and, once it has committed, hands
 *      them to the Managed Agents clean-up (every KEPT session in each of
 *      those workspaces is deleted). Prints the receipt and the clean-up
 *      records, ids and counts only.
 *
 * ## What it refuses
 *
 *   - Anything but `--user <id>` and `--confirm`. An e-mail address is never
 *     an argument: a value with an `@` is refused without being echoed, and so
 *     is any argument it does not know.
 *   - A tenant's SYSTEM user (`sys_` id). It is an automation identity, never
 *     a data subject.
 *   - A subject the plan says cannot be erased: any reference that refuses the
 *     hard delete, a membership in any status included (`TenantMembership` is
 *     ON DELETE RESTRICT). That is `eraseUser`'s own rule, so this follows it
 *     rather than keeping a second one; remove the memberships first.
 *   - Evidence of a membership it cannot classify (an audit action naming the
 *     subject's membership that `MEMBERSHIP_RECORD_ACTIONS` does not list).
 *     The erasure would then miss that workspace's clean-up for good, since
 *     the subject's own rows are pseudonymized by it.
 *
 * ## What it does NOT check
 *
 * The 24-hour cooling-off after the request was VERIFIED (docs/dsar.md), and
 * the rejection criteria (`evaluateDsarRejection`): `eraseUser` receives only
 * a subject id, and so does this. The operator confirms both before
 * `--confirm`; the plan says so every time.
 *
 * ## The audit record
 *
 * Exactly `eraseUser`'s: one `ERASURE_EXECUTED` entry per tenant whose chain
 * it pseudonymized, naming nobody, and the clean-up's own records, which name
 * tenants and connections. Nothing this command prints or writes names the
 * person: it never reads their e-mail or name.
 *
 * ## Usage
 *   npm run dsar:erase-user -- --user <userId>              # the plan; writes nothing
 *   npm run dsar:erase-user -- --user <userId> --confirm    # erase, then the clean-up
 */
import { isTenantSystemUserId } from '@/lib/tenant-system-user';
import type { ErasurePlan, ErasureReceipt, ErasureAfterCommit, ErasureCleanupOutcome } from '@/app-layer/jobs/dsar-erasure';
import type { ErasureWorkspaces } from '@/app-layer/jobs/dsar-erasure-workspaces';
import { assertNoUnknownArgs, readValueFlag } from './lib/value-flag';

const TAG = '[dsar-erase-user]';

export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_USAGE = 2;

export interface DsarEraseUserDeps {
    /** Reads only: what would block the delete, and the workspaces. */
    plan(userId: string): Promise<{ erasure: ErasurePlan; workspaces: ErasureWorkspaces }>;
    /** `eraseUser`, with the after-commit step the command observes. */
    erase(userId: string, afterCommit: ErasureAfterCommit): Promise<ErasureReceipt>;
    /** The Managed Agents clean-up over the tenants the erasure handed over. */
    cleanUp(tenantIds: readonly string[]): Promise<ErasureCleanupOutcome[]>;
    log(line: string): void;
}

const USAGE = `${TAG} usage: dsar:erase-user -- --user <userId> [--confirm]`;

/** Parse argv, never echoing a value it refuses: an operator may have typed an address. */
function parse(args: readonly string[]): { userId: string; confirm: boolean } | { refusal: string } {
    try {
        assertNoUnknownArgs(args, ['confirm'], ['user']);
    } catch {
        return { refusal: `${TAG} refused: an argument it does not know (not echoed). This command takes --user <id> and --confirm only.` };
    }
    let userId: string | undefined;
    try {
        userId = readValueFlag(args, 'user');
    } catch {
        return { refusal: `${TAG} refused: --user was given no value.` };
    }
    if (!userId) return { refusal: `${TAG} refused: --user <id> is required.` };
    if (userId.includes('@')) {
        return { refusal: `${TAG} refused: --user takes a user id, never an e-mail address (the value is not echoed).` };
    }
    if (!/^[A-Za-z0-9_-]{1,191}$/.test(userId)) {
        return { refusal: `${TAG} refused: --user is not a user id (the value is not echoed).` };
    }
    return { userId, confirm: args.includes('--confirm') };
}

function printPlan(log: (line: string) => void, userId: string, erasure: ErasurePlan, workspaces: ErasureWorkspaces): void {
    log(`${TAG} subject ${userId}`);
    log(`${TAG} workspaces where the subject held a membership: ${workspaces.tenantIds.length}`);
    for (const w of workspaces.workspaces) {
        log(`${TAG}   ${w.tenantId} evidence=${w.kinds.join(',')} rows=${w.rows}`);
    }
    log(`${TAG} undecided membership evidence: ${workspaces.undecided.length}`);
    for (const u of workspaces.undecided) {
        log(`${TAG}   ${u.trail} ${u.tenantId ?? '-'} ${u.action} ${u.reason} rows=${u.rows}`);
    }
    log(`${TAG} membership writers that record no row naming the subject (not visible to this read): ${workspaces.writersWithoutASubjectRow.length}`);
    for (const writer of workspaces.writersWithoutASubjectRow) log(`${TAG}   - ${writer}`);
    log(`${TAG} audit rows to pseudonymize: ${erasure.auditRowsToPseudonymize}`);
    log(`${TAG} references refusing the delete: ${erasure.blockers.length}`);
    for (const b of erasure.blockers) {
        log(`${TAG}   ${b.table}.${b.column} rows=${b.rows} ${b.reason ?? 'RESTRICT_REFERENCE'}`);
    }
    log(`${TAG} not checked here: the 24h cooling-off after VERIFIED, and the DSAR rejection criteria. Confirm both before --confirm.`);
}

/**
 * The command. Returns the exit code; prints through `deps.log`. Exported so
 * a test drives it with real or fake dependencies.
 */
export async function runDsarEraseUser(args: readonly string[], deps: DsarEraseUserDeps): Promise<number> {
    const parsed = parse(args);
    if ('refusal' in parsed) {
        deps.log(parsed.refusal);
        deps.log(USAGE);
        return EXIT_USAGE;
    }
    const { userId, confirm } = parsed;

    if (isTenantSystemUserId(userId)) {
        deps.log(`${TAG} refused: ${userId} is a tenant's system user, an automation identity and never a data subject.`);
        return EXIT_USAGE;
    }

    const { erasure, workspaces } = await deps.plan(userId);
    printPlan(deps.log, userId, erasure, workspaces);

    const refusals: string[] = [];
    if (erasure.blockers.length > 0) {
        refusals.push(`${erasure.blockers.length} reference(s) refuse the delete (remove the memberships and resolve the rest first)`);
    }
    if (workspaces.undecided.length > 0) {
        refusals.push(`${workspaces.undecided.length} membership record(s) this command cannot classify`);
    }

    if (!confirm) {
        deps.log(
            refusals.length > 0
                ? `${TAG} dry run: nothing written. --confirm would be refused: ${refusals.join('; ')}.`
                : `${TAG} dry run: nothing written. Re-run with --confirm to erase.`,
        );
        return EXIT_OK;
    }
    if (refusals.length > 0) {
        deps.log(`${TAG} refused: ${refusals.join('; ')}. Nothing written.`);
        return EXIT_REFUSED;
    }

    let handed: readonly string[] = [];
    let outcomes: ErasureCleanupOutcome[] = [];
    const receipt = await deps.erase(userId, async (tenantIds) => {
        handed = tenantIds;
        outcomes = await deps.cleanUp(tenantIds);
    });

    log(deps, `erased ${receipt.userId}: user deleted=${receipt.userDeleted}`
        + ` audit rows pseudonymized=${receipt.auditRowsPseudonymized} deleted=${receipt.auditRowsDeleted}`
        + ` erasure records=${receipt.erasureRecordIds.length} tolerated=${receipt.auditRowsTolerated}`);
    log(deps, `workspaces handed to the Managed Agents clean-up: ${handed.length}`);
    const planned = new Set(workspaces.tenantIds);
    const drift = handed.filter((t) => !planned.has(t)).length + workspaces.tenantIds.filter((t) => !handed.includes(t)).length;
    if (drift > 0) log(deps, `note: ${drift} workspace(s) differ from the plan; the erasure's own read, inside its transaction, is the one used.`);
    log(deps, `clean-up records: ${outcomes.length}`);
    for (const o of outcomes) log(deps, `  ${o.tenantId} ${o.connectionId} ${o.status}${o.reason ? ` ${o.reason}` : ''}`);
    return EXIT_OK;
}

function log(deps: DsarEraseUserDeps, line: string): void {
    deps.log(`${TAG} ${line}`);
}

/**
 * The production wiring. Imported lazily so a test of the parser builds no
 * client; exported so the DB-backed test runs exactly this wiring.
 */
export async function productionDeps(): Promise<DsarEraseUserDeps> {
    const [{ runInGlobalContext }, erasure, discovery] = await Promise.all([
        import('@/lib/db-context'),
        import('@/app-layer/jobs/dsar-erasure'),
        import('@/app-layer/jobs/dsar-erasure-workspaces'),
    ]);
    return {
        plan: (userId) =>
            runInGlobalContext(async (db) => {
                const raw = db as unknown as Parameters<typeof erasure.planErasure>[1]['db'];
                // The plan first: it refuses a connection RLS has narrowed, and
                // an invisible subject, before the workspace read is believed.
                const plan = await erasure.planErasure(userId, { db: raw });
                return { erasure: plan, workspaces: await discovery.readErasureWorkspaces(raw, userId) };
            }),
        erase: (userId, afterCommit) => erasure.eraseUser(userId, { afterCommit }),
        cleanUp: (tenantIds) => erasure.deleteKeptManagedAgentsSessionsAfterErasure(tenantIds),
        log: (line) => console.info(line),
    };
}

if (require.main === module) {
    (async () => {
        let code = EXIT_REFUSED;
        try {
            code = await runDsarEraseUser(process.argv.slice(2), await productionDeps());
        } catch (err) {
            // The erasure's own errors name the subject by id at most.
            console.error(`${TAG} FAILED`, err instanceof Error ? err.message : 'a non-Error value was thrown');
        } finally {
            const { prisma } = await import('@/lib/prisma');
            await prisma.$disconnect().catch(() => undefined);
        }
        process.exit(code);
    })();
}
