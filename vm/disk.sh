#!/bin/bash
# Runs inside the kiosk-vm-builder container (privileged, for a loop mount). Takes Ubuntu's cloud image disk,
# grows it, adds the kiosk app, Node.js and the first-boot seed, and writes an ESXi-ready streamOptimized VMDK.
#   /in    project folder (read-only)      /cache  downloads (read-only)      /out  vm/work
set -euo pipefail
: "${UBUNTU_OVA:?}" "${NODE_TAR:?}" "${DISK_GB:=16}"

W=/work; R=/mnt/root
mkdir -p "$W" "$R"; cd "$W"

echo "1/5  Unpacking the Ubuntu image"
tar -xf "/cache/$UBUNTU_OVA"
VMDK=$(ls ./*.vmdk | head -1); OVF=$(ls ./*.ovf | head -1)
cp "$OVF" /out/base.ovf
qemu-img convert -O raw "$VMDK" disk.raw
rm -f "$VMDK"
qemu-img resize -q -f raw disk.raw "${DISK_GB}G"   # cloud-init grows the partition on first boot

echo "2/5  Finding the root filesystem"
# The largest "Linux filesystem" GPT partition is the root (cloudimg-rootfs).
read -r START SIZE < <(sfdisk -d disk.raw 2>/dev/null | awk -F'[=,]' \
  '/type=0FC63DAF-8483-4772-8E79-3D69D8477DE4/ { gsub(/ /,""); print $2, $4 }' | sort -k2 -n | tail -1)
[ -n "${START:-}" ] || { echo "Couldn't find the root partition"; exit 1; }
mount -o loop,offset=$((START * 512)) disk.raw "$R"
trap 'umount "$R" 2>/dev/null || true' EXIT
[ -x "$R/usr/bin/cloud-init" ] || { echo "That doesn't look like an Ubuntu cloud image"; exit 1; }

echo "3/5  Adding the kiosk app and Node.js"
install -d -m 0755 "$R/opt/visitor-kiosk/public"
# Only the app itself: never config.json, data/, certs/ or other local files from the project folder.
install -m 0644 /in/server.js /in/package.json /in/README.md /in/config.example.json "$R/opt/visitor-kiosk/"
cp -r /in/public/. "$R/opt/visitor-kiosk/public/"
tar -xJf "/cache/$NODE_TAR" -C "$R/opt"
rm -rf "$R/opt/node"; mv "$R/opt/${NODE_TAR%.tar.xz}" "$R/opt/node"

install -m 0644 /in/vm/files/visitor-kiosk.service /in/vm/files/kiosk-console.service /in/vm/files/kiosk-console.timer "$R/etc/systemd/system/"
install -m 0755 /in/vm/files/kiosk "$R/usr/local/bin/kiosk"
install -m 0755 /in/vm/files/kiosk-console "$R/usr/local/sbin/kiosk-console"
install -m 0755 /in/vm/files/kiosk-update "$R/usr/local/sbin/kiosk-update"
install -m 0755 /in/vm/files/kiosk-harden "$R/usr/local/sbin/kiosk-harden"
# Updates from the admin panel: installed here, switched on by visitor-kiosk.service at start (as after an update).
install -m 0755 /in/vm/files/kiosk-web-update "$R/usr/local/sbin/kiosk-web-update"
install -m 0644 /in/vm/files/kiosk-web-update.path /in/vm/files/kiosk-web-update.service "$R/etc/systemd/system/"
# Public half of the update signing key: `kiosk update` only installs updates signed with the private half.
install -d -m 0755 "$R/etc/visitor-kiosk"
install -m 0644 /in/vm/keys/update-signing.pub "$R/etc/visitor-kiosk/update-signing.pub"
install -m 0644 /out/version.json "$R/opt/visitor-kiosk/.version.json"
install -d -m 0755 "$R/etc/issue.d"
# Enabled in the image (not by cloud-init), so the console message is there before the first login prompt.
ln -sf /etc/systemd/system/kiosk-console.service "$R/etc/systemd/system/multi-user.target.wants/kiosk-console.service"
install -d "$R/etc/systemd/system/timers.target.wants"
ln -sf /etc/systemd/system/kiosk-console.timer "$R/etc/systemd/system/timers.target.wants/kiosk-console.timer"
install -m 0644 /in/vm/files/90-visitor-kiosk.cfg "$R/etc/cloud/cloud.cfg.d/90-visitor-kiosk.cfg"
# No floppy driver (the OVA has no floppy drive; older deployments did and logged fd0 I/O errors).
echo "blacklist floppy" > "$R/etc/modprobe.d/blacklist-floppy.conf"
# Don't hold the boot for 2 minutes waiting for a network address (no DHCP on the network, for example).
install -d "$R/etc/systemd/system/systemd-networkd-wait-online.service.d"
install -m 0644 /in/vm/files/wait-online.conf "$R/etc/systemd/system/systemd-networkd-wait-online.service.d/10-visitor-kiosk.conf"

echo "4/5  Adding the first-boot setup"
install -d -m 0700 "$R/var/lib/cloud/seed/nocloud"
install -m 0600 /out/seed/user-data /out/seed/meta-data "$R/var/lib/cloud/seed/nocloud/"
[ -x "$R/usr/bin/vmtoolsd" ] && echo "     open-vm-tools: included" || echo "     open-vm-tools: not in the base image"
sync; umount "$R"; trap - EXIT

echo "5/5  Writing the VMDK"
# Same adapter type and hardware version as Canonical's own VMDK.
qemu-img convert -f raw -O vmdk -o subformat=streamOptimized,adapter_type=lsilogic,hwversion=7 disk.raw /out/visitor-kiosk-disk1.vmdk
# ESXi/vSphere only accept streamOptimized VMDKs that say version 3 (qemu-img writes an older number).
printf '\x03' | dd of=/out/visitor-kiosk-disk1.vmdk bs=1 seek=4 count=1 conv=notrunc status=none
ls -l /out/visitor-kiosk-disk1.vmdk
