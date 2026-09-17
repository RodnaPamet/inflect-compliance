# Entra ID fixtures — DOCUMENTED shapes, not captures

**These are not captures.** They are seeded from Microsoft's *documented* Graph
and token shapes, because no live capture was available. Every file says so in
its own `_fixture_note`, and the test that reads them says so too.

This heading used to read "recorded fixtures", and the sentence here used to
say they were "captured from a staging Entra tenant during the smoke
verification in `docs/enterprise-sso.md`" — while the paragraph below admitted
the opposite. A reader who stopped at the first sentence, which is what a
reader does, came away believing these shapes had been checked against a real
tenant.

That is worth being blunt about rather than quietly correcting, because it is
the same failure that took the OrangeHRM connector down (#2587): a field mapping
written from vendor documentation, fixtures written from the same documentation,
and therefore a test suite that certified the two agreed rather than that either
was right. A fixture's VALUE is entirely in its provenance, so a provenance
claim that overstates itself is worse than no claim.

What they still buy: they anchor the hermetic mocks in `tests/helpers/entra.ts`
to a written-down shape, so swapping in a real capture that drifts from these
fails CI rather than silently breaking production. That is a real guarantee —
it is just a guarantee about DRIFT FROM THE DOCS, not about matching Graph.

Files (replace each verbatim with a redacted real capture when one is available,
per the EI audit/polish pass — and update the heading above when you do):

- `memberOf-page.json` — a `GET /me/memberOf/microsoft.graph.group?$select=id`
  response page (the typed cast we use — returns groups only). Confirms
  `value: [{ "id", "@odata.type" }]` + the `@odata.nextLink` key.
- `overage-claim-names.json` — the `_claim_names` / `_claim_sources` block from a
  decoded ID token of a user in > ~200 groups (the overage marker).

`tests/unit/entra-recorded-fixtures.test.ts` runs both through the real parsing
code (`fetchUserGroupsFromGraph` + `resolveEntraGroupClaims`), so swapping in a
real capture that drifts from these shapes fails CI.

## Redaction rules (MANDATORY)

- Replace every GUID with a `0000…`-style placeholder (keep the 8-4-4-4-12 shape).
- **No access/bearer tokens, no client secrets, no user emails / names / UPNs.**
  These are live credentials / PII and would trip secret-scanning.
- Keep only the structural keys — the test asserts shape, not values.
