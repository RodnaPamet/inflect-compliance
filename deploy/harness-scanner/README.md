# The harness scanner on the production VM

Inflect's own estate scanner (#3665) runs on the production VM from the opt-in
overlay `deploy/docker-compose.harness-scanner.yml`. A person sets it up and
starts it by dispatching the **Scanner VM** workflow
(`.github/workflows/scanner-vm.yml`), whose runs the `production` environment's
reviewer approves. Every credential stays a GitHub secret. None passes through
a chat, a terminal or a session.

| File | What it is |
| --- | --- |
| `config.pilot.example.json` | The pilot estate's configuration. The workflow fills in the four ids from secrets. |
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
   `mcp:read`. That is `INFLECT_INGEST_KEY`.
3. Grant the scanner agent the tool `get_harness_register`.

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
| `configure` | Installs the overlay, the configuration and `.env.scanner` (root, 0600). Generates the signing key on the VM the first time and keeps it after | `configured: …` |
| `public-key` | Prints the scanner's public key | Register it against the scanner agent in Inflect |
| `dry-run` | One scan, not posted, summarised per source | `every source COMPLETE` |
| `start` | `up -d harness-scanner`. It scans at once, then every 24 hours | `status` shows it running |
| `status` | The container's state and its last 30 log lines | |
| `stop` | Stops and removes the container | |

`configure` can be re-run at any time, to rotate a credential or change an id.
It keeps the signing key, so the registered public key stays valid.
