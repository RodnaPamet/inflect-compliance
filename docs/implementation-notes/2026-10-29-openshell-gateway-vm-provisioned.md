# OpenShell: provisioning the gateway VM under a 5 USD/month cap

Part of #3924. The owner decided on 2026-10-29 to pay for the third VM, with a
hard **5 USD/month** cap, and that cap is the constraint every choice below
answers to.

A new note rather than an edit: `docs/implementation-notes/` is
historical-by-path, and `2026-10-29-openshell-0-1-6-upgrade.md` recorded the
upgrade. This records the host.

## 1. The trigger fired, and the memo named it

The earlier cost memo concluded "spend nothing yet" with a named trigger: a
production caller for `openShellToolExecutor`. #4443 is that caller — the
Powerpipe collectors now run in a sandbox and fail closed when one is
unreachable. So the gateway stopped being a thing to measure and became a thing
to run.

## 2. The cap is a runtime budget

Rates are real europe-west1 on-demand SKUs read from the Cloud Billing Catalog
API, not recalled. The USD set was cross-checked against three independently
fetched USD SKUs; they agreed with the EUR set on a single ratio to nine
decimal places, which is what makes the conversion a derivation rather than an
assumed exchange rate.

```
e2-standard-2   2 x $0.023993370/vCPU-h + 8 x $0.003216090/GiB-h = $0.07371546/h
20 GB pd-balanced                        $0.100/GiB-month        = $2.00/month
ephemeral external IP                    $0.005/h
```

The disk is the **only** always-on charge, so the cap reduces to:

```
($5.00 - $2.00 disk - $0.02 egress) / ($0.07371546 + $0.005) = about 38 h/month
```

**38 hours a month — 1.25 h/day.** A 30-minute nightly scan uses 39%.
Projected spend at that rate is about **$3.21/month**. A VM left running for a
month would cost about **$54 — 17x the cap**, and that ratio is the whole
design: the shape barely matters, the runtime is everything.

The project's single commitment (`agrent-inflect-e2-3yr`, 4 vCPU / 32 GiB E2,
europe-west1) is consumed **exactly** by the two existing `e2-highmem-2` VMs,
so this third VM bills fully on-demand. That was already recorded in
`deploy/openshell/README.md` and it held up.

## 3. Sizing came from a measurement

On the lab VM, a 0.1.6 gateway with six containers — three sandboxes, three
supervisors — used **946 MiB of RAM and 3.5 GB of disk**, both driver images
totalling 316 MB. So 8 GiB is roughly 8x headroom for a Powerpipe collector in
a sandbox, and 2 vCPU matches what runs the entire application today.

`pd-balanced` over `pd-standard` costs $1.20/month more and is still right:
`pd-standard` scales IOPS with capacity, so 20 GB would get about **15 read
IOPS** — unusable on a VM whose purpose is to boot, pull images and run for
half an hour.

## 4. Three controls, because an estimate is not a control

1. **`openshell-idle-shutdown.timer`** — the mechanism. Every five minutes:
   is `openshell_server_supervisor_sessions` zero **and**
   `openshell_server_grpc_requests_total` unchanged? Four consecutive yes →
   shut down.
2. **A stop-only daily schedule** at 05:00 Europe/Sofia. No start schedule, on
   purpose: a day with no scan costs nothing, and starting the VM is the
   caller's act. This is the backstop for a broken idle timer.
3. **A label-scoped budget**, 5 USD with alerts at 50/80/100/120%.

### The two signals are two for a reason

The gauge alone reads zero in the gap between one sandbox being deleted and the
next created, so a multi-benchmark scan would be shot in the back. Requiring
the request counter to be unchanged as well means "no sandboxes **and** nobody
talking to us".

### A failed scrape is not idle

If the metrics endpoint cannot be read the state is *unknown*, and treating
unknown as idle would shut the VM down exactly when something is wrong. The
strike counter resets on a scrape failure, erring towards staying up and being
visible in the budget.

### The disk had to be labelled separately

A GCP budget filtered by label only sees resources that **carry** the label, and
**a disk does not inherit its instance's labels**. The budget was created,
looked correct, and silently excluded the single largest always-on charge in the
table above until the disk was labelled too. A budget that omits 62% of the
steady-state cost is worse than no budget, because it reports green.

## 5. What provisioning found that reading could not

Three defects in artefacts that had been reviewed and merged without a host to
run them on.

**The unit could not start the gateway at all.** `ProtectHome=yes` plus root's
own HOME:

```
Error:   × failed to create /root/.local/state/openshell/gateway
  ╰─▶ Read-only file system (os error 30)
```

The gateway writes state under `$HOME/.local/state`. `XDG_STATE_HOME` is the
lever you would reach for and it does not work — the string does not occur in
the 0.1.6 binary — so HOME is the only thing that moves the path. The fix is a
pair: a systemd-owned `StateDirectory` and `HOME` pointing into it, with
`ProtectHome=yes` kept. A guard now fails if the unit protects /root without
redirecting HOME, and fails if HOME points outside what systemd owns.

Worth recording: `StartLimitBurst=3` behaved exactly as its comment promised —
three attempts, then stop and stay failed. The failure was legible in one
`journalctl` read instead of being an endless restart loop.

**The env contract was four variables and needed eight.** Three of the missing
ones are fatal: without `--tls-cert`/`--tls-key` the 0.1.6 gateway exits
immediately. `--disable-tls` is the wrong way out — nothing terminates TLS in
front of this VM, so plaintext would put a root-equivalent Docker socket behind
an unauthenticated VPC port.

**The project's network defaults are wrong for this host.**
`default-allow-internal` opens every port to `10.128.0.0/9` and
`default-allow-ssh` opens 22 to the internet. The VM opts out with a
priority-100 deny-all plus two priority-90 allows (IAP for SSH, the app VM for
the three gateway ports), verified from GCP's `get-effective-firewalls` view and
then probed from the internet.

## 6. Two probes that proved nothing, and how they were caught

Both are the same failure: **a probe whose two arms produce identical output.**

**The TLS probe.** `curl https://…:17670/` returned 404 with a client
certificate and 404 without one, which reads like "mTLS is not enforced". It
is not evidence either way: 404 only means `/` is not a gRPC path, and the HTTP
layer answers it before authentication is considered. The discriminating probe
was `openshell whoami`, which is refused — *"whoami requires authentication …
missing authorization header"*. `openssl s_client` separately confirms the
server does send a CertificateRequest.

**The idle-shutdown control.** The script was written against
`http://127.0.0.1:9091/metrics`, and the gateway binds the **private** address.
So every scrape failed. Then the positive control — break the endpoint, check
it reports UNKNOWN — passed, because the normal case was *already* broken and
both arms printed the same line. The fix was to derive the address and port from
`/etc/openshell/env`, the one file that decides them, after which the arms
differ: reachable-and-idle counts strikes `1/4`, `2/4`; a broken endpoint says
UNKNOWN and resets to zero.

## 7. Verified on this host

Checksum chain end to end, re-checked **on the VM** after transfer (installed
digests `6451533e…` and `962d7d3a…` match the published sums);
`openshell-gateway 0.1.6`; service active with listeners bound to the private
address; Docker driver connected; `readyz`/`healthz` 200; plaintext to 17670
refused; an unauthenticated gRPC call refused; the telemetry endpoint sinkholed
and unreachable (HTTP 000); 22/17670/8081 unreachable from the internet while
IAP SSH and outbound egress work.

And `no_new_privs`, as a discriminating pair on two hosts:

```
dev box (snap docker)      exec /bin/echo: operation not permitted
gateway VM (apt docker)    no_new_privs transition OK
```

That is the Launchpad #1908448 AppArmor failure reproducing on one host and
absent on the other — which is why the precondition says Docker from Docker's
apt repository and not snap.

## 8. Not verified, and left open deliberately

**That an authenticated caller is accepted.** The negative direction is proven;
the positive one is not. The CLI cannot close it: `openshell gateway add
--local` reports that mTLS client certificates were "not found … Start the
gateway package first so it provisions client TLS material" — and that package
is the container distribution this deployment deliberately does not use,
because no gateway image exists for the pinned release.

The caller that matters is the application's own gRPC transport
(`src/lib/agentic/openshell/transport.ts`), so the positive control belongs with
that wiring rather than with provisioning. **OIDC is also unconfigured**, and
its variables are commented out rather than filled with an invented issuer,
which would produce a gateway that starts and validates nothing.
