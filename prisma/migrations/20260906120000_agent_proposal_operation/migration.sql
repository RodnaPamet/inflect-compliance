-- AgentProposal: WHAT the proposal would do, and to WHICH record.
--
-- Until now every queued proposal was a create, so the review UI could show the
-- payload and be telling the truth. An UPDATE proposal's meaning is the
-- difference between the payload and the row it targets; without these two
-- columns the reviewer is handed an opaque blob and asked to consent to a delta
-- nobody rendered. See docs/implementation-notes/2026-09-06-proposal-diff-review.md.
--
-- ROLLING-DEPLOY SAFETY. Three properties, each deliberate:
--   * a NEW enum type, never an ALTER TYPE on an existing one — an old container
--     that has never heard of AgentProposalOperation reads and writes
--     AgentProposal exactly as before, because it names no such column;
--   * ADD COLUMN ... NOT NULL DEFAULT is metadata-only on PG 11+, so no table
--     rewrite and no long lock on a populated table;
--   * the CHECK is satisfied by every existing row by construction — they are
--     all operation='CREATE', for which targetEntityId may be NULL — so it
--     validates without a scan finding anything to reject.
CREATE TYPE "AgentProposalOperation" AS ENUM ('CREATE', 'UPDATE');

ALTER TABLE "AgentProposal"
    ADD COLUMN "operation" "AgentProposalOperation" NOT NULL DEFAULT 'CREATE';

ALTER TABLE "AgentProposal"
    ADD COLUMN "targetEntityId" TEXT;

-- An UPDATE proposal that names no target cannot be diffed, so it must not be
-- storable. Written at the database rather than only at the usecase for the
-- same reason the last-OWNER guard is a trigger: the usecase is the door people
-- use, and this is the wall behind it.
ALTER TABLE "AgentProposal"
    ADD CONSTRAINT "AgentProposal_update_requires_target"
    CHECK ("operation" <> 'UPDATE' OR "targetEntityId" IS NOT NULL);
