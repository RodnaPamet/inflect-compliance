# The Laya server image

What this is, what is pinned, and what has deliberately **not** happened yet.

Owner decision, 2026-10-10: build our own image from the first-party package,
and propose it — **nothing here touches the production VM.**

## Why we build it rather than pull one

Step 6d asks for an image pinned by **digest** and a checkpoint pinned by
**revision**. Neither candidate off the shelf gives both:

| | first-party `laya[serve]` | `enlotec/laya-serve` |
| --- | --- | --- |
| provenance | ships inside the model's own package, but the package is maintained by an individual account (`NandhaKishorM`), not the `convaiinnovations` org | an independent wrapper |
| published image | none we could pin | GHCR, but `latest` / `latest-gpu` — tags, not digests |
| checkpoint revision pin | **not documented** | `LAYA_REVISION` |
| review surface | a PyPI package with releases | 0 stars, 0 forks, 9 commits |

The two blocking rows block *different* candidates, which is why neither is
simply the answer. Building it ourselves buys a digest we control, a revision we
set explicitly, and a provenance chain ending at the model's own publisher.

There is also a name trap worth recording: **`laya-serve` is both the
first-party binary and an unrelated GitHub project**, and the GitHub one is the
first result for that term. Somebody told to "review laya-serve" can easily
review the wrong thing.

## What is pinned, and where each value came from

All three were resolved from their authoritative source on **2026-10-10**:

| link | value | source |
| --- | --- | --- |
| base image | `python:3.12-slim-bookworm@sha256:34386ef0…` | the Docker registry manifest API |
| package | `laya[serve]==0.4.2` (Apache-2.0, `requires_python >=3.10`) | the PyPI JSON API |
| checkpoint | `convaiinnovations/laya-multilingual` at `1720e3e3357cfe1e281542e223f8273b0890ca34` | the Hugging Face model API |

**The checkpoint is baked in at build time**, not fetched on start-up, and
`HF_HUB_OFFLINE=1`. A container that downloads a model on boot behaves according
to whatever the Hub serves that morning — which is the drift the canary exists
to catch, arriving one layer below where the canary can see it.

**We pin the revision ourselves** via `snapshot_download(revision=…)`, because
the package documents no way to. That is the single most useful thing this image
adds over `pip install laya[serve]`: an evaluation record's whole claim is *"this
revision scored this on this corpus"*, and a floating checkpoint makes the record
a statement about nothing.

## What has NOT happened

- **Nothing is deployed.** The workflow is `workflow_dispatch`-only and stops
  after printing the digest to pin.
- **No Compose service exists yet**, and that is sequencing rather than an
  omission: the service must reference a **digest**, and the digest does not
  exist until the first build runs. Adding one with a placeholder would look
  pinned and not be.
- **Latency is unmeasured.** 6d requires p50 and p95 over the adjudication
  corpus on the production VM's own CPU, and that a 500-account residue fits the
  120-second deadline. If it does not: raise the concurrency, or add a GPU.
  **Never raise the deadline silently.**
- **No evaluation record exists**, so even once this is running every account
  gets `NO_EVALUATION` and no verdict. That is the designed safe default, not a
  bug — see the runbook in the design document.
- **The health path is unconfirmed.** The design's wire table says
  `GET /v1/models`; the package's own documentation lists `/models`. The
  Dockerfile uses `/v1/models` via `LAYA_HEALTH_PATH` and the first real build is
  the first moment anything can observe which is right.

## The order the rest has to happen in

1. Dispatch **Laya image** and record the digest it prints.
2. Confirm the health path against the built image; adjust `LAYA_HEALTH_PATH` if
   the package serves `/models`.
3. Add the `laya` service to `deploy/docker-compose.prod.yml`,
   `docker-compose.prod.yml` and `docker-compose.staging.yml`, **pinned to that
   digest** — internal network only, **no published port**, resource limits, and
   `LAYA_BASE_URL` set for the app and worker. The runtime-image pillar
   (`tests/guardrails/runtime-image-pinning.test.ts`) refuses a tag here.
4. Measure p50/p95 on the VM's CPU and record the figures in the design document.
5. Produce the evaluation record on the deployed service with the Step 6b
   harness, and confirm the canary passes **before** any tenant enables
   `LOCAL_ONLY`.
6. Apply the Compose change as `CLAUDE.md` describes — back up the file,
   `docker compose config` to validate, then `docker compose up -d laya`. The
   Compose file is repo-canonical; it reaches the VM through `deploy/apply.sh`.

Steps 4–6 need production access. Step 5 needs a live service. None of them is
in this pull request.
