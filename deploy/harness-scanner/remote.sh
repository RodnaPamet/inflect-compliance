#!/usr/bin/env bash
#
# THE HARNESS SCANNER ON THE PRODUCTION VM — the VM half (#3665).
#
# Runs ON the VM, as root, from `vm.sh`, which the dispatch-only `Scanner VM`
# workflow runs (.github/workflows/scanner-vm.yml). Nothing here is meant to be
# run by hand, and nothing here prints a credential: the workflow's logs are
# public, because the repository is.
#
#   remote.sh <action> <stage-dir> <image>
#
#   preflight   what is present, and whether the VM can pull the pinned image
#   configure   install the overlay, the configuration and .env.scanner from
#               <stage-dir>; generate the signing key on the VM, once
#   public-key  print the scanner's public key, to register in Inflect
#   dry-run     one scan, NOT posted, summarised to each source's state
#   start       start the scheduled scanner
#   status      the container's state and its last log lines
#   stop        stop and remove the scanner container
#
# The image is scanent's (scanent #26): its CLI is `node
# /app/packages/scanner/dist/cli.js`, its egress proxy
# `/app/packages/scanner/dist/egress-proxy.js`, its configuration at
# /etc/scanent. It is distroless: `node` is on its PATH and nothing else is, so
# every helper below runs as `--entrypoint node ... -e`.
#
# What may be printed: file NAMES, variable NAMES, container states, the public
# key, the hosts the configuration reaches, and the scanner's own log lines,
# which are one JSON line each on stderr, carry kinds and counts and redact
# anything secret-shaped (scanent's `packages/scanner/src/log.ts`). What is
# never printed: a value from .env.scanner, .env or .env.prod, the live compose
# file, or the dry-run report itself — it lists the estate's agents, and the
# summary below carries only each source's state and the count.
#
set -euo pipefail

ACTION="${1:?action}"
STAGE="${2:?stage directory}"
IMAGE="${3:?image}"

REMOTE_DIR=/opt/inflect
OVERLAY=docker-compose.harness-scanner.yml
CONFIG_IN_CONTAINER=/etc/scanent/config.json

case "$IMAGE" in
    ghcr.io/rodnapamet/scanent@sha256:*) ;;
    *) echo "refusing an image that is not the pinned scanner digest" >&2; exit 2 ;;
esac

cd "$REMOTE_DIR"

compose() {
    docker compose --env-file .env --env-file .env.prod -f docker-compose.prod.yml -f "$OVERLAY" "$@"
}

need() {
    local f
    for f in "$@"; do
        [ -e "$f" ] || { echo "missing on the VM: $REMOTE_DIR/$f — run the 'configure' action first" >&2; exit 1; }
    done
}

case "$ACTION" in
preflight)
    echo "docker: $(docker --version | cut -d, -f1)"
    echo "compose: $(docker compose version --short)"
    for f in docker-compose.prod.yml .env .env.prod "$OVERLAY" harness-scanner/config.json .env.scanner; do
        if [ -e "$f" ]; then echo "present: $f"; else echo "absent:  $f"; fi
    done
    if docker pull -q "$IMAGE" >/dev/null 2>&1; then
        echo "image pull: ok"
    else
        echo "image pull: FAILED — the VM cannot pull the pinned scanent image from ghcr.io (it is public: check the VM's network and the digest)" >&2
        exit 1
    fi
    ;;

configure)
    for f in "$OVERLAY" config.json env.partial; do
        [ -s "$STAGE/$f" ] || { echo "the stage is missing $f" >&2; exit 1; }
    done
    # The overlay runs the egress proxy from the scanner's own image (#5004
    # part C), at the path scanent ships it. An image without it would start a
    # scanner with no way out, so refuse it here, before anything is installed.
    docker pull -q "$IMAGE" >/dev/null
    if ! docker run --rm --network none --entrypoint node "$IMAGE" -e \
        "require('fs').accessSync('/app/packages/scanner/dist/egress-proxy.js')" 2>/dev/null; then
        echo "the pinned image carries no egress proxy at /app/packages/scanner/dist/egress-proxy.js: pin a scanent release that does" >&2
        exit 1
    fi

    # The pinned image reads the staged configuration, offline, before
    # anything is installed: a configuration it refuses stops here (exit 4,
    # issues by path, never a value), and so does one whose hosts are not
    # exactly the overlay's EGRESS_ALLOW, which would leave a source
    # UNREACHABLE behind the proxy or the proxy admitting a host nothing reads.
    check_dir="$(mktemp -d)"
    chmod 0755 "$check_dir"
    install -m 0644 "$STAGE/config.json" "$check_dir/config.json"
    hosts_rc=0
    wanted="$(docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
        --user 1000:1000 -v "$check_dir:/etc/scanent:ro" "$IMAGE" \
        hosts --config /etc/scanent/config.json --format egress-allow)" || hosts_rc=$?
    rm -rf "$check_dir"
    if [ "$hosts_rc" -ne 0 ]; then
        echo "the pinned scanent image refuses the staged configuration (exit $hosts_rc)" >&2
        exit 1
    fi
    allowed="$(sed -n 's/^ *EGRESS_ALLOW: *//p' "$STAGE/$OVERLAY")"
    if [ "$(printf '%s' "$wanted" | tr ',' '\n' | sort -u)" != "$(printf '%s' "$allowed" | tr ',' '\n' | sort -u)" ]; then
        echo "the configuration reaches: $wanted" >&2
        echo "the overlay's EGRESS_ALLOW: $allowed" >&2
        echo "they differ: put the configuration's hosts on EGRESS_ALLOW in deploy/docker-compose.harness-scanner.yml" >&2
        exit 1
    fi
    echo "configuration: accepted by the pinned image; hosts equal EGRESS_ALLOW ($wanted)"
    install -m 0644 -o root -g root "$STAGE/$OVERLAY" "$OVERLAY"
    install -d -m 0755 -o root -g root harness-scanner
    install -m 0644 -o root -g root "$STAGE/config.json" harness-scanner/config.json

    # The signing key is generated HERE, once, and kept across reconfigures: its
    # public half is registered in Inflect, so a new key would stop every
    # report being accepted until somebody registered it again.
    key_line=""
    if [ -f .env.scanner ]; then
        key_line="$(grep -E '^SCANNER_SIGNING_KEY=.+' .env.scanner || true)"
    fi
    if [ -z "$key_line" ]; then
        docker pull -q "$IMAGE" >/dev/null
        pem="$(docker run --rm --network none --entrypoint node "$IMAGE" -e \
            "process.stdout.write(require('crypto').generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}))")"
        # One line, double-quoted, `\n` for each break: Compose's dotenv turns
        # those back into newlines inside double quotes.
        key_line="SCANNER_SIGNING_KEY=\"$(printf '%s\n' "$pem" | awk 'BEGIN { ORS = "\\n" } { print }')\""
        unset pem
        echo "signing key: generated on the VM"
    else
        echo "signing key: kept"
    fi

    umask 077
    tmp="$(mktemp "$REMOTE_DIR/.env.scanner.XXXXXX")"
    {
        echo "# Written by the Scanner VM workflow (configure). Re-run it rather than editing."
        printf '%s\n' "$key_line"
        cat "$STAGE/env.partial"
    } >"$tmp"
    unset key_line
    chown root:root "$tmp"
    chmod 0600 "$tmp"
    mv "$tmp" .env.scanner

    # Validates the merged file without starting anything; prints nothing on success.
    compose config --quiet
    echo "configured: $OVERLAY, harness-scanner/config.json, .env.scanner (0600) holding $(grep -oE '^[A-Z_]+=' .env.scanner | tr -d '=' | tr '\n' ' ')"
    ;;

public-key)
    need "$OVERLAY" harness-scanner/config.json .env.scanner
    compose run --rm --no-deps -T harness-scanner public-key --config "$CONFIG_IN_CONTAINER"
    ;;

dry-run)
    need "$OVERLAY" harness-scanner/config.json .env.scanner
    # The scanner's only way out is its egress proxy (#5004 part C), so the
    # proxy is up before the scan, and the scan runs without re-creating it.
    # The report goes to a summariser and nowhere else; the scanner's own log
    # lines (kinds and counts) stay on stderr. `--dry-run` drops the `inflect`
    # output and prints the signed agent report as the first line of stdout
    # (an integrations report, which this configuration does not make, would
    # be a second line), so the summariser reads the first line only.
    compose up -d harness-egress
    compose run --rm --no-deps -T harness-scanner scan --dry-run --config "$CONFIG_IN_CONTAINER" \
        | docker run --rm -i --network none --entrypoint node "$IMAGE" -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
    let r;
    try { r = JSON.parse(s.split("\n")[0]); } catch { console.log("dry run: no report"); process.exit(1); }
    const sources = (r.population && r.population.sources) || [];
    for (const x of sources) {
        console.log(`${x.kind}: ${x.status}${x.reason ? " " + x.reason : ""} (${x.rows ?? "?"} rows)`);
    }
    console.log(`agents: ${(r.agents || []).length}`);
    for (const a of r.agents || []) {
        const v = (a.verdicts || []).find((x) => x.criterion === "H3.egress_enforced");
        if (v) console.log(`egress: ${v.met ? "enforced" : "NOT enforced"} (${v.evidence})`);
    }
    const complete = sources.length > 0 && sources.every((x) => x.status === "COMPLETE");
    console.log(complete ? "every source COMPLETE" : "NOT every source is COMPLETE: do not start the schedule");
    process.exit(complete ? 0 : 3);
});'
    ;;

start)
    need "$OVERLAY" harness-scanner/config.json .env.scanner
    compose up -d harness-scanner
    compose ps harness-scanner harness-egress
    ;;

status)
    if [ -e "$OVERLAY" ]; then
        compose ps -a harness-scanner harness-egress
        id="$(compose ps -a -q harness-scanner)"
        if [ -n "$id" ]; then
            docker inspect -f 'state={{.State.Status}} started={{.State.StartedAt}} restarts={{.RestartCount}}' "$id"
            docker logs --tail 30 "$id" 2>&1
        fi
    else
        echo "the overlay is not installed"
    fi
    ;;

stop)
    need "$OVERLAY"
    compose rm -sf harness-scanner harness-egress
    ;;

*)
    echo "unknown action: $ACTION" >&2
    exit 2
    ;;
esac
