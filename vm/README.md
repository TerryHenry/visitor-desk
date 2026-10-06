# Visitor Desk VM (OVA for VMware ESXi / vSphere)

A ready-to-run appliance: Ubuntu Server 24.04 LTS with the kiosk server, Node.js 24 and HTTPS built in.
Nothing is downloaded when the VM starts; the first boot works without internet (RUCKUS One still needs it).

## Deploy on ESXi

1. ESXi Host Client: **Virtual Machines → Create / Register VM → Deploy a virtual machine from an OVF or OVA file**,
   and pick `visitor-desk-<version>.ova` (vSphere Client: **Deploy OVF Template**).
2. Choose a datastore and the network the tablets can reach. Thin provisioning is fine.
3. Power it on. The first boot takes a minute or two.
4. Open the VM console. Above the login prompt it shows:
   - **Kiosk and staff sign-in:** `https://<vm-address>/`
   - **Tablet first-time setup:** `http://<vm-address>/setup` (installs the kiosk certificate so the camera works)
   - **Admin setup code:** needed once, to create the first admin user from your browser.
5. In a browser, open `https://<vm-address>/`, tap **Admin**, and create the admin user with the setup code
   (8 digits; the dash is optional). Or log in on the console and run `kiosk create-admin` (no code needed there).
   Then set up the RUCKUS One connection as in the main README.

**No DHCP on that network (or no address shown)?** Log in on the console as kioskadmin and run `kiosk network`
to set a static address. It asks for the address with prefix (for example `192.168.10.50/24`), gateway and DNS servers.
Or in one line: `kiosk network static 192.168.10.50/24 192.168.10.1 192.168.10.1,1.1.1.1`. `kiosk network dhcp`
switches back. Without DHCP the boot waits about 30 seconds for an address and then carries on.

Give the VM a fixed address (static, or a DHCP reservation), so tablets keep finding it. The HTTPS certificate follows the
address automatically, and tablets don't need the certificate installed again.

Hardware: 2 vCPU, 2 GB RAM, 16 GB disk (thin), VMXNET3 network, VMware paravirtual SCSI, no floppy, BIOS, hardware version
vmx-10 (ESXi 5.5 and later). VMware Tools (open-vm-tools) is included.

## Console and maintenance

- Log in as **kioskadmin**, password **visitorkiosk**. You must choose a new password at the first login.
- Type `kiosk` for maintenance commands: `kiosk status`, `kiosk logs`, `kiosk restart`, `kiosk setup-code`,
  `kiosk reset-admin` (forgotten admin password or lost 2FA phone), `kiosk check` (RUCKUS One), `kiosk address`,
  `kiosk network` (DHCP or static IP), `kiosk version`, `kiosk update`, `kiosk rollback`, `kiosk backup`, `kiosk restore`, `kiosk firewall`, `kiosk create-admin` (first admin, no setup code needed).
- SSH doesn't accept passwords. To use SSH, add your public key to `/home/kioskadmin/.ssh/authorized_keys`.
- App and data: `/opt/visitor-kiosk` (config.json, data/visits, certs). Back it up with `kiosk backup`: it asks for a
  password and writes an encrypted file (settings, users, visitor records, certificates). Copy it off the VM, for
  example `scp kioskadmin@<vm>:visitor-desk-backup-*.enc .`. `kiosk restore <file>` puts it back on this or a new VM
  (the current data is kept in `/opt/visitor-kiosk-before-restore-<date>.tar.gz` first).
- Firewall (ufw, turned on automatically): 80 and 443 from anywhere, SSH only from private networks (10.x, 172.16–31.x,
  192.168.x). `kiosk firewall` shows the rules. To allow SSH from elsewhere: `sudo ufw allow from <address> to any port 22 proto tcp`.
- Ubuntu installs security updates automatically (unattended-upgrades) when the VM has internet access.
- Two-step sign-in codes depend on the correct time. The VM keeps time with NTP (ntp.ubuntu.com); if it has no
  internet, point it at your own NTP server in `/etc/systemd/timesyncd.conf`.

## Updating a deployed VM

**From the admin panel (1.8.0 and later):** Admin → **Updates** → **Choose update file** (the `.kup`), check the
version, **Install now**. The VM checks the signature, installs, restarts and goes back by itself if the new version
doesn't start. **Go back to …** returns to the previous version. The first update to 1.8.0 still has to be done on the
console (below); after that the admin panel works.

**On the console:**

Updates replace only the app and the VM's helper files. `config.json`, visitor records, certificates, users and the
shared look stay as they are.

1. On the build computer: `vm/build-update.sh` → `vm/dist/visitor-desk-update-<version>-<build>.kup` (about 70 KB).
2. Make it reachable from the VM, for example: `python3 -m http.server 8000 --directory vm/dist` on the build computer.
3. On the VM console: `kiosk update http://<build computer>:8000/visitor-desk-update-....kup`
   (or `kiosk update <file>`). It shows the installed and new versions and asks before installing.
4. The kiosk restarts on the new version. If it doesn't answer within 30 seconds, the update is undone automatically.
   `kiosk rollback` goes back to the version before the last update. `kiosk version` shows what's installed.
5. **Node.js updates:** `vm/build-update.sh --with-node` also puts the Node.js runtime from `vm/cache` into the update
   (download the newest `node-v24.*-linux-x64.tar.xz` there first). The VM checks it runs the kiosk before switching,
   and `kiosk rollback` restores the old one. VMs on 1.3.x need one normal update to 1.4.0 first.

Updates are signed. Each VM trusts only updates signed with the key it was built with: `vm/keys/update-signing.key`
(private, created on the first build, not in Git). **Back that key up.** Without it you can't make updates for VMs
that are already deployed; they'd need a redeploy. An update whose signature doesn't match is refused.

## Build it again

On a Mac or Linux computer with Docker and python3:

```
vm/build-ova.sh
```

It uses `vm/cache/ubuntu-24.04-server-cloudimg-amd64.ova` and `vm/cache/node-v24.21.0-linux-x64.tar.xz`
(it prints the download commands if they're missing) and writes `vm/dist/visitor-desk-<version>.ova` plus a
`.sha256` file. Only the app files are copied in: never `config.json`, `data/`, `certs/` or other local files.

`vm/test-boot.sh` boots the built disk under qemu (x86 emulation, slow on Apple Silicon) with ESXi-like hardware,
with the VM's ports 80/443 on this computer as 18080/18443. Stop it with `docker rm -f kiosk-vm-test`.
