# 2026-10-08 — Registering the `legacy-mcp` provider (Step 1c)

**Commit:** `4abcebd0f feat(integrations): register the legacy-mcp provider (Step 1c)`

## Design

An `IntegrationProvider` like any other, plus one new rule kind and one new client
entry point. The far end is the **customer's** system — an MCP server they run in
front of an application they own — and that single fact decides everything else.

```
admin saves a connection
   │
   ├─ validateProviderConfig('legacy-mcp', config)
   │     endpointUrl: { kind: 'publicOrigin' }   ← https + checkWebhookUrl, at SAVE time
   │     applicationName: { kind: 'inert' }
   │
   ├─ redirectsStoredCredential(...)             ← refuses an endpoint change that
   │     covers endpointUrl because publicOrigin    keeps the stored bearer token
   │     is in ORIGIN_KINDS
   │
   └─ LegacyMcpProvider.validateConnection()
         probeManifest()  → handshake + manifest, and STOPS
            every request through safeFetch, which re-resolves at USE time
```

### Why a third origin kind

`vendorOrigin` needs an allowlist naming the vendor's hosts. There is no such list
here: the host belongs to the customer and every customer's is different.

`internalOrigin` settles only the scheme — correct for an `ldaps:` bind to a
domain controller inside the customer's own network, and wrong here, where we dial
out across the public internet to whatever an admin typed.

So `publicOrigin`: `https:` required, `checkWebhookUrl` run at save time (which
refuses literal private, loopback, link-local and metadata addresses and the
blocked names), and no credentials in the URL. What it cannot settle is DNS — a
name resolving to `169.254.169.254` looks like any other name — and `safeFetch`
re-resolving at use time is the half that closes rebinding.

### The hole the comment denied

`originFieldsFor` derives the host-bearing fields that `redirectsStoredCredential`
protects. Its docstring said:

> `vendorOrigin` and `internalOrigin` already mark exactly these … A third origin
> kind added to `ConfigFieldRule` is covered here the day it is added; a
> hand-written list would not be.

The filter beneath it read:

```ts
.filter(([, rule]) => rule.kind === 'vendorOrigin' || rule.kind === 'internalOrigin')
```

Which is a hand-written list with different punctuation. Adding `publicOrigin` to
the union alone would have left `endpointUrl` outside the credential-redirect
check — silently, with the comment asserting otherwise — and an `admin.manage`
holder could then have pointed the connection at a host they control and kept the
customer's bearer token. That is precisely the attack `redirectsStoredCredential`
exists to close, and it would have been reopened by the function written to close
it.

The kinds now live in one `Set` that the filter and a reader both see, and the
docstring records what happened instead of what it hoped.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/integrations/providers/legacy-mcp/index.ts` | The provider: config schema, setup guide, `validateConnection`, and the kind-to-sentence mapping. |
| `src/app-layer/integrations/config-schema.ts` | `publicOrigin`; `ORIGIN_KINDS`; the validation arm; the corrected docstring. |
| `src/lib/mcp/client/index.ts` | `probeManifest` — handshake and manifest, nothing else. |
| `src/app-layer/integrations/bootstrap.ts` | Registration. |
| `src/app-layer/usecases/integrations.ts` | `PROVIDER_CATEGORY`: a `legacy` category of its own. |
| `docs/sub-processors.md` | A row saying this is NOT a sub-processor. |

## Decisions

- **`probeManifest` rather than `pullSnapshot`.** Validation answers "is this a
  conforming server"; `pullSnapshot` would answer it by reading every page, which
  for a million-row export is a lot of someone else's bandwidth spent on a Test
  button. Same handshake, same strict validation, stops before the pages.

- **A green Test is a narrower promise than it looks, and the docblock says so.**
  It means: supported protocol version, resources advertised, manifest satisfies
  the contract. It does not mean the pages are readable. Conflating them would hide
  the torn-snapshot failure, which by definition only appears while paging — so the
  button would be greenest about exactly the thing it cannot see.

- **A category of its own, not `identity`.** The four identity providers are
  DIRECTORIES we read accounts from. A legacy application is the opposite end of
  the problem: its own access table, no directory behind it. Grouping them would
  tell an operator these connectors do the same job, and the premise of the whole
  roadmap is that they do not.

- **Listed in the sub-processor inventory while saying it is not one.** The guard
  requires every external provider there, and the alternative — adding it to
  `INTERNAL_PROVIDERS` — would be false, since it is not evaluated entirely inside
  this product. The honest resolution is a row that answers the question a reader
  came with. `active-directory` set the precedent: customer-hosted, in the table,
  with the data flow spelled out.

- **The Test button never calls `markAuthFailure`, pinned by a test.** That flag is
  read by the freshness surface and the leaver pass; an operator pressing Test with
  a half-typed token would otherwise have a typo recorded as evidence the
  integration is down. Only a background pull, which nobody is watching, is
  entitled to that conclusion. The test uses `codeOf` so this module's own docblock
  saying it never calls the function cannot satisfy the assertion.

- **Six error kinds, six fixed sentences, in a closed switch.** The client's
  `kind` field exists so each failure maps to a different remedy; this is where
  that mapping is spent. `torn-snapshot` is unreachable from a manifest-only probe
  and is handled anyway, so the switch stays exhaustive and a new kind fails to
  compile rather than falling through to a message about the wrong thing. None
  interpolates a response body.

## Mutation proof

Four mutations against 33 assertions, each restored byte-identical:

| Mutation | Failing assertions |
| --- | --- |
| `publicOrigin` dropped from `ORIGIN_KINDS` | 3 |
| the filter reverted to its inline two-kind form | 3 |
| the `publicOrigin` validation arm deleted | 13 |
| `endpointUrl` classified `inert` | 16 |

The first two are the same three assertions, which is the point: they are two ways
of writing the same regression, and the test catches it by behaviour rather than
by the shape of the code.

## What this step did not do

Nothing pulls yet. The provider can be created, tested and stored; the snapshot
model and the scheduled pull are Step 2a. So there is a connection row, a
validated endpoint and an encrypted token, and no job that reads them.
