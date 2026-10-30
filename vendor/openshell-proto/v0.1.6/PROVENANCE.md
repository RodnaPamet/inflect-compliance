# OpenShell gRPC contract, vendored at `v0.1.6`

The gateway's own protocol definition, vendored because this product needs a
gRPC client to talk to it (#4561) and a client built against a reading of the
contract is a client that can disagree with the gateway silently.

| | |
| --- | --- |
| Source | `NVIDIA/OpenShell`, path `proto/` |
| Tag | `v0.1.6` |
| Tag object sha | `ac7f615cd12d5cc49cb16eb1f5f10ffeb1e90f47` (a commit, not an annotated tag) |
| Commit date | 2026-10-27T15:44:53Z |
| Retrieved | 2026-10-30 |
| Licence | Apache License 2.0 — read **at this tag**, and byte-identical to the copy already vendored at `.claude/skills/LICENSE-Apache-2.0.txt` (`sha256:d07c0367…`, 11,431 B), so there is one licence copy rather than two that can drift |

## Blob shas — checkable without trusting this note

| Blob sha | Bytes | File | Package |
| --- | --- | --- | --- |
| `1be9dc7da899cd125f8f70c28b5a4da5bde0dfa7` | 159,222 | `openshell.proto` | `openshell.v1` |
| `80344bd4a126cf88112d1141349b1430e7439d36` | 24,108 | `sandbox.proto` | `openshell.sandbox.v1` |
| `7506360d672eb82853afce24ec62223414fbcc4a` | 4,892 | `datamodel.proto` | `openshell.datamodel.v1` |
| `6f127cb2810e2c39030e038c41adb15511a1037f` | 1,351 | `options.proto` | `openshell.options.v1` |

These are **git blob** shas, not content hashes, and that is deliberate: the
same value is printable from both sides without any tooling of ours.

```bash
git hash-object vendor/openshell-proto/v0.1.6/openshell.proto
gh api "repos/NVIDIA/OpenShell/contents/proto/openshell.proto?ref=ac7f615cd12d5cc49cb16eb1f5f10ffeb1e90f47" --jq .sha
```

All four matched when this was vendored, which is what makes "unmodified" a
verified claim rather than an assurance. The same primitive as
`tests/fixtures/a2a/PROVENANCE.md`, for the same reason.

## Pinned by the commit the DEPLOYED gateway runs

`deploy/openshell/gateway.toml` pins the 0.1.6 images by digest and the guard in
`sandbox-runtime-channels-match-the-runtime` holds every recorded fact to that
release. A contract read from `main` would answer about main — and upstream has
already demonstrated that it re-pushes release tags (`:0.1.5` resolved to
different image content within 72 hours, recorded in the deploy README), so
"the current contract" is not a stable thing to build against.

The commit here is the one `.claude/skills/VENDORED.md` already pins for the
vendored developer skills. One commit for both, so the skills that describe the
gateway and the contract used to call it cannot describe different gateways.

## Vendored WHOLE, not trimmed to the five methods we call

The transport calls five of the service's **86** rpcs. The files are vendored
entire anyway, for the reason the a2a note gives: a trimmed file is our
editorial selection, and a reviewer can no longer check it against upstream by
its sha. It also keeps the next method one import away rather than one
re-vendoring away.

`openshell.proto` declares exactly 86 rpcs in `service OpenShell`, confirmed two
ways on 2026-10-30 — counted in this file, and `grpcurl list` against the
**running** 0.1.6 gateway over mTLS. Both say 86.

## The closure is these four files and the google well-known types

```
openshell.proto  -> datamodel.proto, options.proto, sandbox.proto,
                    google/protobuf/{duration,struct,timestamp}.proto
sandbox.proto    -> datamodel.proto, google/protobuf/{struct,duration}.proto
datamodel.proto  -> options.proto, google/protobuf/timestamp.proto
options.proto    -> google/protobuf/descriptor.proto
```

Nothing else is imported, so no fifth file is missing. `protobufjs` bundles the
`google/protobuf/*` types, which is why they are not vendored here — vendoring
them would create a second copy of definitions the loader already has and could
disagree with.

## Refreshing at a later release

Change the directory name, re-fetch the four files at the new commit, record the
new blob shas above, and expect `openshell-proto-matches-its-provenance` to fail
until they are right. Re-pin `VENDORED.md` in the same change, and check the
rpc count: a method this transport calls could be renamed, and the loader will
say so at load time rather than at call time.
