#!/bin/bash
# Quick checks against a running Visitor Desk VM, from another computer:
#   vm/smoke-test.sh                       the qemu test VM from vm/test-boot.sh (ports 18080/18443 on this computer)
#   vm/smoke-test.sh 192.168.1.50          a deployed VM (ports 80/443)
# Waits up to 6 minutes for the VM to answer (a first boot under emulation is slow). Exit code 0 = all passed.
set -u
if [ $# -ge 1 ]; then HTTP="http://$1"; HTTPS="https://$1"; else HTTP="http://127.0.0.1:18080"; HTTPS="https://127.0.0.1:18443"; fi
pass=0; fail=0
ok()  { echo "  ok    $1"; pass=$((pass+1)); }
bad() { echo "  FAIL  $1"; fail=$((fail+1)); }
check() { if eval "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi; }

printf "Waiting for %s " "$HTTPS"
for _ in $(seq 1 72); do curl -skf -m 4 "$HTTPS/health" >/dev/null 2>&1 && break; printf "."; sleep 5; done; echo

check "HTTPS health"                         "curl -skf -m 5 '$HTTPS/health' | grep -q '\"ok\":true'"
check "the kiosk page is Visitor Desk"        "curl -sk -m 5 '$HTTPS/' | grep -q '<title>Visitor Desk</title>'"
check "plain http page redirects to https"    "curl -s -m 5 -o /dev/null -w '%{http_code} %{redirect_url}' '$HTTP/' | grep -q '^302 https://'"
check "plain http API is refused"             "test \"\$(curl -s -m 5 -o /dev/null -w '%{http_code}' '$HTTP/api/kiosk-info')\" = 403"
check "tablet setup page works over http"     "curl -sf -m 5 '$HTTP/setup' | grep -q 'Visitor Desk CA'"
check "Content Security Policy with a nonce"  "curl -sk -m 5 -D - -o /dev/null '$HTTPS/' | grep -i '^content-security-policy:' | grep -q \"'nonce-\""
check "no framing (X-Frame-Options DENY)"     "curl -sk -m 5 -D - -o /dev/null '$HTTPS/' | grep -qi '^x-frame-options: DENY'"
check "HSTS on https"                         "curl -sk -m 5 -D - -o /dev/null '$HTTPS/' | grep -qi '^strict-transport-security:'"
check "staff API needs a sign-in"             "test \"\$(curl -sk -m 5 -o /dev/null -w '%{http_code}' '$HTTPS/api/admin/visits')\" = 401"
CA=$(mktemp); curl -sf -m 5 "$HTTP/ca.crt" -o "$CA"
check "certificate authority is Visitor Desk CA" "openssl x509 -in '$CA' -noout -subject | grep -q 'Visitor Desk CA'"
check "certificate authority is name-constrained" "openssl x509 -in '$CA' -noout -text | grep -q 'Name Constraints'"
rm -f "$CA"
HOSTPORT=${HTTPS#https://}; [[ "$HOSTPORT" == *:* ]] || HOSTPORT="$HOSTPORT:443"   # a deployed VM: port 443
check "server certificate is signed by it"    "echo | openssl s_client -connect '$HOSTPORT' 2>/dev/null | grep -q 'issuer=.*Visitor Desk CA'"

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
