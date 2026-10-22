# SAP `$metadata`, for M4's tool definitions

**What this directory is for:** the OData `$metadata` documents M4 (#3871) must
be written against, exported by someone who can reach SAP. Every `*.sap.com`
host is unreachable from the build environment, so these cannot be fetched here
— they are dropped in by hand and committed.

**Why it is worth doing before the policy answer.** M4 is blocked on Phase 0
item 3, which decides *where* the MCP server may be hosted — customer-operated
or inside Integration Suite MCP Gateway. Entity and field shapes do not depend
on that answer. So the tool definitions can be built against real field names
now, and only the hosting decision remains. Owner decision, 2026-10-22.

## What to export

#3871's STEP 0 says to verify four things against real `$metadata` before
building. Those four are what decide which services are needed:

> `A_SalesOrder.CreatedByUser` / `SoldToParty` / `CreationDate` filterable,
> `to_Item` exposing `Material` and `NetAmount`, and the item-versus-header split
> on billing documents.

So, three services — and note these are **OData V2**, which is what
`@sap-cloud-sdk/odata-v2` and "OData V2 has no date arithmetic in `$filter`"
in #3871 both imply:

| # | needed for | entity named in #3871 | service I expect — **confirm** |
| --- | --- | --- | --- |
| 1 | `sales_orders_by_creator` | `A_SalesOrder` + `to_Item` | `API_SALES_ORDER_SRV` |
| 2 | `billing_exists_for_creator_and_customer` | billing header + item | `API_BILLING_DOCUMENT_SRV` |
| 3 | `resolve_entities` — customer name → `SoldToParty` | Business Partner | `API_BUSINESS_PARTNER` |

**The service names in that last column are my expectation, not a fact.** #3871
names the *entity* (`A_SalesOrder`) and not the service, and I inferred the rest
from S/4HANA Cloud's usual naming. Please send whatever the API Business Hub
actually calls them — if a name differs, that is information rather than a
problem, and I would rather have the real one than build against a guess. This
is the same discipline that caught two details in the A2A proto that recollection
would have got wrong.

A fourth export is worth including if it is cheap: the **service catalogue**
listing, so the three above can be confirmed to be the right ones rather than
assumed.

## How

From the API Business Hub sandbox, which is free with an SAP account:

```
curl -H "APIKey: $SANDBOX_KEY" \
  "https://sandbox.api.sap.com/s4hanacloud/sap/opu/odata/sap/<SERVICE>/\$metadata" \
  -o docs/sap/metadata/<SERVICE>.xml
```

Escape the `$` (or single-quote the URL) — an unescaped `$metadata` is an empty
shell variable, which produces a 200 for the service document instead and looks
like success.

## Where to put them

Here, as `<SERVICE>.xml`, committed. They are vendor-published interface
descriptions rather than customer data — but **please skim one before
committing**: if an export carries a customer identifier, tenant host or key in
a comment or annotation, say so and I will handle it differently.

## What I will do with them

1. Check #3871's STEP 0 claims against the real documents — the three filterable
   fields, `to_Item` exposing `Material` and `NetAmount`, and the billing
   item-versus-header split. Any that do not hold is a finding on #3871 before a
   line of M4 is written.
2. Replace the stub's **invented** field names with the real ones. The fixtures
   in `packages/sap-mcp-stub/src/fixtures.ts` currently use plausible names I
   made up; once these land, the stub and M4 agree with SAP instead of with me.
3. Write the three tool definitions' input schemas and their `$filter` /
   `$expand` shapes against the real entities.

### What it still will not answer

The sandbox is API-key authenticated, so it proves **nothing about the auth
chain** — not `OAuth2SAMLBearerAssertion`, not the BTP Destination service, and
not Phase 0 item 4 (`SAP_COM_0109` offering OAuth 2.0), which is a fact about a
specific tenant. #3871's STEP 0 says the client's *own* `$metadata`; the sandbox
is a stand-in that settles shapes, and the client's tier is still what settles
the rest.
