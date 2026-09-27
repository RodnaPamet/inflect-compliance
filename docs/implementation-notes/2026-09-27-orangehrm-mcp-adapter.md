# 2026-09-27 — an MCP far end that can be written to (#2861)

**Commit:** `<pending> feat(deploy): OrangeHRM lab fixture + MCP adapter`

## Design

#2861 governs an agent CHANGING a configuration in an external system. The
first production proving run (2026-09-26, run `cmujpuc84000001pgl3rdy9ud`)
established that the far end we had cannot be written to: Microsoft's Entra MCP
server advertises three tools, all declaring `readOnlyHint: true`, none taking a
method or a body. A ladder whose top rung dispatches an unattended write cannot
be proven against a server with no write verb — the top rung would typecheck,
ship green, and never execute, which is the failure mode this subsystem has
already produced nine times over (see `wired-is-not-delivered`).

So the far end is the deliverable here, not the ladder. Two files:

```
deploy/orangehrm-mcp/server.mjs          the adapter — MCP streamable HTTP → OrangeHRM REST
deploy/docker-compose.orangehrm-lab.yml  an OPT-IN overlay standing up all three services
```

The shape on the VM:

```
  agent ──public HTTPS──▶ Caddy ──▶ orangehrm-mcp:8080   (the only proxied service)
                                        │
                                        └─private bridge─▶ orangehrm:80 ──▶ orangehrm-db:3306
```

The adapter advertises exactly two tools, and the pair is the point:

| tool | `readOnlyHint` | what it does |
| --- | --- | --- |
| `orangehrm_get_employee_contact` | `true` | reads one employee's contact details |
| `orangehrm_set_employee_work_email` | `false` | writes one field back |

That is the first tool this product has ever seen declare itself a write, which
is what makes #2861's ladder testable rather than merely type-correct. It is
also what #2941 was for: `annotationsHash` pins those hints on their own axis, so
a far end that redeclares the read tool as a write is a security event rather
than an identical `manifestHash`.

## Files

| file | role |
| --- | --- |
| `deploy/orangehrm-mcp/server.mjs` | 337 lines, no dependencies. `initialize` / `tools/list` / `tools/call` over JSON-RPC in a POST body, served by Node's own `http`. Mints an OAuth2 client-credentials token per call and persists nothing. |
| `deploy/docker-compose.orangehrm-lab.yml` | The overlay: `orangehrm-db` (mariadb:10.11), `orangehrm` (orangehrm/orangehrm:5.9, pinned), `orangehrm-mcp` (node:24-alpine + the source bind-mounted read-only). Header carries the preconditions. |

## Decisions

- **An adapter process, not IC's own connector.** `providers/orangehrm` already
  speaks this API, and reusing it was the first thing considered. It is the
  wrong seam: the thing under test is an AGENT reaching an MCP server it was
  granted, and routing through IC's HRIS connector would exercise the
  connector's credential handling and allowlist instead. The adapter is
  deliberately dumb and deliberately outside the product.

- **No build, no `package.json`, no lockfile.** MCP over HTTP is JSON-RPC in a
  POST body; `node:http` serves that. A build step would add a supply-chain
  surface and a thing to keep current, for a lab fixture.

- **Neither OrangeHRM nor its database publishes a port.** Only the adapter gets
  a Caddy vhost. The fixture holds invented employees, but it is an
  internet-exposed PHP application the moment it is published and it does not
  need to be published for any of this to work. That split is the whole reason
  these are three processes rather than one.

- **The bearer fails CLOSED.** `MCP_BEARER` unset ⇒ every call answers 503
  rather than serving anonymously, and the compose `:?` makes it a start-time
  error. A 401 carries `WWW-Authenticate: Bearer error="invalid_token"` so the
  client can tell "wrong credential" from "wrong shape".

- **`employeeNumber` is validated `/^[0-9]{1,9}$/` before interpolation**, not
  after. It lands in a URL path, and the model chooses it.

- **The write reads first, merges, then reads back.** OrangeHRM's
  contact-details PUT takes the whole object, so a naive write of one field
  blanks every other. The adapter GETs current state, merges its one field over
  it, PUTs, then re-reads and reports `applied` — which is also the prior value
  the mode ladder's journal needs to make a write reversible by hand.

- **An OPT-IN overlay, not `docker-compose.prod.yml`.** The same argument
  `docker-compose.pipelock.yml` makes, and it applies harder: this is a
  third-party PHP application plus a service whose whole purpose is accepting
  writes. It has no business starting because somebody ran the canonical deploy.
  `apply.sh` refuses any `COMPOSE_BASENAME` but the canonical one, so the
  overlay is not pushable by it either — which is correct, and is also why the
  header spells out the manual `scp`.

- **The bind mount is the trap worth naming.** `./orangehrm-mcp:/srv:ro` with no
  source directory on the VM does not fail loudly: Docker creates an empty
  DIRECTORY and mounts it, `node /srv/server.mjs` finds nothing, and the
  container restart-loops. `docker compose config` validates syntax and says
  nothing about bind-mount sources, so it passes every check short of `up`.
  pipelock's header names the same trap for its signing key; the overlay's
  preconditions name it for this.

- **`ORANGEHRM_HOSTS` in `allowed-host.ts` is deliberately NOT widened.** That
  allowlist governs IC's HRIS CONNECTOR reaching an OrangeHRM instance directly.
  An agent reaching this ADAPTER is a different path — an `mcp-server`
  connection, whose `url` is classified `internalOrigin` and carries no vendor
  allowlist. Adding a suffix there would widen the connector for a fixture the
  connector is not pointed at.

- **The Caddy vhost is documented, not pre-added.** The domain is the operator's
  to choose, and `allowed-host.ts` already says as much about this same fixture.
  The block in the overlay's header deliberately does not `import app_site`:
  that snippet carries the product's cache rules and a 110MB body limit, neither
  of which belongs on a JSON-RPC endpoint.
