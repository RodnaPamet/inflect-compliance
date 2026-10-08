-- Step 0b — KEEP THE LOGIN NAMES THE DIRECTORY ALREADY TOLD US.
--
-- Active Directory's enumeration has requested `sAMAccountName` and
-- `userPrincipalName` since it shipped, and computed both on every account, to
-- derive `email` and then throw them away. Entra's `$select` already carried
-- `userPrincipalName` and did the same. So this is not new collection — it is
-- the end of a discard.
--
-- It matters because almost no on-premises application keys its users by email
-- address. An AD-joined one stores `DOMAIN\sAMAccountName` or a bare
-- `sAMAccountName`; an Entra-federated one stores the UPN. The directory bridge
-- is the only signal that produces a LINK without a human confirming it, and it
-- has nothing to compare against unless these are stored.
--
-- ─── ADDITIVE, NULLABLE, NOT BACKFILLED ─────────────────────────────
--
-- All three nullable with no default and no backfill, which is what makes this
-- survive a rolling deploy in either direction: a container on the previous
-- image upserts a ConnectedIdentityAccount without naming these columns and
-- Postgres supplies NULL, so both images write valid rows for as long as both
-- are running. Nothing reads the columns yet.
--
-- A backfill would have to DERIVE the values from `email`, and a
-- `samAccountName` reconstructed from an email local-part is precisely the
-- plausible-but-wrong key that links the wrong person — the failure the
-- deterministic-signal invariant exists to prevent. The next sync fills them
-- with what the directory actually says.
ALTER TABLE "ConnectedIdentityAccount"
    ADD COLUMN "samAccountName"    TEXT,
    ADD COLUMN "userPrincipalName" TEXT,
    ADD COLUMN "mailNickname"      TEXT;
