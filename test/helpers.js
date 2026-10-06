// Test helpers: a throwaway copy of the app with a test config, a fake mail server, and the kiosk server running on it
// (with test/mock-r1.js standing in for RUCKUS One and Twilio). Nothing touches the real config.json or data/.
const fs = require("fs"), os = require("os"), path = require("path"), net = require("net"), { spawn } = require("child_process");
const ROOT = path.join(__dirname, "..");
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";   // the test server's HTTPS uses its own new certificate authority

function sandbox(config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "visitor-desk-test-"));
  fs.copyFileSync(path.join(ROOT, "server.js"), path.join(dir, "server.js"));
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(dir, "package.json"));
  fs.mkdirSync(path.join(dir, "public"));
  fs.copyFileSync(path.join(ROOT, "public", "index.html"), path.join(dir, "public", "index.html"));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config, null, 2));
  return dir;
}

// The server's helper functions, loaded from a throwaway copy (removed again straight away).
function loadServer() {
  const dir = sandbox({}), mod = require(path.join(dir, "server.js"));
  fs.rmSync(dir, { recursive: true, force: true });
  return mod;
}

const freePort = () => new Promise(res => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });

// A plain SMTP server that keeps every message (subject and text decoded).
function startSmtp() {
  const messages = [];
  const server = net.createServer(sock => {
    let buf = "", data = false, mail = { to: [] };
    sock.write("220 test\r\n");
    sock.on("data", d => {
      buf += d;
      for (;;) {
        if (data) {
          const end = buf.indexOf("\r\n.\r\n"); if (end < 0) return;
          const raw = buf.slice(0, end); buf = buf.slice(end + 5); data = false;
          const [head, ...rest] = raw.split("\r\n\r\n");
          const subj = (head.match(/^Subject: (.*)$/m) || [])[1] || "";
          const b64 = subj.match(/=\?UTF-8\?B\?([^?]*)\?=/);
          messages.push({ to: mail.to, subject: b64 ? Buffer.from(b64[1], "base64").toString() : subj,
            text: Buffer.from(rest.join("\r\n\r\n").replace(/\s/g, ""), "base64").toString() });
          mail = { to: [] }; sock.write("250 ok\r\n"); continue;
        }
        const i = buf.indexOf("\r\n"); if (i < 0) return;
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (/^EHLO|^HELO/i.test(line)) sock.write("250 test\r\n");
        else if (/^RCPT TO:<(.*)>/i.test(line)) { mail.to.push(line.match(/<(.*)>/)[1]); sock.write("250 ok\r\n"); }
        else if (/^DATA/i.test(line)) { data = true; sock.write("354 go\r\n"); }
        else if (/^QUIT/i.test(line)) { sock.write("221 bye\r\n"); sock.end(); }
        else sock.write("250 ok\r\n");
      }
    });
    sock.on("error", () => {});
  });
  return new Promise(res => server.listen(0, "127.0.0.1", () => res({ port: server.address().port, messages, close: () => server.close() })));
}

// The config most tests start from: RUCKUS One "connected" (to the mock), email and texts set up, one host.
function testConfig(smtpPort, extra = {}) {
  return {
    ruckus: { region: "na", tenantId: "tenant-id-0001", clientId: "client-id-0002", clientSecret: "good-secret" },
    guestPass: { wifiNetworkId: "n1" }, dpsk: { poolId: "d1" }, psk: { password: "shared-pass-1" },
    notifications: { email: { host: "127.0.0.1", port: smtpPort, security: "none", from: "Desk <desk@test.example>" },
      sms: { accountSid: "AC123", authToken: "tok", from: "+18135550100" } },
    hosts: [{ name: "Dana Ruiz", email: "dana@test.example", phone: "813-555-0142" }],
    storage: { recordDays: 30, imageDays: null },
    ...extra
  };
}

async function startServer({ config, https = false, env: extraEnv = {} } = {}) {
  const smtp = await startSmtp();
  const dir = sandbox(config || testConfig(smtp.port));
  const port = await freePort(), httpsPort = await freePort();
  const env = { ...process.env, PORT: String(port), MOCK_LOG: path.join(dir, "mock.log"), MOCK_STATE: path.join(dir, "mock-state.json"), ...extraEnv };
  if (https) env.HTTPS_PORT = String(httpsPort);
  else { const c = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")); c.https = { enabled: false }; fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(c)); }
  const proc = spawn(process.execPath, ["-r", path.join(__dirname, "mock-r1.js"), "server.js"], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; proc.stdout.on("data", d => out += d); proc.stderr.on("data", d => out += d);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/health")).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
    if (i === 99) throw new Error("The test server didn't start:\n" + out);
  }
  if (https) for (let i = 0; i < 100; i++) { try { await fetch(`https://127.0.0.1:${httpsPort}/health`); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  const s = {
    dir, base, port, httpsPort, smtp, out: () => out,
    setState: st => fs.writeFileSync(env.MOCK_STATE, JSON.stringify(st)),
    calls: () => { try { return fs.readFileSync(env.MOCK_LOG, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } },
    file: (...p) => path.join(dir, ...p),
    async stop() { proc.kill(); smtp.close(); await new Promise(r => setTimeout(r, 100)); fs.rmSync(dir, { recursive: true, force: true }); },
    // JSON request helper: s.api("POST", "/api/admin/login", body, token) → { status, body, headers }
    async api(method, p, body, token, extraHeaders = {}, origin = base) {
      const res = await fetch(origin + p, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: "Bearer " + token } : {}), ...extraHeaders }, body: body !== undefined ? JSON.stringify(body) : undefined });
      const type = res.headers.get("content-type") || "";
      const b = type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer());
      return { status: res.status, body: b, headers: res.headers };
    }
  };
  return s;
}

// First admin (allowed from this computer without the setup code), signed in.
async function adminToken(s, name = "admin", password = "Admin-Pass-1") {
  const r = await s.api("POST", "/api/admin/setup", { username: name, password });
  if (r.status !== 200) throw new Error("setup failed: " + JSON.stringify(r.body));
  return r.body.token;
}

// A check-in as the kiosk page sends it.
function checkin(s, { name = "Test Visitor", mode = "dpsk", hours = 4, extra = {}, visitor = {}, headers = {}, origin } = {}) {
  return s.api("POST", "/api/guest-pass", {
    visitor: { name, email: name.split(" ")[0].toLowerCase() + "@visitor.example", phone: "813-555-0199", company: "Initech", host: "Dana Ruiz",
      purpose: "Meeting", checkedInAt: new Date().toISOString(), ...visitor },
    network: { mode, ssid: "Guest", devices: 2, codeStyle: "words", expiresAt: new Date(Date.now() + hours * 3600e3).toISOString() },
    delivery: {}, retentionDays: 30, ...extra
  }, undefined, headers, origin);
}

const lanIp = () => Object.values(os.networkInterfaces()).flat().find(a => a && a.family === "IPv4" && !a.internal)?.address;
const waitFor = async (fn, ms = 5000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await new Promise(r => setTimeout(r, 100)); } };

module.exports = { loadServer, sandbox, startServer, startSmtp, testConfig, adminToken, checkin, lanIp, waitFor, ROOT };
