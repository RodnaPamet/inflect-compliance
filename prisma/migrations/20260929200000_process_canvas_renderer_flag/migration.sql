-- #2960 — which renderer draws the process canvas, per tenant.
--
-- A MIGRATION FLAG WITH A SCHEDULED END. tldraw replaces xyflow one tenant at
-- a time rather than everywhere at once; Phase 4 (#2962) removes xyflow and
-- then this column.
--
-- A boolean rather than an enum, because of that end date: an enum models a
-- lasting choice between named renderers, and Postgres cannot drop an enum
-- value without recreating the type — which, mid rolling deploy, makes
-- still-running old containers fail with SQLSTATE 42704. That cost is worth
-- paying for a permanent domain and not for a switch we intend to delete.
--
-- DEFAULT FALSE so every existing tenant keeps the renderer it already has.
-- NOT NULL with a default rather than nullable: "nobody has chosen yet" and
-- "chose the old one" are the same thing here, and a third state would only
-- invite a caller to treat NULL as some other meaning later.
ALTER TABLE "TenantSecuritySettings"
  ADD COLUMN "processCanvasUsesTldraw" BOOLEAN NOT NULL DEFAULT false;
