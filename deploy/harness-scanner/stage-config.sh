#!/usr/bin/env bash
#
# Fill the pilot configuration template and write the credential lines, on the
# runner, for `vm.sh configure` (#3665). Run by the `Scanner VM` workflow, with
# every value in the environment from a `production` environment secret.
#
#   stage-config.sh <out-dir>    writes <out-dir>/config.json and <out-dir>/env.partial
#
# Prints nothing but which files it wrote. Refuses a missing value, and a value
# carrying a quote or a newline, which the single-quoted dotenv line could not
# hold as written.
#
set -euo pipefail

OUT="${1:?output directory}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$HERE/config.pilot.example.json"

for name in SCANNER_TENANT_SLUG SCANNER_AGENT_ID SCANNER_ENTRA_DIRECTORY_ID SCANNER_ENTRA_CLIENT_ID \
    INFLECT_INGEST_KEY ENTRA_CLIENT_SECRET SCANNER_GITHUB_READ_TOKEN GCP_SCANNER_KEY; do
    [ -n "${!name:-}" ] || { echo "the production environment has no secret $name" >&2; exit 1; }
done

umask 077
mkdir -p "$OUT"

jq --arg slug "$SCANNER_TENANT_SLUG" \
    --arg agent "$SCANNER_AGENT_ID" \
    --arg dir "$SCANNER_ENTRA_DIRECTORY_ID" \
    --arg client "$SCANNER_ENTRA_CLIENT_ID" \
    '.scanner.agentId = $agent
     | .inflect.tenantSlug = $slug
     | .sources |= map(if .kind == "entra-sp" then .directoryId = $dir | .clientId = $client else . end)' \
    "$TEMPLATE" >"$OUT/config.json"

# The GCP key on one line: the JSON escapes inside `private_key` stay as JSON
# wrote them, which is what single quotes preserve.
gcp_key="$(jq -c . <<<"$GCP_SCANNER_KEY")" || { echo "GCP_SCANNER_KEY is not JSON" >&2; exit 1; }

line() {
    local name="$1" value="$2"
    case "$value" in
        *"'"* | *$'\n'*) echo "$name holds a quote or a newline, which its dotenv line cannot carry" >&2; exit 1 ;;
    esac
    printf "%s='%s'\n" "$name" "$value"
}

{
    line INFLECT_INGEST_KEY "$INFLECT_INGEST_KEY"
    line ENTRA_CLIENT_SECRET "$ENTRA_CLIENT_SECRET"
    line GITHUB_READ_TOKEN "$SCANNER_GITHUB_READ_TOKEN"
    line GCP_SCANNER_KEY "$gcp_key"
} >"$OUT/env.partial"
unset gcp_key

echo "staged: config.json, env.partial"
