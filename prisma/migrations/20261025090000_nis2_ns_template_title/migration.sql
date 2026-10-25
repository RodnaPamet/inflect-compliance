-- Retitle the NIS2-NS control template to its requirement's own title.
--
-- NIS2-NS maps to Art. 21(2)(e), "Security in network and information systems
-- acquisition, development and maintenance", and its tasks cover exactly that:
-- the development register, the secure lifecycle, CI security tests,
-- vulnerability handling and acquired software. Its old title, "Network and
-- information system security", named something broader than either. #4112
-- corrected the title in the fixture and in prisma/seed-catalog.ts.
--
-- The fixture change alone reaches only new databases. catalog-applier.ts
-- leaves an existing template's title alone on purpose ("re-titling a shipped
-- control is a decision, not a sync"), so a database that already holds the row
-- keeps the old title. This migration is that decision, made once.
--
-- Guarded on the old title, so it renames only the row the seeder wrote and
-- never one somebody has since edited by hand. On a fresh database the table is
-- empty when migrations run, so it matches nothing and the seeder writes the
-- new title itself. Installed controls carry their own name and are untouched.
UPDATE "ControlTemplate"
   SET "title" = 'Security in network and information systems acquisition, development and maintenance'
 WHERE "code" = 'NIS2-NS'
   AND "title" = 'Network and information system security';
