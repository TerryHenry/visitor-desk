# Tools for building the kiosk OVA (and test-booting it). Runs on this Mac in Docker; not part of the VM.
FROM debian:bookworm
RUN apt-get update && apt-get install -y --no-install-recommends qemu-utils qemu-system-x86 fdisk xz-utils e2fsprogs ca-certificates busybox \
 && rm -rf /var/lib/apt/lists/*
