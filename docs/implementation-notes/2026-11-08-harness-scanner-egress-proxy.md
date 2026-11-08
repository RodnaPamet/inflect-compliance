# 2026-11-08 — The harness scanner behind its own egress proxy, proven each scan

**Commit:** _(this change)_ — #5004 part C, on top of part B
(`2026-11-08-harness-register-enforcement-evidence.md`).

## Design

`H3.egress_enforced` asks whether an agent's outbound network is ENFORCED
against an allowlist, with evidence. The ladder's own comment names "a
mediating proxy that fails closed" as one way to evidence it. The owner chose
that way for the scanner (decision 4 on #5004).

```
 harness-scanner-internal (internal: no route out)      harness-scanner-egress
 ┌──────────────────┐   CONNECT host:443   ┌───────────────────┐
 │ harness-scanner  │ ───────────────────▶ │  harness-egress   │ ──▶ allowlisted host
 │ HTTPS_PROXY,     │                      │  EGRESS_ALLOW     │
 │ NODE_USE_ENV_    │   anything else      │  403 / 405        │
 │ PROXY=1          │ ◀─────────────────── │                   │
 └──────────────────┘                      └───────────────────┘
```

- **The proxy is reviewed code from this repository.** It is
  `src/egress-proxy.ts`, about a hundred lines, run from the scanner's own
  pinned image with a different entrypoint, so there is no third-party image
  and no second supply chain.
  - It is CONNECT-only and admits a tunnel to an exact hostname on 443.
  - It refuses everything else: a suffix match, another port, an IP literal,
    or cleartext. An empty allowlist refuses all.
  - It decides on the CONNECT line and never sees inside the TLS tunnel.
- **The scanner gets one network, which has no route out.** That also removes
  its reach to the production database and Redis, which share the default
  network.
- **The scanner needs no proxy code.** Node 24's fetch honours `HTTPS_PROXY`
  when `NODE_USE_ENV_PROXY=1`.
- **Each scan proves the confinement before it reads.** `egress-proof.ts` runs
  four checks, all of which must hold in one expression:
  1. the environment points fetch at the configured proxy;
  2. the proxy admits the Inflect host;
  3. the proxy refuses the canary;
  4. a direct TCP connection to the Inflect host fails.

  The fourth is the one a proxy cannot show by itself. A proxy that refuses the
  canary proves nothing if the scanner could simply not use it.
- **The proof is the scanner's own `H3.egress_enforced`.** It goes on the
  scanner's own agent through the register source. It is "met" or a "no"
  together with the failed check, because it is the scanner's own observation of
  its own container. Without an `egress` block in the configuration, the
  criterion is unanswered.

## Files

| File | Role |
| --- | --- |
| `packages/agent-harness-scanner/src/egress-proxy.ts` | The proxy |
| `packages/agent-harness-scanner/src/egress-proof.ts` | The per-scan proof and the production probe |
| `packages/agent-harness-scanner/src/{config,scan}.ts` | The `egress` block; the proof taken before the sources read |
| `packages/agent-harness-scanner/src/sources/inflect-register.ts` | The verdict on the scanner's own agent |
| `packages/agent-harness-scanner/src/scanner-surface.ts` | The proof's three connections declared; version 0.12.0 |
| `deploy/docker-compose.harness-scanner.yml` | The two networks, the proxy service, the scanner's proxy environment |
| `deploy/harness-scanner/{remote,vm}.sh` | One digest for both services; dry-run starts the proxy; `configure` refuses an image without it |
| `deploy/harness-scanner/config.pilot.example.json` | `egress` added; the `mcp` source removed |

## Decisions

- **The pilot's `mcp` source is removed** (owner decision, 2026-11-08). Its one
  server was Inflect's own `/api/mcp`, listed for no agent, so it evidenced
  nothing. It read with the ingest key raw, which part A refuses once the key
  requires the exchange, so it would have failed every scan. The register
  source already reads that endpoint, on a tool-scoped token. An estate that
  still declares `mcp` reads STALE until the declaration drops it.
- **The allowlist is the overlay's, and a test holds it to the configuration.**
  `pilot-deployment-template.test.ts` requires the allowlist to equal the hosts
  the pilot's sources and the ingest reach, no more and no fewer. It also
  requires the canary to be off the list, and the scanner's `HTTPS_PROXY` to
  name the configured proxy. A source added without its host reads
  UNREACHABLE, which is the safe direction.
- **The canary is `example.com`.** It is reserved for examples, and the proxy
  refuses it before dialling, so the proof sends nothing off the VM.
- **`configure` refuses an image that predates the proxy.** Both services run the
  digest the overlay pins, and the digest in force today is from before this
  change. Applying the overlay before a new image is published would leave the
  scanner with no way out. The refusal names the remedy instead.
