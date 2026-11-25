/**
 * DSAR erasure (GDPR Art. 17) — the operator's entry point (#5802, #5940;
 * owner decisions 2026-11-25). Operator-only, and deliberately not an HTTP
 * route. It takes a DSAR REGISTER REQUEST, never a person: the subject is read
 * from the request.
 *
 * ## What it does
 *
 *   1. Finds the request: `--request <id>`, or `--due` — the one ERASURE
 *      request that is due (verified, past its cooling-off, not completed,
 *      rejected or cancelled). `--due` refuses unless exactly one is due; it
 *      is what the production `VM apply` actions run, since they take no
 *      parameter.
 *   2. Decides on it (`decideErasureRequest`, `dsar-erasure-request.ts`) and
 *      refuses by a named reason: not found, not an erasure, already
 *      completed, rejected, cancelled, not verified, still cooling off, not
 *      started (IN_PROGRESS is required), subject already erased, or a
 *      rejection criterion (`evaluateDsarRejection`: LAST_OWNER from the
 *      subject's memberships; outstanding balance and legal hold are printed
 *      as the operator's check, because the product holds neither).
 *   3. Reads, writing nothing: `planErasure` and `readErasureWorkspaces`.
 *      Prints the plan, ids and counts only.
 *   4. Only with `--confirm`: `eraseUser` with the request, which decides
 *      again inside its own transaction, completes the request, clears the
 *      subject's register columns, erases, and hands the workspaces to the
 *      Managed Agents clean-up.
 *
 * The plan exits 1 whenever `--confirm` would be refused, so a preflight that
 * passed means the write may run.
 *
 * ## Output
 *
 * Ids, statuses, timestamps and counts. Never an e-mail or a name: this
 * command reads neither. The production action's log is public.
 *
 * ## Usage
 *   npm run dsar:erase -- --request <requestId>              # the plan; writes nothing
 *   npm run dsar:erase -- --request <requestId> --confirm    # erase
 *   node dist/dsar-erase.mjs --due [--confirm]               # the one due request (VM apply)
 *
 * The entry point is `scripts/dsar-erase-main.ts`; this module only exports,
 * so a test drives it and esbuild can bundle the entry as ESM.
 */
import { isTenantSystemUserId } from '@/lib/tenant-system-user';
import type { ErasurePlan, ErasureReceipt, ErasureAfterCommit, ErasureCleanupOutcome } from '@/app-layer/jobs/dsar-erasure';
import type { ErasureWorkspaces } from '@/app-layer/jobs/dsar-erasure-workspaces';
import { OPERATOR_CHECKS } from '@/app-layer/jobs/dsar-erasure-request';
import type { ErasureRequestRefusal, ErasureRequestRow } from '@/app-layer/jobs/dsar-erasure-request';
import { assertNoUnknownArgs, readValueFlag } from './lib/value-flag';

const TAG = '[dsar-erase]';

export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_USAGE = 2;

export interface DsarEraseDeps {
    now(): Date;
    /** One request by id. */
    readRequest(requestId: string): Promise<ErasureRequestRow | null>;
    /** The due erasure requests, at most two (none, one, or more than one). */
    readDue(now: Date): Promise<ErasureRequestRow[]>;
    /** The request's refusal, or null: the register's rules, then the rejection criteria. */
    decide(request: ErasureRequestRow, now: Date): Promise<ErasureRequestRefusal | null>;
    /** Reads only: what would block the delete, and the workspaces. */
    plan(userId: string): Promise<{ erasure: ErasurePlan; workspaces: ErasureWorkspaces }>;
    /** `eraseUser` with the request, and the after-commit step the command observes. */
    erase(userId: string, request: { id: string; now: Date }, afterCommit: ErasureAfterCommit): Promise<ErasureReceipt>;
    /** The Managed Agents clean-up over the tenants the erasure handed over. */
    cleanUp(tenantIds: readonly string[]): Promise<ErasureCleanupOutcome[]>;
    log(line: string): void;
}

const USAGE = `${TAG} usage: dsar:erase -- (--request <requestId> | --due) [--confirm]`;

type Target = { kind: 'request'; requestId: string } | { kind: 'due' };

/** Parse argv, never echoing a value it refuses: an operator may have typed an address. */
function parse(args: readonly string[]): { target: Target; confirm: boolean } | { refusal: string } {
    try {
        assertNoUnknownArgs(args, ['confirm', 'due'], ['request']);
    } catch {
        return { refusal: `${TAG} refused: an argument it does not know (not echoed). This command takes --request <id> or --due, and --confirm.` };
    }
    let requestId: string | undefined;
    try {
        requestId = readValueFlag(args, 'request');
    } catch {
        return { refusal: `${TAG} refused: --request was given no value.` };
    }
    const due = args.includes('--due');
    if (due && requestId !== undefined) return { refusal: `${TAG} refused: --request and --due name the request two ways; give one.` };
    if (!due && requestId === undefined) return { refusal: `${TAG} refused: --request <id> or --due is required.` };
    const confirm = args.includes('--confirm');
    if (due) return { target: { kind: 'due' }, confirm };
    if (requestId!.includes('@')) {
        return { refusal: `${TAG} refused: --request takes a request id, never an e-mail address (the value is not echoed).` };
    }
    if (!/^[A-Za-z0-9_-]{1,191}$/.test(requestId!)) {
        return { refusal: `${TAG} refused: --request is not a request id (the value is not echoed).` };
    }
    return { target: { kind: 'request', requestId: requestId! }, confirm };
}

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : '-');

function printPlan(log: (line: string) => void, erasure: ErasurePlan, workspaces: ErasureWorkspaces): void {
    log(`${TAG} workspaces where the subject held a membership: ${workspaces.tenantIds.length}`);
    for (const w of workspaces.workspaces) {
        log(`${TAG}   ${w.tenantId} evidence=${w.kinds.join(',')} rows=${w.rows}`);
    }
    log(`${TAG} undecided membership evidence: ${workspaces.undecided.length}`);
    for (const u of workspaces.undecided) {
        log(`${TAG}   ${u.trail} ${u.tenantId ?? '-'} ${u.action} ${u.reason} rows=${u.rows}`);
    }
    log(`${TAG} what no row names the subject in (not visible to this read): ${workspaces.writersWithoutASubjectRow.length}`);
    for (const writer of workspaces.writersWithoutASubjectRow) log(`${TAG}   - ${writer}`);
    log(`${TAG} audit rows to pseudonymize: ${erasure.auditRowsToPseudonymize}`);
    log(`${TAG} references refusing the delete: ${erasure.blockers.length}`);
    for (const b of erasure.blockers) {
        log(`${TAG}   ${b.table}.${b.column} rows=${b.rows} ${b.reason ?? 'RESTRICT_REFERENCE'}`);
    }
    log(`${TAG} not checked by the product (the operator's check before --confirm): ${OPERATOR_CHECKS.length}`);
    for (const line of OPERATOR_CHECKS) log(`${TAG}   - ${line}`);
}

/**
 * The command. Returns the exit code; prints through `deps.log`. Exported so
 * a test drives it with real or fake dependencies.
 */
export async function runDsarErase(args: readonly string[], deps: DsarEraseDeps): Promise<number> {
    const parsed = parse(args);
    if ('refusal' in parsed) {
        deps.log(parsed.refusal);
        deps.log(USAGE);
        return EXIT_USAGE;
    }
    const { target, confirm } = parsed;
    const now = deps.now();

    // ── THE REQUEST ───────────────────────────────────────────────────
    let request: ErasureRequestRow | null;
    if (target.kind === 'due') {
        const due = await deps.readDue(now);
        if (due.length !== 1) {
            log(deps, due.length === 0
                ? 'refused: NO_DUE_REQUEST — no erasure request is verified, past its cooling-off and still open. Nothing written.'
                : `refused: MORE_THAN_ONE_DUE — more than one erasure request is due (${due.map((r) => r.id).join(', ')}, …). `
                    + 'Fulfil them one at a time with --request. Nothing written.');
            return EXIT_REFUSED;
        }
        request = due[0];
    } else {
        request = await deps.readRequest(target.requestId);
        if (!request) {
            log(deps, `request ${target.requestId}: refused: REQUEST_NOT_FOUND. Nothing written.`);
            return EXIT_REFUSED;
        }
    }
    log(deps, `request ${request.id} type=${request.type} status=${request.status} verified=${iso(request.verifiedAt)}`
        + ` subject=${request.userId ?? '-'}`);

    const refusal = await deps.decide(request, now);
    if (refusal) {
        log(deps, `refused: ${refusal.reason}${refusal.rejection ? ` (${refusal.rejection})` : ''}. Nothing written.`);
        return EXIT_REFUSED;
    }
    const userId = request.userId!;
    if (isTenantSystemUserId(userId)) {
        log(deps, `refused: SYSTEM_USER — ${userId} is a tenant's system user, an automation identity and never a data subject.`);
        return EXIT_REFUSED;
    }

    // ── THE PLAN ──────────────────────────────────────────────────────
    const { erasure, workspaces } = await deps.plan(userId);
    printPlan(deps.log, erasure, workspaces);

    const refusals: string[] = [];
    if (erasure.blockers.length > 0) {
        refusals.push(`${erasure.blockers.length} reference(s) refuse the delete (remove the memberships and resolve the rest first)`);
    }
    if (workspaces.undecided.length > 0) {
        refusals.push(`${workspaces.undecided.length} membership record(s) this command cannot classify`);
    }
    if (refusals.length > 0) {
        log(deps, `refused: ${refusals.join('; ')}. Nothing written.`);
        return EXIT_REFUSED;
    }
    if (!confirm) {
        log(deps, 'plan only: nothing written. Re-run with --confirm to erase.');
        return EXIT_OK;
    }

    // ── THE ERASURE ───────────────────────────────────────────────────
    let handed: readonly string[] = [];
    let outcomes: ErasureCleanupOutcome[] = [];
    const receipt = await deps.erase(userId, { id: request.id, now }, async (tenantIds) => {
        handed = tenantIds;
        outcomes = await deps.cleanUp(tenantIds);
    });

    log(deps, `erased ${receipt.userId}: user deleted=${receipt.userDeleted}`
        + ` audit rows pseudonymized=${receipt.auditRowsPseudonymized} deleted=${receipt.auditRowsDeleted}`
        + ` erasure records=${receipt.erasureRecordIds.length} tolerated=${receipt.auditRowsTolerated}`);
    log(deps, `register: request completed=${receipt.requestCompleted ?? '-'} requests cleared=${receipt.registerRequestsCleared}`);
    log(deps, `workspaces handed to the Managed Agents clean-up: ${handed.length}`);
    const planned = new Set(workspaces.tenantIds);
    const drift = handed.filter((t) => !planned.has(t)).length + workspaces.tenantIds.filter((t) => !handed.includes(t)).length;
    if (drift > 0) log(deps, `note: ${drift} workspace(s) differ from the plan; the erasure's own read, inside its transaction, is the one used.`);
    log(deps, `clean-up records: ${outcomes.length}`);
    for (const o of outcomes) log(deps, `  ${o.tenantId} ${o.connectionId} ${o.status}${o.reason ? ` ${o.reason}` : ''}`);
    return EXIT_OK;
}

function log(deps: DsarEraseDeps, line: string): void {
    deps.log(`${TAG} ${line}`);
}

/**
 * What a failure may print. The log of the production action is public, so
 * only this repository's own errors — whose messages carry ids and counts —
 * are printed whole; anything else (a driver error, a connection error) is
 * reduced to its class and code.
 */
export function failureLine(err: unknown): string {
    const own = new Set([
        'ErasureBlockedError',
        'ErasureRequestRefusedError',
        'ErasureWorkspaceDiscoveryTruncatedError',
    ]);
    if (err instanceof Error && own.has(err.name)) return `${TAG} FAILED ${err.message}`;
    const code = (err as { code?: unknown } | null)?.code;
    const name = err instanceof Error ? err.name : 'a non-Error value';
    return `${TAG} FAILED ${name}${typeof code === 'string' ? ` ${code}` : ''} (message withheld: the log may be public)`;
}

/**
 * The production wiring. Imported lazily so a test of the parser builds no
 * client; exported so the DB-backed test runs exactly this wiring.
 */
export async function productionDeps(): Promise<DsarEraseDeps> {
    const [{ runInGlobalContext }, erasure, discovery, requests] = await Promise.all([
        import('@/lib/db-context'),
        import('@/app-layer/jobs/dsar-erasure'),
        import('@/app-layer/jobs/dsar-erasure-workspaces'),
        import('@/app-layer/jobs/dsar-erasure-request'),
    ]);
    type Raw = Parameters<typeof erasure.planErasure>[1]['db'];
    return {
        now: () => new Date(),
        readRequest: (requestId) => runInGlobalContext((db) => requests.readErasureRequest(db as unknown as Raw, requestId)),
        readDue: (now) => runInGlobalContext((db) => requests.readDueErasureRequests(db as unknown as Raw, now)),
        decide: (request, now) => runInGlobalContext((db) => requests.decideErasureRequest(db as unknown as Raw, request, now)),
        plan: (userId) =>
            runInGlobalContext(async (db) => {
                const raw = db as unknown as Raw;
                // The plan first: it refuses a connection RLS has narrowed, and
                // an invisible subject, before the workspace read is believed.
                const plan = await erasure.planErasure(userId, { db: raw });
                return { erasure: plan, workspaces: await discovery.readErasureWorkspaces(raw, userId) };
            }),
        erase: (userId, request, afterCommit) => erasure.eraseUser(userId, { afterCommit, request }),
        cleanUp: (tenantIds) => erasure.deleteKeptManagedAgentsSessionsAfterErasure(tenantIds),
        log: (line) => console.info(line),
    };
}

/** The process: run, print a failure safely, disconnect, exit. */
export async function main(argv: readonly string[]): Promise<number> {
    let code = EXIT_REFUSED;
    try {
        code = await runDsarErase(argv, await productionDeps());
    } catch (err) {
        console.error(failureLine(err));
    } finally {
        const { prisma } = await import('@/lib/prisma');
        await prisma.$disconnect().catch(() => undefined);
    }
    return code;
}
