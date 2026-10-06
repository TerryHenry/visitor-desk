#!/bin/bash
# Build a signed update (.kup) for deployed kiosk VMs:  vm/build-update.sh
# Install on a VM with:  kiosk update <URL or file>
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
[ -f keys/update-signing.key ] || { echo "No signing key (vm/keys/update-signing.key). VMs only trust the key they were built with."; exit 1; }
# The automated tests must pass first (SKIP_TESTS=1 to build anyway, for example to ship an urgent fix).
if [ "${SKIP_TESTS:-}" != "1" ]; then
  echo "Running the tests…"; mkdir -p work
  (cd "$ROOT" && node --test test/*.test.js > vm/work/tests.log 2>&1) || { tail -40 "$ROOT/vm/work/tests.log"; echo "Tests failed, so no update was built. Details: vm/work/tests.log"; exit 1; }
  echo "Tests passed ($(grep -m1 '^ℹ pass' "$ROOT/vm/work/tests.log" | sed 's/ℹ //'))."
fi
VERSION=${UPDATE_VERSION:-$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json")}   # UPDATE_VERSION: for test builds
BUILD=$(date +%Y%m%d%H%M)
OUT="dist/visitor-desk-update-$VERSION-$BUILD.kup"
mkdir -p dist work
NODE_ARGS=()
if [ "${1:-}" = "--with-node" ]; then   # also ship the Node.js runtime in vm/cache (see build-ova.sh)
  NODE_TAR=$(ls -t cache/node-v*-linux-x64.tar.xz | head -1); rm -rf work/node-unpacked; mkdir -p work/node-unpacked
  tar -xJf "$NODE_TAR" -C work/node-unpacked; NODE_ARGS=(--node-dir "work/node-unpacked/$(basename "$NODE_TAR" .tar.xz)")
  echo "Including Node.js $(basename "$NODE_TAR" .tar.xz)"
fi
python3 make-update.py --root "$ROOT" --version "$VERSION" --build "$BUILD" --out work/update.tar.gz ${NODE_ARGS[@]+"${NODE_ARGS[@]}"}
node -e '
  const c = require("crypto"), fs = require("fs");
  fs.writeFileSync("work/update.sig", c.sign(null, fs.readFileSync("work/update.tar.gz"), c.createPrivateKey(fs.readFileSync("keys/update-signing.key"))));'
python3 - "$OUT" <<'PY'
import sys, tarfile
with tarfile.open(sys.argv[1], "w", format=tarfile.USTAR_FORMAT) as t:
    for n in ("update.tar.gz", "update.sig"):
        i = t.gettarinfo("work/" + n, arcname=n); i.uid = i.gid = 0; i.uname = i.gname = "root"; i.mode = 0o644
        with open("work/" + n, "rb") as f: t.addfile(i, f)
PY
rm -rf work/update.tar.gz work/update.sig work/node-unpacked
echo "Done: vm/$OUT ($(du -k "$OUT" | cut -f1) KB)"
echo "Install it from the admin panel (Updates), or on the VM:  kiosk update http://<this computer>:8000/$(basename "$OUT")"
