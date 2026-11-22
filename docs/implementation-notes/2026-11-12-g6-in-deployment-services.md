# 2026-11-12 — G6 amended: one rule for in-deployment model services

**Commit:** see the `wf/g6-in-perimeter` branch (`feat(ai): hold the in-deployment model services to one perimeter rule`).

## Design

The owner amended G6 on 2026-11-12. An in-deployment service is an
operator-set URL, read by exactly one module and never tenant-writable. It must
resolve to an address inside the deployment: RFC 1918, loopback or IPv6 ULA, and
every resolved address must qualify. It is dialled with a deadline and a byte
cap that aborts the read. `safeFetch` stays the rule for every host outside the
deployment.

```
DOC_PARSER_BASE_URL      → parsing/index.ts          → docling-provider.ts ┐
AI_GUARD_NEMO_BASE_URL   → guard/providers/registry  → nemo-provider.ts    ├→ inDeploymentRequest
AI_EMBED/RERANK_LOCAL_*  → embeddings/select.ts      → tei-provider → http ┘   (src/lib/ai/in-deployment-service.ts)
```

The embedding seam already had the right mechanism: `perimeter.ts` held the
address rule and `http.ts` did the pinned dial. Both moved, unchanged, into
`src/lib/ai/in-deployment-service.ts`, and the module was generalised:

- it returns the response text and content type, not parsed JSON;
- it reports a non-2xx answer as `HTTP_STATUS` with its status, so each client
  maps statuses itself;
- it treats `deadlineMs <= 0` as a `TIMEOUT` that sends nothing.

`embeddings/http.ts` is now a JSON adapter that keeps the seam's failure
vocabulary. Docling moved off `wirePost`/`safeFetch`. NeMo moved off `safeFetch`
and its `fetchImpl` seam.

## Files

| File | Role |
| --- | --- |
| `src/lib/ai/in-deployment-service.ts` | The address rule, the closed `IN_DEPLOYMENT_SERVICES` registry, and the one pinned, bounded dial |
| `src/lib/ai/embeddings/http.ts` | JSON adapter over the dial (`perimeter.ts` deleted) |
| `src/lib/ai/parsing/docling-provider.ts` | Calls the dial as `doc-parser`; `fetchImpl` removed |
| `src/app-layer/ai/guard/providers/nemo-provider.ts` | Calls the dial as `ai-guard-nemo`; http admitted; a public literal is refused at the endpoint; `fetchImpl` removed |
| `tests/guards/ssrf-egress-coverage.test.ts` | NeMo left `SINKS`, Docling left `MCP_CLIENTS`; a new "IN-DEPLOYMENT SERVICES" section |
| `tests/unit/ai/in-deployment-service.test.ts` | The address rule (moved) plus the dial's behaviour |

## Decisions

- **A new module, not `local-gateway.ts`.** The local-gateway rule decides
  which URL a tenant may nominate, before anything is dialled, and Flue's model
  selection imports it. Putting `node:dns` and `undici` in it would have pulled
  them into that import graph for no gain. The two modules share a precedent,
  the derived one-reader guard, not code.
- **The guard derives readers from the tree.** For each variable in
  `IN_DEPLOYMENT_SERVICES`, exactly `src/env.ts` and one classified reader may
  name it in code. Exact equality fails for a new reader and for a stale entry.
  The guard also checks each link of the chain: reader → client import →
  `inDeploymentRequest` call. So the only URL that reaches the dial is the
  operator's.
- **No `fetchImpl` anywhere.** NeMo and Docling tests now mock `undici` and
  `node:dns`, as the embedding tests already did, so the address rule runs in
  every test.
- **Failure mapping per client.** A name that does not resolve is an outage:
  Docling reports `UNREACHABLE` and falls back, NeMo reports `UNREACHABLE` and
  flags. An address outside the deployment, or a redirect, is a configuration
  fault: Docling reports `EGRESS_REFUSED` with no fallback, NeMo reports
  `EGRESS_REFUSED` and flags. The embedding seam keeps `NETWORK_ERROR` and
  `ENDPOINT_OUTSIDE_PERIMETER`, as it did before the dial moved.
- **Docling now reads the body before checking its content type.** A large
  non-JSON answer therefore reports `RESPONSE_TOO_LARGE` rather than
  `CONTRACT_VIOLATION`. The cap still bounds the read.
