# OpenShell gateway deployment — 4.3 (#3964)

Everything in this directory belongs to **one host that does not exist yet**: a
dedicated gateway VM. Nothing here is installed on the production app VM, and
nothing here is reachable from `deploy/apply.sh`, which refuses any compose
basename other than `docker-compose.prod.yml`.

| | |
|---|---|
| Release | **v0.1.5**, binary, verified to its published checksum |
| Config | `gateway.toml` → `/etc/openshell/gateway.toml` |
| Unit | `openshell-gateway.service` → `/etc/systemd/system/` |
| Driver images | digest-pinned in `gateway.toml` |
| Telemetry | off by setting **and** by egress policy |
| Inbound auth | OIDC bearer tokens, validated against the issuer's JWKS |
| Operator mTLS | disabled here; the certificate lives on neither VM |

## Why a binary and not a container

Upstream publishes no gateway image for this release. `ghcr.io/nvidia/openshell/gateway`
carries 4000 tags whose highest semantic version is **0.0.91**, built
**2026-07-24**; `docker run … --version` on it reports `openshell-gateway 0.0.91`,
against our binary's `0.1.5`.

It is not merely older. It is missing nine flags the 0.1.5 binary has, three of
which this phase depends on — `--compute-driver`, `--enable-operator-auth` and
`--oidc-jwks-allowed-origins`. Using it would also break the pre-1.0 rule that
the SDK and the gateway move together: a 0.1.5 SDK against a 0.0.91 gateway,
reverting three months of fixes including the ones found on 0.1.2.

## Why its own VM

The Docker compute driver needs the Docker socket, which is **root-equivalent
on the host**. The app VM runs eight compose services, so granting it there
would put the whole stack inside the blast radius of the component whose job is
to contain things.

There is a second reason, specific to packaging: snap-packaged Docker cannot
run these sandboxes at all. snapd's AppArmor denies the `no_new_privs`
transition (Launchpad #1908448, open since 2020), and the driver sets
`no_new_privileges` on sandbox containers — correctly. So the requirement is
not "its own VM" but **its own VM with Docker from Docker's apt repository**.

## The binary's checksum chain

The published checksums cover the **archives**, not the extracted files, so the
chain has four links and all four are checked:

```
published SHA256SUMS → tarball → extracted binary → host-to-VM transfer
```

`openshell-gateway --version` on the VM must print `openshell-gateway 0.1.5`
before the unit is enabled. That is the pin; there is no digest for a binary.

## Digest pinning, and why the tag is not trusted

With no configuration the gateway resolves its driver images **by mutable tag**.
Observed in its own Docker socket traffic:

```
GET /images/ghcr.io/nvidia/openshell/sandbox:0.1.5/json
GET /images/ghcr.io/nvidia/openshell/supervisor:0.1.5/json
```

And that tag moves. The digests in `gateway.toml` are the images this phase ran
and verified, recorded 2026-10-24. Re-resolved 2026-10-27 — **three days
later** — `:0.1.5` pointed at different content in both repositories:

```
sandbox:0.1.5     -> sha256:e9adf9ec…    recorded: sha256:d60222e1…
supervisor:0.1.5  -> sha256:fabcd01f…    recorded: sha256:07cc8b62…
```

Both recorded digests still exist and still pull, so this is not a mistaken
record: a **release** tag was re-pushed within 72 hours. Anyone who pinned
`:0.1.5` believing they had pinned v0.1.5 would have had both images replaced
underneath them, with nothing to see in any diff.

`tests/guardrails/runtime-image-pinning.test.ts` scans this directory's TOML and
requires a digest on every image reference it finds.

## Watchtower

Watchtower does not update anything here, for two independent reasons:

1. **It does not run on this VM.** It is a service in
   `deploy/docker-compose.prod.yml`, on the app VM, watching containers on that
   VM's Docker socket. It has no view of this host.
2. **It is opt-in by label, and nothing here carries the label.** It runs with
   `WATCHTOWER_LABEL_ENABLE: "true"` and `--label-enable`, so only containers
   labelled `com.centurylinklabs.watchtower.enable=true` are candidates. The
   gateway is not a container at all, and the two images it pulls are created by
   the gateway rather than by compose.

The second reason is a **premise that can expire**: drop `--label-enable` and
Watchtower watches everything it can see. It still could not see this VM, but
the guard pins the premise anyway, because an argument whose conditions have
gone false while nothing failed is worse than no argument.

## Egress

`OPENSHELL_TELEMETRY_ENABLED=false` is set in the unit, and anonymous telemetry
is **default on** in this build, which is why the line exists.

**And it works — measured, after an earlier claim here that it could not be
verified.** 0.1e (#3930) ran the gateway against a DNS sinkhole for 300 seconds
per arm, with a positive control and `readyz` gated at both ends of each window:

```
default (unset),  create+list+delete   3013 bytes   (reproduced exactly)
default (unset),  list only               0 bytes
=false,           create+list+delete      0 bytes
```

So telemetry is on by default, this line turns it off completely, and the sends
are EVENT-DRIVEN rather than periodic. The earlier text here said the setting
was not self-verifying, on the strength of three 18-second traced runs that were
indistinguishable — too short, and generating no sandbox lifecycle at all, so it
was watching for an event-driven send while producing no events.

So the endpoint must be denied by the VM's egress policy, independently of the
setting:

```
https://events.telemetry.data.nvidia.com/v1.1/events/jsonstruct
```

That denial is a **precondition below**, not something this directory
configures — there is no egress policy here to point at, and claiming otherwise
would be the same mistake as trusting the setting. A setting whose effect cannot
be observed is a request; the network rule is the enforcement, and it is the
thing to check on the host.

## Inbound authentication

The gateway warns, in plain words, when it has none:

```
WARN Neither mTLS user auth nor OIDC nor sandbox JWT auth is configured
     — the gateway has no authentication mechanism
```

That warning disappearing is how you know the configuration took effect. Set in
`/etc/openshell/env`, which is not in this repository:

```
OPENSHELL_OIDC_ISSUER=<issuer URL>          # validates `authorization: Bearer`
OPENSHELL_OIDC_AUDIENCE=<our client id>     # NOT the default `openshell-cli`
OPENSHELL_OIDC_JWKS_TTL=3600                # the renewal interval
OPENSHELL_BIND_ADDRESS=<private address>    # default 127.0.0.1
```

The worker obtains a token by the OAuth2 **client-credentials** grant and sends
it as a bearer token; the gateway validates it against the issuer's JWKS and
refreshes that key set on the TTL above. Renewal is therefore a property of the
grant and the TTL, not of a long-lived secret on the app VM.

`OPENSHELL_ENABLE_OPERATOR_AUTH=false` is set explicitly, though it is also the
default, so that the default moving does not change this deployment. Operator
access is gateway-wide mTLS with `OU=operator`; that certificate is deliberately
absent from both VMs and is presented out of band by a person.

## Preconditions before enabling

```
[ ] A VM exists, with Docker from Docker's apt repository — NOT snap.
[ ] Linux 6.2+ with Landlock. Under hard_requirement the gateway REFUSES to
    start without it, which is the behaviour to want rather than work around.
[ ] openshell-gateway 0.1.5 at /usr/local/bin, checksum chain checked.
[ ] /etc/openshell/pki/jwt/signing.pem exists, root-owned, mode 0400.
    The unit ASSERTS this and FAILS without it — it does not skip.
[ ] /etc/openshell/env written with the four variables above.
[ ] Egress policy denies events.telemetry.data.nvidia.com.
[ ] `openshell-gateway --version` prints 0.1.5 on the VM.
```

## The VM is not provisioned, and that is an owner decision

This is the one precondition that is not a task. The GCP project has **one**
commitment, `agrent-inflect-e2-3yr` (36-month, GENERAL\_PURPOSE\_E2,
europe-west1, `VCPU;MEMORY = 4;32768`, active to 2029-09-21), and a commitment
is **regional and aggregated across every instance in the family** — not
per-VM. Both existing VMs are E2 in europe-west1 and together they consume it
exactly.

So a third VM is **not covered** and bills entirely on-demand. The last time
one of these VMs was resized beyond the commitment it billed about EUR 64 per
month and was reverted the same day.

Provisioning is therefore a cost decision, not a deployment step, and nothing
in this directory provisions anything. Everything here is ready for a host that
somebody has decided to pay for.

## Upgrades

Pre-1.0, **the SDK and the gateway move together.** Upgrading one alone is the
failure this release line makes easy: the version spaces are confusing on
purpose-adjacent grounds — releases run `0.1.x`, the published documentation
versions itself `v0.0.116`, and the container images stop at `0.0.91`. Three
numbering spaces, none of them the same.

### The checklist

Steps marked **[test]** fail in CI if skipped — `tests/guards/sandbox-runtime-channels-match-the-runtime.test.ts`
holds the pinned release as a constant and every recorded measurement against
it, so moving the pin reddens the build until each one is re-established (5.3,
#3973). The unmarked steps are still yours to do.

```
[ ]       new binary at /usr/local/bin, checksum chain re-checked (4 links)
[ ]       `openshell-gateway --version` on the VM prints the new release
[ ]       driver digests RE-RESOLVED and recorded in gateway.toml
[ ] [test] every image reference in deploy/openshell/*.toml is digest-pinned
[ ]       the SDK bumped in the SAME change — pre-1.0 they move together
[ ] [test] no file claims a release newer than the pin (a half-done upgrade)
[ ] [test] every phase 0.1 fact re-verified against the new release
[ ]          0.1b above all: is `enforcement` unset still AUDIT mode?
[ ] [test] vendored skills re-pinned, VENDORED.md Tag matches the pin
[ ]       the NOTICE commit updated, and THE NEW SKILL TEXT READ before merging
[ ]       policy prover re-run
[ ]       `npm run skills:evaluate` re-run (needs the owner's key)
[ ]       scanner contract tests re-run
```

**Why 0.1b is called out.** #3927 calls it "the most consequential fact in the
roadmap". An endpoint with `enforcement` unset runs in audit mode:
`NETWORK_ENFORCEMENT_MODE_UNSPECIFIED` is zero on the wire and documented as
"log violations and allow traffic", so an omitted field, a proxy-dropped field
and explicit audit are the same bytes — and all three allow the traffic the
policy appears to forbid. Every verdict the scanner and the skill derive from a
policy rests on that reading. A release that changed it, or renamed the enum so
our explicit value stopped matching, would invert what a policy means with
nothing visible in any diff.

That is why the re-verification is a test and not a line on a checklist: the
discovery has to happen in CI rather than in a client's estate.
