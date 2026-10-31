# `inflect-egress-telemetry-deny` — the OpenShell telemetry sink, denied in the data plane

Created 2026-10-31 by owner decision on #4566. Recorded here because a cloud
resource nobody can find in the repository is a resource nobody will maintain —
the same reason `infra/alerts/policies/` exists.

## What it is

| | |
| --- | --- |
| kind | global network firewall policy (the first in this project) |
| name | `inflect-egress-telemetry-deny` |
| rule | priority 1000, `EGRESS`, `deny`, all protocols |
| match | `dest-fqdns: events.telemetry.data.nvidia.com` |
| logging | **on** — a control nobody can see fire is a configuration, not a control |
| association | `network:default` |

## Why FQDN and not an IP range

The endpoint is CDN-hosted. An IP rule would rot, and a rotted IP rule restores
egress **silently** — the failure shape this roadmap has repeatedly paid for.
Google resolves the name on its side, so a changed address is handled. A changed
NAME is not, and that is the residual.

## Why VPC-wide

Targeting one instance in a network firewall policy requires secure tags, and
this project has none. Nothing here has any reason to reach NVIDIA's telemetry
sink, so the wider scope is the stronger control rather than a compromise. Both
production apps were verified answering `200` immediately after association.

## How to verify it, and how NOT to

**Not from the gateway VM.** Its `/etc/hosts` carries
`0.0.0.0 events.telemetry.data.nvidia.com`, so a probe there is blocked by name
resolution whether or not the firewall works — a probe with no discriminating
power.

From the app VM, which has no such entry, with a positive control:

```bash
grep -c telemetry.data.nvidia.com /etc/hosts                      # expect 0
curl -s -o /dev/null -w '%{http_code}\n' https://ghcr.io/          # expect 3xx — egress works
curl -s -o /dev/null -w '%{http_code}\n' --max-time 20 \
     https://events.telemetry.data.nvidia.com/                     # expect 000
curl -s -o /dev/null -w '%{http_code}\n' --max-time 20 \
     --resolve events.telemetry.data.nvidia.com:443:<ip> \
     https://events.telemetry.data.nvidia.com/                     # expect 000
```

And the attributable form — the data plane naming the rule:

```bash
gcloud logging read 'logName=~"compute.googleapis.com%2Ffirewall"' --freshness=20m \
  --format='value(timestamp,jsonPayload.rule_details.action,jsonPayload.rule_details.reference)'
# DENY  network:default/firewallPolicy:inflect-egress-telemetry-deny
```

## To remove it

```bash
gcloud compute network-firewall-policies associations delete \
  --firewall-policy=inflect-egress-telemetry-deny --global-firewall-policy \
  --name=inflect-egress-telemetry-deny-default
gcloud compute network-firewall-policies delete inflect-egress-telemetry-deny --global
```

Deleting the association is enough to lift the denial; the policy is inert
without one.
