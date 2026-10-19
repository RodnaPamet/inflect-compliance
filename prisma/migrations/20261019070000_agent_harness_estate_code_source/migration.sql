-- The harness report contract `inflect-agent-harness/2` (#3754) adds the source
-- kind `code`: agent definitions a scanner reads from source code and
-- configuration (#3737). An estate declares the sources its scanner reads, and
-- `AgentHarnessEstateSource_kind_known` pins that list to the contract's
-- (`SOURCE_KINDS` in src/lib/agentic/harness-contract.ts), so the pin follows
-- the contract: the same seven kinds, and `code`.
--
-- WIDENING ONLY. Every row the old CHECK admitted, the new one admits, so no
-- row is touched and a container still running the previous release — whose
-- schema validation refuses `code` before it reaches the database — is
-- unaffected during a rolling deploy. Re-runnable: the DROP is IF EXISTS, and
-- both statements run in the migration's one transaction.
--
-- `tests/unit/agentic/harness-contract.test.ts` reads the newest migration that
-- names this constraint and fails unless its list is `SOURCE_KINDS`.

ALTER TABLE "AgentHarnessEstateSource"
    DROP CONSTRAINT IF EXISTS "AgentHarnessEstateSource_kind_known";

ALTER TABLE "AgentHarnessEstateSource"
    ADD CONSTRAINT "AgentHarnessEstateSource_kind_known"
    CHECK ("kind" IN ('entra-sp', 'okta-app', 'vault', 'mcp', 'runtime', 'cicd', 'inflect-register', 'code'));
