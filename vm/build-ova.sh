#!/bin/bash
# Build the Visitor Desk appliance OVA for VMware ESXi / vSphere (x86_64).
# Needs Docker and python3. Run from anywhere:  vm/build-ova.sh
# Optional: CONSOLE_PASSWORD=... (default "visitorkiosk"; it must be changed at first login anyway).
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"

UBUNTU_OVA=ubuntu-24.04-server-cloudimg-amd64.ova
NODE_TAR=node-v24.21.0-linux-x64.tar.xz
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json")
BUILD=$(date +%Y%m%d%H%M)

for f in "$UBUNTU_OVA" "$NODE_TAR"; do
  [ -f "cache/$f" ] || { cat <<EOF
Missing cache/$f. Download it first:
  curl -L -o cache/$UBUNTU_OVA https://cloud-images.ubuntu.com/releases/noble/release/$UBUNTU_OVA
  curl -L -o cache/$NODE_TAR https://nodejs.org/dist/latest-v24.x/$NODE_TAR
EOF
  exit 1; }
done

rm -rf work; mkdir -p work/seed dist
./make-key.sh
printf '{"version":"%s","build":"%s"}\n' "$VERSION" "$BUILD" > work/version.json
HASH=$(openssl passwd -6 "${CONSOLE_PASSWORD:-visitorkiosk}")
sed "s|@BUILD@|$BUILD|" cloud-init/meta-data > work/seed/meta-data
awk -v h="$HASH" '{ gsub(/@PASSWORD_HASH@/, h); print }' cloud-init/user-data > work/seed/user-data

docker build -q -t kiosk-vm-builder builder >/dev/null
docker run --rm --privileged -v "$ROOT":/in:ro -v "$PWD/cache":/cache:ro -v "$PWD/work":/out \
  -e UBUNTU_OVA="$UBUNTU_OVA" -e NODE_TAR="$NODE_TAR" -e DISK_GB=16 kiosk-vm-builder bash /in/vm/disk.sh

python3 make-ova.py --base work/base.ovf --vmdk work/visitor-kiosk-disk1.vmdk \
  --out "dist/visitor-desk-$VERSION.ova" --version "$VERSION" --build "$BUILD"
(cd dist && shasum -a 256 "visitor-desk-$VERSION.ova" > "visitor-desk-$VERSION.ova.sha256")
echo "Done: vm/dist/visitor-desk-$VERSION.ova"
