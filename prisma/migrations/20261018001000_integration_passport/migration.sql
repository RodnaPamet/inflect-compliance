-- The INTEGRATION PASSPORT (#3672, agentic IAM step 2d).
--
-- Three changes, each additive and each safe mid-rolling-deploy:
--
--   1. `IntegrationConnection.ownerUserId` — passport field P11, the person
--      accountable for what an external agent connection lets an agent do. The
--      specification lists it as a gap: no column named one. Nullable, no
--      backfill (every connection starts unowned, and the weekly sweep raises
--      CONNECTION_OWNER_MISSING for it), and unread by old containers.
--      `ON DELETE SET NULL`: a deleted owner reads as NO owner, which is the
--      fail-closed direction — RESTRICT would block a user's erasure and
--      CASCADE would delete the connection.
--   2. `McpToolManifestPin.declaresWrite` — the write declaration of the
--      definition a person accepted, closing the specification's second gap
--      (the pin stored `annotationsHash`, not the `readOnlyHint` it covers).
--      Nullable: NULL is "not recorded" (baseline, built-in, or approved before
--      this column), which is not "read-only".
--   3. The `AgenticEvidenceArtefact.kind` CHECK widened to the passport kind.
--      Only widened, never narrowed: an old container never writes the new kind,
--      and its withdrawal sweep skips a kind it does not know.
--
-- COORDINATION. The CHECK is DROP + ADD listing EVERY kind
-- `AGENTIC_ARTEFACT_KINDS` holds on this branch. Another open branch (#3687,
-- migration 20261017235500) widens the same CHECK for its own kind; whichever of
-- the two merges SECOND must re-list both kinds in its migration, or its
-- ADD CONSTRAINT fails against rows of the kind it left out.

-- 1. P11 — the accountable owner.
ALTER TABLE "IntegrationConnection" ADD COLUMN "ownerUserId" TEXT;

CREATE INDEX "IntegrationConnection_tenantId_ownerUserId_idx"
    ON "IntegrationConnection"("tenantId", "ownerUserId");

ALTER TABLE "IntegrationConnection"
    ADD CONSTRAINT "IntegrationConnection_ownerUserId_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 2. The write declaration of an accepted external tool definition.
ALTER TABLE "McpToolManifestPin" ADD COLUMN "declaresWrite" BOOLEAN;

-- 3. The passport artefact kind. The list is EVERY kind, not this step's
-- addition: 20261017235500 (#3687) re-created the same CHECK with
-- AGENT_HARNESS_SCANS, and a CHECK naming only the kinds one branch knew would
-- refuse the harness rows already written.
ALTER TABLE "AgenticEvidenceArtefact" DROP CONSTRAINT IF EXISTS "AgenticEvidenceArtefact_kind_known";
ALTER TABLE "AgenticEvidenceArtefact"
    ADD CONSTRAINT "AgenticEvidenceArtefact_kind_known"
    CHECK ("kind" IN (
        'AGENT_ACTION_RECEIPTS',
        'AI_DECISION_RECORDS',
        'AGENT_HARNESS_SCANS',
        'INTEGRATION_PASSPORTS'
    ));
