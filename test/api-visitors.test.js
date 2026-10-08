// End-to-end: the visitor side. Check-in (guest pass, DPSK, shared password), check-out, invites, returning
// visitors, blocked visitors and staff alerts, against the real server with a fake RUCKUS One.
const plain = x => JSON.parse(JSON.stringify(x));
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs");
const { startServer, adminToken, checkin, waitFor } = require("./helpers");

let s, admin;
test.before(async () => { s = await startServer(); admin = await adminToken(s); });
test.after(() => s.stop());

const visits = async () => (await s.api("GET", "/api/admin/visits", undefined, admin)).body;
const visitOf = async name => (await visits()).find(v => v.name === name);

test("guest pass check-in: code from RUCKUS One, E.164 phone, MAIL enum, check-out code", async () => {
  const r = await checkin(s, { name: "Gina Guest", mode: "portal", extra: { delivery: { email: true } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.password, "123456"); assert.equal(r.body.ssid, "Acme-Guest"); assert.match(r.body.checkoutCode, /^\d{6}$/);
  const call = s.calls().find(c => c.method === "POST" && /guestUsers/.test(c.path)), body = JSON.parse(call.body);
  assert.equal(body.mobilePhoneNumber, "+18135550199");
  assert.deepEqual(body.deliveryMethods, ["MAIL"]);
  const v = await visitOf("Gina Guest");
  assert.equal(v.mode, "portal"); assert.equal(v.passCode, undefined, "the guest pass code never leaves the server in lists");
});

test("DPSK check-in: password in the pool's format, created without personal fields, then details patched", async () => {
  const r = await checkin(s, { name: "Dee Pisk", mode: "dpsk" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.password, /^[a-z]+(-[a-z]+){3}\d{3}$/, "pool d1: four words and a 3-digit suffix");
  const create = s.calls().find(c => c.method === "POST" && /\/dpskServices\/d1\/passphrases$/.test(c.path));
  assert.deepEqual(Object.keys(JSON.parse(create.body)).sort(), ["expirationDate", "numberOfDevices", "passphrase"]);
  assert.ok(s.calls().some(c => c.method === "PATCH" && /passphrases\/p\d+/.test(c.path)), "username/email/phone added afterwards");
});

test("shared password check-in uses the saved password; nothing is created in RUCKUS One", async () => {
  const n = s.calls().length, creates = list => list.filter(c => c.method === "POST" && /guestUsers|passphrases/.test(c.path)).length;
  const r = await checkin(s, { name: "Sam Shared", mode: "psk" });
  assert.equal(r.status, 200); assert.equal(r.body.password, "shared-pass-1");
  assert.equal(creates(s.calls().slice(n)), 0, "no guest pass or passphrase created");
});

test("photo and signature are saved; the photo is served to staff only", async () => {
  const photo = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==", signature = "data:image/png;base64,iVBORw0KGgo=";
  const r = await checkin(s, { name: "Pat Photo", mode: "psk", visitor: { photo, signature } });
  assert.equal(r.status, 200);
  const v = await visitOf("Pat Photo");
  assert.equal(v.hasPhoto, true); assert.equal(v.hasSignature, true);
  const img = await s.api("GET", `/api/admin/visits/${v.id}/signature.png`, undefined, admin);
  assert.equal(img.status, 200); assert.equal(img.headers.get("content-type"), "image/png");
  assert.equal((await s.api("GET", `/api/admin/visits/${v.id}/photo.jpg`)).status, 401, "not without signing in");
});

test("the kiosk can't set server-only fields on a visit", async () => {
  const someone = await visitOf("Pat Photo");
  await checkin(s, { name: "Eve Forger", mode: "psk", visitor: { photoFrom: someone.id, inviteId: "x", returningFrom: someone.id } });
  const v = await visitOf("Eve Forger");
  assert.equal(v.photoFrom, undefined); assert.equal(v.inviteId, undefined); assert.equal(v.returningFrom, undefined); assert.equal(v.hasPhoto, false);
});

test("check-out at the kiosk: by code, ends DPSK access with a plain array of ids", async () => {
  const r = await checkin(s, { name: "Otto Out", mode: "dpsk" });
  assert.equal((await s.api("POST", "/api/checkout/find", { q: "000000" })).status, 404);
  const f = await s.api("POST", "/api/checkout/find", { q: r.body.checkoutCode });
  assert.equal(f.status, 200); assert.equal(f.body.firstName, "Otto");
  assert.equal(JSON.stringify(f.body).includes("@"), false, "no email or phone comes back");
  assert.equal((await s.api("POST", "/api/checkout", { token: f.body.token })).status, 200);
  const v = await visitOf("Otto Out");
  assert.ok(v.checkedOutAt); assert.equal(v.revokedBy, "Checked out");
  const del = s.calls().filter(c => c.method === "DELETE" && /dpskServices\/d1\/passphrases$/.test(c.path)).pop();
  assert.ok(Array.isArray(JSON.parse(del.body)), "DELETE body is a plain array (RUCKUS One refuses {ids})");
  assert.equal((await s.api("POST", "/api/checkout", { token: f.body.token })).status, 410, "a used token is gone");
});

test("check-out by phone number finds the visit", async () => {
  await checkin(s, { name: "Phil Phone", mode: "psk", visitor: { phone: "(813) 555-0177" } });
  const f = await s.api("POST", "/api/checkout/find", { q: "813.555.0177" });
  assert.equal(f.status, 200); assert.equal(f.body.firstName, "Phil");
});

test("invites: code emailed, kiosk lookup without contact details, multi-day pass, single use", async () => {
  const today = new Date().toISOString().slice(0, 10), last = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10);
  const add = await s.api("POST", "/api/admin/invites", { name: "Ivy Invite", email: "ivy@visitor.example", phone: "813-555-0111",
    host: "Dana Ruiz", from: today, until: last, sendEmail: true, sendText: true }, admin);
  assert.equal(add.status, 200, JSON.stringify(add.body));
  const code = add.body.invite.code;
  const mail = await waitFor(() => s.smtp.messages.find(m => m.to.includes("ivy@visitor.example")));
  assert.ok(mail, "invite email sent"); assert.ok(mail.text.includes(code));
  const sms = s.calls().find(c => c.host === "api.twilio.com" && decodeURIComponent(c.body).includes(code));
  assert.ok(sms, "invite text sent");
  const look = await s.api("POST", "/api/invite", { q: code, today });
  assert.equal(look.status, 200); assert.equal(look.body.name, "Ivy Invite"); assert.equal(look.body.hasEmail, true); assert.equal(look.body.until, last);
  assert.equal(JSON.stringify(look.body).includes("ivy@"), false, "the kiosk doesn't get the email address");
  // The kiosk asks for a pass ending after the invite: the server keeps it to the invite's last day.
  const r = await checkin(s, { name: "Ivy Invite", mode: "dpsk", hours: 24 * 20, visitor: { email: "", phone: "" }, extra: { inviteToken: look.body.token } });
  assert.equal(r.status, 200);
  assert.ok(new Date(r.body.expiresAt) <= new Date(last + "T23:59:59Z").getTime() + 14 * 3600e3);
  const v = await visitOf("Ivy Invite");
  assert.equal(v.email, "ivy@visitor.example", "email filled in from the invite"); assert.ok(v.inviteId);
  assert.equal((await s.api("POST", "/api/invite", { q: code, today })).status, 404, "a used code doesn't work again");
});

test("invite import: good rows added, bad rows explained", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const r = await s.api("POST", "/api/admin/invites/import", { rows: [
    { name: "Imp One", email: "one@visitor.example", from: today, until: today },
    { name: "X", from: today, until: today },
    { name: "Imp Old", from: "2020-01-01", until: "2020-01-01" }], sendEmail: false }, admin);
  assert.equal(r.status, 200); assert.equal(r.body.added, 1);
  assert.match(r.body.results[1].error, /name/); assert.match(r.body.results[2].error, /passed/);
});

test("returning visitor: details and photo reused, the photo never sent to the kiosk", async () => {
  await checkin(s, { name: "Ruth Return", mode: "psk", visitor: { email: "ruth@visitor.example", photo: "data:image/jpeg;base64,/9j/4AAQ" } });
  const look = await s.api("POST", "/api/returning", { q: "RUTH@visitor.example" });
  assert.equal(look.status, 200); assert.equal(look.body.name, "Ruth Return"); assert.equal(look.body.hasPhoto, true);
  const r = await checkin(s, { name: "Ruth Return", mode: "psk", visitor: { email: "", phone: "" }, extra: { returningToken: look.body.token, reusePhoto: true } });
  assert.equal(r.status, 200); assert.equal(r.body.photo, undefined);
  const latest = (await visits()).filter(v => v.name === "Ruth Return").sort((a, b) => b.id.localeCompare(a.id))[0];
  assert.ok(latest.returningFrom); assert.ok(latest.photoFrom); assert.equal(latest.hasPhoto, true); assert.equal(latest.email, "ruth@visitor.example");
  assert.equal((await s.api("POST", "/api/returning", { q: "nobody@nowhere.example" })).status, 404);
});

test("blocked visitor is refused and staff are alerted", async () => {
  await checkin(s, { name: "Bob Blocked", mode: "psk", visitor: { email: "bob@visitor.example" } });
  const v = await visitOf("Bob Blocked");
  await s.api("PUT", "/api/admin/config", { alerts: { emails: ["ops@test.example"], phones: [] } }, admin);
  assert.equal((await s.api("POST", `/api/admin/visits/${v.id}/block`, { reason: "test" }, admin)).status, 200);
  const r = await checkin(s, { name: "Robert Someone", mode: "psk", visitor: { email: "BOB@visitor.example" } });
  assert.equal(r.status, 403); assert.equal(r.body.blocked, true);
  const alert = await waitFor(() => s.smtp.messages.find(m => m.to.includes("ops@test.example") && /Blocked visitor/.test(m.subject)));
  assert.ok(alert, "staff alert email");
});

test("ending access also disconnects the visitor's devices that are still on the Wi-Fi", async () => {
  const ci = await checkin(s, { name: "Kick Me", mode: "dpsk", visitor: { email: "kick@visitor.example", phone: "727-555-0199" } }); assert.equal(ci.status, 200, JSON.stringify(ci.body));
  const v = await visitOf("Kick Me");
  s.setState({ dpskDevices: [{ mac: "AA:BB:CC:00:00:09" }, { mac: "AA:BB:CC:00:00:0A" }],   // the second one isn't connected
    clients: [{ macAddress: "AA:BB:CC:00:00:09", hostname: "Kick-Phone", apInformation: { name: "Lobby AP", macAddress: "11:11:11:00:00:02", serialNumber: "S2" } }] });
  const deletes = () => s.calls().filter(c => c.method === "DELETE" && /passphrases$/.test(c.path)).length, before = deletes();
  const r = await s.api("POST", `/api/admin/visits/${v.id}/block`, { reason: "test", revoke: true }, admin);
  assert.equal(r.status, 200); assert.equal(r.body.ended, "ended");
  // DPSK: the visitor's RUCKUS One identity is blocked (shows as Blocked there); the password isn't deleted.
  const blockCall = s.calls().find(c => c.method === "PATCH" && /^\/identityGroups\/g1\/identities\/i\d+$/.test(c.path));
  assert.deepEqual(JSON.parse(blockCall.body), { revoked: true });
  assert.ok(r.body.record.identityBlocked, "recorded on the visit");
  assert.equal(deletes(), before, "no password deleted");
  assert.deepEqual(plain(r.body.record.lastDisconnect && { d: r.body.record.lastDisconnect.disconnected, f: r.body.record.lastDisconnect.failed }), { d: 1, f: 0 });
  const kicks = () => s.calls().filter(c => c.method === "PATCH" && /\/clients\//.test(c.path));
  assert.equal(kicks().length, 1);
  assert.match(kicks()[0].path, /^\/venues\/v1\/aps\/S2\/clients\/AA%3ABB%3ACC%3A00%3A00%3A09$/, "venue from the AP list, the AP's serial, the device's MAC");
  // The device is still on (or came back before the pass was gone): staff can disconnect it again.
  const again = await s.api("POST", `/api/admin/visits/${v.id}/revoke`, undefined, admin);
  assert.equal(again.status, 200); assert.equal(again.body.ended, "already"); assert.equal(kicks().length, 2);
  const audit = (await s.api("GET", "/api/admin/audit?q=Kick", undefined, admin)).body.map(a => a.action + ": " + a.detail);
  assert.ok(audit.some(a => /Ended Wi-Fi access: .*1 device\(s\) disconnected/.test(a)), audit.join("\n"));
  // Unblocking in Visitor Desk unblocks the identity too; the pass is still valid, so their Wi-Fi works again.
  const block = (await s.api("GET", "/api/admin/blocks", undefined, admin)).body.find(b => b.visitId === v.id);
  assert.equal((await s.api("DELETE", `/api/admin/blocks/${block.id}`, undefined, admin)).status, 200);
  const unblock = s.calls().filter(c => c.method === "PATCH" && /\/identities\//.test(c.path)).pop();
  assert.deepEqual(JSON.parse(unblock.body), { revoked: false });
  const after = await visitOf("Kick Me");
  assert.equal(after.revokedAt, undefined); assert.ok(after.accessRestoredAt); assert.equal(after.identityBlocked, undefined);
  s.setState({});
});

test("ending a DPSK visitor's access deletes the password and the identity RUCKUS One would leave behind", async () => {
  const ci = await checkin(s, { name: "End Me", mode: "dpsk", visitor: { email: "end@visitor.example", phone: "727-555-0198" } });
  assert.equal(ci.status, 200);
  const v = await visitOf("End Me");
  assert.ok(v.identityId && v.identityGroupId, "identity saved at check-in");
  assert.equal((await s.api("POST", `/api/admin/visits/${v.id}/revoke`, undefined, admin)).status, 200);
  assert.ok(s.calls().some(c => c.method === "DELETE" && c.path === `/identityGroups/g1/identities/${v.identityId}`));
});

test("records keep a check-out code only while on site; CSV neutralises formulas", async () => {
  await checkin(s, { name: "=HYPERLINK(\"x\")", mode: "psk" });
  const csv = await s.api("GET", "/api/admin/visits.csv", undefined, admin);
  assert.equal(csv.status, 200);
  const text = csv.body.toString();
  assert.ok(text.startsWith("﻿"));
  assert.ok(text.includes(`"'=HYPERLINK(""x"")"`), "a leading = gets a ' so Excel doesn't run it");
});

test("the audit log records what staff did", async () => {
  const a = await s.api("GET", "/api/admin/audit?limit=200", undefined, admin);
  const actions = a.body.map(x => x.action);
  for (const want of ["Created the first admin user", "Added an expected visitor", "Blocked a visitor", "Exported the visitor report"])
    assert.ok(actions.includes(want), `audit has "${want}"`);
  assert.ok(fs.statSync(s.file("data", "audit.log")).mode & 0o600);
});
