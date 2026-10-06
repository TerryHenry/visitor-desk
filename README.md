# Visitor Desk

Visitor check-in and Wi-Fi for RUCKUS One, as a ready-to-run virtual appliance for VMware ESXi and vSphere.

Visitors check in on a lobby tablet. Visitor Desk creates their Wi-Fi access in RUCKUS One, keeps a record of the
visit and tells their host they've arrived. It handles all three access types you can pick in the admin settings:

| Access type | What Visitor Desk does |
|---|---|
| Captive portal with guest pass code | Creates a guest user on your guest pass network. RUCKUS One makes the code and can email or text it. |
| Personal password per visitor (DPSK) | Creates a DPSK passphrase in your DPSK service, with the device limit and expiry you set. |
| Shared password | Logs the visitor and hands out your shared Wi-Fi password. Nothing is created in RUCKUS One. |

The appliance is Ubuntu Server 24.04 LTS with Visitor Desk, Node.js and HTTPS built in. Nothing is downloaded when
the VM starts; the first boot works without internet (RUCKUS One still needs it).

---

## 1. Download

From the [Releases](../../releases) page, download:

- `visitor-desk-<version>.ova`: the virtual machine, for a new install.
- `visitor-desk-update-<version>-<build>.kup`: the signed update, for a VM you already have.
- `SHA256SUMS-<version>.txt`: checksums, to check the downloads (`shasum -a 256 -c SHA256SUMS-<version>.txt`).

## 2. Get your RUCKUS One API credentials

1. Log in to RUCKUS One.
2. Go to **Administration > Account Management > Settings**.
3. At the bottom, click **Add Application Token**. Save the **client ID** and **client secret**.
4. Note your **tenant ID** (shown with the token details, and in the URL after you log in).
5. Note your region: `na` (ruckus.cloud), `eu` (eu.ruckus.cloud) or `asia` (asia.ruckus.cloud).

If you manage customers as an MSP, you'll also need the customer's tenant ID.

## 3. Deploy the VM

1. ESXi Host Client: **Virtual Machines → Create / Register VM → Deploy a virtual machine from an OVF or OVA file**,
   and pick `visitor-desk-<version>.ova` (vSphere Client: **Deploy OVF Template**).
2. Choose a datastore and the network the tablets can reach. Thin provisioning is fine.
3. Power it on. The first boot takes a minute or two.
4. Open the VM console. Above the login prompt it shows:
   - **Kiosk and staff sign-in:** `https://<vm-address>/`
   - **Tablet first-time setup:** `http://<vm-address>/setup`
   - **Admin setup code:** needed once, to create the first admin user from your browser.

Hardware: 2 vCPU, 2 GB RAM, 16 GB disk (thin), VMXNET3 network, VMware paravirtual SCSI, BIOS, hardware version
vmx-10 (ESXi 5.5 and later). VMware Tools (open-vm-tools) is included.

**No DHCP on that network (or no address shown)?** Log in on the console as kioskadmin (see
[Console and maintenance](#console-and-maintenance)) and run `kiosk network` to set a static address. It asks for the
address with prefix (for example `192.168.10.50/24`), gateway and DNS servers. Or in one line:
`kiosk network static 192.168.10.50/24 192.168.10.1 192.168.10.1,1.1.1.1`. `kiosk network dhcp` switches back.
Without DHCP the boot waits about 30 seconds for an address and then carries on.

Give the VM a fixed address (static, or a DHCP reservation), so tablets keep finding it. The HTTPS certificate follows
the address automatically, and tablets don't need the certificate installed again.

## 4. First setup

1. In a browser, open `https://<vm-address>/` (accept the certificate warning this once, or install the certificate
   from `/setup` first), tap **Admin**, and create the admin user with the setup code (8 digits; the dash is optional;
   password 8 to 20 characters). Or log in on the console and run `kiosk create-admin` (no code needed there).
2. Go to **RUCKUS One connection**:
   - Pick the region, enter the tenant ID, client ID and client secret, then click **Connect**.
     The secret is saved on the VM and is never shown again.
   - Pick the venue, the visitor Wi-Fi network and (for DPSK) the DPSK service from the lists.
     Choosing a network also sets the access type and SSID.
   - Click **Save settings**.
3. Set up each tablet once, so its camera works (browsers only allow the camera over https):
   - On the tablet, open `http://<vm-address>/setup`.
   - Follow the steps there to install the kiosk certificate. On iPad: download it, install the profile in Settings,
     then turn it on under **Settings → General → About → Certificate Trust Settings**.
   - Tap **Open the kiosk**. It opens at `https://<vm-address>/`. Add it to the home screen.
   The certificate is made by the VM and only works for local addresses, never for real websites.
4. On the tablet, open **Admin**, sign in, and pair it under **Kiosk tablets** (see below).
5. To tell hosts their visitor has arrived: in **Admin**, turn on **Tell the host their visitor has arrived**, add each
   person to the host list as `name, email, mobile`, and fill in **Email and text messages**:
   - Email: your mail server (for example `smtp.office365.com` or `smtp.gmail.com`, port 587, STARTTLS) and an app password.
   - Text: a Twilio account SID, auth token and Twilio phone number.
   Use **Send test email** / **Send test text** to check.
6. Set the kiosk options (fields, look, location name, host list) under **Admin**. **Use this look on every kiosk**
   shares the look with all tablets.

## 5. Test it

Check in a test visitor with each access type you plan to use, then look in RUCKUS One:

- **Guest pass:** Clients > Wireless > Guest Pass Credentials should show the new guest.
- **DPSK:** Network Control > My Services > DPSK > your service > Passphrases.
  DPSK creation is processed in the background, so the passphrase can take a few seconds to work.

If RUCKUS One rejects something, **Admin → Recent problems** shows what went wrong and what to do.
`kiosk check` on the console tests the RUCKUS One login and lists your venues, networks and DPSK services.

## Staff sign-in

- **Admin** users can change everything and manage users. **Reception** users only see visitor records, can end a
  visitor's Wi-Fi access (guest pass or DPSK password), check visitors out, add expected visitors, and block or unblock visitors.
- Passwords are 8 to 20 characters. Each user can turn on **two-step sign-in** (an authenticator app code) under
  **Users and sign-in** (reception: **My account**).
- 5 wrong tries lock that device out for 5 minutes. Closing the admin panel signs out; an idle panel closes after 10 minutes.
- Forgot the admin password or lost the phone? On the VM console run `kiosk reset-admin` (removes admin users,
  keeps reception users), then create a new admin with the setup code (`kiosk setup-code`). An admin can also set a new password for any other user,
  which also turns off that user's two-step sign-in.
- Blocked visitors see "Please see reception" at check-in and get no Wi-Fi. A match is the same email, phone number
  or full name. The attempt shows in the visitor records.

## Kiosk tablets (pairing)

Once one tablet is paired, the server accepts check-ins and the host list **only from paired tablets** (and from the
server itself). Until then any device can check in, and the admin panel warns about it.

1. On each tablet, open the kiosk, tap **Admin**, sign in, and go to **Kiosk tablets**.
2. Type a name (for example "Lobby iPad") and tap **Pair this tablet**. The tablet keeps its own key; nothing to copy.
3. Lost or replaced tablet: **Remove** it from the list. It can't check anyone in after that.

Each tablet can check in 20 visitors per 10 minutes (150 per hour overall), so a stolen key or a script can't fill
RUCKUS One with passes. From other devices the API works only over `https://`.

## At a glance, and the audit log

- **Admin → At a glance** (reception users see it at the top of Visitor records): check-ins today, this week and this month; active passes; guest devices online now; a
  14-day chart; top hosts, companies and visit reasons this month; the busiest hour, returning visitors, blocked
  check-ins, paired tablets and problems in the last 24 hours.
- **Admin → Audit log:** who signed in (and failed), changed settings or users, exported, deleted, ended access,
  blocked, resent, printed, looked up devices, and paired tablets. Kept in `data/audit.log`.

## Visitor records, report and devices

- **Admin → Privacy:** how long visit records are kept (up to 5 years, or **Forever**), and separately how long
  photos and license scans are kept. It applies to older visits too.
- **Visitor records → Export CSV / Export PDF** (admins and reception): the visits matching the search, date range or
  "On site now", as a spreadsheet or a printable report (times in your device's time zone).
- **Visitor records → Expected visitors → Import from CSV** (admins and reception): add many expected visitors at once.
  **Download a template** for the columns: Name, Email, Phone, Company, Visiting, Reason, Date, Last day, Note (only
  Name is required; dates like 2026-10-03 or 10/3/2026; no date means today). A preview shows what will be added and
  which lines have problems; their codes can be emailed straight away.
- **Visitor records:** quick ranges (Last 24 hours, 7 days, 30 days, All). On a visit, admins can **Print badge**
  and **Email / Text Wi-Fi details** again; both use the visitor's current password from RUCKUS One. Resending uses
  the settings under Email and text messages (DPSK can also fall back to RUCKUS One's own message).
- **Visitor records → Devices** (admins): visitor devices **on site now** with the access point they're on, and a
  search by MAC address, device name, visitor or access point. Each device has a **timeline** of the access points it
  used. A visit's details list its devices too. Works for DPSK and guest pass visitors (not shared-password visitors);
  the server checks RUCKUS One every 2 minutes and keeps the timeline with the visit record.
  Tell visitors: the default agreement text mentions device locations.

## Check-out, expected visitors and other visitor features

Turn these on under **Admin → Kiosk buttons and languages** (they need the kiosk server):
- **Leaving? Check out:** visitors type the check-out code from their pass or badge (or their email or phone). Their
  Wi-Fi access ends too (you can turn that off). Staff can also tap **Check out** on a visit.
  **Visitor records → On site now** lists everyone still here, with each visitor's devices and the access point
  they're connected to. Choose **Everyone checked in** or **Device connected now** (only people whose phone or laptop is
  on the Wi-Fi right now); **Refresh devices** asks RUCKUS One straight away (it's otherwise checked every 2 minutes).
  **Print on-site list** prints a roll-call sheet for an evacuation, and the CSV/PDF exports follow the same choice.
  Shared-password visitors' devices can't be told apart, so they show "Not tracked".
  **Floor plan** shows the venue's RUCKUS One floor plans with the access points on them and how many visitor devices
  are on each; tap one to see who. On a device (admins), **Show on floor plan** opens the right floor with that access
  point highlighted. A visitor's spot is the access point they're connected to, not their exact position. Floor plans
  and AP positions come from RUCKUS One (add a floor plan to the venue and place the APs on it there).
- **I have an invite code:** add people under **Visitor records → Expected visitors** (admins and reception). They get
  a 6-digit code by email; at the kiosk their details are filled in. Give a **last day** for a multi-day pass (up to
  31 days): one check-in, Wi-Fi for the whole visit.
- **Been here before?** visitors type the email or phone from an earlier visit to fill in their details, and can
  reuse their photo (it's never shown on the kiosk).
- **Languages:** English, Spanish, French. Visitors switch at the top of the first screen.
- **Signature:** under **What visitors fill in**, set **Signature** to Required or Optional. Visitors sign on the
  last step; the signature is kept with the visit.
- **Badge size** (under After check-in): full page, or a label for Brother QL (62 mm), DYMO 30857 or a 4-inch Zebra.
- **Staff alerts:** email or text staff when a blocked person tries to check in, a tablet goes offline, or check-ins
  fail. **Summary email:** daily or weekly numbers. Both use **Email and text messages**.
- **Find a person** (Visitor records, admins): for privacy requests, download everything about one person as a file,
  or delete it all.

## Updating

Updates replace only the app and the VM's helper files. Settings, visitor records, certificates, users and the shared
look stay as they are. Updates are signed: the VM refuses any file that isn't signed with the Visitor Desk update key.

**From the admin panel (VMs on 1.8.0 and later):** download the `.kup` from [Releases](../../releases), then
**Admin → Updates → Choose update file**, check the version and tap **Install now**. The VM checks the signature,
installs, restarts (about 20 seconds) and goes back by itself if the new version doesn't start.
**Go back to …** returns to the previous version.

**On the console (VMs older than 1.8.0):** put the `.kup` somewhere the VM can download it (for example
`python3 -m http.server 8000` in the download folder on your computer), then on the VM console:
`kiosk update http://<your computer>:8000/<file>.kup`. It shows the installed and new versions and asks before
installing. If the kiosk doesn't answer within 30 seconds afterwards, the update is undone automatically.
VMs older than 1.4.1 should run the update from a copy of the updater:
`sudo cp /usr/local/sbin/kiosk-update /tmp/ku && sudo bash /tmp/ku <url>`.

`kiosk rollback` goes back to the version before the last update; `kiosk version` shows what's installed.

## Console and maintenance

- Log in as **kioskadmin**, password **visitorkiosk**. You must choose a new password at the first login.
- Type `kiosk` for maintenance commands: `kiosk status`, `kiosk logs`, `kiosk restart`, `kiosk setup-code`,
  `kiosk reset-admin` (forgotten admin password or lost 2FA phone), `kiosk check` (RUCKUS One), `kiosk address`,
  `kiosk network` (DHCP or static IP), `kiosk version`, `kiosk update`, `kiosk rollback`, `kiosk backup`,
  `kiosk restore`, `kiosk firewall`, `kiosk create-admin` (first admin, no setup code needed).
- SSH doesn't accept passwords. To use SSH, add your public key to `/home/kioskadmin/.ssh/authorized_keys`.
- **Backups:** `kiosk backup` asks for a password and writes an encrypted file (settings, users, visitor records,
  certificates). Copy it off the VM, for example `scp kioskadmin@<vm>:visitor-desk-backup-*.enc .`.
  `kiosk restore <file>` puts it back on this or a new VM (the current data is saved first).
- Firewall (turned on automatically): 80 and 443 from anywhere, SSH only from private networks (10.x, 172.16–31.x,
  192.168.x). `kiosk firewall` shows the rules. To allow SSH from elsewhere: `sudo ufw allow from <address> to any port 22 proto tcp`.
- Ubuntu installs security updates automatically when the VM has internet access.
- Two-step sign-in codes depend on the correct time. The VM keeps time with NTP (ntp.ubuntu.com); if it has no
  internet, point it at your own NTP server in `/etc/systemd/timesyncd.conf`.

## A few RUCKUS One details

Some API details weren't fully documented and may need a tweak for your account (in `/opt/visitor-kiosk/config.json`
on the VM, then `kiosk restart`):

- **Guest pass delivery names.** Visitor Desk sends `MAIL`, `SMS` or `PRINT` (from the RUCKUS One guest API). If RUCKUS One ever renames them, change `deliveryMethodNames`.
- **Guest pass phone number.** RUCKUS One requires a phone number for guest users. If you hide the phone field in the kiosk, set `fallbackPhone` (such as your front desk number).
- **DPSK expiry format.** If you get an error about expiration, set `dpsk.expirationFormat` to `"date"`.

## Security notes

- The RUCKUS One secret stays on the VM and is never sent to a browser.
- Staff sign in (passwords, optional two-step sign-in). Check-ins come only from paired tablets once one is paired.
- DPSK passwords follow the chosen DPSK service's passphrase format in RUCKUS One. The admin panel shows the format
  and warns if it's easy to guess (under about a trillion combinations, for example 8 digits). Raise the length or
  pick a stronger format for that service in RUCKUS One.
- The kiosk page sends a strict Content Security Policy and the usual security headers.
- Visitor records include photos and ID images. Keep the datastore encrypted if your privacy rules require it, set
  how long records are kept under **Admin → Privacy**, and keep backups somewhere safe.

## Building it yourself

See [vm/README.md](vm/README.md) for building the OVA and signed updates, and running the automated tests.
