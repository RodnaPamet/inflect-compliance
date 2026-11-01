-- Agent oversight settings (round 15: #4895, #4900, #4896, #4897, #4898).
--
-- Five Owner-set switches on TenantSecuritySettings and one column recording
-- who composed a request on /agents/compose. Every column is additive with a
-- default (or nullable), so a container still running the previous build
-- neither reads nor writes them, and a rolling deploy is safe in both orders.
--
-- The defaults keep today's behaviour everywhere except one deliberate change:
-- a composed request now needs someone other than its composer to approve it
-- (agentComposeNeedsSecondApprover defaults to TRUE). Requests composed before
-- this migration have no recorded composer, so the rule cannot reach them.

ALTER TABLE "TenantSecuritySettings"
    ADD COLUMN "agentComposeNeedsSecondApprover" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "agentExactParameterEditNeedsSecondApprover" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "auditorReadsAiDecisionLog" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "auditorReadsAgentReceipts" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "auditorReadsAgentQuarantine" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "AgentProposal" ADD COLUMN "composedByUserId" TEXT;
