# 2026-11-22 — Step 5a: the `anthropic-workspace` integration provider

**Commit:** see the pull request for issue #4164 (Step 5a of `docs/claude-managed-agents-design.md`).

## Design

A customer connects its own Anthropic workspace on Admin → Integrations. The
connection is an ordinary `IntegrationConnection`:

```
configJson  { workspaceId: 'wrkspc_…', keepSessions: false }   (apiHost never sent)
secret      { apiKey }  → encryptField → secretEncrypted       (connection-secret path)
```

```
card ──POST /admin/integrations──▶ upsertIntegrationConnection ──▶ validateProviderConfig
                                                                   apiHost: vendorOrigin(api.anthropic.com)
                                                                   workspaceId: wrkspc_ shape
card ──PUT  /admin/integrations──▶ testConnectionCredentials ──▶ AnthropicWorkspaceProvider.validateConnection
                                                                   resolveVendorOrigin(apiHost ?? default)
                                                                   safeFetch GET /v1/agents?limit=1
                                                                   x-api-key, anthropic-version 2026-10-21,
                                                                   anthropic-beta managed-agents-2026-04-01,
                                                                   anthropic-workspace-id
                                                                   ◀── 200 + response anthropic-workspace-id == configured → valid
```

`AGENT_MANAGED_AGENTS` (opt-in, `flueEnvEnabled` parser) decides whether
`bootstrap.ts` registers the provider. The page renders the card only when the
server's provider list names it, so the switch is the single source of truth for
both. The provider joins `CARD_OWNED_PROVIDERS`: the generic catalogue, form and
table never show it, because the generic form renders every declared field and
would offer `apiHost` for typing.

Test outcomes are a closed union (`VALID`, `KEY_INVALID`,
`KEY_NOT_WORKSPACE_SCOPED`, `KEY_REFUSED_FOR_WORKSPACE`, `WRONG_WORKSPACE`,
`WORKSPACE_UNCONFIRMED`, `RATE_LIMITED`, `UNREACHABLE`, `UNEXPECTED_RESPONSE`,
`CONFIG_INCOMPLETE`, `CONFIG_REFUSED`), each with one sentence of ours and one
label on the `agent_workspace.validation.outcome` counter.

The end-to-end spec needs the real provider to dial something. `e2e-faux.ts`
names a constant loopback port, chosen only when both `NEXT_TEST_MODE=1` and
`AUTH_TEST_MODE=1`; Playwright starts `scripts/e2e-anthropic-workspace-faux.mjs`
there as a second webServer entry.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/integrations/providers/anthropic-workspace/index.ts` | The provider: config schema, the one-read Test, classification, capped body read |
| `src/app-layer/integrations/providers/anthropic-workspace/e2e-faux.ts` | The Playwright-only loopback seam and its port |
| `src/app-layer/integrations/allowed-host.ts` | `ANTHROPIC_API_HOSTS`; the refusal sentence for an exact-only allowlist |
| `src/app-layer/integrations/config-schema.ts` | Rules: `apiHost` vendorOrigin, `workspaceId` shape, `keepSessions` inert |
| `src/app-layer/integrations/bootstrap.ts` | Registration behind the switch |
| `src/lib/agentic/managed-agents-switch.ts` | `managedAgentsEnabled` |
| `src/env.ts` | `AGENT_MANAGED_AGENTS` |
| `src/lib/observability/integration-metrics.ts` | `recordAnthropicWorkspaceValidation` |
| `src/app/t/[tenantSlug]/(app)/admin/integrations/AnthropicWorkspaceCard.tsx` | The card |
| `src/app/t/[tenantSlug]/(app)/admin/integrations/page.tsx` | Renders the card when listed; keeps the provider out of the generic surfaces |
| `messages/en.json`, `messages/bg.json` | Card copy, provider label and provider text |
| `docs/sub-processors.md` | The opt-in per-tenant row in decision 5's words, and a detail section |
| `scripts/e2e-anthropic-workspace-faux.mjs`, `playwright.config.ts`, `.env.e2e.example` | The faux API and its wiring |
| `jest.setup.js` | The switch on for the suite, so registry censuses see the provider |

## Decisions

- **The workspace header is always sent.** The Managed Agents and OpenTelemetry
  references document `anthropic-workspace-id` as the header that places an
  organisation-level key's request in a workspace, and the repo already has
  `anthropicWorkspaceHeaders`. Sending it makes an organisation key work rather
  than refusing it. The cost is that such a key can act in every workspace of
  the customer's organisation; the connection only ever names one.
- **The RESPONSE header decides the workspace.** Whatever Anthropic does with a
  workspace-scoped key for workspace B sent with header A, the answer's own
  `anthropic-workspace-id` names where the work ran, and the Test passes only
  when that equals the configured id. An answer naming no workspace fails closed
  (`WORKSPACE_UNCONFIRMED`) rather than being read as a match.
- **`apiHost` is declared but never typed.** The design asks for a
  `vendorOrigin` rule; a rule needs a field. The field is in the descriptor so
  the classification guard and the save-time refusal see it, and the card and
  the generic surfaces never render it.
- **"Writes no row" is read as: no execution, connection or audit row of its
  own, and `authFailedAt` untouched.** The shared Test usecase still stamps
  `lastTestedAt` / `lastTestStatus` (the card's badge reads it) as it does for
  every provider, and the audit extension journals that one `updateMany`.
- **The E2E seam is a constant, not a variable.** An env-configurable origin
  would be one more thing to triage and one more value somebody could point
  elsewhere; a loopback constant behind two test flags cannot leave the host.
- **The switch is on for the whole Jest suite.** Every guard that enumerates the
  registry must see what an operator can register. The production default is
  proven by an isolated-registry test with the variable cleared.
- **Changing the workspace on a saved connection is not offered.** The card
  offers keep sessions, Test and Disable; a different workspace is a new
  connection, entered with its own key.
