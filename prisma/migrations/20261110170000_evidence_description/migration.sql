-- #5018 — an optional free-text description on Evidence: what the evidence shows
-- and why it supports its controls. Nullable with no default, so the ADD COLUMN
-- is a catalogue-only change (no table rewrite) and every existing row reads
-- NULL. Encrypted at rest by the Epic B manifest (Evidence: ['description']);
-- the column holds ciphertext.
ALTER TABLE "Evidence" ADD COLUMN "description" TEXT;
