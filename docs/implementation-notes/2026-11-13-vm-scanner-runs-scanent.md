# 2026-11-13 — The production VM's harness scanner runs scanent

**Commit:** `feat(deploy): run scanent 0.15.0 as Inflect's own estate scanner on the VM`

## Design

Step 3 of 4 of scanent #26 on the Inflect side. The opt-in overlay
`deploy/docker-compose.harness-scanner.yml` ran Inflect's in-repo scanner
(`ghcr.io/rodnapamet/agent-harness-scanner@sha256:e905…`, 0.13.0, private
package). It now runs scanent 0.15.0, the standalone product that carries
every source and rule that package does, from its public image pinned by the
multi-arch index digest:

```
ghcr.io/rodnapamet/scanent@sha256:4c688362967681cec569ca6bff3f0b90de0423443b90be9f9dfa347c29faa171
```

Signed keylessly by
`https://github.com/RodnaPamet/scanent/.github/workflows/release.yml@refs/tags/v0.15.0`
(`cosign verify` passes for that identity, and `gh attestation verify` passes
for its SLSA provenance). Both services, the scanner and its egress proxy, run
that one image; `vm.sh` still refuses two digests.

The deployment shape is unchanged: dispatch-only `Scanner VM` workflow, the
`production` reviewer, `.env.scanner` alone, an internal network whose one
neighbour is the CONNECT-only proxy, the same five credential variables and the
same signing key, so the public key registered in Inflect stays valid.

The difference map, read from both codebases:

| | before | scanent 0.15.0 |
| --- | --- | --- |
| entrypoint | the image's (tsx over TypeScript source) | `node /app/packages/scanner/dist/cli.js` (image default) |
| scanner command | `schedule --config /etc/agent-harness-scanner/config.json` | `schedule --config /etc/scanent/config.json` |
| proxy | `node --import tsx …/agent-harness-scanner/src/egress-proxy.ts` | `node /app/packages/scanner/dist/egress-proxy.js` |
| mount | `./harness-scanner:/etc/agent-harness-scanner:ro` | `./harness-scanner:/etc/scanent:ro` |
| base | Node image | distroless: `node` on PATH, no shell |
| writes | none | none: only the `file` output writes, and it is not configured |
| configuration | no `outputs` | `"outputs": [{"kind":"inflect"}]` |
| scanner env | proxy variables | the same, plus `EGRESS_PROXY_CHECKS_ADDRESSES=1` |
| hardening | read-only, uid 1000, caps dropped | the same, plus `pids_limit: 256` on both |
| dry run | the signed report on stdout | the same, first line of stdout |

## Files

| File | Role |
| --- | --- |
| `deploy/docker-compose.harness-scanner.yml` | scanent's digest on both services; its paths; the previous digest in a rollback comment |
| `deploy/harness-scanner/config.pilot.example.json` | gains `outputs: [{"kind":"inflect"}]` |
| `deploy/harness-scanner/remote.sh` | scanent's image pattern, config path and proxy path; `configure` has the pinned image parse the staged configuration and compares its `hosts --format egress-allow` with the overlay's `EGRESS_ALLOW` before installing anything; the dry-run summariser reads the first stdout line |
| `deploy/harness-scanner/vm.sh` | reads the scanent digest from the overlay |
| `deploy/harness-scanner/{README.md,scanner.env.example,stage-config.sh}` | the image, its verification, the difference table, the move and rollback order |
| `tests/unit/harness-scanner-vm-templates.test.ts` | moved from `tests/unit/agent-harness-scanner/pilot-deployment-template.test.ts`, no longer imports that package |
| `tests/guards/deploy-compose-canonical.test.ts` | the overlay's new values, and the order of the configuration check in `configure` |

## Decisions

- **The index digest, not the amd64 manifest's.** The VM is amd64 today; the
  index digest is what the release signed and attested, and it stays right if
  the VM's architecture changes.
- **`outputs` is explicit.** scanent reads an absent `outputs` beside an
  `inflect` block as "post", so the old template would have worked. Stating it
  makes the one thing the scanner writes to visible, and makes a later
  `file` output a reviewed edit that also needs a writable mount.
- **The template test no longer runs a parser.** Inflect's package parser
  refuses `outputs` (it is strict and predates it), and scanent's parser is not
  a dependency of this repository. The parse moved to where the pinned image is:
  `configure` runs `hosts --config … --format egress-allow` in the pinned image,
  offline, before installing anything, and refuses a refused configuration or a
  host set that differs from `EGRESS_ALLOW`. The Jest test keeps what a
  template can quietly lose: no secret-shaped string (the contract's own
  `looksLikeSecret`, which scanent's parser applies first), the four sources,
  the one output, the environment file's names, and the allowlist equal to the
  hosts scanent fixes for those kinds plus the Inflect origin. The template was
  parsed with scanent 0.15.0's own `parseScannerConfig` and its CLI for this
  change.
- **`EGRESS_PROXY_CHECKS_ADDRESSES=1`.** scanent resolves a host the
  configuration names (an MCP server, a self-hosted LangSmith) before each
  request; on the internal network it has no resolver for an outside name, so
  scanent's own egress overlay hands that check to its proxy, which resolves,
  checks and dials the address itself. The pilot names no such host today, so
  it changes nothing now; without it, adding one would read UNREACHABLE.
- **512m kept.** scanent's own Compose file sets 1536m for its `file` output's
  scoring and rendering (its `docs/scanner.md`). With the `inflect` output that
  does not run. A dry run of the pinned image under this overlay, every source
  refused by an empty allowlist, peaked at 125 MiB resident; the C1 measurement
  of the previous scanner on the VM was 155 MiB.
- **`packages/agent-harness-scanner` stays** until step 4; nothing on the VM
  references its image now. The `Scanner image` workflow that published it is
  left for that step too.
