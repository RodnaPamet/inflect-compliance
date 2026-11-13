-- #5288, deploy 2 of 2: tenants live where production runs.
--
-- Production is one GCP VM in europe-west1 (Belgium), but every tenant was
-- recorded as US_EAST_1 ("United States (East)") because that was the column
-- default and the only provisioned region: a false residency statement on the
-- privacy page. Deploy 1 (20261113090000) declared EUROPE_WEST1 and shipped to
-- every running container first, so no Prisma client still running meets a
-- value it was not generated with when this writes it.
--
-- US_EAST_1 is the only value a tenant can hold today: the other regions were
-- never provisioned and assertProvisionedRegion refused them at creation. It
-- was assigned by default, never chosen, so every such row moves.

ALTER TABLE "Tenant" ALTER COLUMN "region" SET DEFAULT 'EUROPE_WEST1';

UPDATE "Tenant" SET "region" = 'EUROPE_WEST1' WHERE "region" = 'US_EAST_1';
