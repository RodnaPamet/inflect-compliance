# 2026-10-19 — `inflect-agent-harness/3` and the GCP service-account source (#3785)

**Commit:** see the pull request for #3785.

## Design

```
contract   /3 = /2 + source kind 'gcp-sa'          (no member, reason or bound changes)
           verifier: size → JSON → trusted signature → schema OF THE ID NAMED
             /2 body  ─► HarnessReportBodyV2Schema (kinds /2)   gcp-sa anywhere ⇒ SCHEMA
             /3 body  ─► HarnessReportBodyV3Schema (kinds /3)
           stored scans re-read against SOURCE_KINDS = /3's kinds
           IDENTITY_BEARING_SOURCE['gcp-sa'] = true         (a Record: no entry ⇒ no compile)
           estate CHECK widened to nine kinds               (20261019230000, widening only)

scanner    speaks /3 (0.9.0)
  gcp-sa   key JSON (env) ─► RS256 assertion ─► POST oauth2.googleapis.com/token (jwtBearer)
           GET iam.googleapis.com/v1/projects/{p}/serviceAccounts        paged, nextPageToken
           GET …/serviceAccounts/{uniqueId}/keys?keyTypes=USER_MANAGED   not paged
             principal  gcp:sa:{uniqueId}  for each enabled account but the key's own
             credential gcp-sa-key://{p}/{uniqueId}/{keyId}  for each enabled key
             verdicts   H2.credential_bound, H2.grant_kind_declared
```

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/harness-contract-rules.ts` | `HARNESS_CONTRACT_V3`, and `HARNESS_CONTRACT_IDS` holding `/2` and `/3` |
| `src/lib/agentic/harness-contract.ts` | `SOURCE_KINDS_V3`, the `/3` agent and body schemas, the per-id unbound-credential schema, the dispatch entry, the union types |
| `src/lib/agentic/harness-findings.ts` | `gcp-sa` classified identity-bearing |
| `prisma/migrations/20261019230000_agent_harness_estate_gcp_sa_source/` | The estate CHECK, widened to nine kinds |
| `packages/agent-harness-scanner/src/sources/gcp-service-accounts.ts` | The source: key parsing, the signed assertion, the two listings |
| `packages/agent-harness-scanner/src/http.ts` | `TokenExchange.jwtBearer`, beside `clientCredentials`, through one exchange helper |
| `packages/agent-harness-scanner/src/{report,source,scan,config,scanner-surface,index}.ts` | `/3` on the wire, the `gcp-sa` configuration entry, the declared reads and the token POST, version 0.9.0 |
| `tests/helpers/agent-harness-fake-scanner.ts` | `validV3ReportBody`, and three `/3`-on-`/2` malformations |

## Decisions

- **A new id, not a widened `/2`.** The kinds are a closed enum on the wire. A
  `/2` verifier refuses `gcp-sa`, and widening `/2` in place would make this
  verifier accept a report an older one refuses, under the same id. Each id is
  held to its own strict schema, so the planner and the ingest need no change:
  neither narrows on the id since `/1` was retired.
- **The `wrong-contract` malformation moved to `/4`.** It used `/3` as "an id
  that was never in force", which stopped being true.
- **Keyed on `uniqueId`, never the e-mail address.** A service account's address
  is chosen by whoever created it and can name a person; the numeric id cannot.
  The key's resource name embeds the address too, so only its last segment is
  read.
- **The scanner's own account is skipped by its key's `client_email`.** That is
  the account Google authenticated the token request as. A display name is not
  evidence, so it is not used, which is the Okta source's rule.
- **The token endpoint is a constant.** A key file's `token_uri` is the one
  input within the configuration's reach that names a host, and following it
  would send a signed assertion wherever the file says.
- **`cloud-platform` scope.** The IAM API offers no read-only scope. The role
  and the GET-only wire are what keep the read read-only, and the README and
  DPIA say so rather than implying the scope does.
- **Disabled accounts and disabled keys are not reported.** Neither can act. A
  disabled account is still counted in `rows`.
- **An account with no user-managed key is a principal holding no credential.**
  It acts through tokens Google mints for the workload it is attached to, and
  none of those leave Google.
- **No role bindings.** `getIamPolicy` is a POST, and adding a POST verb to the
  wire for one read would widen what every source holds.
