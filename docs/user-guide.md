# User guide

How to use Visitor Desk day to day. New install? Start with [Getting started](getting-started.md).

- [What visitors see](#what-visitors-see)
- [Signing in](#signing-in)
- [Front desk](#front-desk): visitor records, on site now, check-out, expected visitors, reports, emergencies
- [Admins](#admins): every setting, grouped as in the settings menu
- [Maintenance](#maintenance): updates, the VM console, backups
- [Troubleshooting](#troubleshooting)

The same help is built in: tap **Help** in Visitor records or on the settings page.

---

## What visitors see

1. **First screen.** The headline and **Check in**. Depending on the settings there are also **Leaving? Check out**,
   **I have an invite code**, **Been here before?** and a language switch (English, Spanish, French).
2. **About you.** Name (always required), and email, phone and company if they're turned on.
3. **Who you're visiting.** The host (type-ahead or pick from a list) and the reason for the visit.
4. **Photo and ID.** A photo through the tablet camera, with an oval guide, and a photo of the front of their ID
   with a card guide. **Choose a file instead** is there if the camera can't be used.
5. **Agreement and signature.** The agreement text (with how long their details are kept), and a signature if it's
   turned on.
6. **Their pass.** The Wi-Fi network, a QR code that joins it, the password or guest pass code, when it runs out, and
   a 6-digit check-out code. The badge prints, and the pass is emailed or texted, if those are turned on. When the
   host taps **On my way**, the pass screen shows "Dana is on the way to meet you".

Steps with nothing to fill in are skipped, and the kiosk clears itself after a short time so the next visitor starts
fresh. Visitors never see another visitor's details: lookups for returning visitors show only a first name and
company, never an email, phone or photo.

## Signing in

Tap **Admin** on the kiosk (or tap the signal bars at the top five times), or open `https://<vm-address>/` on any
computer and tap **Admin**.

- **Admins** see all settings and Visitor records. **Reception** (front desk) users see Visitor records and
  **My account** only.
- Passwords are 8 to 20 characters. 5 wrong tries lock that device out for 5 minutes.
- **Two-step sign-in:** under **Users and sign-in** (admins) or **My account** (front desk), scan the QR code with an
  authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…) and enter a code to turn it on.
- Closing the panel signs you out, and so do 10 minutes without use.
- Lost your phone or forgot the password? An admin can set a new password for you, which also turns two-step sign-in
  off. If every admin is locked out, see [kiosk reset-admin](#console-and-maintenance).

---

## Front desk

Everything for the front desk is in **Visitor records**. Admins can do all of this too.

### Visitor records

Tabs: **Visits** (everyone who checked in), **Expected visitors**, **Blocked**, **Analytics**, and for admins
**Devices** and **Find a person**. At the top, **At a glance** shows today's check-ins, who's on site and a 14-day chart.

- Search by name, company, host or email, and pick a range: **Last 24 hours**, **7 days**, **30 days**, **All**, or
  your own dates. On a wide screen the list is a table you can sort; tap a visit to open it.
- **A visit** shows the details, photo, ID image, signature and devices. From there:
  - **Check out**: marks them as gone and ends their Wi-Fi (unless an admin turned that off).
  - **End Wi-Fi access**: their guest pass or personal password is deleted in RUCKUS One, and their devices that are
    still on the Wi-Fi are disconnected, so they can't get back on. The visit shows how many were disconnected. (For
    DPSK, the identity RUCKUS One keeps for the password is removed too.)
    A shared password can't be ended for one person.
  - **Block this visitor**: they can't check in again with the same name, email or phone, and staff are alerted if
    they try. **Also end their Wi-Fi access now** (ticked) ends their access and disconnects their devices. For a
    personal password (DPSK) visitor, their identity is blocked in RUCKUS One instead of their password being deleted,
    so they show as **Blocked** under **Clients > Identities**, where a property manager can see it and undo it.
    Unblock them under the **Blocked** tab: their identity is unblocked too, and their Wi-Fi works again if their pass
    hasn't run out. (Guest pass visitors aren't identities in RUCKUS One: their pass is deleted.)
  - **Disconnect their devices** (once access has ended): disconnects their devices again, for example a phone that
    was still connected. For a blocked DPSK visitor it also blocks their identity in RUCKUS One if that hasn't
    happened yet.
  - Admins can also **Print badge**, **Email / Text Wi-Fi details** again (with the visitor's current password from
    RUCKUS One) and **Delete this visit**.

### Who's on site

**Visitor records → On site now** lists everyone who has checked in, hasn't checked out and whose pass is still valid,
with their devices and the access point each one is connected to.

- **Everyone checked in** or **Device connected now** (only people whose phone or laptop is on the Wi-Fi right now).
- **Refresh devices** asks RUCKUS One straight away; it's otherwise checked every 2 minutes.
- **Print on-site list** prints a roll-call sheet with photos and a tick box per person.
- **Floor plan** shows the RUCKUS One floor plans with the access points and how many visitors are near each one.
  Tap an access point to see who. A visitor's spot is the access point their device uses, not their exact position.
- **Probably left** means none of their devices has been on the Wi-Fi for a while (2 hours unless an admin changed it).
- Shared-password visitors' devices can't be told apart, so they show "Not tracked".

### Checking visitors out

Visitors check themselves out at the kiosk: **Leaving? Check out**, then the 6-digit check-out code from their pass or
badge, or the email or phone number they used. To do it yourself, open their visit and tap **Check out**. If someone
leaves without checking out, their pass still runs out at the time shown.

### Expected visitors and invite codes

Add people before they arrive so check-in takes seconds: **Visitor records → Expected visitors → Add an expected
visitor**.

- Each gets a 6-digit invite code. At the kiosk they tap **I have an invite code** and their details are filled in.
- **Email pass now** / **Text pass now** send them the code, or tick "Email/Text them their code now" when adding.
- Give a **Last day** for a multi-day visit (contractors, up to 31 days): they check in once and their Wi-Fi lasts the
  whole visit. A code works once, on the visit's days only.
- **Import from CSV** adds many at once. **Download a template** for the columns: Name, Email, Phone, Company,
  Visiting, Reason, Date, Last day, Note. Only Name is needed; dates like 2026-10-03 or 10/3/2026; no date means today;
  "Lee, Jordan" becomes "Jordan Lee". A preview shows what will be added and which lines have problems.
- Hosts can add their own visitors with their personal link (see [Host links](#arrivals-and-departures)).

### Reports

Pick what you want in Visitor records (search, range, dates, or **On site now**), then **Export CSV** for a
spreadsheet or **Export PDF** for a printable report. Times are in your device's time zone. Exports are recorded in
the audit log.

### Analytics

**Visitor records → Analytics**, for 7 days, 30 days, 90 days, a year or your own dates: visits, different and
returning visitors, how long visits last, busy times (day of the week × hour), how visits ended, where visitors spend
their time (by access point), top hosts, companies and reasons, and Wi-Fi data used.

### Emergency message and roll call

1. **Visitor records → On site now → Emergency message.**
2. Pick **Evacuate**, **Shelter in place** or **All clear**, or write your own message.
3. Choose who: **Everyone checked in**, or only people with a device connected now. Tick **Text message** and/or
   **Email**, then **Send now**. Staff on the alert list get a copy.
4. The roll call opens. As people reach the assembly point, tap **Safe** next to their name. Other staff see the same
   list, and a red bar at the top of Visitor records shows how many are safe. "Show only people not marked safe" helps
   find who's missing; **Print roll call** gives you a paper copy.
5. Sending **All clear** keeps the safe marks. When everyone is accounted for, tap **End roll call**.

Visitors can't reply to the message, so marking them safe is up to staff.

---

## Admins

The settings page is grouped like this (on a wide screen there's a menu on the left).

### Overview

- **Visitor records** opens the records described above.
- **At a glance**: check-ins today, this week and this month, active passes, guest devices online, a 14-day chart,
  top hosts, companies and reasons, the busiest hour, returning visitors, blocked check-ins, paired tablets and
  problems in the last 24 hours.
- **Recent problems**: failed check-ins, RUCKUS One errors and failed messages, newest first, with what to do for each.
  Visitors only ever see "Please ask reception for help".

### Kiosk screen

- **What visitors fill in**: each item (email, phone, company, host, reason, photo, license photo, signature) is
  **Required**, **Optional** or **Hidden**. The host list is one person per line as `name, email, mobile`
  (for example `Jordan Lee, jordan@acme.com, 813-555-0142`); visitors pick from it or type ahead. Also the visit
  reasons and the agreement text.
- **Kiosk buttons and languages**: **Leaving? Check out**, **I have an invite code**, **Been here before?** (visitors
  type the email or phone from an earlier visit and can reuse their photo), and Spanish and French. Text you've
  changed shows as you typed it.
- **Look**: light, dark or automatic; color scheme; logo (with size, and the location name under it if you like);
  background image. **Use this look on every kiosk** shares it, with the location name and headline, with all tablets.
- **Location and screen**: the location name (used in messages and reports), the headline, how soon the kiosk
  clears itself, and the **On-screen keyboard**: for touch screens that don't show their own keyboard, such as a
  touch-screen PC. **Automatic** shows it on touch screens except iPads, Android tablets and phones (they have their
  own); **Always show** or **Never show** overrides that. It's set on each device. It has number pads for phone
  numbers and codes, `@` and `.com` for email, accented letters for names, and suggests hosts as visitors type.

### Arrivals and departures

- **After check-in**: print a badge (full page, or a label for Brother QL 62 mm, DYMO 30857 or a 4-inch Zebra), email
  or text the pass to the visitor, and **Tell the host their visitor has arrived** (email, text and/or a Slack or
  Teams webhook).
- **Host links**: send each host a personal link (by email, or text if there's no email) to a page where they add
  their own expected visitors and see who has arrived today. Arrival alerts include an **On my way** link: the visitor
  sees "Dana is on the way to meet you" on the kiosk and gets a text. Anyone with a host's link can add visitors for
  that host, so it's personal; **New link** stops the old one working. Hosts need to reach the VM (your network).
- **Leaving without checking out**: after how long without any device on the Wi-Fi a visitor shows as
  **Probably left** (30 minutes to 8 hours), and whether to check them out automatically (which also ends their
  Wi-Fi). Shared-password visitors and visitors who never joined the Wi-Fi are never marked.

### Messages

- **Email and text messages**: your mail server (for example `smtp.office365.com` or `smtp.gmail.com`, port 587,
  STARTTLS, with an app password) and Twilio (account SID, auth token, phone number). Used for passes, host alerts,
  invites, staff alerts, the summary and emergency messages. Use **Send test email** / **Send test text**.
- **Staff alerts**: email or text the people you list when a blocked person tries to check in, a tablet goes offline,
  or check-ins fail (at most one every 30 minutes).
- **Summary email**: check-ins, top hosts and who's on site, daily or weekly, at the hour you choose.

### Wi-Fi and RUCKUS One

- **RUCKUS One connection**: region, tenant ID, client ID and secret (and the customer's tenant ID for MSP accounts).
  **Connect** tests the login before saving. Then pick the venue, the visitor network and, for personal passwords, the
  DPSK service. The secret is never shown again; IDs show only their last 4 characters.
- **Wi-Fi access type**:
  - **Guest pass (captive portal)**: visitors join an open network and type a code. RUCKUS One makes the code.
  - **Personal password (DPSK)**: each visitor gets their own password; the QR code joins in one scan. Passwords
    follow the DPSK service's format in RUCKUS One, and the panel warns when that format is easy to guess (for example
    8 digits).
  - **Shared password**: everyone gets the same password, read from the network in RUCKUS One. Visitors are still
    logged, but their access can't be ended one by one and their devices can't be tracked.
  - Also: how long access lasts (hours, or until the end of the day) and how many devices per visitor.
- **Floor plans** come from RUCKUS One: add a floor plan to the venue and place the access points on it there; Visitor
  Desk picks it up within an hour.

### Security and privacy

- **Users and sign-in**: your own password and two-step sign-in; add, remove and reset other users (Admin or
  Reception). There is always at least one admin.
- **Kiosk tablets**: once one tablet is paired, only paired tablets (and the VM itself) can check visitors in or see
  host names. Pair a tablet by opening the kiosk on it, signing in, typing a name and tapping **Pair this tablet**.
  Remove a lost tablet from the list. Each tablet can check in 20 visitors per 10 minutes (150 per hour overall).
- **Privacy**: how long visit records are kept (up to 5 years, or forever) and, separately, photos and ID images.
  It applies to older visits too. **Find a person** (in Visitor records) searches by exact email, phone or full name
  to download everything about one person as a file, or delete it all.
- **Audit log**: who signed in (and failed), changed settings or users, exported, deleted, blocked, ended access,
  resent, printed, looked up devices and paired tablets.

### System

- **Network**: the VM's address, gateway, DNS servers and time, and changing them:
  - **DHCP** or a **Static address** (IP address, subnet mask, gateway). With DHCP, the form starts from the current
    lease, so switching to static keeps the same address.
  - **DNS servers** (up to 3) and **search domains**. With DHCP, leave DNS empty to use the servers from DHCP.
  - **Time servers (NTP)**, up to 4. Empty: the ones from DHCP, else ntp.ubuntu.com. Two-step sign-in codes need the
    right time.

  Changing the address, gateway or DHCP/static has a safety net. Open the new address within 3 minutes, sign in, go to
  **Network** and tap **Keep these settings**. Otherwise the VM goes back to its previous settings by itself, so a typo
  can't lock you out. Before you keep them, the panel shows whether the gateway answers, names resolve and RUCKUS One
  can be reached. DNS and time server changes apply straight away.

  After an address change, open the new address on each tablet, add it to the home screen again and **pair it again**
  (a browser keeps the pairing and the kiosk settings per address). The shared look comes back by itself; other kiosk
  settings need setting again. The certificate follows the address, so it doesn't need installing again.
- **Updates**: see [Updating](#updating).

---

## Maintenance

### Updating

Updates replace only the app and the VM's helper files. Settings, users, visitor records and certificates are kept.
Updates are signed: the VM refuses any file that isn't signed with the Visitor Desk update key.

**From the admin panel (VMs on 1.8.0 and later):** download the `.kup` file from the
[Releases](https://github.com/TerryHenry/visitor-desk-releases/releases) page, then **Admin → Updates → Choose update file**.
Check the version shown and tap **Install now**. The server restarts (visitors can't check in for about a minute);
sign in again to see the result and the log. If the new version doesn't start, the VM goes back to the old one by
itself. **Go back to …** returns to the version before the last update.

**On the console (VMs older than 1.8.0):** put the `.kup` somewhere the VM can download it (for example
`python3 -m http.server 8000` in the download folder on your computer), then on the VM console:
`kiosk update http://<your computer>:8000/<file>.kup`. It shows the installed and new versions and asks before
installing. VMs older than 1.4.1 should run the update from a copy of the updater:
`sudo cp /usr/local/sbin/kiosk-update /tmp/ku && sudo bash /tmp/ku <url>`.

### Console and maintenance

- Log in on the VM console as **kioskadmin**, password **visitorkiosk**. You must choose a new password at the first
  login. SSH doesn't accept passwords; add your public key to `/home/kioskadmin/.ssh/authorized_keys` to use it.
- Type `kiosk` for the commands:

| Command | What it does |
|---|---|
| `kiosk status`, `kiosk logs`, `kiosk restart` | Check, read the log of, or restart the Visitor Desk service. |
| `kiosk address` | The VM's network addresses. |
| `kiosk network` | Shows the network settings; sets DHCP or a static address (`kiosk network static <ip/prefix> <gateway> <dns,...> [search domain]`, `kiosk network dhcp`) or the DNS servers (`kiosk network dns <servers>`). |
| `kiosk ntp` | Shows the time servers and whether the clock is in sync; `kiosk ntp time.example.com,pool.ntp.org` sets them, `kiosk ntp default` goes back to the default. |
| `kiosk setup-code` | The code to create the first admin from a browser. |
| `kiosk create-admin` | Create the first admin here, no code needed. |
| `kiosk reset-admin` | Removes admin users (keeps front desk users) when every admin is locked out. |
| `kiosk check` | Tests the RUCKUS One login and lists venues, networks and DPSK services. |
| `kiosk version`, `kiosk update`, `kiosk rollback` | Installed version, install an update, go back. |
| `kiosk backup`, `kiosk restore <file>` | Encrypted backup of settings, users, visits and certificates, and putting it back. |
| `kiosk firewall` | Shows the firewall rules (web from anywhere, SSH from private networks only). |

- **Backups:** `kiosk backup` asks for a password and writes an encrypted file. Copy it off the VM, for example
  `scp kioskadmin@<vm>:visitor-desk-backup-*.enc .`. `kiosk restore <file>` works on this or a new VM (the current
  data is saved first).
- Ubuntu installs security updates automatically when the VM has internet access.
- Two-step sign-in codes depend on the correct time. The VM uses the time servers from DHCP, else ntp.ubuntu.com;
  without internet, set your own under **Admin → Network** or with `kiosk ntp`.
- A few RUCKUS One details can be tuned in `/opt/visitor-kiosk/config.json` (then `kiosk restart`):
  `deliveryMethodNames` (guest pass delivery names), `fallbackPhone` (RUCKUS One needs a phone number for guest users;
  use your front desk number if you hide the phone field) and `dpsk.expirationFormat` (`"date"` if DPSK expiry errors).

---

## Troubleshooting

| What you see | What to do |
|---|---|
| "This kiosk isn't set up yet" | The tablet isn't paired. An admin pairs it under **Kiosk tablets**. |
| "Please see reception" | They're on the blocked list (see the **Blocked** tab), or the check-in failed: see **Recent problems**. |
| "Too many tries" | A tablet can check in 20 people per 10 minutes. Wait a few minutes. |
| Wi-Fi doesn't work | Check they joined the network on their pass. Guest pass: they type the code on the sign-in page that opens. Personal password: the QR code joins in one scan. DPSK passwords can take a few seconds to start working. |
| Invite code "isn't valid" | It was already used, or it's not one of the visit's days. Check **Expected visitors**. |
| The camera doesn't open | The tablet needs the kiosk certificate: open `http://<vm-address>/setup` on it once. |
| No address on the VM console | No DHCP on that network: set a static address with `kiosk network`. |
| Two-step sign-in codes are always refused | The VM's clock is off. **Admin → Network** (or `kiosk ntp`) shows whether it's in sync; set time servers it can reach. |
| Tablets say "This kiosk isn't set up yet" after an address change | Pair each tablet again at the new address (**Kiosk tablets**). |
| Check-ins fail after changing RUCKUS One credentials | **RUCKUS One connection**: enter the new client ID and secret and **Connect**. |
