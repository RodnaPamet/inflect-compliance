-- #4931: a BIA review records who reviewed it, not only when.
--
-- "Mark reviewed" used to PUT a browser-supplied `reviewedAt` and nothing
-- else, so the register could say a BIA was reviewed but never by whom. The
-- review is now its own server act that stamps both, and this is the column
-- the reviewer goes in.
--
-- Additive and nullable: a row reviewed before this migration keeps its date
-- and reads "reviewer not recorded". Set-null on user delete, as the owner
-- column is, so removing a person never removes the record that a review
-- happened.
ALTER TABLE "BusinessImpactAnalysis" ADD COLUMN "reviewedByUserId" TEXT;

ALTER TABLE "BusinessImpactAnalysis"
    ADD CONSTRAINT "BusinessImpactAnalysis_reviewedByUserId_fkey"
    FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "BusinessImpactAnalysis_tenantId_reviewedByUserId_idx"
    ON "BusinessImpactAnalysis"("tenantId", "reviewedByUserId");
