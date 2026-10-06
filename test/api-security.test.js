// End-to-end: security. Page headers and Content Security Policy, sign-in lockout, HTTPS-only API from other devices,
// the setup code, tablet pairing and check-in rate limits. Tests from "another device" use this computer's network
// address (they're skipped when it has none).
const test = require("node:test"), assert = require("node:assert/strict");
const { startServer, adminToken, checkin, lanIp } = require("./helpers");

let s, admin;
const ip = lanIp();
test.before(async () => { s = await startServer({ https: true }); });
test.after(() => s.stop());

test("the kiosk page: nonce CSP that matches its scripts, no framing, no sniffing", async () => {
  const r = await fetch(s.base + "/");
  const csp = r.headers.get("content-security-policy"), html = await r.text();
  const nonce = csp.match(/'nonce-([^']+)'/)[1];
  assert.match(csp, /default-src 'self'/); assert.match(csp, /object-src 'none'/); assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
  for (const tag of html.match(/<script\b[^>]*>/g)) assert.ok(tag.includes(`nonce="${nonce}"`), `script without the nonce: ${tag}`);
  assert.equal(r.headers.get("x-frame-options"), "DENY"); assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  const r2 = await fetch(s.base + "/");
  assert.notEqual(r2.headers.get("content-security-policy"), csp, "a new nonce for every page");
});

test("API answers are locked down too", async () => {
  const r = await fetch(s.base + "/api/kiosk-info");
  assert.match(r.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal((await s.api("GET", "/api/admin/visits")).status, 401, "staff pages need a sign-in");
  assert.equal((await s.api("GET", "/api/admin/visits", undefined, "made-up-token")).status, 401);
});

test("first admin: from this computer without a code", async () => {
  admin = await adminToken(s);
  assert.equal((await s.api("POST", "/api/admin/setup", { username: "second", password: "Second-Pass-1" })).status, 409, "only once");
});

test("visit file names can't be used to reach other files", async () => {
  for (const p of ["/api/admin/visits/..%2F..%2Fconfig.json/photo.jpg", "/api/admin/visits/x/photo.jpg", "/api/admin/visits/..%2Fconfig.json"])
    assert.ok([400, 404].includes((await s.api("GET", p, undefined, admin)).status), p);
});

test("from another device: plain http API refused, the page redirects to https", { skip: !ip && "no network address" }, async () => {
  const api = await fetch(`http://${ip}:${s.port}/api/kiosk-info`);
  assert.equal(api.status, 403);
  const page = await fetch(`http://${ip}:${s.port}/`, { redirect: "manual" });
  assert.equal(page.status, 302); assert.equal(page.headers.get("location"), `https://${ip}:${s.httpsPort}/`);
  assert.equal((await fetch(`http://${ip}:${s.port}/setup`)).status, 200, "the certificate setup page works over http");
  const https = await fetch(`https://${ip}:${s.httpsPort}/`);
  assert.equal(https.status, 200); assert.match(https.headers.get("strict-transport-security"), /max-age=/);
});

test("from another device: setup needs the setup code", { skip: !ip && "no network address" }, async () => {
  // Uses its own server: no admin yet.
  const t = await startServer({ https: true });
  try {
    const at = `https://${ip}:${t.httpsPort}`;
    const no = await t.api("POST", "/api/admin/setup", { username: "admin", password: "Admin-Pass-1", setupCode: "1234-5678" }, undefined, {}, at);
    assert.equal(no.status, 401);
    const code = t.out().match(/setup code: (\d{4}-?\d{4})/i)?.[1];
    assert.ok(code, "the setup code is printed at start");
    const yes = await t.api("POST", "/api/admin/setup", { username: "admin", password: "Admin-Pass-1", setupCode: code }, undefined, {}, at);
    assert.equal(yes.status, 200);
  } finally { await t.stop(); }
});

test("tablet pairing: open until the first tablet is paired, then paired tablets only", { skip: !ip && "no network address" }, async () => {
  const at = `https://${ip}:${s.httpsPort}`;
  assert.equal((await checkin(s, { name: "Before Pairing", mode: "psk", origin: at })).status, 200);
  const pair = await s.api("POST", "/api/admin/kiosks", { name: "Lobby iPad" }, admin);
  assert.equal(pair.status, 200); assert.ok(pair.body.token.length >= 32);
  const unpaired = await checkin(s, { name: "Not Paired", mode: "psk", origin: at });
  assert.equal(unpaired.status, 401); assert.equal(unpaired.body.pairing, true);
  assert.equal((await s.api("GET", "/api/hosts", undefined, undefined, {}, at)).status, 401, "host names hidden from unpaired devices");
  const K = { "x-kiosk-token": pair.body.token };
  assert.equal((await s.api("GET", "/api/hosts", undefined, undefined, K, at)).status, 200);
  assert.equal((await checkin(s, { name: "Paired Tablet", mode: "psk", headers: K, origin: at })).status, 200);
  assert.equal((await checkin(s, { name: "Server Itself", mode: "psk" })).status, 200, "the server's own computer always can");
  assert.equal((await s.api("POST", "/api/checkout/find", { q: "000000" }, undefined, {}, at)).status, 401, "kiosk lookups need pairing too");
  // The pairing key is stored hashed.
  const cfg = require("fs").readFileSync(s.file("config.json"), "utf8");
  assert.equal(cfg.includes(pair.body.token), false);
});

test("check-in rate limit: 20 per tablet in 10 minutes", { skip: !ip && "no network address" }, async () => {
  const at = `https://${ip}:${s.httpsPort}`;
  const { token } = (await s.api("POST", "/api/admin/kiosks", { name: "Busy iPad" }, admin)).body, K = { "x-kiosk-token": token };
  const codes = [];
  for (let i = 0; i < 21; i++) codes.push((await checkin(s, { name: `Rush ${i}`, mode: "psk", headers: K, origin: at })).status);
  assert.deepEqual(codes.slice(0, 20), Array(20).fill(200)); assert.equal(codes[20], 429);
  const audit = (await s.api("GET", "/api/admin/audit?q=too%20many", undefined, admin)).body;
  assert.ok(audit.length >= 1, "refusals are in the audit log");
});

test("sign-in lockout after 5 wrong passwords", async () => {
  const t = await startServer();
  try {
    await adminToken(t);
    for (let i = 0; i < 5; i++) assert.equal((await t.api("POST", "/api/admin/login", { username: "admin", password: "wrong-" + i })).status, 401);
    const locked = await t.api("POST", "/api/admin/login", { username: "admin", password: "Admin-Pass-1" });
    assert.equal(locked.status, 429, "even the right password waits");
  } finally { await t.stop(); }
});
