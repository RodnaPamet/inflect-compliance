#!/usr/bin/env bash
# A self-signed certificate for the stub, valid for an IP ADDRESS.
#
# THE SAN IS THE WHOLE POINT. A certificate whose identity is only in the CN is
# rejected by Node for an IP-based connection — modern TLS requires a
# subjectAltName, and for an IP it must be `IP:x.x.x.x`, not `DNS:x.x.x.x`.
# Getting that wrong produces ERR_TLS_CERT_ALTNAME_INVALID at the moment of the
# first call, which reads like an Inflect problem rather than a certificate one.
#
# Self-signed is fine BECAUSE the scheme check is not being relaxed: Inflect
# still requires https, and trusting this certificate is done explicitly with
# NODE_EXTRA_CA_CERTS rather than by disabling verification. Never reach for
# NODE_TLS_REJECT_UNAUTHORIZED=0 to make this work — that turns the check off
# for every outbound connection the process makes, including real ones.
set -euo pipefail

HOST="${1:-$("$(dirname "$0")/pick-host.sh")}"
OUT="${2:-$(dirname "$0")/.certs}"
DAYS="${CERT_DAYS:-365}"

mkdir -p "$OUT"
openssl req -x509 -newkey rsa:2048 -sha256 -days "$DAYS" -nodes \
    -keyout "$OUT/stub-key.pem" \
    -out "$OUT/stub-cert.pem" \
    -subj "/CN=sap-mcp-stub" \
    -addext "subjectAltName=IP:$HOST" \
    -addext "basicConstraints=critical,CA:TRUE" \
    2>/dev/null

chmod 600 "$OUT/stub-key.pem"

echo "host  $HOST"
echo "cert  $OUT/stub-cert.pem"
echo "key   $OUT/stub-key.pem"
echo
# Printed, not assumed. If the SAN is missing or wrong, every later step fails
# with a TLS error that names neither this script nor the address.
echo "subjectAltName, read back from the certificate:"
openssl x509 -in "$OUT/stub-cert.pem" -noout -ext subjectAltName | sed 's/^/  /'
echo
echo "Next: export NODE_EXTRA_CA_CERTS=$(cd "$OUT" && pwd)/stub-cert.pem"
echo "      for the Inflect process, then run ./run-stub.sh"
