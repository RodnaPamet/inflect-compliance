# 2026-10-09 — Access-package and policy discovery

**Commit:** see the PR for #3329 — `feat(entra): access package and assignment policy discovery`

## The gap

A grant needs three identifiers from the customer's directory:

| identifier | where it came from |
| --- | --- |
| `targetId` | the target population (#3299, shipped) |
| `accessPackageId` | **nothing** |
| `assignmentPolicyId` | **nothing** |

`entitlement.ts` had zero discovery reads. So #3301's compose form could only
have offered two free-text boxes for opaque GUIDs — an operator copying from the
Entra portal in another tab.

Worse than unusable: **both are opaque GUIDs, so swapping them is undetectable
until Graph refuses, and a wrong-but-valid pair is not refused at all.** There is
no later error to catch a grant composed against the wrong package.

## Where it deliberately does not go

**Not as a third tool on the grant MCP endpoint.**
`tests/unit/entra-grant-mcp-endpoint.test.ts` asserts that catalogue has exactly
two tools, and says why:

> The count is the assertion. A third tool here reaches a privileged surface
> whose only intended client is our own dispatch, and checking the two by name
> would pass with a third beside them.

Adding discovery there would turn that red, and the right response would be to
fix the design rather than the number. The dispatch has no use for discovery —
it is handed a resolved package id by an approved template. The compose form is a
**different caller with a different authority**: a human OWNER in a session, not
a machine holding a connection token.

## Files

| file | role |
| --- | --- |
| `…/providers/entra-id/entitlement.ts` | `pagedGet`, the two reads, `policyBelongsToPackage` |
| `…/usecases/entra-entitlement-discovery.ts` | connection resolution, refusal passthrough, the belonging filter |
| `…/admin/entra-entitlement/access-packages/route.ts` | GET, `admin.manage` |
| `…/admin/entra-entitlement/assignment-policies/route.ts` | GET, `admin.manage`, `accessPackageId` required |
| `src/lib/security/route-permissions.ts` | the subtree rule, GET only |

## Decisions

- **`admin.manage`, not `admin.tenant_lifecycle`.** Its sibling
  `admin/external-write-policy` carries the OWNER-only key two rules above,
  because that one sets how far an agent may go when CHANGING a customer system.
  This is read-only: knowing which packages exist grants nothing. The rule
  declares `methods: ['GET']` explicitly so a future POST under the subtree
  fails the coverage guard instead of inheriting a read gate.

- **The `@odata.nextLink` is origin-checked and then RE-BUILT.** Graph's
  nextLink is absolute and this code attaches a bearer token to whatever it is
  given; `index.ts` already states the consequence for its own stored cursor —
  *a tampered stored cursor would otherwise send this request, carrying a Graph
  bearer token, to an arbitrary host.* So only the link's path and query are
  used, against our own `GRAPH` constant, and the host cannot come from the
  response at all. That is stronger than a prefix check alone, which still
  requests the string the far end chose, and it is the same rule the legacy MCP
  client follows for advertised page URIs.

- **`startsWith`, and a test that can tell it from `includes`.** The first
  foreign-host test used `https://evil.test/v1.0/more`, which **both**
  implementations refuse — so it proved nothing about which was in use. The
  added case is `https://evil.test/v1.0/more?x=graph.microsoft.com`: it
  satisfies `includes` and fails `startsWith`, which is the
  `js/incomplete-url-substring-sanitization` shape this file already has a
  paragraph about. The mutation run confirms it is the *only* test that
  distinguishes them.

- **Truncation is returned, not hidden.** A list silently cut at a page boundary
  is a form that cannot offer a package the tenant has, and the operator cannot
  tell that from the package not existing. Ten pages is the cap — 1000 packages,
  far beyond any tenant this form is for; the bound exists so a pathological
  tenant cannot make one form load walk an unbounded cursor, not because 1000 is
  meaningful.

- **Policies are read per package, not all at once.** Fetching every package's
  policies to build one payload is an N+1 against a customer's directory on
  every form load.

- **`accessPackage/id` is `$expand`ed and echoed back.** `policyBelongsToPackage`
  compares the policy's own package id to the one asked for. Taking it from the
  REQUEST instead would make the check confirm its own input, and a null is not
  treated as belonging — an absent answer is not a yes.

- **The usecase has its own test, because a predicate nobody calls is green.**
  `policyBelongsToPackage` is tested where it lives; what that cannot show is
  whether anything calls it. Deleting the `.filter(...)` in the usecase leaves
  every assertion about the predicate passing while the product offers policies
  from the wrong package again — so the usecase test mutation-reddens on exactly
  that deletion.

- **Catalogs are not fetched.** `accessPackage` in Graph v1.0 carries no
  `catalogId` scalar — the catalog is a navigation property, so grouping by it
  needs `$expand=catalog`, which is not in the set measured live against a
  licensed tenant (#3311). Building a form grouping on an unmeasured expand
  would be an assumption dressed as a feature.
