// Network settings from the admin panel: the server's checks match the VM helper's (vm/files/kiosk-netcfg, run as
// root), the netplan file it writes, and the request/confirm hand-over between the two.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), os = require("os"), path = require("path");
const { startServer, adminToken, loadServer, ROOT } = require("./helpers");
const S = loadServer(), N = require(path.join(ROOT, "vm", "files", "kiosk-netcfg"));
const plain = x => JSON.parse(JSON.stringify(x));

const CASES = [
  { mode: "static", address: "192.168.10.50", prefix: 24, gateway: "192.168.10.1", dns: "192.168.10.1, 1.1.1.1", search: "Corp.Example.com", ntp: "time.example.com,10.0.0.5" },
  { mode: "static", address: "10.1.2.3/16", gateway: "10.1.0.1", dns: ["10.1.0.2"] },
  { mode: "dhcp" },
  { mode: "dhcp", dns: "9.9.9.9", ntp: "pool.ntp.org" },
  // refused
  { mode: "maybe" },
  { mode: "static", address: "192.168.10.0", prefix: 24, gateway: "192.168.10.1", dns: "1.1.1.1" },      // network address
  { mode: "static", address: "192.168.10.255", prefix: 24, gateway: "192.168.10.1", dns: "1.1.1.1" },    // broadcast
  { mode: "static", address: "192.168.10.5", prefix: 24, gateway: "192.168.11.1", dns: "1.1.1.1" },      // gateway elsewhere
  { mode: "static", address: "192.168.10.5", prefix: 24, gateway: "192.168.10.5", dns: "1.1.1.1" },      // gateway = self
  { mode: "static", address: "192.168.10.5", prefix: 24, gateway: "192.168.10.1" },                      // no DNS
  { mode: "static", address: "127.0.0.5", prefix: 8, gateway: "127.0.0.1", dns: "1.1.1.1" },
  { mode: "static", address: "192.168.10.5", prefix: 31, gateway: "192.168.10.4", dns: "1.1.1.1" },
  { mode: "static", address: "192.168.300.5", prefix: 24, gateway: "192.168.10.1", dns: "1.1.1.1" },
  { mode: "dhcp", dns: "dns.google" },
  { mode: "dhcp", dns: "1.1.1.1,1.0.0.1,8.8.8.8,8.8.4.4" },
  { mode: "dhcp", ntp: "a,b,c,d,e" },
  { mode: "dhcp", ntp: "bad_name" },
  { mode: "dhcp", search: "-x.example" },
];
const run = (f, c) => { try { return { ok: plain(f(c)) }; } catch (e) { return { error: e.message }; } };

test("the server and the VM helper check network settings the same way", () => {
  let refused = 0;
  for (const c of CASES) {
    const a = run(S.netSettings, c), b = run(N.validate, c);
    assert.deepEqual(a, b, JSON.stringify(c));
    if (a.error) refused++;
  }
  assert.equal(refused, 14, "every bad case is refused");
  assert.deepEqual(plain(S.netSettings(CASES[0])), { mode: "static", dns: ["192.168.10.1", "1.1.1.1"], search: ["corp.example.com"],
    ntp: ["time.example.com", "10.0.0.5"], address: "192.168.10.50", prefix: 24, gateway: "192.168.10.1" });
});

test("netplan file: static, DHCP, DHCP with its own DNS and NTP", () => {
  const y = N.netplanYaml("ens192", N.validate(CASES[0]));
  assert.match(y, /dhcp4: false\n {6}addresses: \[192\.168\.10\.50\/24\]\n {6}routes:\n {8}- to: default\n {10}via: 192\.168\.10\.1/);
  assert.match(y, /nameservers:\n {8}addresses: \[192\.168\.10\.1, 1\.1\.1\.1\]\n {8}search: \[corp\.example\.com\]/);
  assert.equal(N.netplanYaml("ens192", N.validate({ mode: "dhcp" })), "network:\n  version: 2\n  ethernets:\n    ens192:\n      dhcp4: true\n");
  const d = N.netplanYaml("ens192", N.validate(CASES[3]));
  assert.match(d, /dhcp4-overrides:\n {8}use-dns: false\n {8}use-ntp: false\n {6}nameservers:\n {8}addresses: \[9\.9\.9\.9\]/);
  assert.match(N.netplanYaml("ens192", N.validate({ mode: "dhcp", ntp: "pool.ntp.org" })), /dhcp4-overrides:\n {8}use-ntp: false\n$/);
  assert.equal(N.ntpConf(N.validate(CASES[3])), "# Set by Visitor Desk (admin panel or \"kiosk ntp\")\n[Time]\nNTP=pool.ntp.org\n");
  assert.equal(N.ntpConf(N.validate({ mode: "dhcp" })), null, "no servers: Ubuntu's default");
});

test("only address, gateway and DHCP/static changes need to be kept", () => {
  const st = N.validate(CASES[0]);
  assert.equal(N.risky(st, { ...st, dns: ["9.9.9.9"], ntp: [] }), false);
  assert.equal(N.risky(st, { ...st, gateway: "192.168.10.254" }), true);
  assert.equal(N.risky(st, N.validate({ mode: "dhcp" })), true);
  assert.equal(N.risky(N.validate({ mode: "dhcp" }), N.validate(CASES[3])), false);
});

let s, admin, dir;
test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vd-net-"));
  s = await startServer({ env: { KIOSK_NET_DIR: dir } }); admin = await adminToken(s);
  await s.api("POST", "/api/admin/users", { name: "desk", role: "reception", password: "Desk-Pass-12" }, admin);
});
test.after(async () => { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
const file = f => path.join(dir, f);

test("network: admins only; bad settings refused with the reason", async () => {
  const desk = (await s.api("POST", "/api/admin/login", { username: "desk", password: "Desk-Pass-12" })).body.token;
  assert.equal((await s.api("GET", "/api/admin/network", undefined, desk)).status, 403);
  assert.equal((await s.api("PUT", "/api/admin/network", { mode: "dhcp" }, desk)).status, 403);
  const g = (await s.api("GET", "/api/admin/network", undefined, admin)).body;
  assert.equal(g.available, true); assert.equal(g.status, null);
  const bad = await s.api("PUT", "/api/admin/network", { mode: "static", address: "192.168.10.5", prefix: 24, gateway: "10.0.0.1", dns: "1.1.1.1" }, admin);
  assert.equal(bad.status, 400); assert.match(bad.body.error, /isn't on the 192\.168\.10\.5\/24 network/);
  assert.equal(fs.existsSync(file("network.request")), false);
});

test("network: a change is handed to the VM, and can be kept once it's waiting", async () => {
  const put = await s.api("PUT", "/api/admin/network", CASES[0], admin);
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const req = JSON.parse(fs.readFileSync(file("network.request"), "utf8"));
  assert.equal(req.settings.address, "192.168.10.50"); assert.equal(req.by, "admin");
  assert.equal(put.body.status.state, "queued");
  assert.equal((await s.api("PUT", "/api/admin/network", { mode: "dhcp" }, admin)).status, 409, "one change at a time");
  assert.equal((await s.api("POST", "/api/admin/network/confirm", {}, admin)).status, 400, "nothing waiting yet");
  // What root's kiosk-netcfg writes after applying a risky change:
  fs.writeFileSync(file("network-status.json"), JSON.stringify({ state: "waiting", to: req.settings, deadline: new Date(Date.now() + 180e3).toISOString(),
    checks: { gateway: true, dns: true, internet: false }, at: new Date().toISOString() }));
  assert.equal((await s.api("POST", "/api/admin/network/confirm", {}, admin)).status, 200);
  assert.ok(fs.existsSync(file("network.confirm")), "the file kiosk-netcfg waits for");
  const audit = (await s.api("GET", "/api/admin/audit?q=network", undefined, admin)).body.map(a => a.action);
  assert.ok(audit.includes("Changed the network settings") && audit.includes("Kept the new network settings"));
});

test("network: a request nobody picks up is reported", async () => {
  fs.writeFileSync(file("network-status.json"), JSON.stringify({ state: "queued", at: new Date(Date.now() - 5 * 60e3).toISOString() }));
  const st = (await s.api("GET", "/api/admin/network", undefined, admin)).body.status;
  assert.equal(st.state, "failed"); assert.match(st.message, /didn't pick up/);
});

test("network: off when not on the VM", async () => {
  const t = await startServer();
  try {
    const a = await adminToken(t);
    assert.equal((await t.api("GET", "/api/admin/network", undefined, a)).body.available, false);
    assert.equal((await t.api("PUT", "/api/admin/network", { mode: "dhcp" }, a)).status, 409);
  } finally { await t.stop(); }
});
