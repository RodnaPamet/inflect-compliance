-- #5764 item 6 — the Training list reads assignments a page at a time, newest
-- first: equality on tenantId, ordered by (createdAt DESC, id DESC), with a
-- keyset cursor on the same two columns. No existing index leads with
-- (tenantId, createdAt), so without this every page sorts the tenant's whole
-- assignment set. Additive; changes no row.

-- CreateIndex
CREATE INDEX "TrainingAssignment_tenantId_createdAt_idx" ON "TrainingAssignment"("tenantId", "createdAt");
