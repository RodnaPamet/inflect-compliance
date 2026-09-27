-- #2861 — every MCP connection that existed BEFORE the rung gated anything keeps
-- the reach it already had.
--
-- THIS SUPERSEDES THE REASONING IN 20260927150000. That migration said "NO
-- BACKFILL, AND THAT IS NOT AN OMISSION", because NULL coerces to DISABLED and
-- DISABLED was what every existing connection should read as. That was true while
-- the rung governed NOTHING. The owner's decision on 2026-09-27 is that the rung
-- governs whether an agent may call a connection AT ALL — reads included, not just
-- writes — which turns the same NULL into an outage: the connection that produced
-- the first production proving run reads DISABLED, so the gate would take it dark
-- the moment it ships. The earlier comment is left in place rather than edited,
-- because that migration is already applied and its checksum is load-bearing.
--
-- WHY THIS GRANTS NOTHING. `DRY_RUN` is where these connections already sat in
-- every sense that matters: their tools were approved against a pinned manifest,
-- granted per agent, cleared for `EXTERNAL_EGRESS`, and scanned on the way out.
-- The rung is a NEW term in that conjunction, so setting it to the value that
-- preserves the existing conjunction is the identity operation on authority. The
-- alternative — leaving them DISABLED and asking an operator to widen each one —
-- is stricter only in the sense that a service interruption is stricter.
--
-- AND WHY IT IS DRY_RUN AND NOT HIGHER. `DRY_RUN` permits reads and sends no
-- write. Every one of these connections is read-only today: the far end that can
-- be written to is a lab fixture nobody has stood up, and the live Entra server
-- advertises three tools that all declare `readOnlyHint: true`. So `DRY_RUN` is
-- both the smallest rung that avoids the outage and an accurate description of
-- what these connections are actually doing.
--
-- SCOPED TO WHAT EXISTS NOW, deliberately. A connection created AFTER this
-- migration gets NULL, which coerces to DISABLED — the right default for
-- something nobody has approved anything on yet. The line this draws is "existed
-- before the gate", which is exactly the population that would otherwise break.
--
-- `externalWriteModeSince` is stamped so the ladder has a window to measure from.
-- Without it the dwell would read a null start; DISABLED is exempt from that as of
-- the same decision, but DRY_RUN is not, and a connection cannot widen off a rung
-- whose start was never recorded.
--
-- UpdateTable
UPDATE "IntegrationConnection"
SET "externalWriteMode" = 'DRY_RUN',
    "externalWriteModeSince" = NOW()
WHERE "provider" = 'mcp-server'
  AND "externalWriteMode" IS NULL;
