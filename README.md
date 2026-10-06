# Visitor Desk

Visitor check-in and Wi-Fi for RUCKUS One.

A small server that runs the check-in kiosk page and creates Wi-Fi access in RUCKUS One.
It handles all three access types you can pick in the kiosk admin settings:

| Kiosk setting | What the server does |
|---|---|
| Captive portal with guest pass code | Creates a guest user on your guest pass network. RUCKUS One makes the code and can email or text it. |
| Personal password per visitor (DPSK) | Creates a DPSK passphrase in your DPSK service, with the device limit and expiry you set. |
| Shared password | Logs the visitor and hands out your shared Wi-Fi password. Nothing is created in RUCKUS One. |

It also saves each visit (details, photo, license image) in `data/visits/` and deletes them after the retention period.
Host alerts go to a Slack or Teams webhook if you set one.

No `npm install` is needed. It only uses what comes with Node.js.

---

## 1. Get your RUCKUS One API credentials

1. Log in to RUCKUS One.
2. Go to **Administration > Account Management > Settings**.
3. At the bottom, click **Add Application Token**. Save the **client ID** and **client secret**.
4. Note your **tenant ID** (shown with the token details, and in the URL after you log in).
5. Note your region: `na` (ruckus.cloud), `eu` (eu.ruckus.cloud) or `asia` (asia.ruckus.cloud).

If you manage customers as an MSP, you'll also need the customer's tenant ID.

## 2. Set up on your MacBook

1. Install Node.js 20 LTS from https://nodejs.org (or `brew install node`).
2. Open Terminal in this folder and start the server:
   ```
   caffeinate -s node server.js
   ```
   (`caffeinate` keeps the Mac awake while the kiosk runs.) No `config.json` is needed yet.
3. On the Mac, open `http://localhost:3000` and tap **Admin**. The first time, create the admin user
   (password 8 to 20 characters). From another device you also need the **setup code** printed in the server window.
   Then go to **RUCKUS One connection**:
   - Pick the region, enter the tenant ID, client ID and client secret, then click **Connect**.
     The secret is saved in `config.json` on the Mac and is never shown again.
   - Pick the venue, the visitor Wi-Fi network and (for DPSK) the DPSK service from the lists.
     Choosing a network also sets the access type and SSID.
   - Click **Save settings**.
4. Set up the tablet once, so its camera works (browsers only allow the camera over https):
   - The server prints a **setup** address, e.g. `http://192.168.1.50:3000/setup`. Open it on the tablet.
   - Follow the steps there to install the kiosk certificate. On iPad: download it, install the profile in Settings,
     then turn it on under **Settings → General → About → Certificate Trust Settings**.
   - Tap **Open the kiosk**. It opens at `https://192.168.1.50:3443`. Add it to the home screen.
   If macOS asks whether to allow incoming connections for node, click **Allow**.
   The certificate is made by the server with `openssl` (built into macOS and Raspberry Pi OS; on Windows install
   Git for Windows or OpenSSL). It only works for local addresses, never for real websites.
5. To tell hosts their visitor has arrived: in **Admin**, turn on **Tell the host their visitor has arrived**, add each
   person to the host list as `name, email, mobile`, and fill in **Host alerts**:
   - Email: your mail server (for example `smtp.office365.com` or `smtp.gmail.com`, port 587, STARTTLS) and an app password.
   - Text: a Twilio account SID, auth token and Twilio phone number.
   Use **Send test email** / **Send test text** to check. Contacts and passwords stay in `config.json` on the Mac.
6. On the tablet, open **Admin** and set the kiosk options (fields, look, host list). These are saved on the tablet.

You can still edit `config.json` by hand (see `config.example.json`), and `node server.js check` tests the login
and lists your venues, networks and DPSK services.

## Staff sign-in

- **Admin** users can change everything and manage users. **Reception** users only see visitor records, can end a
  visitor's Wi-Fi access (guest pass or DPSK password), check visitors out, add expected visitors, and block or unblock visitors.
- Passwords are 8 to 20 characters. Each user can turn on **two-step sign-in** (an authenticator app code) under
  **Users and sign-in** (reception: **My account**).
- 5 wrong tries lock that device out for 5 minutes. Closing the admin panel signs out; an idle panel closes after 10 minutes.
- Forgot the admin password or lost the phone? On the server run `node server.js reset-admin` (removes admin users,
  keeps reception users), restart, and create a new admin. An admin can also set a new password for any other user,
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

## Automated tests

```
npm test
```

Runs about 60 checks in a few seconds, with nothing to install (Node's built-in test runner). Each test starts the
server on a throwaway copy with a fake RUCKUS One, a fake mail server and a fake Twilio, so nothing real is touched:
check-ins in all three Wi-Fi modes, check-out, invites and CSV import, returning visitors, blocking and staff alerts,
users and two-step sign-in, reports (CSV and PDF), privacy requests, devices and floor plans, the page's security
headers, HTTPS-only access from other devices, tablet pairing and rate limits, plus the kiosk page's translations and
helpers. Run it before building an update.

For a VM: `vm/test-boot.sh` boots the built OVA under emulation, then `vm/smoke-test.sh` checks it (or
`vm/smoke-test.sh 192.168.1.50` for a deployed VM): HTTPS, redirects, security headers, the certificate and sign-in.

## Emergencies, leaving, hosts and analytics

- **Emergency message** (Visitor records → On site now, admins and front desk): pick Evacuate, Shelter in place or All
  clear (or write your own), send it by text and/or email to everyone checked in (or only those with a device connected
  now). A **roll call** follows: tap **Safe** as people arrive at the assembly point; every staff screen shows a red bar
  with the count until it's ended. Visitors can't reply (their phones usually can't reach the kiosk server).
- **Leaving without checking out** (admin): visitors whose devices haven't been on the Wi-Fi for a while (2 hours by
  default) show as **Probably left**; optionally they're checked out automatically (and their Wi-Fi ended).
- **Host links** (admin): send each host a personal link to a page where they add their own expected visitors and see
  who has arrived. Arrival alerts include an **On my way** link: the visitor sees "Dana is on the way to meet you" on the
  kiosk, and gets a text. Hosts need to reach the kiosk server (your network), and may see a certificate warning the
  first time unless they install it from `/setup`.
- **Analytics** (Visitor records tab): visits, different and returning visitors, visit length, busy times (day × hour),
  how visits ended, where visitors spend time (by access point), top hosts/companies/reasons and Wi-Fi data used.

## 3. Test it

Check in a test visitor with each mode you plan to use, then look in RUCKUS One:

- **Guest pass:** Clients > Wireless > Guest Pass Credentials should show the new guest.
- **DPSK:** Network Control > My Services > DPSK > your service > Passphrases.
  DPSK creation is processed in the background, so the passphrase can take a few seconds to work.

The server window shows one line per check-in, and the full error if RUCKUS One rejects something.

A few API details weren't fully documented and may need a tweak for your account:

- **Guest pass delivery names.** The kiosk sends `MAIL`, `SMS` or `PRINT` (from the RUCKUS One guest API). If RUCKUS One ever renames them, change `deliveryMethodNames`.
- **Guest pass phone number.** RUCKUS One requires a phone number for guest users. If you hide the phone field in the kiosk, set `fallbackPhone` (such as your front desk number).
- **DPSK expiry format.** If you get an error about expiration, set `dpsk.expirationFormat` to `"date"`.

## 4. Settings reference (`config.json`)

| Setting | Meaning |
|---|---|
| `port` | Port the kiosk runs on. Default 3000. |
| `ruckus.*` | API login. You can use environment variables instead: `R1_REGION`, `R1_TENANT_ID`, `R1_CLIENT_ID`, `R1_CLIENT_SECRET`. |
| `guestPass.wifiNetworkId` | Your captive portal guest pass network. |
| `dpsk.poolId` | Your DPSK service. |
| `psk.password` | Shared Wi-Fi password. If empty, the one in the kiosk settings is used. |
| `notifications.hostWebhookUrl` | Slack or Teams incoming webhook for "your visitor is here" messages. |
| `storage.storeIdImages` | `false` records that ID was checked without saving the image. |
| `storage.retentionDays` | Maximum days to keep visitor records. The kiosk setting can make it shorter, not longer. |
| `security.allowedIps` | List of tablet IP addresses allowed to use the server. Empty means any device on your network. |
| `security.users` | Staff sign-in accounts, managed in **Admin → Users and sign-in** (passwords stored as hashes). |

## 5. Moving to Windows or a Raspberry Pi later

Copy the whole folder, including `config.json` and `data/`, to the new machine.

**Windows**
1. Install Node.js 20 LTS from https://nodejs.org.
2. In PowerShell, in this folder: `node server.js`
3. Click **Allow access** when Windows Firewall asks (Private networks).
4. To start automatically, create a Task Scheduler task that runs `node.exe` with argument `server.js`, "Start in" set to this folder, trigger "At startup".

**Raspberry Pi (Raspberry Pi OS)**
1. Install Node.js 20:
   ```
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt install -y nodejs
   ```
2. Copy this folder to `/home/pi/ruckus-kiosk` and test with `node server.js`.
3. To run at boot, create `/etc/systemd/system/ruckus-kiosk.service`:
   ```
   [Unit]
   Description=Visitor Desk
   After=network-online.target
   Wants=network-online.target

   [Service]
   WorkingDirectory=/home/pi/ruckus-kiosk
   ExecStart=/usr/bin/node server.js
   Restart=always
   User=pi

   [Install]
   WantedBy=multi-user.target
   ```
   Then: `sudo systemctl enable --now ruckus-kiosk`

## Security notes

- `config.json` holds your API secret. Don't share it or commit it to Git (it's in `.gitignore`).
- Staff sign in (passwords, optional two-step sign-in). Check-ins come only from paired tablets once one is paired.
  `allowedIps` can limit it further.
- DPSK passwords follow the chosen DPSK service's passphrase format in RUCKUS One (like DwellLink). The admin panel
  shows the format and warns if it's easy to guess (under about a trillion combinations, for example 8 digits).
  Raise the length or pick a stronger format for that service in RUCKUS One.
- The kiosk page sends a strict Content Security Policy and the usual security headers.
- `data/visits/` contains photos and ID images. Keep the machine's disk encrypted (FileVault on Mac, BitLocker on Windows) and check your local privacy rules.
