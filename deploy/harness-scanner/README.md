# The harness scanner on the production VM

Inflect's own estate scanner (#3665) runs on the production VM from the opt-in
overlay `deploy/docker-compose.harness-scanner.yml`. A person sets it up and
starts it by dispatching the **Scanner VM** workflow
(`.github/workflows/scanner-vm.yml`), whose runs the `production` environment's
reviewer approves. Every credential stays a GitHub secret. None passes through
a chat, a terminal or a session.

## The image: scanent

Since scanent #26 the overlay runs **scanent**, the standalone scanner product
(github.com/RodnaPamet/scanent), and not this repository's
`packages/agent-harness-scanner`. Both services, the scanner and its egress
proxy, run one image pinned by its multi-arch index digest:

```
ghcr.io/rodnapamet/scanent@sha256:4c688362967681cec569ca6bff3f0b90de0423443b90be9f9dfa347c29faa171   # 0.15.0
```

The image is public, so the VM pulls it with no registry login. Before a
digest goes into the overlay, check that scanent's release workflow signed it
and attested its build:

```bash
IMAGE=ghcr.io/rodnapamet/scanent@sha256:<digest>
cosign verify "$IMAGE" \
  --certificate-identity https://github.com/RodnaPamet/scanent/.github/workflows/release.yml@refs/tags/v<version> \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
gh attestation verify "oci://$IMAGE" --repo RodnaPamet/scanent \
  --signer-workflow RodnaPamet/scanent/.github/workflows/release.yml --source-ref refs/tags/v<version>
```

The index digest is what `docker-content-digest` answers for
`/v2/rodnapamet/scanent/manifests/<version>` asked with an OCI index or
manifest-list `Accept` header (the SHA-256 of that body).

What the move changed, and what it did not:

| | Inflect's scanner (before) | scanent 0.15.0 |
| --- | --- | --- |
| Image | `ghcr.io/rodnapamet/agent-harness-scanner`, private | `ghcr.io/rodnapamet/scanent`, public, signed |
| Scanner command | `schedule --config …` | the same verbs (`schedule`, `scan --dry-run`, `public-key`), plus the offline `hosts` |
| Egress proxy | `node --import tsx …/agent-harness-scanner/src/egress-proxy.ts` | `node /app/packages/scanner/dist/egress-proxy.js` |
| Configuration in the container | `/etc/agent-harness-scanner/config.json` | `/etc/scanent/config.json` (the VM path is still `/opt/inflect/harness-scanner/`) |
| Configuration | no `outputs` | `"outputs": [{"kind": "inflect"}]`: post to the ingest, write nothing |
| Environment variables | the five in `scanner.env.example` | the same five, read the same way |
| Signing key | `SCANNER_SIGNING_KEY` in `.env.scanner` | the same key, kept: the registered public key stays valid |
| Report | contract `/4` | contract `/4`, from the same `@rodnapamet/scanent-contract` the ingest uses |
| User, filesystem | uid 1000, read-only | uid 1000, read-only, distroless (no shell), `pids_limit: 256` |
| Memory | 512m | 256m (capacity C1b, from measured peaks of 155 and 134 MiB): scanent's own 1.5 GiB is for its `file` output's rendering, which does not run here |

scanent reads each credential once, when `schedule` starts. `configure`
rewrites `.env.scanner`, and the following `start` re-creates the container
because its environment changed.

| File | What it is |
| --- | --- |
| `config.pilot.example.json` | The pilot estate's scanent configuration. The workflow fills in the four ids from secrets. |
| `scanner.env.example` | The variables `.env.scanner` holds, for reference. The workflow writes the real file. |
| `stage-config.sh` | On the runner: fills the template and writes the credential lines. |
| `vm.sh` | On the runner: stages `remote.sh` on the VM over IAP and runs it as root. |
| `remote.sh` | On the VM: the actions below. Prints names and states, never a value. |

## One-time setup

### In GCP (Cloud Shell, as a project owner)

A service account for the workflow, reachable only through Workload Identity
Federation, so there is no key to leak or rotate:

```bash
PROJECT=hazel-design-419410
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
SA="scanner-vm-operator@${PROJECT}.iam.gserviceaccount.com"

gcloud iam service-accounts create scanner-vm-operator --project "$PROJECT" \
  --display-name "Scanner VM workflow (GitHub Actions)"

# SSH with sudo through OS Login, over IAP, to this one project's instances.
for ROLE in roles/compute.osAdminLogin roles/iap.tunnelResourceAccessor roles/compute.viewer; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:${SA}" --role "$ROLE" --condition=None
done
VM_SA="$(gcloud compute instances describe inflect-compliance --zone europe-west1-b --project "$PROJECT" \
  --format='value(serviceAccounts[0].email)')"
gcloud iam service-accounts add-iam-policy-binding "$VM_SA" --project "$PROJECT" \
  --member "serviceAccount:${SA}" --role roles/iam.serviceAccountUser

# GitHub's tokens, admitted only from this repository's `production` environment.
gcloud iam workload-identity-pools create github --project "$PROJECT" --location global \
  --display-name "GitHub Actions"
gcloud iam workload-identity-pools providers create-oidc inflect-compliance --project "$PROJECT" \
  --location global --workload-identity-pool github \
  --issuer-uri https://token.actions.githubusercontent.com \
  --attribute-mapping 'google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.environment=assertion.environment' \
  --attribute-condition "assertion.repository == 'RodnaPamet/inflect-compliance' && assertion.environment == 'production'"
gcloud iam service-accounts add-iam-policy-binding "$SA" --project "$PROJECT" \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/attribute.repository/RodnaPamet/inflect-compliance"

echo "GCP_WIF_PROVIDER=projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/providers/inflect-compliance"
echo "GCP_VM_OPERATOR_SA=${SA}"
```

Two things to check on the instance:

- **OS Login.** `roles/compute.osAdminLogin` works only where OS Login is on.
  Read `metadata.items.enable-oslogin` on the instance and the project. If it is
  off, `gcloud compute instances add-metadata inflect-compliance --zone
  europe-west1-b --metadata enable-oslogin=TRUE` turns it on. A project owner's
  own `gcloud compute ssh`, which `deploy/apply.sh` uses, keeps working.
- **IAP.** `deploy/apply.sh` already reaches the VM with `--tunnel-through-iap`,
  so the firewall rule admitting `35.235.240.0/20` on tcp:22 is in place.

The scanner's own GCP read credential is a different service account, holding
`roles/iam.serviceAccountViewer` and nothing else. Its JSON key is the
`GCP_SCANNER_KEY` secret below. It is the one long-lived key, because the
scanner on the VM has no GitHub token to federate with.

### In Inflect

1. Register the scanner as an agent in Inflect's tenant. Its id is
   `SCANNER_AGENT_ID`.
2. Create an API key bound to that agent, holding `admin:harness_ingest` and
   `mcp:read`, with "Agent tool calls only through a short-lived, tool-scoped
   token" ticked (#5004). That is `INFLECT_INGEST_KEY`.
3. Grant the scanner agent the tool `get_harness_register`, and nothing else.
   Keep it at autonomy 1 with no behaviour profile: that bound is what its
   read-only H3 verdicts stand on.
4. Give it a policy card.
5. The estate the scanner reports for declares its four sources: `entra-sp`,
   `inflect-register`, `cicd` and `gcp-sa`. The pilot read Inflect's own
   `/api/mcp` as an `mcp` source until 2026-11-08 (#5004 part C); an estate
   still declaring `mcp` reads STALE until that source is removed from it.

The scanner runs behind its own egress proxy (#5004 part C; the overlay's
header), which ships in scanent's image. `configure` refuses an image without
it. It also has the pinned image read the staged configuration, offline,
before anything is installed: a configuration the image refuses stops there,
and so does one whose hosts (`hosts --format egress-allow`) are not exactly
the overlay's `EGRESS_ALLOW`.

### In GitHub (Settings → Environments → `production`)

- **Variables:** `GCP_WIF_PROVIDER` and `GCP_VM_OPERATOR_SA`, as printed above.
- **Secrets:**
  - `SCANNER_TENANT_SLUG`
  - `SCANNER_AGENT_ID`
  - `SCANNER_ENTRA_DIRECTORY_ID`
  - `SCANNER_ENTRA_CLIENT_ID`
  - `INFLECT_INGEST_KEY`
  - `ENTRA_CLIENT_SECRET`
  - `SCANNER_GITHUB_READ_TOKEN`: GitHub reserves the `GITHUB_` prefix. It becomes `GITHUB_READ_TOKEN` on the VM.
  - `GCP_SCANNER_KEY`: the JSON key file's contents.

  The four ids are secrets only so they are masked in the logs, which are
  public.

## The actions, in order

| Action | Does | Done when |
| --- | --- | --- |
| `preflight` | Lists what is on the VM, by name, and pulls the pinned image | `image pull: ok` |
| `configure` | Checks the configuration with the pinned image, then installs the overlay, the configuration and `.env.scanner` (root, 0600). Generates the signing key on the VM the first time and keeps it after | `configuration: accepted …` and `configured: …` |
| `public-key` | Prints the scanner's public key | Register it against the scanner agent in Inflect |
| `dry-run` | Starts the egress proxy, then one scan, not posted, summarised per source and with the egress proof | `every source COMPLETE` and `egress: enforced` |
| `start` | `up -d harness-scanner`. It scans at once, then every 24 hours | `status` shows it running |
| `status` | The container's state and its last 30 log lines | |
| `stop` | Stops and removes the scanner and its egress proxy | |

`configure` can be re-run at any time, to rotate a credential or change an id.
It keeps the signing key, so the registered public key stays valid.

## Moving a running scanner to a new image

The same actions, in this order: `preflight` (the VM pulls the new digest),
`configure` (the pinned image accepts the configuration; the overlay and
configuration are replaced and the signing key is kept), `public-key` (it
prints the key already registered in Inflect; a different key means
`.env.scanner` lost its `SCANNER_SIGNING_KEY` line), `dry-run` (it re-creates
the egress proxy from the new image; every source `COMPLETE`, `egress:
enforced`), then `start`, which re-creates the scanner from the new image.
Until `start`, the scanner already running keeps its old image. `status`
afterwards shows the new container's first scan in its log lines.

To roll back, revert the commit that moved the overlay to the image: the
overlay, `remote.sh`, `vm.sh` and the configuration template move together,
because each names the image's paths and `remote.sh` refuses any other
image. Then run `configure` and `start` from `main`. The signing key is kept
either way.
