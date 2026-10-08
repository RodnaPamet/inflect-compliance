-- Step 0c — STOP DISCARDING THE NAME PARTS HR ALREADY SENDS.
--
-- BambooHR's roster request already asks for `firstName` and `lastName`.
-- OrangeHRM's list rows already carry `firstName`, `middleName` and `lastName`.
-- Workday's report template already carries `legalName` and `preferredName`.
-- Every provider concatenated them into `fullName` and dropped the parts.
--
-- Keeping them makes name matching a comparison of PARTS rather than of one
-- flattened string. "Smith, John" and "John Smith" are the same person and
-- different strings, and a reconciler given only `fullName` has to guess which
-- half is the family name from word order that varies by locale and by HRIS —
-- the guess these columns exist to remove.
--
-- ─── `employeeNumber` HAS NO FALLBACK, AND THAT IS THE POINT ─────────
--
-- NULL whenever the HRIS has none. It never falls back to `workEmail`.
--
-- A real employee number is the strongest deterministic match signal in this
-- subsystem: it is one of the few things permitted to produce a LINKED without
-- a human confirming it. `externalId` keeps its email fallback because it is
-- provenance and nothing matches on it. If this column fell back the same way,
-- a work email would silently acquire the authority of a payroll identifier,
-- and a legacy table full of emails would begin auto-linking at LINK strength
-- on a signal that is only an address.
--
-- ─── ADDITIVE, NULLABLE, NOT BACKFILLED ─────────────────────────────
--
-- No backfill, in either direction. Splitting `fullName` into parts would
-- invent the very guess the columns remove, and `employeeNumber` cannot be
-- derived from anything already stored — that is what makes it a signal.
-- The next HRIS sync fills whatever its provider actually sends.
--
-- `fullName` is UNTOUCHED by this migration and by the code in the same diff.
-- The joiner pass builds mailbox addresses and display names from it, so a
-- change to its derivation changes what gets created in a customer's
-- directory.
ALTER TABLE "Employee"
    ADD COLUMN "givenName"      TEXT,
    ADD COLUMN "familyName"     TEXT,
    ADD COLUMN "middleName"     TEXT,
    ADD COLUMN "preferredName"  TEXT,
    ADD COLUMN "legalName"      TEXT,
    ADD COLUMN "employeeNumber" TEXT;
