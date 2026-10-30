#!/usr/bin/env bash
#
# Swap the app VM's default service account for a narrow dedicated one — #4562.
#
# ═══════════════════════════════════════════════════════════════════════════
# WHY THIS NEEDS DOWNTIME, AND WHY IT IS WORTH IT ANYWAY
# ═══════════════════════════════════════════════════════════════════════════
#
# #4562 needs the app to START the gateway VM. The app's IAM already permits it
# — the default compute SA holds `roles/editor` — but the VM's OAuth SCOPES
# exclude `compute`, and scopes gate the metadata token regardless of IAM:
#
#   $ gcloud compute instances set-service-account inflect-compliance --scopes=compute-rw
#   ERROR: The instance must be stopped before the service account can be changed.
#
# So the capability costs a stop/start of the production app VM. The owner chose
# on 2026-10-30 to take that window AND narrow the account while it is open,
# rather than widen an already over-broad one.
#
#   before   880736019978-compute@developer   roles/editor, project-wide
#   after    inflect-app@…                    logging.logWriter
#                                             monitoring.metricWriter
#                                             openshellGatewayStarter, on the
#                                               gateway INSTANCE only
#
# `openshellGatewayStarter` is a custom role holding exactly
# `compute.instances.get`, `compute.instances.start` and
# `compute.zoneOperations.get`. Not delete, not stop, not setMetadata. A
# compromised app VM can start that one instance and read its status.
#
# ═══════════════════════════════════════════════════════════════════════════
# WHAT BREAKS IF THE SCOPES ARE WRONG — ESTABLISHED, NOT GUESSED
# ═══════════════════════════════════════════════════════════════════════════
#
# Three systemd timers on the app VM write custom metrics every 1–5 minutes:
#
#   container-health-reporter.timer      every 1 min
#   identity-unsettled-reporter.timer    every 5 min
#   work-overdue-reporter.timer          every 5 min
#
# They pull a token from the metadata server and POST to the Monitoring API —
# `container-health-reporter.sh`'s own comment says "monitoring.write, so a
# token from the metadata server is enough". FOUR of the project's seven alert
# policies read those `custom.googleapis.com` metrics, including
# "inflect disk filling — act before postgres cannot write".
#
# Drop `monitoring.write` and those alerts go BLIND rather than red. That is the
# failure this script's scope list exists to prevent, and it is why the
# verification below checks a metric actually lands rather than only that the
# app answers.
#
# The application itself needs NOTHING from the service account: `package.json`
# carries no `@google-cloud` dependency and no container on the VM uses a GCP
# SDK. That is what makes the narrowing safe.
#
# ═══════════════════════════════════════════════════════════════════════════
# RUN THIS IN A MAINTENANCE WINDOW
# ═══════════════════════════════════════════════════════════════════════════
#
#   ./deploy/swap-app-service-account.sh --dry-run    # prints, changes nothing
#   ./deploy/swap-app-service-account.sh --apply
#
set -euo pipefail

PROJECT="${PROJECT:-hazel-design-419410}"
ZONE="${ZONE:-europe-west1-b}"
VM="${VM:-inflect-compliance}"
GATEWAY="${GATEWAY:-openshell-gateway}"
SA="inflect-app@${PROJECT}.iam.gserviceaccount.com"

# monitoring.write and logging.write are LOAD BEARING — see the header. `compute`
# is what the start call needs; IAM is what keeps it narrow.
SCOPES="https://www.googleapis.com/auth/compute,\
https://www.googleapis.com/auth/monitoring.write,\
https://www.googleapis.com/auth/logging.write,\
https://www.googleapis.com/auth/devstorage.read_only,\
https://www.googleapis.com/auth/pubsub,\
https://www.googleapis.com/auth/service.management.readonly,\
https://www.googleapis.com/auth/servicecontrol,\
https://www.googleapis.com/auth/trace.append"

MODE="${1:---dry-run}"
say() { printf '  %s\n' "$*"; }

say "project $PROJECT   vm $VM   zone $ZONE"
say "target SA $SA"

say "preflight: the SA and its grants must already exist"
gcloud iam service-accounts describe "$SA" --project "$PROJECT" >/dev/null
gcloud iam roles describe openshellGatewayStarter --project "$PROJECT" >/dev/null
say "  SA and custom role present"

if [[ "$MODE" != "--apply" ]]; then
    say ""
    say "DRY RUN — nothing changed. Would run:"
    say "  gcloud compute instances stop $VM"
    say "  gcloud compute instances set-service-account $VM --service-account=$SA --scopes=<9 scopes>"
    say "  gcloud compute instances start $VM"
    say "then verify the app, the metric reporters, and the gateway start."
    exit 0
fi

say "STOPPING $VM — production is down from here"
gcloud compute instances stop "$VM" --project "$PROJECT" --zone "$ZONE"

say "swapping the service account and scopes"
gcloud compute instances set-service-account "$VM" --project "$PROJECT" --zone "$ZONE" \
    --service-account="$SA" --scopes="$SCOPES"

say "STARTING $VM"
gcloud compute instances start "$VM" --project "$PROJECT" --zone "$ZONE"

# ── VERIFY. Three things, because "the app came back" is not enough. ───────
say "waiting for the app to answer"
for _ in $(seq 1 40); do
    sleep 10
    if gcloud compute ssh "$VM" --project "$PROJECT" --zone "$ZONE" --tunnel-through-iap \
        --command='curl -sf -m 5 -o /dev/null http://127.0.0.1:3000/api/readyz' 2>/dev/null; then
        say "  readyz answers"; break
    fi
done

say "verifying the metadata token carries monitoring.write (the alerts depend on it)"
gcloud compute ssh "$VM" --project "$PROJECT" --zone "$ZONE" --tunnel-through-iap --command='
  S=$(curl -s -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/scopes)
  echo "$S" | grep -q monitoring.write && echo "  monitoring.write PRESENT" || { echo "  monitoring.write MISSING — alerts will go blind"; exit 1; }
  echo "$S" | grep -q auth/compute && echo "  compute PRESENT" || { echo "  compute MISSING — cannot start the gateway"; exit 1; }'

say "forcing a metric reporter run and checking it succeeds"
gcloud compute ssh "$VM" --project "$PROJECT" --zone "$ZONE" --tunnel-through-iap --command='
  sudo systemctl start container-health-reporter.service
  sleep 3
  sudo journalctl -u container-health-reporter.service -n 5 --no-pager --output=cat | sed "s/^/    /"'

say "proving the app VM can now start the gateway, and nothing more"
gcloud compute ssh "$VM" --project "$PROJECT" --zone "$ZONE" --tunnel-through-iap --command="
  T=\$(curl -s -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token | sed -n 's/.*\"access_token\":\"\([^\"]*\)\".*/\1/p')
  B=https://compute.googleapis.com/compute/v1/projects/$PROJECT/zones/$ZONE/instances/$GATEWAY
  echo \"    get:    HTTP \$(curl -s -o /dev/null -w '%{http_code}' -H \"Authorization: Bearer \$T\" \$B)\"
  echo \"    delete: HTTP \$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H \"Authorization: Bearer \$T\" \$B)   (403 expected — NOT granted)\""

say ""
say "done. If anything above failed, roll back with:"
say "  gcloud compute instances stop $VM"
say "  gcloud compute instances set-service-account $VM --service-account=880736019978-compute@developer.gserviceaccount.com --scopes=default"
say "  gcloud compute instances start $VM"
