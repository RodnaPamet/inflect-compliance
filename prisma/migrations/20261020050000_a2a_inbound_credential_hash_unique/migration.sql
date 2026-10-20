-- #3742: the per-tenant inbound A2A endpoint finds the peer from its bearer
-- alone, by the credential's SHA-256. Unique per tenant, so one token names one
-- credential and so one peer. Revoked rows are included on purpose: a revoked
-- token is then refused as its own peer's BAD_CREDENTIAL, not as a stranger's.
--
-- Tokens are 32 random bytes, so no existing pair of rows can collide; the
-- index builds on whatever the table holds.
CREATE UNIQUE INDEX "PeerAgentInboundCredential_tenantId_keyHash_key" ON "PeerAgentInboundCredential"("tenantId", "keyHash");
