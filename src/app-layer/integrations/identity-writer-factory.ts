/**
 * The one seam from an `IntegrationConnection` to a `DirectoryWriter`.
 *
 * ═══ WHY DRY_RUN DOES NOT GET A REAL WRITER ═══
 *
 * `decideAndDisable` calls `writer.readState()` BEFORE it reaches the DRY_RUN
 * branch — the mode decides whether to WRITE, not whether to look. So a naive
 * factory would have to construct a live writer just to observe, and the Entra
 * writer's constructor refuses unless `writesEnabled === true`.
 *
 * That flag exists so a setup-guide edit alone cannot upgrade a read-only tenant
 * into a writing one. Requiring it in order to run the observation rung would
 * invert the whole ladder: a tenant would have to grant standing power to
 * disable accounts before it could watch what disabling would do. The
 * alternative — forcing the flag on inside the factory — is worse, because it
 * routes around a control by pretending to satisfy it.
 *
 * So DRY_RUN reads from the last CONFIRMED-COMPLETE directory enumeration this
 * product already stores, and never opens a socket. That is not an
 * approximation: `identity-sync` records `SUSPENDED` exactly when the directory
 * reports the account disabled — `accountEnabled === false` for Entra, the
 * `userAccountControl` ACCOUNTDISABLE bit for AD — so `enabled === (status ===
 * 'ACTIVE')` reproduces what a live `readState` would have returned as of that
 * pass. `DEPROVISIONED` reads as not-enabled too, matching the live Entra
 * writer, which RESOLVES a 404 rather than throwing.
 *
 * Three problems dissolve at once: no consent is needed to observe, no Graph
 * token is minted (so a dry run can never be mistaken for evidence that
 * `User.EnableDisableAccount.All` was granted), and a transient network failure
 * during the read cannot produce a FAILED outcome — which the notification layer
 * would turn into a mail telling IT an account is still live.
 *
 * ═══ WHAT THE SNAPSHOT DELIBERATELY REFUSES ═══
 *
 * `disable()` on the snapshot writer throws. It is a reader wearing the writer
 * interface because that is what the orchestration takes, and the only correct
 * response to being asked to write is to refuse loudly — a snapshot writer that
 * silently no-ops would make a mode bug invisible.
 *
 * `staleEvidence` is set on every snapshot read. The orchestration must not
 * settle an INDETERMINATE journal row from it: settling asserts "our earlier
 * write landed", inferred from the account being disabled NOW. That inference is
 * sound from a live read and unsound from a snapshot up to a day old — an
 * account re-enabled by an admin this morning still reads SUSPENDED in last
 * night's data, and the pass would both mis-settle the journal and report
 * "nothing to do" for exactly the person who needed disabling.
 *
 * @module integrations/identity-writer-factory
 */
import { decryptField } from '@/lib/security/encryption';
import { logger } from '@/lib/observability/logger';
import { runInTenantContext } from '@/lib/db-context';
import type { RequestContext } from '../types';
import {
    DirectoryWriteError,
    type DirectoryAccountState,
    type DirectoryWriter,
} from '../usecases/identity-disable-account';
import { createEntraIdWriter } from './providers/entra-id/writer';
import { createActiveDirectoryWriter } from './providers/active-directory/writer';

/** The providers this product can write to. Nothing else resolves. */
export const WRITABLE_IDENTITY_PROVIDERS = ['entra-id', 'active-directory'] as const;
export type WritableIdentityProvider = (typeof WRITABLE_IDENTITY_PROVIDERS)[number];

export function isWritableIdentityProvider(p: string): p is WritableIdentityProvider {
    return (WRITABLE_IDENTITY_PROVIDERS as readonly string[]).includes(p);
}

/** Why no writer could be produced. Each is a distinct operator action. */
export type WriterRefusal =
    /** The provider has no writer, and never will through this seam. */
    | 'UNSUPPORTED_PROVIDER'
    /** No enabled connection for this (tenant, provider). */
    | 'NO_CONNECTION'
    /**
     * More than one enabled connection for this (tenant, provider).
     *
     * Refused rather than guessed. `ConnectedIdentityAccount` now carries a
     * `connectionId`, but it is NULLABLE and nothing here selects a connection
     * per account yet: a row observed before that column existed, or one whose
     * connection was deleted, cannot say which directory it came from. Until
     * the column is NOT NULL and this factory resolves a writer per account
     * rather than per (tenant, provider), picking either connection still means
     * a disable addressed at a forest the account may not live in.
     */
    | 'AMBIGUOUS_CONNECTION'
    /** The connection's secrets did not decrypt. */
    | 'SECRETS_UNREADABLE'
    /** The connection exists but is not enabled for directory writes. */
    | 'WRITES_NOT_ENABLED'
    /** The writer's own constructor refused (missing config, bad URL, …). */
    | 'WRITER_REFUSED';

/**
 * A resolved writer plus its disposal.
 *
 * `close` is ALWAYS present — a no-op for Entra and for the snapshot reader,
 * AD's real `close()` for the live AD arm. That is deliberate: a caller's
 * `finally` becomes unconditional and typechecked, rather than a
 * `'close' in writer` narrowing somebody will eventually forget. The AD writer
 * holds an LDAP socket, and a leaked bind outlives the process that made it.
 */
export type WriterResolution =
    | { kind: 'snapshot'; writer: DirectoryWriter; close: () => Promise<void> }
    | { kind: 'live'; writer: DirectoryWriter; close: () => Promise<void> }
    | { kind: 'none'; refusal: WriterRefusal; detail: string };

const NOOP_CLOSE = async (): Promise<void> => {};

/**
 * A `readState` served from the last confirmed-complete enumeration.
 *
 * Carries `staleEvidence: true` on every read so a caller can refuse to draw
 * conclusions that only a live read supports. See the module header.
 */
export function createSnapshotWriter(
    ctx: RequestContext,
    provider: string,
    connectionId: string,
    selfAccountIds: readonly string[] = [],
): DirectoryWriter {
    return {
        provider,
        // Supplied by the caller, from the same connection fields the live
        // writer binds with. It used to be hardcoded `null` with a comment
        // claiming "the pass supplies it from the connection instead" — the pass
        // did not, and there was no parameter through which it could have. So
        // the self-lockout refusal was a guard bound to nothing in the ONE mode
        // every tenant runs for seven days.
        //
        // Defaulting to empty keeps the meaning honest for a caller that has no
        // connection to read: no identities, so refuse nothing on this ground.
        selfAccountIds,

        async readState(externalUserId: string): Promise<DirectoryAccountState> {
            const row = await runInTenantContext(ctx, (db) =>
                db.connectedIdentityAccount.findFirst({
                    // SCOPED TO THE CONNECTION as of phase 2. The account key is
                    // now (tenantId, connectionId, externalUserId), so the same
                    // externalUserId can legitimately exist under two connections
                    // — two forests, two rows, two different accounts. Reading by
                    // (tenantId, provider, externalUserId) would return whichever
                    // Prisma happened to order first, and a dry run would report a
                    // decision about the wrong directory.
                    where: { tenantId: ctx.tenantId, provider, connectionId, externalUserId },
                    select: { status: true, updatedAt: true, onPremisesSyncEnabled: true },
                }),
            );
            if (!row) {
                // Not in the last enumeration at all. A live read would answer
                // 404, which the Entra writer resolves as "cannot be disabled
                // because it is not there".
                throw new DirectoryWriteError(
                    `No observed directory record for ${externalUserId}. The last complete sync did not ` +
                        'see this account, so there is nothing to report on without contacting the ' +
                        'directory — which the observation rung deliberately does not do.',
                    { definitivelyNotApplied: true },
                );
            }
            return {
                enabled: row.status === 'ACTIVE',
                priorState: {
                    // Explicitly NOT a capture. Marked so that if this ever
                    // reached a real journal row, the row would say plainly that
                    // it holds observed state rather than a restorable capture.
                    source: 'SNAPSHOT',
                    observedStatus: row.status,
                    observedAt: row.updatedAt?.toISOString?.() ?? null,
                    onPremisesSyncEnabled: row.onPremisesSyncEnabled ?? null,
                    staleEvidence: true,
                },
            };
        },

        async disable(externalUserId: string): Promise<void> {
            // Loud, not silent. A snapshot writer that no-opped here would make
            // a mode bug — a PROPOSE or AUTOMATIC pass handed the observation
            // writer — look exactly like a successful dry run.
            throw new DirectoryWriteError(
                `Refusing to disable ${externalUserId}: this is the observation reader, which has no ` +
                    'connection to the directory. Reaching this line means a pass above DRY_RUN was ' +
                    'given the snapshot writer, which is a wiring bug, not a directory condition.',
                { definitivelyNotApplied: true },
            );
        },
    };
}

/** Config merged with decrypted secrets, exactly as identity-sync assembles it. */
function mergeConnection(conn: {
    configJson: unknown;
    secretEncrypted: string | null;
}): Record<string, unknown> {
    const config = (conn.configJson ?? {}) as Record<string, unknown>;
    // Explicit rather than a `catch → {}`. A connection whose secrets do not
    // decrypt must refuse by name: silently continuing with an empty secret bag
    // produces a writer that fails once per account with nothing said about why.
    const secrets: Record<string, unknown> = conn.secretEncrypted
        ? (JSON.parse(decryptField(conn.secretEncrypted)) as Record<string, unknown>)
        : {};
    return { ...config, ...secrets };
}

/**
 * The bind identities a connection authenticates as, for the snapshot reader.
 *
 * Both binds, because a dedicated write bind does not make the read bind
 * expendable — the nightly sync authenticates as it, and disabling it stops the
 * sync, stales every link, and makes each later leaver pass refuse
 * NO_FRESH_LINKS. Offboarding stops for everyone and the account that did it
 * looks like an ordinary leaver in the report.
 *
 * DEGRADES RATHER THAN REFUSES. `bindDN` is a config field and needs no
 * decryption; `writeBindDN` arrives as a secret. If the secret bag will not
 * decrypt we keep what configJson alone can tell us and say so, because a dry
 * run that protects one bind beats a dry run that protects neither. The LIVE
 * path still refuses SECRETS_UNREADABLE by name — that judgement is unchanged
 * and is made below, where a real write is at stake.
 */
function selfAccountIdsFromConnection(conn: {
    configJson: unknown;
    secretEncrypted: string | null;
}): string[] {
    let merged: Record<string, unknown>;
    try {
        merged = mergeConnection(conn);
    } catch (err) {
        merged = (conn.configJson ?? {}) as Record<string, unknown>;
        logger.warn('dry-run self-account ids fell back to config: secrets did not decrypt', {
            component: 'identity-writer-factory',
            error: err instanceof Error ? err.message : String(err),
        });
    }
    return [merged.writeBindDN, merged.bindDN]
        .map((v) => String(v ?? '').trim())
        .filter((v) => v !== '');
}

export interface ResolveWriterInput {
    readonly ctx: RequestContext;
    readonly provider: string;
    /** The rung this pass is running at. Only AUTOMATIC/PROPOSE get a live writer. */
    readonly mode: string;
}

/**
 * Resolve the writer for one (tenant, provider), or say precisely why not.
 *
 * Refusals are ordered cheapest-first: an unsupported provider costs nothing to
 * reject, and the connection read only happens for a provider that could have
 * had a writer.
 */
export async function resolveDirectoryWriter(
    input: ResolveWriterInput,
): Promise<WriterResolution> {
    const { ctx, provider, mode } = input;

    if (!isWritableIdentityProvider(provider)) {
        return {
            kind: 'none',
            refusal: 'UNSUPPORTED_PROVIDER',
            detail: `${provider} has no directory writer. Only ${WRITABLE_IDENTITY_PROVIDERS.join(' and ')} can be written to.`,
        };
    }

    const conns = await runInTenantContext(ctx, (db) =>
        db.integrationConnection.findMany({
            where: { tenantId: ctx.tenantId, provider, isEnabled: true },
            select: { id: true, configJson: true, secretEncrypted: true },
            orderBy: { id: 'asc' },
            // Three is enough to tell "one" from "more than one" without
            // reading a directory's worth of connections to say so.
            take: 3,
        }),
    );

    if (conns.length === 0) {
        return {
            kind: 'none',
            refusal: 'NO_CONNECTION',
            detail: `No enabled ${provider} connection for this tenant.`,
        };
    }
    if (conns.length > 1) {
        return {
            kind: 'none',
            refusal: 'AMBIGUOUS_CONNECTION',
            detail:
                `${conns.length} enabled ${provider} connections. Each directory account now names the ` +
                'connection that observed it, so the accounts are no longer ambiguous — but a writer is ' +
                'still resolved per (tenant, provider) rather than per account, so one of the two would ' +
                'have to be chosen for all of them. Choosing either would address a disable at a ' +
                'directory the account may not live in, so this refuses instead. Leave one connection ' +
                'enabled for this provider.',
        };
    }

    // THE DRY_RUN ARM MOVED BELOW THE TWO CONNECTION REFUSALS IN PHASE 2, and
    // that reverses what phase 1 argued. The earlier reasoning was sound for its
    // own release: a snapshot reader answering from stored rows could still
    // observe usefully with zero or several connections, so refusing would have
    // stopped a tenant observing during seven days it is REQUIRED to observe.
    //
    // Phase 2 makes that false. `connectionId` is NOT NULL and the account key is
    // (tenantId, connectionId, externalUserId), so the reader needs ONE connection
    // to scope by. Without it the two cases degrade rather than refuse:
    //   · zero connections — no account rows exist either, since a row is created
    //     by a connection's sync. Every candidate would come back "no observed
    //     directory record", which is a FAILED per account instead of one named
    //     NO_CONNECTION for the run.
    //   · two connections — the same externalUserId can legitimately exist under
    //     both, and readState would return whichever Prisma ordered first. A dry
    //     run reporting a decision about the wrong directory is worse than one
    //     that refuses.
    // Since #2066 the refusal is RECORDED, so a refused pass is visible in the
    // seven-day artefact rather than being silence.
    //
    // SECRETS_UNREADABLE stays BELOW, deliberately: `selfAccountIdsFromConnection`
    // degrades to what configJson alone can say, so an undecryptable secret still
    // yields a dry run with one bind protected instead of none. That half of the
    // phase 1 argument survives intact.
    if (mode === 'DRY_RUN') {
        const selfIds = selfAccountIdsFromConnection(conns[0]);
        return {
            kind: 'snapshot',
            writer: createSnapshotWriter(ctx, provider, conns[0].id, selfIds),
            close: NOOP_CLOSE,
        };
    }

    let connection: Record<string, unknown>;
    try {
        connection = mergeConnection(conns[0]);
    } catch (err) {
        return {
            kind: 'none',
            refusal: 'SECRETS_UNREADABLE',
            detail: `The ${provider} connection's secrets could not be decrypted: ${err instanceof Error ? err.message : String(err)}`,
        };
    }

    try {
        if (provider === 'entra-id') {
            const writer = createEntraIdWriter(connection);
            return { kind: 'live', writer, close: NOOP_CLOSE };
        }
        const writer = createActiveDirectoryWriter({ connection });
        return {
            kind: 'live',
            writer,
            // The one arm with a real obligation. `close()` is documented never
            // to throw, and the caller's finally is unconditional, so a leaked
            // bind needs both of those to fail at once.
            close: () => writer.close(),
        };
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        // The Entra constructor refuses a connection that has not opted in to
        // writes. Named separately because it is a deliberate operator state,
        // not a misconfiguration.
        const refusal: WriterRefusal = /not enabled for directory writes/i.test(detail)
            ? 'WRITES_NOT_ENABLED'
            : 'WRITER_REFUSED';
        logger.warn('directory writer could not be constructed', {
            component: 'identity-writer-factory',
            tenantId: ctx.tenantId,
            provider,
            refusal,
        });
        return { kind: 'none', refusal, detail };
    }
}
