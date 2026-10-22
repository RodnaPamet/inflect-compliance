# `@inflect/sap-mcp-stub`

A stub SAP MCP server exposing the three tools M4 will build against, plus the
fixture set both it and the inflect-side tests read. Part of #3867, under the SAP
agent integration roadmap (#3859).

It is **not** SAP. The roadmap's own table says what a stub can and cannot prove:
entity shapes and tool contracts, yes; the auth chain, real `$metadata`, and a
client's release and authorisation design, no. A green test run here means M4's
code can be written and exercised, not that it will work against S/4.

## Layout

| file | role |
| --- | --- |
| `src/fixtures.ts` | **the single source.** Every case in the roadmap's fixture list, each commented with the behaviour it proves, plus the derived A2A `facts` projection J4 needs |
| `src/definitions.ts` | the three tool definitions, versioned, with a hash that covers the annotations |
| `src/handler.ts` | a pure `(url, init) => Response` MCP handler |
| `src/server.ts` | binds the handler to an https socket |

`tests/unit/sap-mcp-stub-boundary.test.ts` in the inflect repo calls
`createStubHandler` directly and drives the real tool client through it, so the
tests exercise the stub rather than a fake resembling it.

## Running it

```bash
npx tsx packages/sap-mcp-stub/src/server.ts \
  --host 192.168.56.20 --port 8443 \
  --cert /path/cert.pem --key /path/key.pem
```

It prints the definitions hash on boot, so a run can state which contract it was
exercised against.

Flags: `--fail-mode` (every tool call returns a tool-level error) and
`--empty-catalogue` (the handshake succeeds and advertises no tools). Those are
different failures, which is why there are two: "the agent had nothing to call"
has its own `WorkflowRunStatus` precisely because it is not "the agent failed".

## It will not bind loopback, and it is https-only

Inflect's egress guard refuses `http://localhost:PORT` for **two independent
reasons**, and this stub satisfies both rather than punching through either
(owner decision, 2026-10-22):

- **Scheme.** `webhook-safety.ts:73` requires `https:`. There is no http mode,
  because a fallback is the thing that ends up used. A self-signed certificate
  needs `NODE_EXTRA_CA_CERTS` on the Inflect process.
- **Address.** `NEVER_ALLOWLISTABLE` in `src/lib/security/egress-allowlist.ts`
  lists `127.0.0.0/8` and `::1/128` and is checked *before* the operator's
  allowlist, so even `0.0.0.0/0` cannot reach loopback — its stated reason being
  that loopback is the Inflect process's own admin surfaces. A non-loopback
  RFC1918 address is not on that list and **is** admissible in `SELFHOSTED` mode
  with no code change.

So `--host` has no default and the server exits 2, naming the reason, if given a
loopback address: binding one produces a stub the product can never reach, and
the symptom would be a refused connection with no hint which of the two checks
said no.

To reach it from a dev tenant: `SELFHOSTED` billing mode, the operator declares
the CIDR, and the stub's certificate is trusted by the Inflect process. Redirects
stay refused, DNS is still re-resolved at use time, and every resolved address is
still checked.

## The automated tests need none of that

They call the handler in-process, so the socket, the certificate and the
allowlist are only needed for the end-to-end dev-tenant check.
