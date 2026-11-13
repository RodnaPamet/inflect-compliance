-- #5288, deploy 1 of 2: declare GCP europe-west1 (Belgium), where production
-- runs. No row is written with it here: a container whose Prisma client
-- predates the value fails every Tenant read that meets it, so the default
-- change and the backfill ship in the next deploy, once every running client
-- knows the value.
ALTER TYPE "TenantRegion" ADD VALUE IF NOT EXISTS 'EUROPE_WEST1';
