-- Control index fit — one index dropped, three added.
--
-- DROP "Control_tenantId_idx"
--   A strict PREFIX of seven composites on the same table
--   ([tenantId,code], [tenantId,createdAt], [tenantId,status],
--   [tenantId,applicability], [tenantId,deletedAt], [tenantId,ownerUserId],
--   [tenantId,category]). Any of those serves a tenantId-only lookup, so it
--   bought nothing and cost a write on every insert and update of a
--   32-column table already carrying 12 index structures.
--
-- ADD trigram indexes for the ?q= search
--   ControlRepository:150-157 runs THREE unanchored ILIKE `contains`
--   predicates, OR'd, on every keystroke over up to 500 rows:
--
--       name ILIKE '%q%' OR code ILIKE '%q%' OR objective ILIKE '%q%'
--
--   A leading wildcard defeats a btree entirely, so each keystroke was a
--   sequential scan. pg_trgm's GIN index indexes 3-grams, which makes
--   `%foo%` an index lookup.
--
--   ONE INDEX PER COLUMN, not one over a concatenation. Postgres only uses
--   an expression index when the query matches that same expression — an
--   index on `name || code || objective` would be ignored by the OR above
--   and would have been dead on arrival, which is the exact failure this
--   migration removes elsewhere. Three per-column indexes are what the
--   query as written can actually use; the planner ORs the bitmap scans.
--
--   CONCURRENTLY is deliberately NOT used: Prisma runs migrations in a
--   transaction, and CREATE INDEX CONCURRENTLY cannot run inside one.

DROP INDEX IF EXISTS "Control_tenantId_idx";

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "Control_name_trgm_idx"
    ON "Control" USING GIN ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Control_code_trgm_idx"
    ON "Control" USING GIN ("code" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Control_objective_trgm_idx"
    ON "Control" USING GIN ("objective" gin_trgm_ops);
