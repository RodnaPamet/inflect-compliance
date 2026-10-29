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
 * "Latest" is the newest read STARTED (`pulledAt`), not the newest finished.
 * A read still in progress is therefore the latest one, and both readers report
 * it as not complete, which is the truth about it. A read that crashed stays
 * the latest only until somebody starts another, which then takes over whether
 * it completes or refuses. Ordering by `completedAt` DESC instead sorted an
 * unfinished row's NULL first in Postgres, so one crashed pull blocked every
 * campaign for the application until the 30-day unconsumed-snapshot purge
 * removed it, and reading again changed nothing (owner decision, 2026-10-29).
 * `id` breaks a tie, so two readers can never disagree on equal timestamps.
 *
 * Only a type is imported, so a client component can still hold it.
 *
 * @module lib/legacy-access/latest-snapshot
 */

import type { Prisma } from '@prisma/client';

/** `orderBy` for the latest `LegacyAccessSnapshot` of a connection. */
export const LATEST_SNAPSHOT_ORDER: Prisma.LegacyAccessSnapshotOrderByWithRelationInput[] = [
    { pulledAt: 'desc' },
    { id: 'desc' },
];

/**
 * `orderBy` for the latest `LegacyAccountResolution` of a snapshot. Resolutions
 * are immutable and a second run adds rows rather than overwriting, so the
 * newest row names the run whose verdicts are the snapshot's current state.
 */
export const LATEST_RESOLUTION_ORDER = { createdAt: 'desc' } as const;
