# Visitor Desk (RUCKUS One visitor kiosk): project context

Installation-specific notes (addresses, tenant names) live in CLAUDE.local.md, which is not published.

This project was started in a claude.ai chat and moved here. This file holds the context from that conversation.

## What it is
A lobby check-in kiosk (tablet web page) that collects visitor details and creates Wi-Fi access through the RUCKUS One API.
Runs on the owner's MacBook for now; Windows or Raspberry Pi later, so keep everything cross-platform.

## Files
- `server.js`: Node 18+ server, zero npm dependencies (built-in `http` and `fetch`). Serves the kiosk page and the API.
  - `node server.js` starts it; `node server.js check` tests the RUCKUS One login and lists Wi-Fi network / DPSK IDs.
- `public/index.html`: the kiosk page. Single self-contained file (inline CSS/JS, qrcodejs from cdnjs, Google Fonts).
  The server injects `window.KIOSK_BACKEND="/api/guest-pass"` so the kiosk talks to it with no setup.
- `config.json` (gitignored; holds the API secret). Optional at first start: the admin panel's RUCKUS One connection
  section writes it (mode 600). `config.example.json` shows every setting for hand editing.
- `README.md`: setup for Mac, Windows (Task Scheduler), Raspberry Pi (systemd).
- `data/visits/<id>/`: visit.json, photo.jpg, id.jpg per check-in. Deleted automatically after the retention period.

## Kiosk features (public/index.html)
- Visitor flow: About you → Who you're visiting → Photo and ID → pass screen (badge, Wi-Fi QR, password/code, expiry).
  Steps with no visible fields are skipped. Auto-clears after a timeout.
- REMOVED in 1.3.0 at the user's request (license back / barcode scanning; history kept for reference). Was: License barcode (field `idBarcode`, default optional): PDF417 on the back, decoded on the tablet with zxing-wasm 3.1.4
  (IIFE reader from jsDelivr, loaded on first use, ~1 MB wasm; Safari has no BarcodeDetector). Use `textMode:"Plain"`
  (default HRI mode spells control chars as <LF>). `parseAAMVA` reads DCS/DAC/DAA/DCT (name), DBA (expiry; MMDDCCYY US,
  CCYYMMDD Canada), DAJ, DCG. Only first/last/state/country/expires/expired/nameMatches are sent (`licenseSummary`) and
  the server whitelists the same fields in visit.json. Birth date, address, license number are never kept. Expired or
  name mismatch are flagged (tablet, visitor records), not blocking. Camera scans automatically (`scanLoop`, 1920x1080).
  iPhone: the web camera is the main wide lens (min focus ~15-20 cm), so `preferAutoLensCamera` switches to Safari's
  "Back Triple/Dual Wide Camera" (auto lens switching incl. macro) when listed; the loop shows help after 8 s.
  Barcode mode has a "Take photo" button (`snapBarcode`: ImageCapture.takePhoto full-res still, else a video frame;
  all CROPS). The file-input link says "Use the camera app instead" on phones/tablets (HAS_CAMERA_APP) and
  "Choose a picture file instead" on computers (a desktop browser only shows a file browser). Shipped as 1.1.1; installed on an ESXi VM with `kiosk update` (first real update, 2026-09-30).
  iPhone 17 Pro test 2026-09-30 (Chrome iOS 26.6): reader loaded, "Back Triple Camera" used, portrait video 1080x1920,
  143 frames, found 0 (16 ms/decode); photo (1.7 MB JPEG) found 0. Likely too few pixels per bar: the frame was 64%
  of 1080 px. Now: ideal 3840x2160 for barcodes, frame 92% wide, second pass on a larger crop (not the whole 4K
  picture), diagnostics add crop size/brightness/contrast and photo dimensions.
  Retest (same phone): 4K frames 2160x3840, crop 2160x1454, brightness 145, contrast 66, 25 ms/decode, found 0;
  photo 3024x4032, found 0. So not resolution: no PDF417 start/stop pattern found (glare/hologram suspected).
  Root cause (found on a real license photo, 2026-09-30): on the whole image ZXing's default LocalAverage binarizer
  can't lock on (rest of the card), GlobalHistogram/FixedThreshold find it but ChecksumError. Tightly cropped, the
  default reads it. Fix (`zxRead`): try whole image with LocalAverage/GlobalHistogram/FixedThreshold (returnErrors),
  take the tallest reported position, crop (min height 0.36 x width, since failed reads outline only the top rows,
  pad 3%/8%), read the crop with default/denoise/GlobalHistogram. Real license: photo and simulated live both read.
  iPhone live test after that: scanned but slowly (~20 s): barcode located in ~1 of 5 frames, most ChecksumError.
  Now `CROPS` (12 cut-outs: crop pads, scales 0.75/1/1.25, "straighten" = affine map of the located top/left edges
  to horizontal/vertical, denoise/GlobalHistogram); a live frame tries 4 (rotating), a photo tries all 12; 40 ms
  pause between frames; no wide second pass. Synthetic hand-held test (±5° tilt, slant, blur, noise, 40 frames):
  26 read vs 16 with the previous crops. iPhone retest: found in only 1/123 frames because the wide pass had been
  removed (restored: alternate pad .08 / .35); photos still ChecksumError.
  Decision (2026-09-30): ZXing reads real licenses only sometimes. Keep the barcode Optional, rely on the front photo.
  If reliable scanning is needed later, consider a commercial SDK (STRICH, Scandit, Dynamsoft) in place of ZXing.
  `readLicense` tries the browser's BarcodeDetector (pdf417) first, then ZXing. (Temporary scan diagnostics that
  posted to `/api/diag` were used to find the problems below and have been removed.)
- Photo/license capture uses a live camera view (getUserMedia) with "Choose a file instead" as fallback;
  desktop browsers ignore `capture=` on file inputs. Camera needs localhost or HTTPS.
  The camera view is sized to the video's aspect and shows a guide (`layoutCam`): ID-1 card frame (85.6×54) for the
  license, oval for the face; outside is darkened. `snapCam` saves only the guide area (+4% for ID, head-and-shoulders
  margin for the face). Guide coords are fractions of the view = fractions of the video frame.
- Admin panel: "Admin" button or tap the signal bars 5 times. With a kiosk server: staff sign-in (user name, password,
  optional TOTP) checked by the server; role admin → settings, role reception → visitor records only (+ My account).
  Closing the panel signs out; idle panel closes after 10 min. Demo mode: local password (`kiosk.pin`, 8-20 chars,
  default "kioskadmin"). Kiosk settings (fields, look...) are still saved in the tablet's localStorage.
  On screens ≥1024px the settings page gets a sticky section menu on the left (`buildAdminNav`); tablets/phones unchanged.
  - Access type: `portal` (captive portal guest pass code), `dpsk` (personal password per visitor), `psk` (shared password).
  - SSID, hidden network flag, devices per pass, code style, validity (hours or end of day), portal QR (join SSID or open portal URL).
  - Each field (name locked required, email, phone, company, host, purpose, photo, license scan): Required / Optional / Hidden.
  - Host list (type-ahead or pick-only), visit reasons, consent text and retention days. With a kiosk server the host
    list lives in config.json `hosts` [{name,email,phone}] (admin textarea lines "name, email, mobile"); the kiosk page
    fetches names only from `GET /api/hosts`.
  - After check-in: print badge, email, text, notify host (warns if the matching field is hidden).
  - Look: light/dark/auto, color scheme (PALETTES presets or custom main + accent; light and dark variables are
    derived in `lookVars()`; a palette's `base` sets the neutral greys). Default is `ruckus` (shown as "Orange"): logo orange #F47920,
    charcoal #231F20. Saved settings without `look.v` move from teal to ruckus once.
    "Powered by RUCKUS One" footer (`look.poweredBy`), logo size (`look.logoSize` small|medium|large, medium default),
    "Use this look on every kiosk": theme + look + orgName + headline saved to `shared-look.json` (PUT/DELETE `/api/admin/look`, admin auth;
    public `GET /api/look` and `/api/look/version`). Kiosks check on load and every 2 min (`syncLook`, `S.lookVersion`). logo (header + badge, optional white card), background image with fade level.
    Images are resized and stored as data URLs in localStorage (~5 MB limit per browser).
  - Kiosk: location name, headline, reset timer, pass service URL (demo mode: local admin password).
  - Users and sign-in (server): own password, own 2FA (QR via qrcodejs), users list/add/remove/new password (admins).
- Demo mode when no backend URL: generates passes locally.

## VM appliance (vm/)
- `vm/build-ova.sh` → `vm/dist/visitor-kiosk-<version>.ova` for ESXi/vSphere (x86_64). Docker + python3; ~2 min.
  Base: Canonical `ubuntu-24.04-server-cloudimg-amd64.ova` + `node-v24.21.0-linux-x64.tar.xz` in `vm/cache` (gitignored,
  SHA-256 checked against the official sums). `vm/disk.sh` runs in the `kiosk-vm-builder` image (debian:bookworm +
  qemu-utils, qemu-system-x86, fdisk; privileged for a loop mount): VMDK→raw, grow to 16 GB, copy only the app
  files (never config.json/data/certs) to /opt/visitor-kiosk, Node to /opt/node, systemd units + helpers, cloud-init
  NoCloud seed in /var/lib/cloud/seed/nocloud (datasource_list [NoCloud, None]); raw→streamOptimized VMDK
  (lsilogic, hwversion 7, header version patched to 3 for ESXi). `vm/make-ova.py` reuses Canonical's OVF (drops its
  cloud-init ProductSection/iso transport, 2 GB RAM, 16 GB), writes SHA256 .mf, USTAR tar (ovf, mf, vmdk).
- In the VM: service `visitor-kiosk` (user kiosk, PORT=80 HTTPS_PORT=443 via CAP_NET_BIND_SERVICE, sandboxed),
  `kiosk-console.timer` writes /etc/issue.d (address via \4, setup code until an admin exists), `kiosk` helper
  command, console user kioskadmin / visitorkiosk (expired: must change at first login), SSH password auth off.
- Tested 2026-09-30 with `vm/test-boot.sh` (qemu TCG, pvscsi + vmxnet3): first boot ready in ~2 min emulated;
  health, http→https redirect, HTTPS with the VM's CA, setup code on console + `kiosk setup-code`, forced password
  change, admin creation with the setup code.
  First real ESXi deploy (2026-09-30): fd0 I/O errors (Canonical's OVF has a floppy) and a long stall then no IP
  (no DHCP reached). Fixed: floppy removed from OVF + floppy module blacklisted; systemd-networkd-wait-online limited
  to 30 s (--any); `kiosk network` (dhcp | static <ip/prefix> <gw> <dns,...> [search]) writes
  /etc/netplan/90-visitor-kiosk.yaml, moves 50-cloud-init.yaml aside, disables cloud-init network config, restarts the
  service. kiosk-console is enabled in the image (Before=getty.target) and runs `agetty --reload` when the text changes.
  Tested under qemu: static/dhcp switching, no-DHCP boot (~30 s wait, service still starts), console text on first boot.
  Setup code field allowed only 7 chars (shared TOTP maxlength); now `max:9` ("1234-5678"; server strips non-digits).
  `kiosk create-admin` posts to http://127.0.0.1/api/admin/setup (local, no code).
  Updates: `vm/build-update.sh` → `.kup` = USTAR tar of update.tar.gz (app/ incl. .version.json, system/ helper files
  + units) + update.sig (Ed25519 over update.tar.gz, key vm/keys/update-signing.key, made by make-key.sh; public key
  baked into the image at /etc/visitor-kiosk/update-signing.pub). On the VM `kiosk update <url|file> [-y]` →
  /usr/local/sbin/kiosk-update: verify signature (node crypto), node --check server.js, confirm, back up to
  /opt/visitor-kiosk-previous, install, restart, health check 30 s, auto-rollback; `kiosk rollback`, `kiosk version`.
  Tested under qemu 2026-09-30: tampered refused, syntax-broken refused, crashing update auto-rolled back, good update
  installed with users/config kept, rollback. App version 1.1.0 (first OVA with updates).
  Confirmed working on a real ESXi host with DHCP (2026-09-30).

## Related projects
- DwellLink (Electron) has RUCKUS One API calls confirmed against a live tenant (venues, DPSK pools and passphrases,
  Wi-Fi networks, error shapes). Check there before guessing an endpoint. Local paths: see CLAUDE.local.md if present.

## Backend behavior (server.js)
- Auth: POST `https://{region.}ruckus.cloud/oauth2/token/{tenantId}`, form-encoded client_credentials. Token cached ~60 min.
  API hosts: api.ruckus.cloud / api.eu.ruckus.cloud / api.asia.ruckus.cloud. Optional `x-rks-tenantid` header for MSP delegated accounts.
- `POST /api/guest-pass` receives `{ visitor, network, delivery, retentionDays }` from the kiosk:
  - portal → `POST /wifiNetworks/{wifiNetworkId}/guestUsers` (name, mobilePhoneNumber required, email, maxDevices,
    deliveryMethods, expiration {activationType, duration, unit}). RUCKUS returns the password. Email/SMS go through RUCKUS delivery.
  - dpsk → server generates the passphrase (min 8 chars). Create and PATCH return 202 and are processed in the
    background: validation errors only show in RUCKUS One's activity log, not on the request (confirmed live 2026-09-30).
    Sending username/email/phone on create 500s (DwellLink). numberOfDevices can't be lowered by PATCH (live error
    "cannot be less than the current number of devices"). So: `POST .../passphrases {passphrase, numberOfDevices,
    expirationDate}` (confirmed live 2026-09-30: limit and ISO expiry both applied), poll `GET .../passphrases?page=0&pageSize=50`, check device limit + expiry stuck (else delete and
    fail), then PATCH username/email/phoneNumber. Phone must be E.164 (`e164()`, default country `dpsk.phoneCountryCode` "1").
    Email/SMS: wait until GET `.../passphrases/{id}` shows email/phoneNumber (the PATCH is async), then
    `POST .../passphrases/notifications {ids, shouldSendEmail, shouldSendSms}` (DpskPassphraseNotificationDto, all three
    required). Skipped if the pool has `autoNotificationsEnabled` (GET /dpskServices/{id}, cached 10 min): RUCKUS One
    then sends on its own when the details are added. Full DPSK OpenAPI (Redocly store):
    https://docs.ruckus.cloud/page-data/shared/api-docs-api/dpsk-api-0.0.3.json.json
  - psk → if the chosen network (`guestPass.wifiNetworkId`) is type psk, password + SSID come from RUCKUS One
    (`GET /wifiNetworks/{id}`: `wlan.passphrase` for WPA2, `wlan.saePassphrase` for WPA3; confirmed live 2026-09-30),
    cached 5 min. Fallbacks: last value read, then `psk.password` (write-only in admin), then (demo only) the kiosk's
    local shared password. Nothing created in RUCKUS.
  - Host alert (`notifyHost`): matches visitor.host to `cfg.hosts` by name (case-insensitive) and sends in parallel:
    email via built-in SMTP client `smtpSend` (STARTTLS 587 / TLS 465 / none, AUTH LOGIN; `notifications.email`),
    text via Twilio REST (`notifications.sms`: accountSid, authToken, from), and the optional Slack/Teams webhook.
    `delivered.notifyHost` is true only if something went out. Kiosk sends `location` (orgName) for the message.
  - Returns `{ ssid, password, expiresAt, delivered: { email, sms, notifyHost } }`.
- HTTPS (tablet camera needs a secure context): `ensureCerts()` uses the openssl CLI to make `certs/ca.crt|key`
  (10 yr, name-constrained to localhost/.local/private IPs, pathlen 0) and `certs/server.crt|key` (825 days, Apple max;
  SAN = localhost, <hostname>.local, 127.0.0.1, LAN IPv4s). Server cert is reissued when addresses change (checked at
  start and every 10 min, `setSecureContext`); CA stays, so tablets keep trusting it. Works with OpenSSL 3 and macOS
  LibreSSL (config files, no -addext). HTTPS on `https.port` (3443); http stays on `port`. Remote `GET /` on http
  redirects to https; `/setup` (install steps) and `/ca.crt` work on both. `https.enabled: false` turns it off.
  The kiosk's localStorage is per origin, so a tablet moving from http to https starts with default kiosk settings.
- Staff accounts (`security.users` [{id,name,role,salt,hash,totp}], scrypt N=16384; passwords 8-20 chars): `GET /auth`,
  `POST /setup` (first admin; localhost, or with the setup code printed at start / setup-code.txt), `POST /login`
  ({username,password,code}; needCode), `/logout`, `/password`, `/2fa/start|confirm|disable`, `/users` (admin: GET, POST,
  PATCH {password|role} (new password clears their TOTP), DELETE; keeps ≥1 admin). TOTP RFC 6238, ±1 step, no reuse
  (verified against RFC test vectors). Sessions: in-memory Bearer tokens, 30 min idle / 12 h. Lockout 5 fails/IP → 5 min.
  Reception may only: GET /visits, visit images, POST /visits/{id}/revoke|block, GET /blocks, DELETE /blocks/{id}.
  `node server.js reset-admin` removes admin users only. Old `security.admin`/`adminKey` are migrated/removed at start.
- Revoke: portal → `DELETE /wifiNetworks/{net}/guestUsers/{id}` (guest API), dpsk → `DELETE /dpskServices/{pool}/passphrases
  {ids}`; visit records store wifiNetworkId/dpskPoolId for this. Shared-password visits can't be revoked individually.
- Block list `data/blocked.json` (not removed by retention): match on email, phone (last 10 digits) or normalized full
  name → check-in refused (403 {blocked}), attempt saved as a visit with status "blocked". Unblock stamps the visit.
- Admin → Visitor records (`/api/admin/visits`, same auth as other admin calls): `GET` list (+hasPhoto/hasId),
  `GET /visits/{id}/photo.jpg|id.jpg` (kiosk fetches with the session token, shows blob URLs), `DELETE /visits/{id}`, `DELETE /visits`
  (all). Visit IDs are matched against `VISIT_ID` so no other path is reachable.
- Retention (server, `retention()`): `storage.recordDays` (0 = forever, default 30; old `retentionDays` honoured) and
  `storage.imageDays` (null = same as records, 0 = forever). Applied by age (checkedInAt) to every record, so changes
  affect older visits; images deleted → photo/idImage "deleted". `deleteAfterOf()` computed for display. Public
  `GET /api/kiosk-info {recordDays}` for the agreement text ({days}; forever → "kept until staff delete them").
- Export: `GET /api/admin/visits.csv?from&to&q` (admin only), BOM + quoted cells, formula prefix ('=+-@) neutralised.
- Visitor devices (`trackDevices`, every 2 min, admin-only views): active DPSK/guest-pass visits; DPSK matched by the
  client `username` = passphrase username (stored as visit.ruckusUsername) + `GET .../passphrases/{id}/devices`; guest
  pass by `GET /wifiNetworks/{net}/guestUsers/{id}` macAddresses. Clients from `POST /venues/aps/clients/query`
  (1-indexed pages). Per visit `devices.json` {mac: {hostname, os, model, ip, online, current {ap, apMac, venue, ssid},
  timeline [{ap, apMac, venue, from, to, source?}]}} (same retention as the record). New device → backfill from
  `POST /events/query` {entity_type:["CLIENT"], entity_id:[mac]} (connected / roamed / left), AP names from
  `POST /venues/aps/query`; R1 keeps client events only ~2 days (confirmed 2026-10-01), session history ~1 day.
  MACs: `normMac()` → "aa:bb:cc:dd:ee:ff" from any form; RUCKUS One clients say "F2:44:CD:84:32:EE" but the guest user's
  macAddresses are bare "f244cd8432ee" (seen live on the VM 2026-10-01: guest devices showed offline until 1.3.3).
  `readDevices()` merges older entries saved under other forms.
  `r1Time()` parses ISO-Z, "… +0000" and epoch (no zone = UTC). Open history stay continues if still on that AP.
  APIs: `GET /visits/{id}/devices`, `GET /devices?q=` (no q = on site now), `POST /devices/refresh`.
  `GET /devices/{mac}/live` (1.3.2, `deviceReport`): live client via clients query filters.macAddress (works), last 50
  client events, finished sessions from POST /historicalClients/query (filters ignored by RUCKUS One → read up to
  4×500 and match clientMac; history went back ~4 weeks on 2026-10-01; times "… +0000"). Path is URL-decoded (the
  page sends %3A). UI: "Details from RUCKUS One" per device; Refresh buttons in Devices view and on a visit. Shared-password
  visits can't be tracked. Default agreement text mentions device locations. Shipped as 1.2.0.
- Deployed VMs: SSH is key-only; `kiosk update` needs sudo (the kioskadmin password). ESXi console paste doesn't
  work: serve short files (python3 -m http.server 8000) and use short names (u.kup).
- Print badge / resend (admins, 1.3.0): `GET /api/admin/visits/{id}/pass` = current Wi-Fi details from RUCKUS One
  (`passDetails`: DPSK GET passphrase (returns `passphrase`, confirmed live); guest pass GET guestUser does NOT return the
  password (confirmed live 2026-10-01; list endpoint 405), so the code is saved as visit.passCode at creation (1.3.1),
  removed at pass expiry (cleanup) or when access is ended, stripped from every API list/record response; older guest
  visits → 409 explanation; shared via
  sharedPsk); 409 if ended/blocked. `POST /visits/{id}/resend {channel: email|sms, timeZone}`: kiosk's SMTP/Twilio
  (times in the admin's time zone), else DPSK → RUCKUS notifications; guest pass has no resend in RUCKUS One (only
  regeneratePassword, which changes the password), so it needs Host alerts email/text. Logged in visit.resent[].
  Badge printed via #printArea + body.printing print CSS. Records: Last 24 hours / 7 days / 30 days / All
  (V.range; CSV `since=`). Admin host list shows DEFAULTS.hostExamples (name, email, mobile) until changed.
- Recent problems: everything printed with console.error, plus request errors with where they happened (Check-in,
  RUCKUS One connection, ...), last 100 in data/errors.json (mode 600). `GET/DELETE /api/admin/errors` (admin only).
  Admin panel section "Recent problems" with PROBLEM_HINTS (what to do) and a 24 h count on its menu entry. 1.1.2.
- `/api/admin/*`: needs a signed-in session (see staff accounts). Secrets and IDs are write-only: tenant/client/MSP IDs and Twilio SID come back
  only as their last 4 chars (`…End`), secrets as `has…` flags. Blank fields on save/connect keep the saved value.
  - `GET /config`, `POST /connect` (tests the login first, saves only if it works, returns lists),
    `POST /discover` (venues, networks, DPSK services), `PUT /config` (venueId, wifiNetworkId, dpskPoolId, email, sms, hostWebhookUrl, hosts, pskPassword),
    `GET /hosts` (full contacts), `POST /notify-test {channel: email|sms, to}`.
  - Lookups use the calls DwellLink confirmed: `POST /venues/query` → `data`; `POST /wifiNetworks/query` → `data`,
    venue in `venueApGroups[].venueId` (filtering by venue on the server returns nothing, so the kiosk filters);
    `GET /dpskServices` → `content` (`POST /dpskServices/query` 500s when paging is sent).
  - Network type is read from `nwSubType` (field confirmed present live; values guest/dpsk/psk assumed). Live fields:
    name, id, vlan, nwType, nwSubType, ssid, securityProtocol, venueApGroups, dpskNetworkType, clientCount, apCount.
- `security.allowedIps` limits which devices may call the server. `storage.storeIdImages=false` skips saving license images.

## Confirmed live (2026-10-01, 1.5.0)
- Guest pass create works on a guest network: MAIL/SMS/PRINT enum, E.164 phone; returns the 6-char code.
  Spec: https://docs.ruckus.cloud/page-data/shared/api-docs-api/guest-1.7.1.json.json (GuestUserV1; 201 with response.password).
- DPSK passwords follow the pool format (a NUMBERS_ONLY, 8 pool → 8 digits).
- DPSK delete: `DELETE /dpskServices/{pool}/passphrases` takes a plain JSON array of ids (schema: array of string).
  `{ids:[...]}` gets 400 "Malformed JSON request" (so "End Wi-Fi access" for DPSK was broken before 1.5.0). 202, then GET → 404.
  The DPSK store is in the spec JSON's `store` (schema ids like schema_353), not under `paths`.

## Not yet verified against a live RUCKUS One account
- Whether guestUsers needs the expiration/maxDevices query parameters (currently sent in both query and body).
- DPSK email/SMS delivery (`sendDpskNotice`): implemented from the docs schema, not yet confirmed live.
API reference: https://docs.ruckus.cloud/api/

## Conventions
- Keep zero npm dependencies unless there's a strong reason.
- Kiosk stays one self-contained HTML file; kiosk UI text is plain, friendly, short.
- Never expose the RUCKUS API secret to the browser.

## Security (1.4.0)
- Tablet pairing: `security.kiosks` [{id, name, hash (sha256 of token)}]; header `x-kiosk-token`. Once one is paired,
  `/api/guest-pass` and `/api/hosts` need a paired tablet, localhost or a staff session. Rate limit 20/10 min per tablet, 150/hour total.
- `/api/*` from other devices only over HTTPS. Nonce CSP on the kiosk page (no inline handlers; QR library has SRI).
- Audit log `data/audit.log` (JSONL), `GET /api/admin/audit`. Stats: `GET /api/admin/stats` (admin panel "At a glance"; reception sees it collapsible on top of Visitor records, 1.4.2).
- DPSK passwords follow the pool's passphraseFormat/length/wordCount/numericSuffix (like DwellLink); kiosk codeStyle is only the fallback.
- VM: `kiosk-harden` (ufw, once), `kiosk backup/restore` (openssl aes-256-cbc pbkdf2), `build-update.sh --with-node`.

- 1.3.3 → 1.4.0 update on a deployed VM (2026-10-01): files installed, then "syntax error" from kiosk-update and kiosk,
  because cp overwrote the running scripts in place (bash reads scripts as it runs). Restart was skipped; done by hand.
  1.4.1: `install_tree` copies to `<file>.kiosk-new` and renames. The first update run by a pre-1.4.1 updater can still
  hit this; run it from a copy: `sudo cp /usr/local/sbin/kiosk-update /tmp/ku && sudo bash /tmp/ku <url>`.

## Visitor features (1.5.0)
- Kiosk first-screen buttons (`S.options` checkout/invites/returning, kiosk server only) open a sheet (`openSheet`). Kiosk
  lookups `POST /api/checkout/find|checkout|invite|returning` (paired tablet, own rate limit) return a 15-min token
  (`LOOKUPS`), first name, company, host, purpose and hasEmail/hasPhone/hasPhoto only: never email, phone or photo.
  The check-in sends `inviteToken` / `returningToken` (+ `reusePhoto`); the server fills email/phone ("On file") and copies
  photo.jpg. `inviteId`/`returningFrom`/`photoFrom` from the kiosk body are deleted before use.
- Check-out: 6-digit `checkoutCode` per visit (on the pass and badge), or email/phone. `checkOut()` sets checkedOutAt and
  ends Wi-Fi unless `cfg.checkout.endAccess === false`. Staff: `POST /visits/{id}/checkout`. `onSite()` = not checked out,
  not ended, pass valid (psk: within a day). Records "On site now" filter + printable roll-call list.
- Invites `data/invites.json` (admins + reception, Visitor records → Expected visitors): code emailed by `emailInvite`,
  single use, from/until dates; until > from = multi-day pass (end of last day, ≤31 days; server caps expiresAt).
- Staff alerts `cfg.alerts` (emails/phones; blocked, tabletOffline after offlineMinutes, problems = "Check-in"/"Device
  tracking" recordProblem, 30-min throttle). Tablets ping via `/api/look/version` with x-kiosk-token (`PINGS`, `OFFLINE`).
- Summary email `cfg.summary` {frequency off|daily|weekly, hour, weekday, to, timeZone, lastSent}; `zoned()`/`zonedMidnight()`;
  checked every minute; `POST /summary/send`.
- Signature field (`fields.signature`, default hidden): canvas on the last step → signature.png, kept with the record.
- Visitor languages en/es/fr (`I18N`, `T()`, `S.options.languages`); staff screens English; admin-edited text as typed,
  custom headline replaced by the translated default in other languages. visit.lang; reprints use it.
- Privacy (admins): `GET /person?q=` (exact email / phone / full name), `POST /person/export` (JSON with images inline),
  `POST /person/delete`. Audit-logged.
- Badges: `S.delivery.badgeSize` page | ql62 (100×62 mm) | dymo (102×57) | zebra (102×76); `printBadgeData` + `printNow` (@page).
- Admin "Host alerts" section is now "Email and text messages" (always shown; used by alerts, summary, invites).


## Staff screen polish (1.5.1)
- Visitor records: header with Close, tabs (Visits / Expected visitors / Devices / Blocked / Find a person; `syncTabs`,
  `enterView`, `leaveViews`, `devicesOff`), table on ≥860px (sortable `SORTS`, `V.sort`, 25 per page `V.page`), status
  chips (`visitChips`), card list below 860px. "Delete all" sits at the bottom.
- Settings: sections reordered into groups (`ADMIN_GROUPS`, 1.7.3: Overview; Kiosk screen; Arrivals and departures;
  Messages; Wi-Fi and RUCKUS One; Security and privacy) with headings in the page and the side menu. The old "Kiosk"
  section is "Location and screen". test/page.test.js checks every section is in a group. Visitor records is first under Overview; its menu entry
  (`data-open="visits"`) opens the records directly. Host examples use the "Jordan Lee, jordan@acme.com, 813-555-0142" form.
- `<details>` content doesn't inherit box-sizing (internal slot), so `details *` sets it. `color-scheme` follows the theme
  (dark date pickers). Phone fix: `.logo.logo-large` ignored the 45vw cap.

## Reports and import (1.5.3)
- `GET /api/admin/visits.pdf` (same filters as visits.csv, plus `onsite=1` and `tz`): `pdfTable()` is a small PDF writer
  (Letter landscape, built-in Helvetica/Helvetica-Bold, WinAnsi text, FlateDecode streams, measured column fitting with
  an ellipsis, page numbers). Shared filter `reportRows()`. Both exports are open to reception too.
- `POST /api/admin/invites/import {rows, sendEmail}` (admins + reception, ≤500 rows): the page parses the CSV (`parseCSV`
  handles quotes, BOM and ; separators; `IMPORT_COLS` maps header names; `csvDate` reads ISO or US M/D/Y) and shows a
  preview; the server checks each row with `cleanInvite` and returns per-row results.

## On site with devices (1.5.4)
- `GET /visits` adds `devices` per visit from the last month (`deviceBrief`: name, online, ap, venue, lastSeen; no MACs).
- `onlineNow(d)`: online only if tracking saw it in the last 10 minutes (expired passes stop being tracked, so their
  last `online:true` went stale before; used by deviceBrief, searchDevices, stats and the summary).
- Records "On site now": `V.onsiteMode` checkedin | connected, Refresh devices (`POST /devices/refresh`, reception allowed),
  `GET /devices/status` for "checked N min ago". Exports take `connected=1`; the PDF swaps Reason for "Connected at".

## Clearer device timelines (1.5.5, display only; stored data unchanged)
- `mergeStays()`: back-to-back stays on the same AP less than `MERGE_GAP` (30 min) apart show as one row with
  "reconnected N times"; between rows: "Not connected for …" (gap ≥ 30 min) or "Moved to another access point".
  "Show every connection" shows the raw stays. Same merge for RUCKUS One sessions (data summed), and `eventRuns()`
  collapses connect/disconnect runs at one AP in Recent events.

## Floor plans (1.6.0)
- Confirmed live 2026-10-02: `POST /venues/aps/query` rows include `venueId`, `floorplanId` and
  `floorPosition {floorplanId, xPercent, yPercent}` (no per-AP floorPositions calls needed); `GET /venues/{v}/floorplans`
  → [{id, venueId, name, floorNumber, imageId, imageName}]; `GET /venues/{v}/signurls/{imageId}/urls` → {signedUrl}
  on storage.googleapis.com, served as `application/image` (PNG).
- `apNames()` keeps venueId/plan/x/y; `venuePlans()` (1 h cache); `floorImage()` (disk cache data/floorplans/<imageId>.img,
  host and magic-byte checked, no SVG); `floorMap()` = floors with APs and connected visitor devices (`onlineNow`).
  Routes `GET /api/admin/floormap`, `GET /api/admin/floormap/{venueId}/{imageId}` (reception allowed).
- Page: `#floor` overlay (`openFloor(mac?)`, `drawFloor`), "Floor plan" button in On site now, "Show on floor plan" per device.


## Name: Visitor Desk (1.6.1)
- Shown everywhere people see it: page titles, staff sign-in, settings menu, emails ("Sent by Visitor Desk"), TOTP
  issuer, VM console and `kiosk version`, OVA product name, docs. Build outputs: `visitor-desk-<version>.ova`,
  `visitor-desk-update-*.kup`, `visitor-desk-backup-*.enc`.
- Internal names kept on purpose (deployed VMs and updates depend on them): /opt/visitor-kiosk, visitor-kiosk.service,
  the `kiosk` command, localStorage keys, package internals.
- The local CA is now "Visitor Desk CA (<host>) <date>"; an old "Visitor Kiosk CA" is replaced once at start (no tablet
  trusted it, per the user, 2026-10-02). /setup shows the real CA name (`caName()`).

## Expected visitors list (1.6.2)
- Own row layout (`.irow`: details, invite code, actions) instead of the visits `.vrow` grid that squeezed it.
- "Email pass now" / "Text pass now" send the invite code (`POST /invites/{id}/email|text`, `textInvite()` via Twilio,
  `textedAt`). Add form and CSV import can text codes too (`sendText`). "Last, First" names: import turns them into
  "First Last"; `firstName()` (server and page) reads the part after the comma.

## Automated QA (2026-10-02)
- `npm test` = `node --test test/*.test.js` (no dependencies; ~56 tests, ~3 s). server.js only starts when run directly
  (`require.main === module`); required, it exports helpers for unit tests.
- test/helpers.js: `startServer()` copies the app to a temp dir with a test config, starts `node -r test/mock-r1.js
  server.js` (fake RUCKUS One/Twilio/floor plan storage; calls logged to MOCK_LOG, state in MOCK_STATE), an in-process
  fake SMTP server; `loadServer()` for unit tests. LAN tests use this computer's network address (skipped without one).
- Files: server-units (passwords, E.164, MACs, times, TOTP RFC vectors, PDF structure, time zones), page (script compiles,
  CSP-safe markup, translations complete incl. placeholders, CSV/timeline helpers), api-visitors, api-staff, api-security.
- VM: `vm/smoke-test.sh [host]` (12 checks; default the qemu VM from vm/test-boot.sh on 18080/18443). Passed on the 1.7.4 OVA (sha256 55478f5e…, 2026-10-05), the 1.6.3 OVA and the
  1.6.2 OVA (sha256 8aa1fba8…), 2026-10-02.
- Add a test with each new feature or fix; the mock should follow live-confirmed RUCKUS One shapes (see above).


## Help (1.6.3)
- `HELP` topics in the page (`who: "all"` for front desk and admins, `"admin"` for setup/maintenance), `#help` overlay
  with search, opened by Help on Visitor records (in context: on-site / expected visitors) and on the settings page.
  Keep the topics in step with features; test/page.test.js checks ids, text and that `openHelp("…")` targets exist.

## Emergency, leaving, hosts, analytics (1.7.0)
- Emergency: data/emergencies.json; `startEmergency()` texts/emails on-site visitors (5 at a time), copies staff alerts
  (kind "emergency", always on), a follow-up message ends the open roll call and carries safe marks over.
  `GET/POST /api/admin/emergency`, `POST /emergency/{id}/safe|end` (reception allowed). Page: `#emerg` overlay, red
  `#eBanner` in Visitor records (polled every 20 s).
- Leaving: `cfg.autoLeave {enabled, hours, checkout}`; `probablyLeft(r)` = on site and the newest device lastSeen older
  than `hours`; `autoCheckOut()` in the minute timer (`KIOSK_TICK_MS` shortens it in tests). Visits list adds
  `probablyLeft`, `lastDeviceSeen`.
- Hosts: `cfg.hostLinks {lowerName: token}`; `/host/<token>` page + `/api/host/<token>/…` (own invites only, "On my way"
  for today's arrivals). Arrival alerts carry `/onmyway/<visit.hostToken>` (GET shows a button; POST records, because
  link previews open links); `visit.statusToken` lets the kiosk pass screen poll `/api/pass-status/<token>`. Tokens are
  stripped from every record sent to browsers. `publicBase(req)` builds links from the request's host.
- Analytics: `GET /api/admin/analytics?from&to&tz` (reception allowed); Wi-Fi bytes from `/historicalClients/query`
  (bulk, cached 10 min). Page: Analytics tab (`drawAnalytics`).
- Tests: test/api-onsite.test.js; page test forbids doubled `\\uXXXX` escapes (a heredoc'd block once showed "\u00b7").


## Device details layout (1.7.1)
- "Details from RUCKUS One" → "Right now" is one horizontal row per group (Where, Network, Radio and signal, This
  connection, Device, Signed in as: label left, details side by side; `.liverow`, 1.7.2 after the user found a card
  grid hard to read); the health note only lists what isn't "Good". Label stacks above on phones.
- Device names: `devName()` (page) / `devLabel()` (server): hostname unless it's just a MAC (seen live: iPhones report
  their MAC as hostname), else the model without the OS version ("Apple iPhone"), else type. MAC stays in the sub-line.
- The global `dd{word-break:break-all}` (for pass codes) split words in details ("Throughpu t"); `.vdetail dd` and
  the cards use `overflow-wrap:anywhere` instead.

## Location name under the logo (1.7.4)
- `look.showName` (default off; kept by `cleanLook` for the shared look): the kiosk header shows the logo with the
  location name centered under it (`.org-stack`). Without it, the logo takes the name's place (as before).
- The location name is used in host alerts, invite and emergency messages and reports, so it should be set to the
  real name (not the sample).

## Updates from the admin panel (1.8.0)
- Admin → System → Updates (admins only): upload a .kup → `readKup()` checks the Ed25519 signature with
  /etc/visitor-kiosk/update-signing.pub and reads app/.version.json from inside (`tarEntries()`), then stages it in
  data/updates/staged.kup. Install renames it to data/updates/incoming.kup; rollback writes data/updates/rollback.request.
- VM: `kiosk-web-update.path` (PathExists on both files) runs `kiosk-web-update.service` → /usr/local/sbin/kiosk-web-update
  (root), which runs `kiosk-update <file> -y` or `--rollback` (signature checked again there) and writes
  data/updates/status.json + last.log. The kiosk server never installs anything; `settled()` reports "done" once the new
  version runs. Off on the Mac (no pub key / path unit). Tests: `KIOSK_UPDATE_PUB`/`KIOSK_UPDATE_DIR`.
- The watcher is switched on by visitor-kiosk.service ExecStartPre (so an update from 1.7.x brings it; the image doesn't
  pre-enable it). That step also chowns data/ to kiosk: the first build created data/ as root on a new VM, so the server
  couldn't write and crash-looped (caught by the boot test, 2026-10-05).
- Tested on the emulated VM: upload → install 1.8.0→1.8.1 (~18 s restart) → status done → rollback → 1.8.0; a tampered
  file is refused. `UPDATE_VERSION=x SKIP_TESTS=1 vm/build-update.sh` makes a test update (delete it afterwards: it's
  signed with the real key).


## Releases (GitHub, from 1.8.1)
- Private repo on GitHub (owner in CLAUDE.local.md). Tag `v<version>`; assets: `visitor-desk-<version>.ova`, the signed
  `visitor-desk-update-<version>-*.kup`, and `SHA256SUMS`. Built from a clean commit (`git status` empty) with
  `vm/build-ova.sh` and `vm/build-update.sh` (needs the gitignored vm/keys/update-signing.key and vm/cache).
- Before publishing: boot the previous release's OVA under qemu, install the new .kup through the admin panel API
  (upload → install → status done → new version), then boot the new OVA and run `vm/smoke-test.sh`.
- Never commit vm/keys/, config.json, data/, certs/, shared-look.json, CLAUDE.local.md.
