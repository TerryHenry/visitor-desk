# Getting started

From download to the first visitor checked in, in about 30 minutes.

**Before you start, you need:**
- VMware ESXi or vSphere (ESXi 5.5 or later) with 2 vCPU, 2 GB RAM and 16 GB of disk free.
- A network the lobby tablets can reach, with internet access for RUCKUS One.
- A RUCKUS One account with permission to create application tokens, and the visitor Wi-Fi network already set up
  in RUCKUS One: a guest pass (captive portal) network, a DPSK network and DPSK service, or a WPA2/WPA3 network
  with a shared password.
- A tablet for the lobby (iPad or Android) with a camera, if you want visitor photos.
- Optional: a mail server account (SMTP) and/or a Twilio account, to email and text passes and host alerts.

## 1. Download

From the [Releases](https://github.com/TerryHenry/visitor-desk-releases/releases) page, download:

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
[Console and maintenance](user-guide.md#console-and-maintenance)) and run `kiosk network` to set a static address. It asks for the
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
4. On the tablet, open **Admin**, sign in, go to **Kiosk tablets**, type a name (for example "Lobby iPad") and tap
   **Pair this tablet**. Once one tablet is paired, only paired tablets can check visitors in.
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

## 6. Add your staff

Under **Users and sign-in**, add a user for each front desk person with the role **Reception**. They see visitor
records but not settings. Ask everyone to turn on two-step sign-in.

## Next steps

- Read the [User guide](user-guide.md): front desk tasks, every admin setting and maintenance.
- Make a backup: on the VM console run `kiosk backup` and copy the file off the VM.
- Set up the extras you want: expected visitors and invite codes, check-out at the kiosk, host links, staff alerts,
  the summary email, and the emergency message.
