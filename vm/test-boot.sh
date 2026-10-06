#!/bin/bash
# Boot the built OVA's disk under qemu (x86_64 emulation) with ESXi-like hardware (pvscsi disk, vmxnet3 NIC),
# to check the first boot works. The VM's port 80/443 appear on this computer as 18080/18443.
# The disk is used read-only (qemu -snapshot), so the OVA is not changed.   Stop:  docker rm -f kiosk-vm-test
set -euo pipefail
cd "$(dirname "$0")"
docker rm -f kiosk-vm-test >/dev/null 2>&1 || true
docker run -d -i --name kiosk-vm-test -p 18080:8080 -p 18443:8443 -v "$PWD/work":/w:ro -v "$PWD/dist":/u:ro kiosk-vm-builder \
  qemu-system-x86_64 -machine q35 -accel tcg,thread=multi -cpu max -smp 2 -m 2048 -snapshot \
    -device pvscsi,id=scsi0 -drive file=/w/visitor-kiosk-disk1.vmdk,if=none,id=d0,format=vmdk -device scsi-hd,drive=d0,bus=scsi0.0 \
    -netdev user,id=n0,hostfwd=tcp::8080-:80,hostfwd=tcp::8443-:443 -device vmxnet3,netdev=n0 \
    -display none -serial stdio
echo "Booting. Watch:  docker logs -f kiosk-vm-test"
