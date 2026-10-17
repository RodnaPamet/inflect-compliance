# 2026-10-17 — anthropic-workspace-id for organisation-level API keys

**Commit:** _(this PR)_ `fix(ai): send anthropic-workspace-id for organisation-level API keys`

## Design

The repository's `ANTHROPIC_API_KEY` is an organisation-level key, not one
created inside a workspace, and production uses the same key. Anthropic refuses
such a key's requests with HTTP 400 — "This API key is not scoped to a
workspace, so this request must include the anthropic-workspace-id header with
the ID of the workspace". Observed on 2026-10-17 against the repository key; the
owner confirmed production uses the same key, so every Anthropic caller there is
very likely refused the same way wherever it is enabled. The two direct
providers hide it — they catch the error and serve their deterministic fallback
— and a Flue run on the external route errors.

```
ANTHROPIC_WORKSPACE_ID (src/env.ts, optional, trimmed)
        │
        ├── compliance-posture/provider.ts ──▶ AnthropicCompliancePostureProvider ──┐
        ├── risk-assessment/index.ts ────────▶ AnthropicRiskSuggestionProvider ─────┤ fetch headers
        │                                                                          │ { ...anthropicWorkspaceHeaders(id) }
        └── flue/runtime-start.ts ──▶ buildFlueProviders(terms.externalWorkspaceId)
                                          └─▶ Model.headers ──▶ pi Models.getAuth + anthropic SDK client
                                                                     │
                     src/lib/ai/anthropic-workspace.ts ◀─────────────┘ one definition of the header
```

`anthropicWorkspaceHeaders(id)` returns `{ 'anthropic-workspace-id': id }` when
an id is configured and `{}` when not, so a caller that spreads it sends exactly
the headers it sent before. A workspace-scoped key needs nothing and is
unaffected.

## Files

| File | Role |
|---|---|
| `src/lib/ai/anthropic-workspace.ts` | The header name and `anthropicWorkspaceHeaders` — pure, import-free |
| `src/env.ts` | `ANTHROPIC_WORKSPACE_ID`: optional, trimmed, mapped from `process.env` |
| `src/app-layer/ai/compliance-posture/{provider,anthropic-provider}.ts` | Factory passes the id; provider spreads the header into its `fetch` |
| `src/app-layer/ai/risk-assessment/{index,anthropic-provider}.ts` | The same, for risk suggestions |
| `src/lib/agentic/flue/runtime-bootstrap.ts` | `FlueProviderTerms.externalWorkspaceId` |
| `src/lib/agentic/flue/runtime-start.ts` | The boot reads the id from `env` beside the key |
| `src/lib/agentic/flue/providers.ts` | The external model carries the header as `Model.headers` |
| `docs/sub-processors.md`, `docs/deployment.md` | The variable, what it sends, and how it reaches the containers |

## Decisions

- **The id is an argument, not read from `env` inside the helper.** Each caller
  already takes its key at its construction site — the Flue builder closes over
  the key it is given rather than reading ambient configuration, and says why at
  length. The workspace id belongs to the key and travels with it. It also keeps
  the helper free of imports, so the ESM-only Flue graph and the server
  providers can share it and nothing about it can reach a client bundle.
- **On the Flue model, not the provider.** pi 0.83's `createProvider` accepts a
  provider-level `headers` option and stores it, but `Models` never reads it
  back. Measured: with the header moved there, the request the SDK hands `fetch`
  carries no `anthropic-workspace-id`. `Model.headers` is merged by
  `Models.getAuth(model)` and again by the anthropic-messages client builder, so
  it reaches the wire on either path. The Flue test therefore reads the headers
  off a real completion call through a `Models` collection with a capturing
  `fetch`, not off a field.
- **Absent means absent.** When no id is configured the Flue model has no
  `headers` key at all and the direct providers' header objects are the same
  three keys as before. The tests pin the exact header set for the unset case.
- **The helper trims, as well as the schema.** Under `SKIP_ENV_VALIDATION=1`
  `@t3-oss/env-nextjs` returns raw strings, so the one place every caller passes
  through is where a stray newline is removed. Blank is unset.
- **Not a route of its own.** `externalWorkspaceId` is not part of
  `flueProviderIdsFor`'s answer, for the same reason `localApiKey` is not: it
  qualifies the route the credential makes. A key with no workspace id is still
  a route; a workspace id with no key is not.
- **No Compose change.** `ANTHROPIC_API_KEY` reaches the `app` and `worker`
  containers through each service's `env_file:`, in all three Compose files, and
  the workspace id goes the same way — a line in the host env file. Listing it
  under `environment:` would be worse than redundant: a service-level
  `environment:` value overrides `env_file:`, so an empty interpolation there
  would blank the value the container was given.
- **Not a sub-processor change.** The header names which of the operator's own
  workspaces a request belongs to. It sends no customer data and does not change
  any payload, so `docs/sub-processors.md` records it under the existing
  Anthropic entry rather than as a new processing activity.
