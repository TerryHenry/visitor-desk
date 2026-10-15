# Building the Visitor Desk VM

How to build the appliance (OVA) and its signed updates. To deploy and use the VM, see the [main README](../README.md).

## What's in the VM

Ubuntu Server 24.04 LTS cloud image with Visitor Desk in `/opt/visitor-kiosk`, Node.js 24 in `/opt/node`, the
`visitor-kiosk` service (ports 80 and 443), the `kiosk` maintenance command, a console banner with the address and
setup code, the ufw firewall, the update installer and the network settings helper (`kiosk-netcfg`, used by the
admin panel's Network section and by `kiosk network` / `kiosk ntp`). Only the app files are copied in: never `config.json`,
`data/`, `certs/` or other local files.

## Build the OVA

On a Mac or Linux computer with Docker and python3:

```
vm/build-ova.sh
```

It uses `vm/cache/ubuntu-24.04-server-cloudimg-amd64.ova` and `vm/cache/node-v24.21.0-linux-x64.tar.xz`
(it prints the download commands if they're missing, and checks them against the official checksums) and writes
`vm/dist/visitor-desk-<version>.ova` plus a `.sha256` file. The version comes from `package.json`.

## Build an update

```
vm/build-update.sh
```

Runs the automated tests, then writes `vm/dist/visitor-desk-update-<version>-<build>.kup`, signed with
`vm/keys/update-signing.key`. `--with-node` also puts the Node.js runtime from `vm/cache` into the update (download the
newest `node-v24.*-linux-x64.tar.xz` there first); the VM checks it runs the kiosk before switching.

Updates are signed with Ed25519. Each VM trusts only updates signed with the key it was built with: the private key
`vm/keys/update-signing.key` is created on the first build and is **not in Git**. **Back that key up.** Without it you
can't make updates for VMs that are already deployed; they'd need a redeploy.

`UPDATE_VERSION=x.y.z SKIP_TESTS=1 vm/build-update.sh` makes a test update with another version number. Delete it
afterwards: it's signed with the real key.

## Test

- `npm test`: the automated tests (no dependencies; a fake RUCKUS One, Twilio and mail server).
- `vm/test-boot.sh` boots the built disk under qemu (x86 emulation, slow on Apple Silicon) with ESXi-like hardware,
  with the VM's ports 80/443 on this computer as 18080/18443. Stop it with `docker rm -f kiosk-vm-test`.
- `vm/smoke-test.sh` runs 12 checks against that VM (HTTPS, redirects, security headers, the certificate and
  sign-in), or `vm/smoke-test.sh <address>` against a deployed VM.

## Release checklist

1. Raise the version in `package.json`, commit, and make sure `git status` is clean.
2. `vm/build-ova.sh` and `vm/build-update.sh`.
3. Boot the previous release's OVA under qemu, then install the new `.kup` through **Admin → Updates** and check it
   reports the new version; try **Go back to …** too.
4. Boot the new OVA with `vm/test-boot.sh` and run `vm/smoke-test.sh`.
5. If the screens changed, run `node docs/screenshots.js` to redo the README screenshots (docs/images).
6. Publish a GitHub release `v<version>` with the OVA, the `.kup` and a `SHA256SUMS-<version>.txt`, in this
   (private) repository and in the public downloads repository `TerryHenry/visitor-desk-releases`. Copy README.md
   (without "Building it yourself") and docs/ there first if they changed.
