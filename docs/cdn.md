# CDN — CloudFront edge tier

> **New to the codebase?** Start at [CONTRIBUTING.md](../CONTRIBUTING.md).

A CloudFront distribution sits in front of the application's HTTPS endpoint and
caches Next.js's immutable static output at the edge. The origin is unchanged —
the existing Caddy / Helm ingress. CloudFront is purely an added global edge tier.

This doc is the **source of truth for what is cached and for how long.**

## Why CloudFront (and when Cloudflare instead)

- **CloudFront** is the default for this AWS-shaped deploy: AWS-native, IAM /
  OIDC integration (the deploy workflow already has `id-token: write`), ACM for
  certs, one vendor, one bill. The terraform lives beside the rest of the stack
  (`infra/terraform/modules/cdn`).
- **Cloudflare** is the alternate path if you need Cloudflare-specific features:
  Workers at the edge, network-layer DDoS scrubbing, or cheaper egress in a
  non-AWS deploy. The cache-behaviour matrix below ports directly (Cloudflare
  Page Rules / cache rules map 1:1). The delta is operational, not architectural —
  but for an AWS-hosted origin, CloudFront avoids a second vendor and keeps auth
  in IAM. **Recommendation: CloudFront for AWS-shaped deploys.**

## Cache-behaviour matrix (source of truth)

| Path | TTL (min/default/max) | Query | Cookies | Methods | Why |
|------|----------------------|-------|---------|---------|-----|
| `/_next/static/*` | 1y / 1y / 1y, `immutable` | dropped | none | GET, HEAD | hashed filenames — content-addressed, never change |
| `/_next/image*` | 1d / 30d / 30d | forwarded (`w=`, `q=`) | none | GET, HEAD | image-optimizer output keyed by query |
| `/api/*` | 0 / 0 / 0 | forwarded | all | all verbs | every response carries auth context — never cache |
| `*` (default — HTML shell) | 0 / 0 / 0 | forwarded | all | all verbs | dynamic, tenant-scoped, auth-gated |

The origin (Caddy, `deploy/caddy/Caddyfile`) emits matching `Cache-Control` headers so
the edge caches with the right TTL on the origin pull:
`public, max-age=31536000, immutable` for `/_next/static/*` and `/static/*`,
`public, max-age=2592000` for `/_next/image*`, and `no-store` for everything
else. On Kubernetes there is no Caddy — Next.js emits the immutable
`Cache-Control` for hashed bundles natively and the ingress passes it through, so
no ingress cache annotation is needed.

`ASSET_PREFIX` (env, wired in `next.config.js` and the Helm `extraEnv` example)
points `/_next/static/*` URLs at the CDN domain when set; unset in dev and on the
bare-VM deploy.

## Invalidation contract

The release/deploy workflow (`.github/workflows/deploy.yml`, after the production
smoke test) runs:

```
aws cloudfront create-invalidation --distribution-id <id> --paths '/_next/*' '/'
```

- **Only `/_next/*` and `/` need busting.** `/_next/*` covers the build output
  (hashed bundles change filename per build, but the optimizer paths can collide)
  and `/` is the HTML shell. Static `public/*` assets are operator-managed and
  expire naturally.
- The step is **gated on `secrets.CLOUDFRONT_DISTRIBUTION_ID`** — it no-ops on
  environments with no CDN tier (e.g. the current GCP-VM production). Enabling it
  requires AWS credentials (an OIDC role) available in the deploy job.

## Edge performance (HTTP/3, brotli, keep-alive)

Beyond static-asset caching, the edge cuts network latency for the
dynamic, **uncached** tenant HTML too:

- **HTTP/3 + 0-RTT.** `http_version = "http2and3"` — supported clients
  (mobile, far-from-origin) negotiate QUIC and skip a round-trip on
  reconnect (~30-80ms on high-latency links). Older clients fall back to
  h2/h1. The origin (Caddy) also advertises h3 (`protocols h1 h2 h3`) for
  direct, no-CDN deployments.
- **TLS termination at the edge.** A user far from the origin completes
  their TLS handshake at the nearest PoP instead of the single VM —
  ~30-80ms saved per first connection.
- **Origin keep-alive connection reuse.** `origin_keepalive_timeout = 60`
  keeps a warm pool of edge→origin TLS connections, so a viewer request
  rides an already-established origin connection rather than paying a
  fresh origin handshake per navigation.
- **Brotli HTML compression.** `compress = true` on every behavior →
  CloudFront serves `content-encoding: br` when the client advertises it
  (better ratio than the origin's gzip/zstd at the same CPU).

These help `/t/*` HTML **without caching it** — the page is still fetched
from the origin every time (see below).

### Measuring the win (deferred)

This change ships the edge settings; the **before/after numbers are
captured separately** once a baseline exists. The RUM instrumentation
(`web.vitals.*`, see `docs/perf/`) needs ~1 week of production traffic for
a baseline, and the win needs ~1 week of post-deploy traffic. Until then,
the figures above are **literature estimates, not measurements** —
`docs/perf/baseline-<date>.md` will hold the real `LCP p95` deltas per
route. If the measured win is < 50ms p95 across routes, the honest
conclusion is "the network tax wasn't this population's bottleneck."

## Per-tenant edge cache (out of scope)

The default behavior caches **nothing** — tenant-scoped HTML (`/t/*`)
carries auth context and must never be served from a shared edge cache
(it would leak one tenant's rendered page to another). Edge-caching
tenant HTML would require per-tenant cache keys (keyed on a verified
tenant claim) **plus** cache-poisoning protection, and is a separate,
larger piece of work — not in this tier.

## Cost

A single distribution with ~1 TB egress/month is ≈ **$85–90/mo** (PriceClass_100:
US/CA/EU edges). That offsets the same ~1 TB of bandwidth + the per-request
compute the origin VM would otherwise serve for every `/_next/static/*` pull on
every page load — and adds global edge latency wins. PriceClass_All adds every
edge location at higher egress cost; default is PriceClass_100.

## What is NOT served via CDN (and why)

- **API responses (`/api/*`).** Every response is tenant-scoped and
  auth-context-bearing. Passed through, never cached.
- **Evidence files / signed-URL downloads.** The evidence S3 bucket
  (`infra/terraform/modules/storage`) is private (`public_access_block` all on)
  and served via short-lived authenticated signed URLs. Public CDN distribution
  of tenant-private evidence is a **separate conversation** (a follow-up would put
  CloudFront in front of the bucket with OAC + signed URLs/cookies — explicitly
  out of scope here).
- **The HTML shell (`/`).** Dynamic, per-tenant, auth-gated.

## Not in this tier (deliberate)

- **No CloudFront Functions / Lambda@Edge.** The cache surface is static +
  immutable; no edge code is needed.
- **Same origin TLS endpoint.** CloudFront → origin uses the same Caddy / ingress
  HTTPS endpoint (`origin_protocol_policy = https-only`, TLSv1.2/1.3, keep-alive
  60s — see "Edge performance" above). A custom-origin
  shared-secret header (`X-CDN-Origin-Secret`, optional) lets the origin reject
  direct, CDN-bypassing traffic — the custom-origin equivalent of S3 OAC (OAC
  itself is S3/Lambda-only and does not apply to a custom HTTP origin).

## Enabling it

1. Set `cdn_enabled = true` + `cdn_domain_name` (must differ from
   `cdn_origin_domain_name`), `cdn_origin_domain_name`, `cdn_hosted_zone_id` in
   the environment's tfvars. The root passes a us-east-1 provider alias
   (`aws.us_east_1`) for the ACM cert automatically.
2. `terraform apply` → note the `cdn_distribution_id` output.
3. Set the `CLOUDFRONT_DISTRIBUTION_ID` repo secret + ensure the deploy job has
   AWS creds, and set `ASSET_PREFIX` to the CDN domain in the app env.
4. Verify: `curl -I https://<cdn-domain>/_next/static/<hashed>.js` returns
   `cache-control: public, max-age=31536000, immutable` and `x-cache: Hit from
   cloudfront` on the second request; `curl -I https://<cdn-domain>/api/health`
   returns `cache-control: no-store` and `Miss from cloudfront`.
