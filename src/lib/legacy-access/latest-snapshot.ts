/**
 * Which snapshot is a legacy connection's "latest", and which reconciliation run
 * is a snapshot's "latest": one definition of each.
 *
 * Two readers ask, and they must agree. Creating a legacy campaign builds from the
 * latest snapshot and the latest run over it (`usecases/access-review-legacy`).
 * The connection page shows that same snapshot's standing and sends its id to
 * "Match to people" (`usecases/legacy-access-standing`). If the page chose a
 * different snapshot, an administrator could match one snapshot and then be
 * refused `NOT_RECONCILED` by a campaign that read another.
 *
 * `completedAt` DESC puts a NULL first in Postgres, so a snapshot that has not
 * finished (PENDING) is the latest one. Both readers then report it as not
 * complete, which is the truth about a read still in progress.
 *
 * No server imports, so a client component can hold it.
 *
 * @module lib/legacy-access/latest-snapshot
 */

/** `orderBy` for the latest `LegacyAccessSnapshot` of a connection. */
export const LATEST_SNAPSHOT_ORDER = { completedAt: 'desc' } as const;

/**
 * `orderBy` for the latest `LegacyAccountResolution` of a snapshot. Resolutions
 * are immutable and a second run adds rows rather than overwriting, so the
 * newest row names the run whose verdicts are the snapshot's current state.
 */
export const LATEST_RESOLUTION_ORDER = { createdAt: 'desc' } as const;
