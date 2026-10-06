// Fake RUCKUS One, Twilio and floor plan storage for the tests. Loaded into the test server with `node -r`.
// Response shapes follow what was confirmed against a live tenant (see CLAUDE.md). Every call is logged to
// MOCK_LOG (one JSON line each) so tests can check what the server sent. MOCK_STATE (a JSON file the test writes)
// holds the connected clients and other things a test wants to change while the server runs.
const fs = require("fs");
const LOG = process.env.MOCK_LOG, STATE = process.env.MOCK_STATE;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const passphrases = [];
let guestN = 0;
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const log = entry => { if (LOG) fs.appendFileSync(LOG, JSON.stringify(entry) + "\n"); };
const state = () => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return {}; } };

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url), m = opts.method || "GET", p = u.pathname;
  const body = typeof opts.body === "string" ? opts.body : opts.body ? String(opts.body) : "";
  log({ host: u.hostname, method: m, path: p, query: u.search, body });
  if (u.hostname === "api.twilio.com") return json({ sid: "SM1" }, 201);
  if (u.hostname === "storage.googleapis.com") return new Response(PNG, { status: 200, headers: { "Content-Type": "application/image" } });
  if (!u.hostname.endsWith("ruckus.cloud")) return json({ message: "the tests don't reach the internet" }, 599);
  const st = state();
  if (p.startsWith("/oauth2/token/")) {
    const f = new URLSearchParams(body);
    return f.get("client_secret") === "good-secret" ? json({ access_token: "tok", expires_in: 3600 }) : json({ error: "invalid_client" }, 401);
  }
  if (st.down) return json({ message: "RUCKUS One is down (test)" }, 503);
  if (p === "/venues/query") return json({ data: [{ id: "v1", name: "HQ" }], totalCount: 1 });
  if (p === "/wifiNetworks/query") return json({ data: [
    { id: "n1", name: "Guest", ssid: "Acme-Guest", nwSubType: "guest", venueApGroups: [{ venueId: "v1" }] },
    { id: "n2", name: "Visitor DPSK", ssid: "Acme-Visitor", nwSubType: "dpsk", dpskServiceProfileId: "d1", venueApGroups: [{ venueId: "v1" }] },
    { id: "n4", name: "Staff", ssid: "Acme-Staff", nwSubType: "psk", venueApGroups: [{ venueId: "v1" }] }] });
  if (p === "/wifiNetworks/n4") return json({ id: "n4", type: "psk", wlan: { ssid: "Acme-Staff", wlanSecurity: "WPA3", saePassphrase: "from-ruckus-pw" } });
  if (p === "/dpskServices" && m === "GET") return json({ content: [{ id: "d1", name: "Visitors" }, { id: "d2", name: "Residents" }] });
  if (/^\/dpskServices\/d2$/.test(p)) return json({ id: "d2", name: "Residents", passphraseFormat: "NUMBERS_ONLY", passphraseLength: 8 });
  if (/^\/dpskServices\/d1$/.test(p)) return json({ id: "d1", name: "Visitors", passphraseFormat: "DICTIONARY_WORDS", wordCount: 4, numericSuffixEnabled: true, autoNotificationsEnabled: false });
  if (/\/passphrases\/notifications$/.test(p)) return json({ requestId: "n" }, 202);
  if (/^\/dpskServices\/\w+\/passphrases\/\w+\/devices$/.test(p)) return json(st.dpskDevices || []);
  const pp = p.match(/^\/dpskServices\/(\w+)\/passphrases(?:\/(\w+))?$/);
  if (pp && m === "POST") {
    const b = JSON.parse(body);
    if (b.username || b.email || b.phoneNumber) return json({ message: "extra fields on create" }, 500);   // like the real one
    passphrases.push({ id: "p" + passphrases.length, ...b }); return json({ requestId: "r1" }, 202);
  }
  if (pp && m === "GET" && pp[2]) return json(passphrases.find(x => x.id === pp[2]) || {}, passphrases.some(x => x.id === pp[2]) ? 200 : 404);
  if (pp && m === "GET") return json({ content: passphrases });
  if (pp && m === "PATCH") { Object.assign(passphrases.find(x => x.id === pp[2]) || {}, JSON.parse(body)); return json({ requestId: "r2" }, 202); }
  if (pp && m === "DELETE") return Array.isArray(JSON.parse(body || "null")) ? json({ requestId: "rd" }, 202) : json({ message: "Malformed JSON request" }, 400);
  const gu = p.match(/^\/wifiNetworks\/(\w+)\/guestUsers(?:\/(\w+))?$/);
  if (gu && m === "POST") return json({ response: { id: "g" + ++guestN, password: "123456", ssid: "Acme-Guest" } }, 201);
  if (gu && m === "GET") return json({ response: { id: gu[2], ssid: "Acme-Guest", expirationDate: Date.now() + 8 * 3600e3, macAddresses: st.guestMacs || [] } });
  if (gu && m === "DELETE") return json({ requestId: "rd" });
  if (p === "/venues/aps/clients/query") { const c = st.clients || []; return json({ data: c, totalCount: c.length, page: 1 }); }
  if (p === "/venues/aps/query") return json({ data: [
    { name: "Lobby AP", apMac: "11:11:11:00:00:02", serialNumber: "S2", venueName: "HQ", venueId: "v1", floorPosition: { floorplanId: "fp1", xPercent: 55, yPercent: 40 } },
    { name: "Conference AP", apMac: "11:11:11:00:00:03", serialNumber: "S3", venueName: "HQ", venueId: "v1", floorPosition: { floorplanId: "fp1", xPercent: 70, yPercent: 30 } }] });
  if (p === "/venues/v1/floorplans") return json([{ id: "fp1", name: "First floor", floorNumber: 1, imageId: "img1" }]);
  if (p === "/venues/v1/signurls/img1/urls") return json({ signedUrl: "https://storage.googleapis.com/test/img1" });
  if (p === "/events/query") return json({ data: [], totalCount: 0 });
  if (p === "/historicalClients/query") return json({ data: [], totalCount: 0 });
  return json({ message: "mock: unknown path " + p }, 404);
};
