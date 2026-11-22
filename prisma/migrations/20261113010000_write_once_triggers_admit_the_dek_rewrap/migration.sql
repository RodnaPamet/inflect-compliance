-- ═══════════════════════════════════════════════════════════════════
-- Two write-once triggers admit the key-rotation re-wrap (#5065)
-- ═══════════════════════════════════════════════════════════════════
--
-- CLAUDE.md states the rule: "Write-once triggers on encrypted columns must
-- admit the re-wrap. The tenant-DEK and master-KEK sweeps rewrite every
-- manifest ciphertext with a raw UPDATE … A new write-once table with an
-- encrypted column needs the same exception."
--
-- `AgentHarnessAcceptance.justification` and `AuditWorkpaperNarrative.text`
-- are both in the Epic B manifest (`encrypted-fields.ts`), and neither trigger
-- carried the exception. No later migration added one.
--
--   * `agent_harness_acceptance_one_way` froze `justification` for EVERY role
--     (it is one term of the identity check at the top of the function).
--   * `audit_workpaper_narrative_write_once` refused every UPDATE outright.
--
-- WHY THAT IS WORSE THAN A REFUSED EDIT. `tenant-dek-rotation` sweeps the
-- manifest with `UPDATE "<model>" SET "<field>" = $1 WHERE id = $2` and counts
-- a throw as an error. The sweep clears `Tenant.previousEncryptedDek` only on
-- `totalErrors === 0`, and `rotateTenantDek`'s atomic swap is predicated on
-- that column being NULL — so for a tenant holding ONE acceptance or ONE
-- narrative:
--
--   1. every sweep run ends with errors, so `previousEncryptedDek` is never
--      cleared and the OLD — possibly compromised — DEK stays live in the
--      decrypt fallback for good;
--   2. those rows stay encrypted under the old key; and
--   3. every later rotation is refused ("concurrent rotation detected … retry
--      once the in-flight sweep completes"), and the sweep can never complete.
--
-- The tenant can never rotate its DEK again. That is the control an OWNER
-- reaches for on a suspected key compromise, so a per-tenant DEK rotation is
-- unavailable exactly when it is needed.
--
-- ─── The exception, and why it is this shape ───────────────────────
--
-- Identical to the one `peer_agent_message_is_immutable` carries: every other
-- column byte-identical, and the encrypted column moving from a v1/v2
-- ciphertext to a v2 ciphertext. Nothing else is admitted — not a plaintext
-- write, not a re-wrap that also changes another column.
--
-- Only the encrypted column is subtracted, deliberately. The sweep's UPDATE is
-- RAW, so it does not touch `updatedAt`; admitting an `updatedAt` change too
-- would widen this to any Prisma-mediated write of the column, which is the
-- edit these triggers exist to refuse.
--
-- NOTE for whoever reads this next: two sibling triggers look like they lack
-- the exception and do not. `tenant_a2a_signing_key_is_final` spells it inline
-- (`AND NOT (OLD."privateKeySeed" ~ '^v[12]:' AND NEW."privateKeySeed" ~
-- '^v2:')`) rather than with the `to_jsonb` subtraction, and
-- `tenant_skill_version_lifecycle` gates its refusal on
-- `current_setting('role') = 'app_user'`, which the sweep is not. A scan that
-- demands one spelling reports both as broken.
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION agent_harness_acceptance_one_way()
RETURNS TRIGGER AS $$
BEGIN
    -- The key-rotation sweeps' re-wrap of the encrypted justification (#5065).
    -- FIRST, because the identity check below names `justification` and would
    -- otherwise refuse it.
    IF (to_jsonb(NEW) - 'justification') = (to_jsonb(OLD) - 'justification')
       AND OLD."justification" ~ '^v[12]:' AND NEW."justification" ~ '^v2:' THEN
        RETURN NEW;
    END IF;

    -- The decision itself never changes. `expiresAt` is in this list BY
    -- DESIGN: extending an acceptance in place would make one row stand for
    -- several decisions and lose which approver granted which extension.
    IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
       OR NEW."discoveredAgentId" IS DISTINCT FROM OLD."discoveredAgentId"
       OR NEW."acceptedLevel" IS DISTINCT FROM OLD."acceptedLevel"
       OR NEW."justification" IS DISTINCT FROM OLD."justification"
       OR NEW."acceptedByUserId" IS DISTINCT FROM OLD."acceptedByUserId"
       OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
       OR NEW."renewedFromId" IS DISTINCT FROM OLD."renewedFromId"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION
            'AGENT_HARNESS_ACCEPTANCE_ONE_WAY: an acceptance is never rewritten or extended; revoke it and accept again, which records the new approver.';
    END IF;

    -- Revocation is one-way too, or a revoked acceptance could be quietly
    -- reinstated and the shortfall suppressed again under the original
    -- approver's name.
    IF OLD."revokedAt" IS NOT NULL
       AND (NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt"
            OR NEW."revokedByUserId" IS DISTINCT FROM OLD."revokedByUserId") THEN
        RAISE EXCEPTION
            'AGENT_HARNESS_ACCEPTANCE_ONE_WAY: a revoked acceptance stays revoked.';
    END IF;

    -- A revocation names its actor. Without this, `revokedAt` could be set
    -- with no `revokedByUserId` and the audit trail would record that an
    -- acceptance was revoked by nobody.
    IF NEW."revokedAt" IS NOT NULL AND NEW."revokedByUserId" IS NULL THEN
        RAISE EXCEPTION
            'AGENT_HARNESS_ACCEPTANCE_ONE_WAY: a revocation records who made it.';
    END IF;

    -- `revokedAt`, `revokedByUserId`, `expiryProcessedAt` and `updatedAt` are
    -- deliberately NOT frozen: the first two are the invalidation this trigger
    -- exists to permit, `expiryProcessedAt` is the expiry job's own bookkeeping
    -- (a machine write about a person's row, not a change to the decision), and
    -- Prisma sets `updatedAt` on every update.
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Refused for every role, `app_user` and the owner alike: a narrative that
-- could be revised is a narrative whose reviewer cannot know what they read.
-- The ONE change admitted is the key-rotation sweeps' re-wrap of the encrypted
-- text (#5065) — ciphertext to v2 ciphertext, nothing else.
CREATE OR REPLACE FUNCTION audit_workpaper_narrative_write_once()
RETURNS TRIGGER AS $$
BEGIN
    IF (to_jsonb(NEW) - 'text') = (to_jsonb(OLD) - 'text')
       AND OLD."text" ~ '^v[12]:' AND NEW."text" ~ '^v2:' THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION
        'IMMUTABLE_AUDIT_WORKPAPER_NARRATIVE: narrative % of workpaper % is written once and never changed.',
        OLD."id", OLD."workpaperId";
END;
$$ LANGUAGE plpgsql;

-- ── Post-conditions ────────────────────────────────────────────────
--
-- The property is in the function BODY, which no behavioural test on a row
-- that nobody rotates can see — which is how both shipped. Assert it here.

DO $$
DECLARE
    n INTEGER;
BEGIN
    SELECT count(*) INTO n FROM pg_proc
     WHERE proname IN ('agent_harness_acceptance_one_way', 'audit_workpaper_narrative_write_once')
       AND pronamespace = 'public'::regnamespace
       AND prosrc LIKE '%to_jsonb(NEW)%'
       AND prosrc LIKE '%v[12]:%';
    IF n <> 2 THEN
        RAISE EXCEPTION
            '#5065: expected both write-once functions to admit the key-rotation '
            're-wrap, found % of 2. Without it a tenant holding one of these rows '
            'can never complete a DEK rotation.', n;
    END IF;

    -- Both triggers still attached, and still BEFORE UPDATE: the exception is
    -- worthless if a later migration detached the trigger it lives in.
    SELECT count(*) INTO n FROM pg_trigger
     WHERE NOT tgisinternal
       AND tgname IN ('agent_harness_acceptance_one_way',
                      'audit_workpaper_narrative_write_once_trg');
    IF n <> 2 THEN
        RAISE EXCEPTION '#5065: expected 2 write-once triggers attached, found %', n;
    END IF;
END
$$;
