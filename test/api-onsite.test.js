// End-to-end: emergency message and roll call, "probably left" and automatic check-out, hosts' own links and
// "On my way", and analytics.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs");
const { startServer, adminToken, checkin, waitFor } = require("./helpers");

let s, admin, desk;
test.before(async () => {
  s = await startServer({ env: { KIOSK_TICK_MS: "300" } }); admin = await adminToken(s);
  await s.api("POST", "/api/admin/users", { name: "desk", role: "reception", password: "Desk-Pass-12" }, admin);
  desk = (await s.api("POST", "/api/admin/login", { username: "desk", password: "Desk-Pass-12" })).body.token;
});
test.after(() => s.stop());

const visits = async () => (await s.api("GET", "/api/admin/visits", undefined, admin)).body;
const twilioTo = () => s.calls().filter(c => c.host === "api.twilio.com").map(c => Object.fromEntries(new URLSearchParams(c.body)));
// Devices for a visit, as device tracking writes them.
function devicesFor(id, minutesAgo) {
  const seen = new Date(Date.now() - minutesAgo * 60e3).toISOString();
  fs.writeFileSync(s.file("data", "visits", id, "devices.json"), JSON.stringify({ "aa:bb:cc:00:00:09": { mac: "aa:bb:cc:00:00:09", hostname: "Phone",
    online: false, lastSeen: seen, firstSeen: seen, backfilled: true, timeline: [{ ap: "Lobby AP", apMac: "11:11:11:00:00:02", from: seen, to: seen }] } }));
}

test("emergency message: texted and emailed to everyone on site, then a roll call", async () => {
  await checkin(s, { name: "Emma Exit", mode: "psk", visitor: { phone: "813-555-0161", email: "emma@visitor.example" } });
  await checkin(s, { name: "Ned Noemail", mode: "psk", visitor: { phone: "813-555-0162", email: "" } });
  const pre = (await s.api("GET", "/api/admin/emergency", undefined, desk)).body;
  assert.equal(pre.current, null); assert.ok(pre.preview.checkedin.people >= 2); assert.equal(pre.canSms, true);
  assert.equal((await s.api("POST", "/api/admin/emergency", { message: "Hi", sms: true }, desk)).status, 400, "a real message is needed");
  const ev = (await s.api("POST", "/api/admin/emergency", { message: "Please leave by the nearest exit.", mode: "checkedin", sms: true, email: true }, desk)).body;
  const emma = ev.recipients.find(x => x.name === "Emma Exit"), ned = ev.recipients.find(x => x.name === "Ned Noemail");
  assert.equal(emma.sms, true); assert.equal(emma.emailed, true); assert.equal(ned.sms, true); assert.equal(ned.emailed, false);
  assert.ok(twilioTo().some(t => t.To === "+18135550161" && /nearest exit/.test(t.Body)));
  assert.ok(await waitFor(() => s.smtp.messages.find(m => m.to.includes("emma@visitor.example") && /nearest exit/.test(m.text))));
  // Mark safe, then a follow-up ("All clear") keeps the marks; then end.
  const marked = (await s.api("POST", `/api/admin/emergency/${ev.id}/safe`, { visitId: emma.visitId, safe: true }, desk)).body;
  assert.ok(marked.safe[emma.visitId]); assert.equal(marked.safe[emma.visitId].by, "desk");
  const clear = (await s.api("POST", "/api/admin/emergency", { message: "All clear. It's safe to go back inside.", sms: true }, admin)).body;
  assert.ok(clear.safe[emma.visitId], "safe marks carried over");
  const now = (await s.api("GET", "/api/admin/emergency", undefined, admin)).body;
  assert.equal(now.current.id, clear.id); assert.ok(JSON.parse(fs.readFileSync(s.file("data", "emergencies.json"))).find(x => x.id === ev.id).endedAt);
  await s.api("POST", `/api/admin/emergency/${clear.id}/end`, undefined, desk);
  assert.equal((await s.api("GET", "/api/admin/emergency", undefined, desk)).body.current, null);
  const audit = (await s.api("GET", "/api/admin/audit?q=emergency", undefined, admin)).body;
  assert.ok(audit.some(a => a.action === "Sent an emergency message"));
});

test("probably left: devices gone for longer than the setting", async () => {
  await checkin(s, { name: "Gone Gary", mode: "dpsk", visitor: { checkedInAt: new Date(Date.now() - 4 * 3600e3).toISOString() } });
  await checkin(s, { name: "Here Hana", mode: "dpsk", visitor: { checkedInAt: new Date(Date.now() - 4 * 3600e3).toISOString() } });
  const v = await visits(), gary = v.find(x => x.name === "Gone Gary"), hana = v.find(x => x.name === "Here Hana");
  devicesFor(gary.id, 180); devicesFor(hana.id, 5);
  const after = await visits();
  assert.equal(after.find(x => x.name === "Gone Gary").probablyLeft, true);
  assert.equal(after.find(x => x.name === "Here Hana").probablyLeft, undefined);
  assert.equal((await s.api("GET", "/api/admin/stats", undefined, admin)).body.probablyLeft >= 1, true);
});

test("automatic check-out when it's turned on", async () => {
  assert.equal((await s.api("PUT", "/api/admin/config", { autoLeave: { enabled: true, hours: 2, checkout: true } }, admin)).status, 200);
  const gary = await waitFor(async () => (await visits()).find(x => x.name === "Gone Gary" && x.checkedOutAt), 5000);
  assert.ok(gary, "checked out by the timer"); assert.match(gary.checkedOutBy, /automatically/);
  assert.ok(s.calls().some(c => c.method === "DELETE" && /passphrases$/.test(c.path)), "and their Wi-Fi ended");
  assert.equal((await visits()).find(x => x.name === "Here Hana").checkedOutAt, undefined);
  await s.api("PUT", "/api/admin/config", { autoLeave: { enabled: true, hours: 2, checkout: false } }, admin);
});

test("host links: sent to the host, their own page, their own visitors only", async () => {
  assert.equal((await s.api("GET", "/api/admin/hostlinks", undefined, desk)).status, 403, "admins only");
  const sent = (await s.api("POST", "/api/admin/hostlinks/send", { name: "Dana Ruiz" }, admin)).body;
  assert.deepEqual(sent.results, [{ name: "Dana Ruiz", sent: "email" }]);
  const mail = await waitFor(() => s.smtp.messages.find(m => m.to.includes("dana@test.example") && /\/host\//.test(m.text)));
  const token = mail.text.match(/\/host\/([A-Za-z0-9_-]+)/)[1];
  const page = await fetch(`${s.base}/host/${token}`);
  assert.equal(page.status, 200); assert.match(page.headers.get("content-security-policy"), /script-src 'nonce-/);
  assert.match(await page.text(), /Your visitors, Dana/);
  // Someone else's expected visitor isn't visible to Dana.
  await s.api("POST", "/api/admin/invites", { name: "Other Host Guest", host: "Sam Hill", from: new Date().toISOString().slice(0, 10) }, admin);
  const add = await s.api("POST", `/api/host/${token}/invites`, { name: "Hosted Hal", email: "hal@visitor.example", from: new Date().toISOString().slice(0, 10), sendEmail: true });
  assert.equal(add.status, 200); assert.equal(add.body.invite.host, "Dana Ruiz"); assert.equal(add.body.invite.by, 'host "Dana Ruiz"');
  const mine = (await s.api("GET", `/api/host/${token}`)).body;
  assert.deepEqual(mine.invites.map(i => i.name), ["Hosted Hal"]);
  const other = (await s.api("GET", "/api/admin/invites", undefined, admin)).body.find(i => i.name === "Other Host Guest");
  assert.equal((await s.api("DELETE", `/api/host/${token}/invites/${other.id}`)).status, 404, "can't remove another host's visitor");
  assert.equal((await s.api("DELETE", `/api/host/${token}/invites/${add.body.invite.id}`)).status, 200);
  assert.equal((await s.api("GET", "/api/host/not-a-real-token-at-all-xx")).status, 404);
  // A new link stops the old one.
  await s.api("POST", "/api/admin/hostlinks/reset", { name: "Dana Ruiz" }, admin);
  assert.equal((await s.api("GET", `/api/host/${token}`)).status, 404);
});

test("On my way: link in the host's alert, shown on the kiosk, visitor texted", async () => {
  const r = await checkin(s, { name: "Wanda Wait", mode: "psk", visitor: { phone: "813-555-0170" }, extra: { delivery: { notifyHost: true } } });
  assert.equal(r.status, 200); assert.ok(r.body.statusToken);
  const mail = await waitFor(() => s.smtp.messages.find(m => m.to.includes("dana@test.example") && /Wanda Wait/.test(m.subject)));
  const hostToken = mail.text.match(/\/onmyway\/([A-Za-z0-9_-]+)/)[1];
  const status = () => s.api("GET", `/api/pass-status/${r.body.statusToken}`);
  assert.equal((await status()).body.hostOnWay, false);
  const page = await fetch(`${s.base}/onmyway/${hostToken}`);
  assert.match(await page.text(), /I'm on my way/);
  assert.equal((await status()).body.hostOnWay, false, "opening the link (or a link preview) doesn't count");
  assert.equal((await s.api("POST", `/api/onmyway/${hostToken}`)).status, 200);
  assert.deepEqual((await status()).body, { hostOnWay: true, host: "Dana Ruiz" });
  assert.ok(twilioTo().some(t => t.To === "+18135550170" && /Dana Ruiz is on the way/.test(t.Body)));
  const v = (await visits()).find(x => x.name === "Wanda Wait");
  assert.ok(v.hostOnWayAt); assert.equal(v.hostToken, undefined); assert.equal(v.statusToken, undefined, "tokens stay on the server");
  assert.equal((await s.api("POST", "/api/onmyway/not-a-real-token-at-all-xx")).status, 404);
});

test("analytics: counts, busy times, visit length", async () => {
  // One visit with a known length: checked in 90 minutes ago, checked out now.
  const r = await checkin(s, { name: "Len Measured", mode: "psk", visitor: { checkedInAt: new Date(Date.now() - 90 * 60e3).toISOString() } });
  const f = await s.api("POST", "/api/checkout/find", { q: r.body.checkoutCode });
  await s.api("POST", "/api/checkout", { token: f.body.token });
  const a = (await s.api("GET", `/api/admin/analytics?tz=${new Date().getTimezoneOffset()}`, undefined, desk)).body;
  assert.ok(a.visits >= 6); assert.ok(a.unique >= 5);
  assert.equal(a.heat.length, 7); assert.equal(a.heat[0].length, 24);
  assert.equal(a.heat.flat().reduce((x, y) => x + y, 0), a.visits);
  assert.equal(a.length.buckets.length, 6); assert.ok(a.length.measured >= 1);
  assert.ok(a.length.buckets.find(b => b.label === "1 to 2 h").count >= 1);
  assert.ok(a.checkouts.kiosk >= 1); assert.ok(a.checkouts.automatic >= 1);
  assert.ok(a.places.some(p => p.name === "Lobby AP"));
  assert.equal(a.days.length, 30);
});
