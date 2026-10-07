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

## Key features

- **Wi-Fi at check-in.** Each visitor gets a RUCKUS One guest pass, their own DPSK password or the shared password,
  shown as a QR code that joins in one scan, with the device limit and expiry you choose.
- **Fast check-in on a tablet.** Name, contact details, who they're visiting, a photo and an ID photo through the
  tablet camera, the agreement and an optional signature. English, Spanish and French.
- **Expected visitors.** Invite codes by email or text, multi-day passes for contractors, CSV import, and returning
  visitors who fill in their details from an earlier visit.
- **Hosts in the loop.** Arrival alerts by email, text, Slack or Teams, a personal page for each host to add their
  own visitors, and an **On my way** button the visitor sees on the kiosk.
- **Who's on site, and where.** Check-out at the kiosk with a 6-digit code, an on-site list with each visitor's
  devices and access point, RUCKUS One floor plans, and **Probably left** when their devices leave the Wi-Fi.
- **Emergencies.** Text and email everyone on site, then a shared roll call where staff mark people safe.
- **Badges and reports.** Badges on paper or label printers (Brother QL, DYMO, Zebra), CSV and PDF reports,
  analytics, a daily or weekly summary email and staff alerts.
- **Security and privacy.** Staff accounts with roles and two-step sign-in, paired tablets, HTTPS with its own
  certificate, a block list, an audit log, retention limits and privacy requests (export or delete one person).
- **Easy to run.** A ready-made VM for ESXi and vSphere, set up from the browser, with signed updates installed from
  the admin panel, automatic rollback, encrypted backups and a firewall.

## Documentation

- **[Getting started](docs/getting-started.md):** download, deploy the VM, connect RUCKUS One, set up the tablets and
  check in your first visitor.
- **[User guide](docs/user-guide.md):** what visitors see, front desk tasks, every admin setting, updates, the VM
  console, backups and troubleshooting.
- The same help is built in: tap **Help** in Visitor records or on the settings page.

## Download

Get the latest `visitor-desk-<version>.ova` (new install) or the signed `.kup` update (existing VM) from
[Releases](https://github.com/TerryHenry/visitor-desk-releases/releases).

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
