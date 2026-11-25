-- ═══════════════════════════════════════════════════════════════════
-- DataSubjectRequest.userId: the register row survives the erasure,
-- unlinked (#5940, owner decision 2026-11-25).
-- ═══════════════════════════════════════════════════════════════════
--
-- The FK was ON DELETE RESTRICT and the column NOT NULL
-- (20260626130000_add_data_subject_request), so a person with any DSAR
-- register row — the erasure request being fulfilled among them — could not
-- be erased: `planErasure` listed the row as a RESTRICT blocker, and the only
-- way past it was to delete the register's own record of the request.
--
-- Now the column is nullable and the FK is `ON DELETE SET NULL ("userId")`.
-- When `eraseUser` hard-deletes the User row, every request of theirs keeps
-- its type, status, dates and rejection reason, as evidence that the request
-- was handled, and stops pointing at the person. `eraseUser` nulls the two
-- columns that could still identify them (`fulfilmentNotes`, `exportUrl`) in
-- the same transaction, before the delete.
--
-- COLUMN-SCOPED, as the retention rule asks of a retained record's FK. On a
-- single-column FK it is the same action as a plain SET NULL; the column list
-- states the intent and cannot widen if the FK ever gains a column.
--
-- NO TRIGGER ON THE TABLE. None freezes the row, so nothing has to admit the
-- FK action's write (contrast #5848). Checked on a database built from the
-- migrations: `SELECT tgname FROM pg_trigger WHERE tgrelid =
-- '"DataSubjectRequest"'::regclass AND NOT tgisinternal` returns no rows.
--
-- RLS. The `tenant_isolation` policy reads the subject's ACTIVE membership,
-- so a row whose `userId` is NULL is visible to no tenant: an erased request
-- is evidence in the database only, readable by a role that is not
-- `app_user` (owner decision 2026-11-25, second round). The policy is
-- unchanged.
--
-- ROLLING DEPLOY. Both statements only loosen a constraint. A container on
-- the previous image never writes NULL and never deletes a User with a
-- register row (its `eraseUser` refuses on the RESTRICT blocker before it
-- writes), so it runs unchanged against this schema. Its Prisma client types
-- the column as required, and would fail reading a row whose `userId` is
-- NULL; no such row exists until an erasure runs on the new image, and the
-- register only reads rows whose subject is an ACTIVE member.
--
-- ROLLBACK. A forward fix only. While no request has been unlinked:
--   ALTER TABLE "DataSubjectRequest" DROP CONSTRAINT "DataSubjectRequest_userId_fkey";
--   ALTER TABLE "DataSubjectRequest" ADD CONSTRAINT "DataSubjectRequest_userId_fkey"
--       FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
--   ALTER TABLE "DataSubjectRequest" ALTER COLUMN "userId" SET NOT NULL;
-- Once one has, NOT NULL cannot return without deleting evidence.

ALTER TABLE "DataSubjectRequest" ALTER COLUMN "userId" DROP NOT NULL;

ALTER TABLE "DataSubjectRequest" DROP CONSTRAINT "DataSubjectRequest_userId_fkey";
ALTER TABLE "DataSubjectRequest" ADD CONSTRAINT "DataSubjectRequest_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ("userId") ON UPDATE CASCADE;

-- Post-condition: column-scoped SET NULL. `confdeltype` alone cannot tell it
-- from a plain SET NULL; the column list can.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'DataSubjectRequest_userId_fkey'
           AND confdeltype = 'n'
           AND confdelsetcols IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'DataSubjectRequest_userId_fkey is not ON DELETE SET NULL ("userId")';
    END IF;
END $$;
