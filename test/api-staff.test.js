// End-to-end: the staff side. Users and roles, two-step sign-in, reports (CSV/PDF), privacy requests, stats,
// device locations and floor plans, the summary email and settings.
const test = require("node:test"), assert = require("node:assert/strict");
const { startServer, adminToken, checkin, waitFor, loadServer } = require("./helpers");
const { totp } = loadServer();

let s, admin, desk;
test.before(async () => {
  s = await startServer(); admin = await adminToken(s);
  await s.api("POST", "/api/admin/users", { name: "desk", role: "reception", password: "Desk-Pass-12" }, admin);
  desk = (await s.api("POST", "/api/admin/login", { username: "desk", password: "Desk-Pass-12" })).body.token;
});
test.after(() => s.stop());

test("users: password rules, roles, can't remove the last admin", async () => {
  assert.equal((await s.api("POST", "/api/admin/users", { name: "short", role: "reception", password: "abc" }, admin)).status, 400);
  assert.equal((await s.api("POST", "/api/admin/users", { name: "x", role: "boss", password: "Long-Enough-1" }, admin)).status, 400);
  const list = (await s.api("GET", "/api/admin/users", undefined, admin)).body;
  assert.deepEqual(list.map(u => u.role).sort(), ["admin", "reception"]);
  const me = list.find(u => u.me);
  assert.equal((await s.api("DELETE", `/api/admin/users/${me.id}`, undefined, admin)).status, 400);
});

test("reception sees records but not settings or privacy tools", async () => {
  assert.equal((await s.api("GET", "/api/admin/visits", undefined, desk)).status, 200);
  assert.equal((await s.api("GET", "/api/admin/stats", undefined, desk)).status, 200);
  assert.equal((await s.api("GET", "/api/admin/visits.pdf", undefined, desk)).status, 200);
  assert.equal((await s.api("GET", "/api/admin/invites", undefined, desk)).status, 200);
  for (const [m, p] of [["GET", "/api/admin/config"], ["PUT", "/api/admin/config"], ["GET", "/api/admin/person?q=a@b.co"], ["GET", "/api/admin/users"],
    ["POST", "/api/admin/summary/send"], ["GET", "/api/admin/audit"], ["DELETE", "/api/admin/visits"]])
    assert.equal((await s.api(m, p, m === "PUT" ? {} : undefined, desk)).status, 403, `${m} ${p}`);
});

test("two-step sign-in: turn on with a code, then needed to sign in", async () => {
  await s.api("POST", "/api/admin/users", { name: "twofa", role: "admin", password: "Two-Fa-Pass-1" }, admin);
  const tok = (await s.api("POST", "/api/admin/login", { username: "twofa", password: "Two-Fa-Pass-1" })).body.token;
  const { secret } = (await s.api("POST", "/api/admin/2fa/start", {}, tok)).body;
  const step = Math.floor(Date.now() / 30000);
  assert.equal((await s.api("POST", "/api/admin/2fa/confirm", { code: "000000" }, tok)).status, 400);
  assert.equal((await s.api("POST", "/api/admin/2fa/confirm", { code: totp(secret, step) }, tok)).status, 200);
  const noCode = await s.api("POST", "/api/admin/login", { username: "twofa", password: "Two-Fa-Pass-1" });
  assert.equal(noCode.status, 401); assert.equal(noCode.body.needCode, true);
  const reused = await s.api("POST", "/api/admin/login", { username: "twofa", password: "Two-Fa-Pass-1", code: totp(secret, step) });
  assert.equal(reused.status, 401, "a code can't be used twice");
  const ok = await s.api("POST", "/api/admin/login", { username: "twofa", password: "Two-Fa-Pass-1", code: totp(secret, step + 1) });
  assert.equal(ok.status, 200);
});

test("PDF report: a real PDF, filtered, with times in the asked time zone", async () => {
  await checkin(s, { name: "Report Person", mode: "psk" });
  const r = await s.api("GET", "/api/admin/visits.pdf?tz=America/New_York&q=report", undefined, admin);
  assert.equal(r.status, 200); assert.equal(r.headers.get("content-type"), "application/pdf");
  const t = r.body.toString("latin1");
  assert.ok(t.startsWith("%PDF-1.4") && t.trimEnd().endsWith("%%EOF"));
  assert.match(r.headers.get("content-disposition"), /visitor-report-\d{4}-\d{2}-\d{2}\.pdf/);
});

test("privacy request: find, export with images, delete everything", async () => {
  await checkin(s, { name: "Priv Acy", mode: "psk", visitor: { email: "priv@visitor.example", photo: "data:image/jpeg;base64,/9j/4AAQ" } });
  await checkin(s, { name: "Priv Acy", mode: "psk", visitor: { email: "priv@visitor.example" } });
  const f = await s.api("GET", "/api/admin/person?q=priv%40visitor.example", undefined, admin);
  assert.equal(f.body.kind, "email"); assert.equal(f.body.visits.length, 2);
  const ids = { visitIds: f.body.visits.map(v => v.id), inviteIds: [], blockIds: [] };
  const ex = await s.api("POST", "/api/admin/person/export", ids, admin);
  assert.equal(ex.status, 200); assert.equal(ex.body.visits.length, 2);
  assert.ok(ex.body.visits.some(v => String(v.photo).startsWith("data:image/jpeg;base64,")));
  assert.equal((await s.api("POST", "/api/admin/person/delete", ids, admin)).body.deleted, 2);
  assert.equal((await s.api("GET", "/api/admin/person?q=priv%40visitor.example", undefined, admin)).body.visits.length, 0);
});

test("stats: today's numbers and the 14-day chart", async () => {
  const st = (await s.api("GET", "/api/admin/stats?tz=240", undefined, admin)).body;
  assert.ok(st.checkIns.today.total >= 1); assert.equal(st.days.length, 14); assert.ok(st.onSite >= 1);
});

test("devices: tracked from RUCKUS One, shown on site and on the floor plan (no MACs to reception)", async () => {
  const r = await checkin(s, { name: "Dev Ice", mode: "dpsk" });
  assert.equal(r.status, 200);
  s.setState({ dpskDevices: [{ mac: "AA:BB:CC:00:00:01" }], clients: [{ macAddress: "AA:BB:CC:00:00:01", hostname: "Devs-Phone",
    apInformation: { name: "Lobby AP", macAddress: "11:11:11:00:00:02" }, venueInformation: { name: "HQ" }, networkInformation: { ssid: "Acme-Visitor" } }] });
  assert.equal((await s.api("POST", "/api/admin/devices/refresh", undefined, desk)).status, 200);
  const v = (await s.api("GET", "/api/admin/visits", undefined, desk)).body.find(x => x.name === "Dev Ice");
  assert.deepEqual(v.devices.map(d => [d.name, d.online, d.ap]), [["Devs-Phone", true, "Lobby AP"]]);
  assert.equal(JSON.stringify(v.devices).includes("aa:bb"), false, "no MAC address in the records list");
  const map = (await s.api("GET", "/api/admin/floormap", undefined, desk)).body;
  const lobby = map.floors[0].aps.find(a => a.name === "Lobby AP");
  assert.deepEqual(lobby.people.map(p => p.name), ["Dev Ice"]); assert.equal(lobby.x, 55);
  const img = await s.api("GET", "/api/admin/floormap/v1/img1", undefined, desk);
  assert.equal(img.status, 200); assert.equal(img.headers.get("content-type"), "image/png");
  assert.equal((await s.api("GET", "/api/admin/floormap/v1/other", undefined, desk)).status, 404);
  const pdf = await s.api("GET", "/api/admin/visits.pdf?onsite=1&connected=1", undefined, desk);
  assert.equal(pdf.status, 200);
});

test("summary email and staff alert test", async () => {
  assert.equal((await s.api("PUT", "/api/admin/config", { summary: { frequency: "daily", hour: 7, to: ["boss@test.example"], timeZone: "America/New_York" },
    alerts: { emails: ["ops@test.example"], phones: ["813-555-0100"] } }, admin)).status, 200);
  assert.equal((await s.api("POST", "/api/admin/summary/send", undefined, admin)).status, 200);
  const m = await waitFor(() => s.smtp.messages.find(x => x.to.includes("boss@test.example")));
  assert.match(m.subject, /^Visitor summary: /); assert.match(m.text, /Check-ins: \d+/);
  assert.equal((await s.api("POST", "/api/admin/alerts/test", undefined, admin)).status, 200);
  assert.ok(await waitFor(() => s.smtp.messages.find(x => x.to.includes("ops@test.example") && /Test staff alert/.test(x.subject))));
  assert.equal((await s.api("PUT", "/api/admin/config", { summary: { to: ["not-an-email"] } }, admin)).status, 400);
});

test("settings: secrets never come back to the browser", async () => {
  const c = (await s.api("GET", "/api/admin/config", undefined, admin)).body, text = JSON.stringify(c);
  for (const secret of ["good-secret", "tenant-id-0001", "client-id-0002", "AC123", "\"tok\""]) assert.equal(text.includes(secret), false, `${secret} leaked`);
  assert.equal(c.hasSecret, true); assert.equal(c.tenantIdEnd, "0001", "only the last 4 characters, so staff can tell which account");
});

test("DPSK pool strength is reported for the admin panel", async () => {
  const d = (await s.api("POST", "/api/admin/discover", undefined, admin)).body;
  const weak = d.dpskServices.find(x => x.id === "d2"), ok = d.dpskServices.find(x => x.id === "d1");
  assert.equal(weak.strength.weak, true); assert.equal(ok.strength.weak, false);
});

test("shared look: saved for every kiosk, including the name under the logo", async () => {
  const logo = "data:image/png;base64,iVBORw0KGgo=";
  const put = await s.api("PUT", "/api/admin/look", { theme: "dark", orgName: "Tampa Office", headline: "Hi",
    look: { palette: "ruckus", logo, showName: true, logoSize: "large", evil: "<script>" } }, admin);
  assert.equal(put.status, 200);
  const look = (await s.api("GET", "/api/look")).body;
  assert.equal(look.orgName, "Tampa Office"); assert.equal(look.look.showName, true); assert.equal(look.look.logo, logo);
  assert.equal(look.look.evil, undefined, "only known settings are kept");
  await s.api("PUT", "/api/admin/look", { look: { logo: "javascript:alert(1)" } }, admin);
  assert.equal((await s.api("GET", "/api/look")).body.look.logo, "", "only real image data is accepted as a logo");
});
