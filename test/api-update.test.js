// End-to-end: updates from the admin panel. A real update file (built with vm/make-update.py, signed with a test key)
// is uploaded, checked and staged; "Install" hands it to the VM's installer (here: just the incoming file).
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto");
const { execFileSync } = require("child_process");
const { startServer, adminToken, ROOT } = require("./helpers");

// A minimal USTAR writer for the outer .kup (update.tar.gz + update.sig), like build-update.sh makes.
function ustar(files) {
  const blocks = [];
  for (const [name, data] of files) {
    const h = Buffer.alloc(512);
    h.write(name, 0); h.write("0000644\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
    h.write(data.length.toString(8).padStart(11, "0") + "\0", 124); h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", 136);
    h.write("        ", 148); h.write("0", 156); h.write("ustar\0", 257); h.write("00", 263);
    let sum = 0; for (const b of h) sum += b; h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(h, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}
function makeKup(version, privateKey) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vd-kup-")), tgz = path.join(dir, "update.tar.gz");
  execFileSync("python3", [path.join(ROOT, "vm", "make-update.py"), "--root", ROOT, "--version", version, "--build", "test", "--out", tgz]);
  const data = fs.readFileSync(tgz); fs.rmSync(dir, { recursive: true, force: true });
  return ustar([["update.tar.gz", data], ["update.sig", crypto.sign(null, data, privateKey)]]);
}
const keys = crypto.generateKeyPairSync("ed25519"), other = crypto.generateKeyPairSync("ed25519");
let s, admin, pubFile;
test.before(async () => {
  pubFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vd-pub-")), "update-signing.pub");
  fs.writeFileSync(pubFile, keys.publicKey.export({ type: "spki", format: "pem" }));
  s = await startServer({ env: { KIOSK_UPDATE_PUB: pubFile } }); admin = await adminToken(s);
  await s.api("POST", "/api/admin/users", { name: "desk", role: "reception", password: "Desk-Pass-12" }, admin);
});
test.after(async () => { await s.stop(); fs.rmSync(path.dirname(pubFile), { recursive: true, force: true }); });

const upload = (buf, token = admin) => fetch(s.base + "/api/admin/update/upload", { method: "POST", headers: { Authorization: "Bearer " + token,
  "Content-Type": "application/octet-stream" }, body: buf }).then(async r => ({ status: r.status, body: await r.json() }));

test("updates: admins only, shows the installed version", async () => {
  const desk = (await s.api("POST", "/api/admin/login", { username: "desk", password: "Desk-Pass-12" })).body.token;
  assert.equal((await s.api("GET", "/api/admin/update", undefined, desk)).status, 403);
  const u = (await s.api("GET", "/api/admin/update", undefined, admin)).body;
  assert.equal(u.available, true); assert.ok(u.current.version); assert.equal(u.staged, null);
});

test("only signed update files are accepted", async () => {
  assert.match((await upload(Buffer.from("not an update"))).body.error, /isn't a Visitor Desk update/);
  const wrong = await upload(makeKup("9.9.9", other.privateKey));
  assert.equal(wrong.status, 400); assert.match(wrong.body.error, /isn't signed with this VM's update key/);
  // Signed, then changed: the signature no longer matches.
  const good = makeKup("9.9.9", keys.privateKey), tampered = Buffer.from(good); tampered[600] ^= 0xff;
  assert.equal((await upload(tampered)).status, 400);
  assert.equal(fs.existsSync(s.file("data", "updates", "staged.kup")), false);
});

test("upload, check, install: hands the file to the VM's installer", async () => {
  const up = await upload(makeKup("9.9.9", keys.privateKey));
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.staged.version, "9.9.9"); assert.equal(up.body.staged.build, "test"); assert.equal(up.body.staged.node, false);
  const go = await s.api("POST", "/api/admin/update/install", {}, admin);
  assert.equal(go.status, 200);
  assert.ok(fs.existsSync(s.file("data", "updates", "incoming.kup")), "the installer's watched file");
  assert.equal(fs.existsSync(s.file("data", "updates", "staged.kup")), false);
  const st = (await s.api("GET", "/api/admin/update", undefined, admin)).body.status;
  assert.equal(st.state, "queued"); assert.equal(st.to, "9.9.9");
  const audit = (await s.api("GET", "/api/admin/audit?q=update", undefined, admin)).body.map(a => a.action);
  assert.ok(audit.includes("Uploaded an update") && audit.includes("Started an update"));
  assert.equal((await s.api("POST", "/api/admin/update/install", {}, admin)).status, 400, "nothing staged any more");
});

test("the running version is reported, not the files an update has just copied in", async () => {
  const before = (await s.api("GET", "/api/admin/update", undefined, admin)).body.current.version;
  fs.writeFileSync(s.file(".version.json"), JSON.stringify({ version: "9.9.9", build: "copied-in" }));
  try { assert.equal((await s.api("GET", "/api/admin/update", undefined, admin)).body.current.version, before); }
  finally { fs.rmSync(s.file(".version.json"), { force: true }); }
});

test("going back needs an earlier version", async () => {
  assert.equal((await s.api("POST", "/api/admin/update/rollback", {}, admin)).status, 400);
});

test("not on the VM: updates are off", async () => {
  const t = await startServer();
  try {
    const a = await adminToken(t);
    assert.equal((await t.api("GET", "/api/admin/update", undefined, a)).body.available, false);
    const r = await fetch(t.base + "/api/admin/update/upload", { method: "POST", headers: { Authorization: "Bearer " + a }, body: Buffer.from("x") });
    assert.equal(r.status, 409);
  } finally { await t.stop(); }
});
