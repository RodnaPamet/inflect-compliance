# 2026-11-16 — per-tenant posture provider names, and how the operator learns them

**Commit:** `(this PR)` feat(posture): derive a per-connection gateway provider name and print it from VM check

## Design

#5251: every tenant's sandboxed posture scan attached the one shared gateway
provider, `inflect-collector`, so a scan benchmarked whatever account that
credential reached and the result was stored as this tenant's Evidence. #5475 made
that refuse rather than attach, leaving sandboxed collection inert by design.

#5476 is the capability that makes it reachable again, and the owner's call is
**path A: the operator provisions, the product attaches.** That division is fixed
by certificates, not convention:

```
OU=operator  (on neither VM)        OU=openshell-user  (the app)
  provider create <name> <cred>       AttachSandboxProvider
                                      ExecSandbox
                                      GetSandboxProviderStatus
        │                                      │
        └────────── one name ──────────────────┘
                 postureProviderName(tenantId, connectionId)
```

So the whole problem reduces to: both halves must compute the same name, and the
operator must be able to read it.

This PR delivers the name and the reading. The attaching half — threading it
through the three posture providers — is the next piece.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/integrations/cloud-posture/provider-name.ts` | NEW. `postureProviderName`, the prefix/width constants, `POSTURE_CONNECTION_PROVIDERS` |
| `deploy/vm-check/remote.sh` | NEW `posture-provider-names` action, and `POSTURE_NAME_RECIPE` |
| `deploy/vm-check/vm.sh`, `.github/workflows/vm-check.yml` | the action in both fixed lists |
| `deploy/openshell/README.md` | the provisioning runbook and a refusal-reading table |
| `tests/guardrails/posture-provider-name-recipe.test.ts` | NEW. Runs the deploy recipe and compares it to the function |
| `tests/guards/vm-check-workflow.test.ts` | the query and exec counts the new action moves |

## Decisions

- **The derivation is UNKEYED, which looks wrong and is not.** The instinct is
  `deriveSubkey` under `DERIVED_SUBKEY_KEY`. That key has no previous-key fallback,
  so rotating it silently re-decides every value derived from it — here, every
  provider name at once, orphaning everything the operator had provisioned and
  refusing every tenant's collection, with nothing in the diff to say so. The name
  is an identifier, not a ciphertext: the same distinction the KEK-rotation note
  draws for `hashForLookup`. Unguessability buys nothing either, because attaching
  a provider needs the gateway's own mTLS.

- **Length-prefixed, not separator-joined — and the test found that.** It started
  as a colon join, reasoning that no cuid or uuid contains one. The companion test
  case probed it immediately: `('a','b:c')` and `('a:b','c')` both build `a:b:c`
  and derived ONE name. The sentence was true of today's ids, and a derivation's
  correctness should not rest on somebody else's format decision when the failure
  mode is two tenants sharing a credential. Length-prefixing is injective for any
  pair, so the assumption is gone rather than documented.

- **A golden value is pinned.** Every other property in the suite holds just as
  well for a different recipe, so without an exact expected string a refactor could
  move every name — orphaning every provisioned provider — with the suite green.
  Changing that line means the operator re-provisions every connection, and the
  assertion exists to force that conversation.

- **The VM check prints names, never tenant ids.** The run log is public. The
  tenant id goes into the digest step on stdin and is dropped; a connection id is
  an opaque cuid naming no customer, and a provider name is a digest. The guardrail
  asserts the absence by running the recipe on a recognisable tenant id and
  checking the output.

- **The guardrail EXECUTES the deploy recipe rather than matching its text.** The
  app container runs plain `node`, so the check cannot import the TypeScript; two
  spellings are unavoidable. A guard asserting the shell file contains an expected
  string proves only that somebody typed a string — it cannot tell `slice(0, 32)`
  from `slice(0, 31)`. So the guardrail extracts `POSTURE_NAME_RECIPE`, runs it in
  a real node process, and compares its output to the function's. Proved by
  drifting the shell three ways and watching it fail each time.

- **No arrow functions in the recipe.** The "remote.sh writes no file" guard reads
  every line for a redirect, and `=> v` is `>` followed by a target. Dropping the
  arrows keeps that guard strict rather than widening a write-detector to
  accommodate a style choice.

- **Two shell steps instead of one pipeline.** The read-only-query guard extracts
  every heredoc and requires each to begin with `SELECT`; a trailing pipe on the
  heredoc's own line lands inside the extracted text. One intermediate variable
  keeps that guard's reading simple, and the variable is never echoed.

- **`POSTURE_CONNECTION_PROVIDERS` is asserted by exact equality.** A fourth cloud
  posture provider must widen it in the same diff, or its connections get a name
  nobody was told to provision and every one of its scans refuses.
