# 2026-10-09 — Minting the grant endpoint's token

**Commit:** see the PR for #3330 — `feat(mcp): mint the grant connection's bearer token`

## Why an action and not a text field

#3323 made the endpoint authenticate `Bearer <connectionId>.<secret>`. The
provider declares `authorization` as free text, so wiring it by hand meant:
create the connection with the field empty, find its id, invent a random secret
with no guidance on length or alphabet, concatenate the two, and edit the
connection again.

Steps two and four are a chicken-and-egg the token shape creates — the id does
not exist until the row does. Step three is the one that matters: **nothing in
this system would notice a four-character secret**, and this is the entire
security boundary for a publicly reachable origin.

## Decisions

- **Stored recoverable, not hashed, and the UI must say so.** An API key here is
  stored as a hash and its plaintext is genuinely unrecoverable. This is not
  that: the endpoint COMPARES against the value, so it is stored encrypted under
  the tenant DEK and anyone with the database and the KEK can read it back.
  Showing it once reduces the number of *copies*; it does not make the secret
  unrecoverable, and implying otherwise would be a false assurance. It is also
  why the comparison is constant-time — the stored value is the thing being
  guessed at.

- **No previous-value window, for a structural reason rather than a judgement.**
  `verifyPlatformApiKey` keeps `PLATFORM_ADMIN_API_KEY_PREVIOUS` valid so
  rotation has no gap, and #3330 asks whether to copy it. There is only ONE copy
  of this secret: the dispatch reads `secrets.authorization` off the connection
  and sends it, and the endpoint reads the same field off the same row and
  compares. Rotation is a single row update that changes both sides at the same
  instant. A window exists to cover the interval where one side is updated and
  the other is not; there is no such interval, so it would add a second
  acceptable secret to the boundary and buy nothing.

- **A token minted onto an OAuth connection is REFUSED.** This is the one that
  would have shipped broken. `authorizationFor` returns the static
  `secrets.authorization` header **only** when no OAuth field is set; if
  `clientSecret` / `refreshToken` are present it mints an access token instead
  and the static value is never read. So the endpoint would compare against a
  credential the dispatch does not present, every grant would refuse as a
  mismatch, and the cause would be invisible from both sides — the endpoint sees
  a wrong secret, the dispatch sees a 401. Refused at mint time, which is the
  one moment somebody is looking at this field.

- **Merge, never replace, and refuse rather than overwrite an unreadable blob.**
  A connection's secrets are one JSON object and this is one key in it. Writing a
  fresh object would silently drop the rest. And when the blob will not decrypt,
  replacing it would destroy whatever it holds in order to add a field — the
  operator needs the key fixed, not the row emptied.

- **A sibling path, not nested under `admin/integrations`.** Matching is
  first-match-wins and `admin/integrations(\/.*)?` resolves to `admin.manage`, so
  nesting would document a weaker gate than the handler enforces.
  `admin/external-write-policy` is a sibling for exactly this reason. The key is
  `admin.tenant_lifecycle` (OWNER-only) because minting the credential GRANTS
  the authority it carries: whoever holds it can drive a time-bounded directory
  write in the customer's own tenant.

- **POST, not GET.** It mutates — it overwrites any previous value — and a GET
  returning a credential invites a browser, a proxy or a log to keep it. The
  `cfnetwork-logs-the-query-string` lesson is about URLs specifically; a body is
  not logged the same way.

- **The audit row records the mint and the secret's LENGTH, never the value.**
  `AuditLog` is hash-chained and built never to be deleted, so a row quoting the
  token would be a second permanent copy that rotation could not remove. The
  length is a property of the policy rather than of the secret, and it lets an
  auditor see that a weak one was not accepted.

- **One provider-id constant, not two.** `entra-grant-auth.ts` had its own
  `'mcp-server'` literal beside the provider's `MCP_SERVER_PROVIDER_ID`. That is
  a drift risk in the one place that cannot afford one: had the provider id ever
  changed, the comparison would have silently stopped matching and every grant
  would have refused `wrong_provider` with nothing failing in a test. Now
  re-exported from the provider.

- **`PermissionedHandler` takes SYNCHRONOUS params.** The repo's convention is
  that a route handler types `params` as `Promise<…>` and awaits it, but
  `requirePermission` has already reified it — `routeArgs: { params: TParams }`
  with `TParams extends { tenantSlug: string }`. Awaiting it inside a
  permissioned handler is a type error, not a style choice.

- **The route is discovered as agentic.** `IS_AGENTIC = /agent|mcp/i` in
  `agentic-route-inbound-links` matches the path, so it must be registered in
  `AGENTIC_API_ROUTES`. It belongs there on the merits too: the credential it
  issues is the one our own dispatch presents.
