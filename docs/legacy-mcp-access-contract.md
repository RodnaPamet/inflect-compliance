# The `inflect-legacy-access/1` wire contract

How a legacy application exposes its access table to Inflect. **The operator builds
the server; Inflect builds the client.** This document is normative: `MUST`, `MUST
NOT`, `SHOULD` and `MAY` carry their RFC 2119 meanings.

`tests/helpers/legacy-mcp-fake-server.ts` is the **reference implementation**. Where
prose and that file disagree, the file is the one the test suite validates against
the schemas, so it is the one to copy. The schemas themselves are
`src/lib/mcp/client/contract.ts`.

## Transport

- The server MUST speak MCP over streamable HTTP, at a single HTTPS endpoint.
- The endpoint MUST be reachable over `https:`. Inflect refuses `http:`, and refuses
  any host that resolves to a private, loopback, link-local or cloud-metadata
  address, both when the configuration is saved and again at the moment of each
  request.
- The server MUST answer with `Content-Type: application/json`. A `text/event-stream`
  response is refused. Streaming buys nothing here: a snapshot is paginated, and the
  client reads pages.
- The server MUST NOT redirect. The client does not follow redirects, because a
  redirect moves the destination after the address checks have passed.
- The server MAY issue an `Mcp-Session-Id` header on `initialize`. If it does, the
  client echoes it on every later request in that pull.

## Authentication

- The server MUST accept a bearer token: `Authorization: Bearer <token>`.
- The token is supplied by the operator when the connection is configured, and is
  held as a secret field. Changing the endpoint host requires re-entering it: a
  stored credential is never carried to a new host.
- `401` and `403` mark the connection as authentication-failed. Every other error is
  a failed pull, which leaves the connection alone.

## Initialisation

- The client sends `initialize` advertising `capabilities: {}` — exactly that, empty.
  It offers no sampling, no roots and no elicitation, so a server has no mechanism
  through which to ask Inflect to do anything.
- The server MUST advertise `resources`. A server that does not is refused.
- The server MUST negotiate a protocol version from the set Inflect supports. Any
  other value is refused.
- The client then sends `notifications/initialized`.
- The client uses exactly three methods: `initialize`,
  `notifications/initialized` and `resources/read`. **It never sends a `tools/*`
  request, even when the server advertises tools.** Version 1 of this contract
  defines no tool, and the client's request log is asserted in the test suite to
  contain none.

## Resources

### `inflect-access://manifest`

```json
{
  "contract": "inflect-legacy-access/1",
  "app":      { "name": "Mainframe Payroll", "owner": "Finance Systems" },
  "snapshot": { "id": "snap-1", "generatedAt": "2026-10-08T06:00:00.000Z", "rowCount": 7 },
  "columns":  [ { "name": "LOGIN_NAME", "type": "string", "nullable": false } ],
  "pages":    [ "inflect-access://accounts/1" ],
  "layout":   "wide"
}
```

- `contract` MUST be the exact string `inflect-legacy-access/1`. A different major
  version is refused rather than best-guessed.
- `columns[].type` is **advisory**. The client does not coerce a value because its
  column claims a type: an export that labels a column `number` and sends `"00123"`
  is describing its own intent, and the leading zeros matter in an employee number.
- `columns[].name` MUST be unique within a manifest. Two columns with one name make a
  row ambiguous, and whichever the server serialises last would win.
- `layout` declares how entitlements are shaped: `wide` for one column per
  entitlement, `long` for one row per account-and-entitlement pair. It is declared
  rather than inferred, because the two are indistinguishable from data alone when
  every account happens to hold exactly one entitlement.
- `pages` MUST list every page of the snapshot, in order.

### `inflect-access://accounts/{n}?fields=COL_A,COL_B`

```json
{ "snapshotId": "snap-1", "page": 1, "rows": [ { "LOGIN_NAME": "user1" } ] }
```

- Pages are numbered from `1`.
- A row is a flat record from column name to a scalar — string, number, boolean or
  null. Nested objects and arrays MUST NOT appear.

## The `snapshotId` rule

**Every page MUST carry the same `snapshotId` as the manifest.** A mismatch is a
*torn read*: the underlying table changed while Inflect was paging through it, so the
pages do not describe one consistent moment. The pull fails and restarts from the
manifest.

This is the contract's central integrity rule. A server that regenerates its snapshot
per request, rather than per snapshot id, violates it even when every individual page
is well-formed.

## The `?fields=` projection rule

- The client requests only the columns a saved mapping uses.
- The server MUST return those columns and **no others**. Returning extra columns is
  *oversharing*: it sends Inflect personal data nobody classified, and the connection
  is flagged for it.
- A column the client did not request MUST NOT appear even when it is cheap to
  include. "Cheap" is a property of the server; "classified" is a property of the
  data.

## Limits

The client enforces these whatever a server claims. They are refusal thresholds, not
targets, and they are checked at the transport layer *before* a body is parsed — a
schema cannot protect against a body already read into memory.

| Dimension | Limit |
|---|---|
| Columns per manifest | 200 |
| Column-name length | 128 characters |
| Snapshot-id length | 200 characters |
| Rows per page | 1,000 |
| Pages per snapshot | 1,000 |
| One cell | 4,096 characters |

A column name MUST NOT contain a control or invisible character — the whole of C0 and
C1, tab and the newlines included, plus the zero-width, bidi and separator marks.
Such a name is **refused, never stripped**: stripping renames a column, and two names
differing only by an invisible character would then collide, producing a mapping that
points at the wrong data. Column names reach an administrator's screen.

## What the client refuses

Each of these ends the pull with a named reason, and the snapshot is recorded as
incomplete rather than reported as complete:

| Condition | Reason |
|---|---|
| A page's `snapshotId` differs from the manifest's | torn snapshot |
| Any limit above exceeded | cap exceeded |
| `text/event-stream`, or any non-JSON content type | contract violation |
| A redirect | contract violation |
| An unknown `contract` value | contract violation |
| A protocol version outside the supported set | contract violation |
| `resources` not advertised | contract violation |
| A host resolving to a private or metadata address | blocked address |
| `401` or `403` | authentication failed |
| No response inside the request deadline | timeout |

A truncated, torn, drifted, partial or unauthenticated read is **never** reported as
complete. An account missing from a snapshot is an account nobody reviews.

## What this contract does not define

- **No writes.** There is no revocation, no disable and no update. Inflect reads.
- **No tool.** Pages are resources. A read tool for servers that genuinely cannot
  serve resources is a version 2 question, and version 2 does not exist.
- **No push.** The server does not notify Inflect of changes; Inflect pulls on
  demand.
