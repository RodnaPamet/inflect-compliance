# Running the stub SAP MCP server for the #3867 VERIFY

Turns the last step of #3867 into a checklist. The stub, its fixtures and its
19 boundary tests are already merged — what this does is run it somewhere
Inflect's egress guard will actually reach, which is the one thing the automated
tests cannot demonstrate because they call the handler in-process.

Every command below was run on this machine and the output in it is real, not
illustrative.

## 0 · Why not localhost

Worth reading first, because it is the question everyone asks and the answer
decides every step after it. `http://localhost:PORT` is refused **twice**:

| check | where | verdict |
| --- | --- | --- |
| scheme must be `https:` | `webhook-safety.ts:73` | `only https webhooks are allowed` |
| hostname `localhost` is blocked | `webhook-safety.ts:50-54` | `blocked host localhost` |
| private address | `webhook-safety.ts:93` | `private address 127.0.0.1` |

And loopback can never be allowlisted: `NEVER_ALLOWLISTABLE` in
`src/lib/security/egress-allowlist.ts` lists `127.0.0.0/8` and `::1/128` and is
checked **before** the operator's allowlist, so even `0.0.0.0/0` will not admit
it. Its reason, recorded there: loopback is the Inflect process's own admin
surfaces.

A non-loopback RFC1918 address is **not** on that list and is admitted in
`SELFHOSTED` mode with no code change. So nothing here relaxes a check — the
stub satisfies both of them instead, which is why `run-stub.sh` refuses a
loopback `--host` rather than binding one you could never reach.

## 1 · Pick the host

```
$ ./pick-host.sh
192.168.56.1
```

Discovered, not configured. It prefers a **host-only** interface (`vboxnet0`
here) over the real LAN: both satisfy the allowlist identically, so the choice
is ours, and a stub serving fixture data over a certificate nobody else trusts
has no business being reachable from the office network. With two candidates and
neither host-only it refuses to choose and tells you to pass `--host` — binding
the wrong interface gives you a stub that works from the wrong places, which is
harder to notice than one that does not start.

## 2 · Make the certificate

```
$ ./make-dev-cert.sh
host  192.168.56.1
cert  ./.certs/stub-cert.pem
key   ./.certs/stub-key.pem

subjectAltName, read back from the certificate:
  X509v3 Subject Alternative Name:
      IP Address:192.168.56.1
```

**The SAN is the whole point.** A certificate identifying itself only in the CN
is rejected for an IP-based connection, and for an IP the SAN must be
`IP:x.x.x.x` rather than `DNS:x.x.x.x`. Get it wrong and the first call fails
`ERR_TLS_CERT_ALTNAME_INVALID`, which reads like an Inflect bug. The script
prints the SAN back out of the finished certificate so you can see it rather
than trust it.

`.certs/` is gitignored — a private key stays out of the repository even when
what it protects is a fixture server.

## 3 · Trust it, in the Inflect process

```
export NODE_EXTRA_CA_CERTS=/abs/path/deploy/sap-stub/.certs/stub-cert.pem
```

Set this where **Inflect** runs, not where the stub runs. Never reach for
`NODE_TLS_REJECT_UNAUTHORIZED=0` instead: that disables verification for every
outbound connection the process makes, including the real ones.

## 4 · Allow the range, in SELFHOSTED mode

The deployment-level allowlist must admit the host's `/24`, and
`privateEgressAllowed` is gated on `getBillingMode() === 'SELFHOSTED'` — on a
hosted deployment the variable is inert even when set, deliberately.

## 5 · Run it

```
$ PORT=8444 ./run-stub.sh
sap-mcp-stub listening on https://192.168.56.1:8444
definitions 1.0.0 sha256=fc4a1212cdfb20919463a534540add52dbd72176ba089c7ec955d27f3731e626
tools resolve_entities, sales_orders_by_creator, billing_exists_for_creator_and_customer
```

**`PORT=8444`, not the 8443 default, on this machine**: a container called
`ciso-caddy` already publishes `0.0.0.0:8443`. The script checks the port before
binding and, on a conflict, names what holds it and suggests a free one — it
does **not** quietly advance, because the port goes into the `mcp-server`
connection Inflect saves and a port that moves between runs breaks that
connection silently.

The definitions hash on boot is there so a later run can state which contract it
exercised.

Flags pass straight through: `./run-stub.sh --fail-mode` makes every tool call
return a tool-level error, and `--empty-catalogue` completes the handshake while
advertising nothing. Those are **different** failures, which is why there are
two — "the agent had nothing to call" has its own `WorkflowRunStatus` precisely
because it is not "the agent failed".

## 6 · Verify, before involving Inflect at all

One call that proves TLS, trust and the fixtures together:

```
$ NODE_EXTRA_CA_CERTS=$PWD/.certs/stub-cert.pem node -e "
  fetch('https://192.168.56.1:8444/mcp',{method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})})
    .then(r=>r.json()).then(j=>console.log(j.result.tools.map(t=>t.name)))"
[ 'resolve_entities', 'sales_orders_by_creator', 'billing_exists_for_creator_and_customer' ]
```

Observed on this machine, along with a `sales_orders_by_creator` call returning
2 orders in EUR and SEK — the multi-currency fixture, which is the one that
proves no total can be naively summed.

Doing this first means a failure in step 7 is Inflect's side, not TLS.

## 7 · Register it in a dev tenant

Add an `mcp-server` integration connection pointing at
`https://<host>:<port>/mcp`, then make one call through the product.

Expect: the tools to list, and a question to come back with fixture data. If the
connection is refused, re-read step 0 — the two checks there are the ones that
refuse, and each has its own message.

## What this does not prove

The roadmap's own table, worth keeping in view: the stub proves tool contracts
and entity shapes. It cannot prove the auth chain, real `$metadata`, or a
client's release and authorisation design. A green run here means M4's code can
be written and exercised, not that it will work against S/4.
