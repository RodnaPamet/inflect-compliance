-- ═══════════════════════════════════════════════════════════════════
-- AuditLog immutability — permit EXACTLY ONE update: DSAR pseudonymization
-- ═══════════════════════════════════════════════════════════════════
--
-- `20260324010000_audit_log_immutable_trigger` made AuditLog append-only by
-- raising on every UPDATE and DELETE unconditionally. That is still the right
-- default and nothing below relaxes it for ordinary writes.
--
-- GDPR erasure needs one exception. The audit trail must survive a subject's
-- erasure — the ACTION is retained, the identifying `userId` is removed — so
-- erasure PSEUDONYMIZES (`userId = NULL`) rather than deleting. docs/dsar.md,
-- "Audit-log pseudonymization (not deletion)". Under the original trigger that
-- write is impossible, so Stage 3 cannot be implemented without this change.
--
-- ─── WHAT IS PERMITTED, EXACTLY ────────────────────────────────────
--
-- An UPDATE is allowed only when ALL of these hold:
--
--   1. `OLD."userId" IS NOT NULL`  — the row currently identifies someone.
--   2. `NEW."userId" IS NULL`      — it stops identifying them.
--   3. Every other column is byte-identical.
--
-- Condition 3 is expressed as `to_jsonb(NEW) - 'userId' = to_jsonb(OLD) -
-- 'userId'` rather than as a list of column comparisons, DELIBERATELY. An
-- enumerated list is a list somebody must remember to extend: add a column to
-- AuditLog and an un-extended list silently permits that column to change
-- inside a "pseudonymization". The jsonb form covers every column this table
-- has or will have, including `entryHash` and `previousHash` — the chain whose
-- rewriting the DSAR oracle's C4 case exists to catch.
--
-- DELETE remains unconditionally forbidden. There is no permitted DELETE.
--
-- ─── WHAT THIS TRIGGER CANNOT ENFORCE, AND MUST NOT BE READ AS ─────
--
-- It grades ONE ROW at a time against a SHAPE. It cannot know whose erasure is
-- running, so it cannot tell the subject's rows from anybody else's: a
-- statement that nulls `userId` on every row in the table satisfies every
-- condition above, row by row. That is the DSAR oracle's C5 case and it is an
-- APPLICATION-layer obligation (the `where` clause), not a database one. Do
-- not let this migration's existence read as "the database prevents
-- over-anonymization". It does not.
--
-- ─── PRIVILEGES ARE DELIBERATELY UNTOUCHED ─────────────────────────
--
-- The original migration did `REVOKE UPDATE, DELETE ON "AuditLog" FROM
-- app_user`, and this migration does NOT grant it back. Tenant-path code runs
-- as `app_user` (`SET LOCAL ROLE app_user`, src/lib/db-context.ts) and remains
-- unable to update an audit row AT ALL, permitted shape or not.
--
-- So there are two independent gates and only one is being loosened:
--
--   privilege — WHO may attempt an UPDATE  (unchanged: not app_user)
--   trigger   — WHICH UPDATE is acceptable (narrowed: pseudonymization only)
--
-- Stage 3's erasure must therefore run via `runInGlobalContext`
-- (src/lib/db-context.ts), which bypasses RLS and never drops to `app_user`.
-- Granting UPDATE back to `app_user` would widen this to every tenant request
-- in the product and must not be how Stage 3 is made to work.
--
-- IDEMPOTENT — safe to re-run.
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION audit_log_immutable_guard()
RETURNS TRIGGER AS $$
BEGIN
    -- The one permitted write. DELETE never reaches here as permitted
    -- because TG_OP is checked implicitly: on DELETE, NEW is NULL and
    -- `NEW."userId" IS NULL` would be true, so the TG_OP test is explicit.
    IF TG_OP = 'UPDATE'
       AND OLD."userId" IS NOT NULL
       AND NEW."userId" IS NULL
       AND to_jsonb(NEW) - 'userId' = to_jsonb(OLD) - 'userId'
    THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION
        'IMMUTABLE_AUDIT_LOG: % operations on "AuditLog" are forbidden. '
        'Audit log entries are append-only and cannot be modified or removed. '
        'The ONLY permitted UPDATE is DSAR pseudonymization: "userId" from a '
        'value to NULL with every other column unchanged (see docs/dsar.md).',
        TG_OP
    USING ERRCODE = 'restrict_violation';
    RETURN NULL; -- never reached
END;
$$ LANGUAGE plpgsql;

-- Re-assert the attachment for idempotency. Unchanged from the original:
-- BEFORE UPDATE OR DELETE, FOR EACH ROW.
DROP TRIGGER IF EXISTS audit_log_immutable ON "AuditLog";

CREATE TRIGGER audit_log_immutable
    BEFORE UPDATE OR DELETE ON "AuditLog"
    FOR EACH ROW
    EXECUTE FUNCTION audit_log_immutable_guard();

SELECT 'AuditLog immutability narrowed — only DSAR pseudonymization permitted' AS result;
