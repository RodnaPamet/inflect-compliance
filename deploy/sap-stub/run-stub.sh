#!/usr/bin/env bash
# Start the stub SAP MCP server where Inflect's egress guard can reach it.
#
# Everything here is derived rather than typed: the host from pick-host.sh, the
# certificate paths from make-dev-cert.sh's output directory. A runbook whose
# commands must be edited before use is a runbook people paraphrase.
set -euo pipefail
cd "$(dirname "$0")"

HOST="${HOST:-$(./pick-host.sh)}"
PORT="${PORT:-8443}"
CERTS="${CERTS:-./.certs}"

if [ ! -f "$CERTS/stub-cert.pem" ]; then
    echo "no certificate at $CERTS — run ./make-dev-cert.sh first" >&2
    exit 1
fi

# THE PORT IS CHECKED, AND A CONFLICT IS NAMED RATHER THAN WORKED AROUND.
# 8443 is a common default and on this machine a container already publishes it
# on 0.0.0.0, which made the stub die with a bare EADDRINUSE naming neither the
# holder nor a way forward. Auto-advancing to the next free port would be
# friendlier and wrong: the port goes into the mcp-server connection Inflect
# saves, so a port that moves between runs breaks the connection silently.
if ! python3 - "$HOST" "$PORT" <<'PROBE'
import socket, sys
host, port = sys.argv[1], int(sys.argv[2])
s = socket.socket()
try:
    s.bind((host, port))
except OSError:
    sys.exit(1)
finally:
    s.close()
PROBE
then
    echo "cannot bind $HOST:$PORT — something already holds it:" >&2
    ss -ltn 2>/dev/null | awk -v p=":$PORT\$" '$4 ~ p {print "  "$1" "$4}' >&2
    free=$(python3 - "$HOST" "$PORT" <<'FREE'
import socket, sys
host, start = sys.argv[1], int(sys.argv[2])
for p in range(start + 1, start + 40):
    s = socket.socket()
    try:
        s.bind((host, p)); print(p); break
    except OSError:
        pass
    finally:
        s.close()
FREE
)
    [ -n "$free" ] && echo "  try: PORT=$free $0 $*" >&2
    exit 1
fi

echo "Inflect must trust this certificate. In the Inflect process's environment:"
echo "  export NODE_EXTRA_CA_CERTS=$(cd "$CERTS" && pwd)/stub-cert.pem"
echo "and the deployment egress allowlist must admit ${HOST%.*}.0/24 in SELFHOSTED mode."
echo

# `--` passes any extra flags through, so --fail-mode and --empty-catalogue
# work without this script needing to know about them.
exec npx tsx ../../packages/sap-mcp-stub/src/server.ts \
    --host "$HOST" --port "$PORT" \
    --cert "$CERTS/stub-cert.pem" \
    --key "$CERTS/stub-key.pem" \
    "$@"
