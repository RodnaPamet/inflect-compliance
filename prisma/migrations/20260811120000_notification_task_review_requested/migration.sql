-- B2-4 — the reviewer sign-off gate (TP-2) creates work for exactly one
-- person and never told them. Add the bell type the IN_REVIEW transition
-- routes to that reviewer.
--
-- `ADD VALUE IF NOT EXISTS` is idempotent, and PostgreSQL 12+ permits
-- ADD VALUE inside a transaction block as long as the new value is not
-- USED in the same transaction — this migration only declares it.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TASK_REVIEW_REQUESTED';
