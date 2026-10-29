# OpenShell: the v0.1.5 → v0.1.6 upgrade

Phase 5.3 (#3973), part of #3924. This is the first exercise of the upgrade
checklist that phase built, run against a release that appeared four days after
the pin was set.

It is a **new** note rather than an edit to `2026-10-25-openshell.md`.
`docs/implementation-notes/` is historical-by-path — `docs-accuracy` classifies
the subtree `historical` and exempts it from the freshness banner, so adding a
classification entry fails the ratchet rather than satisfying it, and rewriting
the earlier note would destroy the record of what was true in v0.1.5. Where this
upgrade **changed** an earlier finding, the correction is stated here and names
the sentence it supersedes.

## 1. The new pin

| | |
|---|---|
| Release | **v0.1.6**, tagged 2026-10-27 |
| Vendored skills commit | `ac7f615cd12d5cc49cb16eb1f5f10ffeb1e90f47` |
| Gateway binary sha256 | `6451533ec9cbc89c040897173a30bb4efc4013fe78b390ce4f6bc18d2de6072f` |
| CLI binary sha256 | `962d7d3a54b9a0a68d4b21a41faf5720b619f2b7c0ac0e6762b8904c3d14159d` |
| Sandbox runtime image | `ghcr.io/nvidia/openshell/sandbox@sha256:1038eb5c1f191fa3c34684fd7041b891c78ec570979d487f36e06e08f91bfb63` |
| Supervisor image | `ghcr.io/nvidia/openshell/supervisor@sha256:ce859a7d77ee515d3fe0b3c7dc61286516f402eb1d25c761d806d9ae5ed96c0b` |

All four checksum links were re-checked, in the same order the earlier note
sets out — published `SHA256SUMS` → tarball → extracted binary → the file
installed on the VM. The two image digests were resolved from the moving
`:0.1.6` tags and then **verified as a matched set** by creating a sandbox on
them; a digest that resolves is not evidence that the pair works together.

## 2. What the upgrade actually changed

Two things, and only one of them is a behaviour change in our direction.

**The gateway now refuses to start without inbound authentication.** v0.1.5
started with none configured and wrote a warning. v0.1.6 exits unless OIDC,
mTLS user or operator authentication, or gateway JWTs are present. This is the
single most valuable thing in the release for this deployment, because the
compute driver holds a Docker socket that is root-equivalent on its host, so a
gateway that starts unauthenticated is a root-equivalent open port.

It has one documented off switch — `allow_unauthenticated_users`, which
upstream marks "trusted local development only" — and setting it restores the
v0.1.5 behaviour **silently**. A new assertion in
`tests/guards/sandbox-runtime-channels-match-the-runtime.test.ts` fails if our
`deploy/openshell/gateway.toml` ever sets it to anything but `false`. The
detector strips TOML comments, because that file names the switch in prose in
order to explain the prohibition: a `grep` for the key fails on the one file it
is meant to clear. Mutation-proved by adding `[openshell.gateway.auth]` with
the switch on, which the assertion reported by line.

**The OCSF log widened its auth-adjacent coverage.** 0.1.6 records denials,
accepted credentials, SSH session tokens and sandbox token checks, and now logs
successful logons where 0.1.5 logged only failures. This does **not** change
0.1g's finding: none of the five sandbox lifecycle decision kinds — created,
policy changed, network denied, deleted, token minted — produces a record, and
a deleted sandbox remains recoverable from neither the log nor the API
afterwards. The widening is real and it is adjacent to, not inside, the gap.

## 3. The seven phase-0.1 facts, re-verified

Every fact carries `verifiedAgainst: '0.1.6'` in the guard. What that cost, and
what it found:

| Fact | Re-verification | Result |
|---|---|---|
| 0.1a policy schema v2 | `--help` surface diffed flag by flag | **33/33 identical**; plus the start-up refusal above |
| 0.1b unset enforcement = audit | proto3 zero-value re-read at the new tag | unchanged — `UNSPECIFIED` is still zero on the wire and documented log-and-allow |
| 0.1c landlock `best_effort` default | config re-read; `hard_requirement` behaviour | unchanged |
| 0.1d dropped-tool MCP rule | upstream #4679 re-checked | still **open**; the release still exposes no proposal flow and no policy-body read, so it remains not-established-as-fixed |
| 0.1e telemetry on by default | two observation windows, same activity | **reproduced**: 3013 bytes with telemetry on, 0 with `OPENSHELL_TELEMETRY_ENABLED=false` |
| 0.1f no NVIDIA JS SDK | PyPI re-read | SDK is now 0.1.6 and **still Python** (`requires_python >=3.11`) |
| 0.1g no lifecycle decision in OCSF | all five decision kinds re-exercised | still zero records; coverage widened elsewhere (§2) |

The flag diff is the load-bearing one. "The flag surface is identical" is the
statement that lets every v0.1.5 measurement stand without being re-run, and it
is cheap to check and expensive to assume.

### What did NOT change, and is worth saying out loud

- **There is still no gateway container image for the pinned release.**
  Published images stop at `0.0.91`, built three months before 0.1.5, and lack
  nine flags this deployment passes — `--compute-driver`,
  `--enable-operator-auth` and `--oidc-jwks-allowed-origins` among them. The
  gateway still runs from the checksum-verified binary.
- **Telemetry is still on by default.** The upgrade did not change the default,
  only our confidence in the measurement.
- **Digest pinning is still load-bearing, not ceremony.** Upstream re-pushed the
  `:0.1.5` tag inside 72 hours. The two digests in §1 are what `gateway.toml`
  carries; the tags are what moved.

## 4. Method, and the one thing that nearly went wrong

The re-verification ran on the lab VM against both releases installed side by
side (`v0.1.5/` and `v0.1.6/` under `/home/lab/openshell/`), with the v0.1.5
config kept as `gateway.toml.015` so a rollback is one `cp`.

The telemetry window is the part that needed care, and it is the mistake worth
recording. Restarting the gateway with a fixed `sleep` after `pkill` produced
`failed to bind health port 8081: Address already in use` — the old process was
still holding the port — and the gateway was therefore **dead for the whole of
a ten-minute observation window** that I read as "0 bytes, telemetry off".
Two corrections, both now standing practice for any window measured against
this gateway:

1. poll the port until it is actually free, then poll `readyz` until it answers.
   A `sleep` is a guess about a race;
2. gate on `readyz` at the **end** of the window as well as the start. The
   start-of-window check cannot see a process that dies at minute two, and a
   dead gateway emits exactly the same zero bytes as a disabled one.

The second is the general shape: when the expected signal is an absence, the
instrument's own health has to be confirmed at both ends, or the absence is
unattributable.

## 5. Checklist state

5.3's checklist is satisfied for the artefacts in this repository: pin, skills,
digests, facts, docs and the deployment config all name v0.1.6, and a guard
fails if any file claims a release newer than the pin. Three items are deferred
because they need credentials or a run this repository cannot perform on its
own — the policy prover re-run, `npm run skills:evaluate`, and the scanner
contract tests — and they are recorded on #3973 rather than being marked done
here.
