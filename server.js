#!/usr/bin/env node
/*
 * Visitor Desk: visitor check-in and Wi-Fi for RUCKUS One (the kiosk server)
 * Runs on macOS, Windows and Raspberry Pi. Needs Node.js 18 or newer. No npm install needed.
 *
 *   node server.js          start the kiosk server
 *   node server.js check    test your RUCKUS One login and list network / DPSK IDs
 */
const http = require("http");
const https = require("https");
const { execFileSync } = require("child_process");
const net = require("net");
const tls = require("tls");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, "config.json");
const DATA_DIR = path.join(ROOT, "data", "visits");

/* ---------------- Audit log (append-only; shown in the admin panel) ---------------- */
// Who did what: sign-ins, users, settings, exports, deletions, blocks, ended access, resends, badge prints, device
// lookups, tablet pairing. One JSON line per entry in data/audit.log (mode 600), never trimmed by the server.
const AUDIT_PATH = path.join(ROOT, "data", "audit.log");
function audit(req, who, action, detail = "") {
  const line = JSON.stringify({ at: new Date().toISOString(), who: who || "", ip: req ? String(req.socket?.remoteAddress || "").replace(/^::ffff:/, "") : "", action, detail: String(detail).slice(0, 300) });
  try { fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true }); fs.appendFileSync(AUDIT_PATH, line + "\n", { mode: 0o600 }); } catch {}
}
function readAudit(q = "", limit = 500) {
  let lines = []; try { lines = fs.readFileSync(AUDIT_PATH, "utf8").trim().split("\n").reverse(); } catch {}
  q = q.toLowerCase(); const out = [];
  for (const l of lines) { if (!l) continue; if (q && !l.toLowerCase().includes(q)) continue; try { out.push(JSON.parse(l)); } catch {} if (out.length >= limit) break; }
  return out;
}

/* ---------------- Recent problems (shown in the admin panel) ---------------- */
// The last 100 errors (failed check-ins, RUCKUS One errors, failed host alerts...), kept in data/errors.json so they
// survive a restart. Everything printed with console.error is recorded; request errors also say where they happened.
const ERRORS_PATH = path.join(ROOT, "data", "errors.json");
let problems = null;
function loadProblems() { if (!problems) { try { problems = JSON.parse(fs.readFileSync(ERRORS_PATH, "utf8")); } catch { problems = []; } } return problems; }
function recordProblem(where, message, quiet = false) {
  const list = loadProblems();
  list.unshift({ at: new Date().toISOString(), where, message: String(message).slice(0, 500) });
  list.length = Math.min(list.length, 100);
  try { fs.mkdirSync(path.dirname(ERRORS_PATH), { recursive: true }); fs.writeFileSync(ERRORS_PATH, JSON.stringify(list, null, 2), { mode: 0o600 }); } catch {}
  // Failed check-ins and RUCKUS One trouble reach staff (at most one alert per 30 minutes).
  if (!quiet && (where === "Check-in" || where === "Device tracking"))
    staffAlert("problems", where === "Check-in" ? "A check-in failed" : "RUCKUS One isn't answering",
      `${where}: ${String(message).slice(0, 300)}\n\nSee Admin > Recent problems.`, { throttleMin: 30 }).catch(() => {});
}
const recordProblemQuiet = (where, message) => recordProblem(where, message, true);
const printError = console.error.bind(console);
console.error = (...args) => { printError(...args); try { recordProblem("Server", args.map(String).join(" ")); } catch {} };
const KIOSK_HTML = path.join(ROOT, "public", "index.html");
const CERT_DIR = path.join(ROOT, "certs");
const LOOK_PATH = path.join(ROOT, "shared-look.json");   // look used by every kiosk, when turned on
const QUESTIONS_PATH = path.join(ROOT, "shared-questions.json");   // "What visitors fill in" for every kiosk, when turned on

// config.json is optional at first start: the RUCKUS One connection can be set up from the kiosk admin panel.
let cfg = {};
if (fs.existsSync(CONFIG_PATH)) cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const env = process.env;
const ENV_KEYS = { region: "R1_REGION", tenantId: "R1_TENANT_ID", clientId: "R1_CLIENT_ID", clientSecret: "R1_CLIENT_SECRET", delegatedTenantId: "R1_DELEGATED_TENANT_ID" };
function r1FromConfig(c = cfg.ruckus || {}) {
  const pick = k => env[ENV_KEYS[k]] || c[k] || "";
  return { region: (pick("region") || "na").toLowerCase(), tenantId: pick("tenantId"), clientId: pick("clientId"),
    clientSecret: pick("clientSecret"), delegatedTenantId: pick("delegatedTenantId") };
}
let R1 = r1FromConfig();
const HOSTS = {
  na:   { auth: "https://ruckus.cloud",      api: "https://api.ruckus.cloud" },
  eu:   { auth: "https://eu.ruckus.cloud",   api: "https://api.eu.ruckus.cloud" },
  asia: { auth: "https://asia.ruckus.cloud", api: "https://api.asia.ruckus.cloud" }
};

function saveConfig() {
  const tmp = CONFIG_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_PATH);
}

/* ---------------- RUCKUS One API ---------------- */
let token = null, tokenExpires = 0;

async function login(r) {
  if (!HOSTS[r.region]) throw new Error(`Unknown region "${r.region}". Use na, eu or asia.`);
  if (!r.tenantId || !r.clientId || !r.clientSecret) throw new Error("RUCKUS One isn't connected yet. Add the tenant ID, client ID and secret in the kiosk admin panel.");
  const res = await fetch(`${HOSTS[r.region].auth}/oauth2/token/${encodeURIComponent(r.tenantId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: r.clientId, client_secret: r.clientSecret })
  });
  const text = await res.text();
  if (!res.ok) throw new Error(res.status === 400 || res.status === 401
    ? `RUCKUS One didn't accept the tenant ID, client ID or secret (${res.status})`
    : `RUCKUS One login failed (${res.status}): ${text.slice(0, 200)}`);
  let j; try { j = JSON.parse(text); } catch { throw new Error("RUCKUS One login returned something unexpected. Check the region."); }
  const t = j.access_token || j.token || j.jwt;
  if (!t) throw new Error("RUCKUS One login succeeded but returned no token");
  return { token: t, expires: Date.now() + (j.expires_in || 3600) * 1000 };
}

async function getToken() {
  if (token && Date.now() < tokenExpires - 60_000) return token;
  ({ token, expires: tokenExpires } = await login(R1));
  return token;
}

// RUCKUS error bodies differ between APIs: a flat `message`, an `error` object, or an `errors` array.
function errorText(j) {
  if (!j) return "";
  if (typeof j.message === "string" && j.message) return j.message;
  const parts = [...(j.error ? [j.error] : []), ...(Array.isArray(j.errors) ? j.errors : [])]
    .map(e => typeof e === "string" ? e : e && [...new Set([e.message, e.reason].filter(Boolean))].join(": ")).filter(Boolean);
  return parts.join("; ") || (typeof j.debugMessage === "string" ? j.debugMessage : "");
}

async function r1(method, apiPath, body, contentType = "application/json", retry = true) {
  const headers = {
    Authorization: `Bearer ${await getToken()}`,
    "Content-Type": contentType,
    Accept: `${contentType}, application/json`
  };
  if (R1.delegatedTenantId) headers["x-rks-tenantid"] = R1.delegatedTenantId;
  const res = await fetch(HOSTS[R1.region].api + apiPath, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401 && retry) { token = null; return r1(method, apiPath, body, contentType, false); }
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const e = errorText(data);
    throw new Error(`RUCKUS One ${method} ${apiPath.split("?")[0]} failed (${res.status})${e ? ": " + e : ""}`);
  }
  return data;
}

/* ---------------- Passwords ---------------- */
// Visitor passwords (DPSK; demo passes). A recorded Wi-Fi handshake lets someone test guesses offline, so these need
// real strength: 3 words from ~635 + 4 digits ≈ 2.3 trillion; 12 digits = 1 trillion; 12 of 31 letters/digits ≈ 8e17.
// (The old "word-1234" style had only 108,000.) Easy words: no look-alikes, all lowercase.
const WORDS = `
acorn actor adobe agent alarm album alder alley alpha amber anchor angle ankle apple apron arbor arch arena armor
arrow aspen atlas attic autumn avenue award bacon badge bagel baker balsa bamboo banjo barley barn basil basin
basket beach beacon beagle beam bean bear beaver bench berry birch bison blade blaze blend bloom blossom board boat
bonnet boot border bottle boulder bounce bowl branch brave bread breeze brick bridge brook broom brush bucket buckle
buffalo bugle bundle burrow butter button cabin cable cactus camel camera candle canoe canvas canyon cape caramel
carbon cargo carpet carrot castle cedar cello chalk channel chapel cheese cherry chess chestnut chimney cider cinder
circle citrus clay cliff clock cloud clover coast cobalt cocoa coconut comet compass copper coral cotton cougar cove
coyote crane crater crayon creek cricket crisp crown crystal cupcake curtain cushion cypress daisy dancer dawn
decimal delta denim desert diamond dinner dock dolphin domain donkey dragon drift drum dune eagle easel echo eclipse
elbow elder ember emerald engine falcon feather fence fern ferry fiddle field fig finch fjord flag flame flannel
flint flower flute forest fossil fountain fox frame freckle frost fruit gadget galaxy garden garlic garnet gazelle
gecko geyser ginger glacier glove gopher granite grape gravel grove guitar gull hammer hamster harbor harp harvest
hatch haven hawk hazel hedge helmet heron hickory hill hippo hollow honey hornet horse husky igloo indigo iris
island ivory jacket jade jaguar jasmine jelly jewel jigsaw journey juniper kayak kernel kettle kiwi koala ladder
lagoon lake lantern lark laurel lava lemon lens lilac lily lime linen lion lizard llama lobster locket lotus lumber
lunar lynx magnet mallard mango mantle maple marble marigold marsh meadow melon mesa meteor midnight mint mirror
mitten molten monarch moose morning mosaic moss motor muffin mural mushroom nectar needle nest nickel noodle north
nugget nutmeg oak oasis ocean olive onion onyx opal orange orbit orchard orchid otter owl oyster paddle palm panda
panther papaya parade parrot pasta pastel peach peanut pearl pebble pecan pelican pencil pepper petal piano pickle
pigeon pillow pine pinto pixel planet plaza plum pocket polar pony poppy porch potato prairie pretzel prism puffin
pumpkin puzzle quail quarry quartz quill quilt rabbit radar radish rainbow raven reef ribbon ridge river robin
rocket rose ruby saddle saffron sage salmon sand sapphire satin scarf scout seal sequoia shadow shell shore sierra
silver sketch sky slate sled slope snail snow socket sonnet sparrow spice spider spiral spoon spruce squash squirrel
stable star steam stone storm stream summit sunset swan sycamore table tablet tadpole tango teapot temple thistle
thunder tiger timber toast tomato topaz torch tortoise tower trail trolley trophy trout tulip tundra turnip turtle
tuxedo twig umbrella unicorn valley vapor velvet vessel violet violin volcano voyage waffle wagon walnut walrus
water wave whale wheat whistle willow window winter wizard wolf wombat wren yacht yarrow yogurt zebra zephyr zigzag
zinc zucchini almond anvil apricot avocado banner barrel beetle biscuit blanket bobcat bramble bronze bubble cabbage
cardinal cashew catfish caviar celery cereal chamber cheetah chili cobra condor cookie corner crocus cuckoo dahlia
dingo dragonfly duck dumpling eggplant elm emu ermine fable fennel ferret flamingo fudge gable galleon gardenia
gerbil gingko goblet goose gourd griffin grizzly guava gumdrop haddock halibut hazelnut heather herring hibiscus
hyacinth ibis iguana jackal jellybean kangaroo kestrel kingfisher kite ladybug lavender leopard lettuce lichen
lobelia lupine macaw magpie mandarin manatee marmot marten meerkat merlin minnow mole mongoose muskrat narwhal
nimbus ocelot okapi oriole osprey ostrich panpipe parsley partridge peacock penguin peony periwinkle petunia
pheasant pistachio platypus plover poplar porcupine primrose puma quokka raccoon raspberry redwood reindeer rhubarb
roadrunner rosemary sandpiper sardine scallop seahorse sesame shamrock shrimp skylark snapdragon sorrel spinach
starling stingray stork sunflower swallow tamarind tangerine tapir tarragon terrier thyme toucan truffle tumbleweed
valerian vanilla verbena vulture warbler wasabi weasel wildcat wisteria woodpecker yak yucca zinnia
`.trim().split(/\s+/);
function makePassword(style, minLen) {
  if (style === "digits") return Array.from({ length: Math.max(minLen, 12) }, () => crypto.randomInt(10)).join("");
  if (style === "mixed") {
    const a = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    return Array.from({ length: Math.max(minLen, 12) }, () => a[crypto.randomInt(a.length)]).join("");
  }
  const w = () => WORDS[crypto.randomInt(WORDS.length)];
  return `${w()}-${w()}-${w()}-${crypto.randomInt(1000, 10000)}`;
}

/* ---------------- The three access modes ---------------- */
async function createGuestPass(v, net, delivery) {
  const gp = cfg.guestPass || {};
  if (!gp.wifiNetworkId) throw new Error("No guest pass network chosen. Pick one under RUCKUS One connection in the admin panel");
  // Guest API spec (docs.ruckus.cloud/api/guest-1.7.1, GuestUserV1): deliveryMethods enum is MAIL|SMS|WHATSAPP|STUB|PRINT.
  const names = { email: "MAIL", sms: "SMS", print: "PRINT", ...(gp.deliveryMethodNames || {}) };
  if (names.email === "EMAIL") names.email = "MAIL";   // older config.example.json value

  const expires = new Date(net.expiresAt);
  const minutes = Math.max(1, Math.round((expires - Date.now()) / 60000));
  const [duration, unit] = minutes % 60 === 0 ? [minutes / 60, "Hour"] : [minutes, "Minute"];

  const methods = [];
  if (delivery.email) methods.push(names.email);
  if (delivery.sms) methods.push(names.sms);
  if (!methods.length) methods.push(names.print);

  const body = {
    name: v.name,
    mobilePhoneNumber: e164(v.phone) || e164(gp.fallbackPhone) || v.phone || gp.fallbackPhone || "",
    email: v.email || undefined,
    maxDevices: net.devices || 1,
    deliveryMethods: methods,
    disabled: false,
    expiration: { activationType: "Creation", duration, unit },
    notes: [v.company && `Company: ${v.company}`, v.host && `Visiting: ${v.host}`, v.purpose && `Reason: ${v.purpose}`]
      .filter(Boolean).join("; ").slice(0, 180)
  };
  // The API reference lists these as query parameters as well as body fields, so both are sent.
  const q = new URLSearchParams({
    "expiration.activationType": "Creation", "expiration.duration": duration,
    "expiration.unit": unit, maxDevices: body.maxDevices
  });
  const data = await r1("POST", `/wifiNetworks/${gp.wifiNetworkId}/guestUsers?${q}`, body);
  const u = data.response || data;
  if (!u.password) throw new Error("RUCKUS One created the guest user but returned no password");
  return {
    ssid: u.ssid || net.ssid,
    password: u.password,
    expiresAt: u.expirationDate ? new Date(u.expirationDate).toISOString() : expires.toISOString(),
    ruckusId: u.id,
    delivered: { email: delivery.email, sms: delivery.sms }
  };
}

// RUCKUS One wants phone numbers in E.164 form (+18135551234). Numbers without a country code get
// dpsk.phoneCountryCode (default 1). Anything that can't be made valid is left off.
function e164(phone, cc = String(cfg.dpsk?.phoneCountryCode || "1")) {
  if (!phone) return undefined;
  const plus = phone.trim().startsWith("+"), digits = phone.replace(/\D/g, "");
  if (plus) return digits.length >= 8 && digits.length <= 15 ? "+" + digits : undefined;
  if (cc === "1") {
    if (digits.length === 10) return "+1" + digits;
    if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
    return undefined;
  }
  const local = digits.replace(/^0/, "");
  return local.length >= 6 && (cc + local).length <= 15 ? "+" + cc + local : undefined;
}

// DPSK behavior, confirmed live (DwellLink's lib/ruckus/dpsk.js and this kiosk):
// - create and PATCH return 202 and are processed in the background, so errors don't come back on the request.
// - sending username/email/phone on create 500s.
// - numberOfDevices can't be lowered by a later PATCH, so it (and the expiry) go on the create.
// So: create with passphrase + device limit + expiry, find the record and check both stuck, then PATCH the
// visitor's details. If the limit or expiry is missing, the passphrase is deleted.
// Whether the DPSK service sends its own email/SMS when a passphrase is created or updated.
// If it does, the kiosk doesn't ask for another one (the visitor would get two). Cached for 10 minutes.
const poolInfo = new Map();
async function dpskPool(poolId) {   // the DPSK service's settings, cached for 10 minutes
  const hit = poolInfo.get(poolId);
  if (hit && Date.now() - hit.at < 600e3) return hit.pool;
  const pool = await r1("GET", `/dpskServices/${encodeURIComponent(poolId)}`);
  poolInfo.set(poolId, { pool, at: Date.now() });
  return pool;
}
async function poolAutoNotifies(poolId) { return (await dpskPool(poolId)).autoNotificationsEnabled === true; }

// DPSK passwords follow the DPSK service's own passphrase settings in RUCKUS One, like DwellLink does
// (passphraseFormat / passphraseLength / wordCount / numericSuffixEnabled; field names confirmed live 2026-10-01).
// The kiosk's own style is only used when the service has no format set. RUCKUS One allows 8 to 63 characters.
const RANDOM_SETS = { NUMBERS_ONLY: "0123456789", KEYBOARD_FRIENDLY: "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789",
  MOST_SECURED: "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+" };
function poolRule(pool) {
  const format = pool?.passphraseFormat;
  if (!format) return null;
  return { format, length: Math.max(8, Math.min(63, Number.isFinite(pool.passphraseLength) ? pool.passphraseLength : 12)),
    wordCount: Number.isFinite(pool.wordCount) ? Math.max(3, Math.min(6, pool.wordCount)) : 4, suffix: pool.numericSuffixEnabled === true };
}
function passwordFromRule(r) {
  const pick = set => set[crypto.randomInt(set.length)];
  if (r.format === "DICTIONARY_WORDS") {
    let out = Array.from({ length: r.wordCount }, () => WORDS[crypto.randomInt(WORDS.length)]).join("-");
    if (r.suffix) out += Array.from({ length: 3 }, () => pick("0123456789")).join("");
    while (out.length < 8) out += pick("0123456789");
    return out;
  }
  return Array.from({ length: r.length }, () => pick(RANDOM_SETS[r.format] || RANDOM_SETS.KEYBOARD_FRIENDLY)).join("");
}
// How many different passwords a rule can make (shown in the admin panel; < 1e12 is called weak).
function ruleStrength(r) {
  if (!r) return null;
  const n = r.format === "DICTIONARY_WORDS" ? WORDS.length ** r.wordCount * (r.suffix ? 1000 : 1)
    : (RANDOM_SETS[r.format] || RANDOM_SETS.KEYBOARD_FRIENDLY).length ** r.length;
  return { combinations: n, weak: n < 1e12 };
}
async function dpskPassword(poolId, codeStyle) {
  try { const r = poolRule(await dpskPool(poolId)); if (r) return passwordFromRule(r); }
  catch (e) { printError(`Couldn't read the DPSK service's passphrase settings (${e.message}); using the kiosk's own style.`); }
  return makePassword(codeStyle, 8);
}

// Email/SMS the visitor their DPSK password through RUCKUS One (POST .../passphrases/notifications, schema
// DpskPassphraseNotificationDto in the DPSK API docs). The contact details go on in a background PATCH,
// so wait until RUCKUS One shows them before asking it to send.
async function sendDpskNotice(base, poolId, id, want) {
  const none = { email: false, sms: false };
  if (!want.email && !want.sms) return none;
  let rec = null;
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, i ? 1000 : 400));
    rec = await r1("GET", `${base}/${encodeURIComponent(id)}`).catch(() => null);
    if ((!want.email || rec?.email) && (!want.sms || rec?.phoneNumber)) break;
  }
  const can = { email: want.email && !!rec?.email, sms: want.sms && !!rec?.phoneNumber };
  if (want.email && !can.email) console.error(`DPSK passphrase ${id}: email address didn't show up in RUCKUS One, so no email was sent.`);
  if (want.sms && !can.sms) console.error(`DPSK passphrase ${id}: phone number didn't show up in RUCKUS One, so no text was sent.`);
  if (!can.email && !can.sms) return none;
  try {
    if (await poolAutoNotifies(poolId)) return can;   // RUCKUS One already sent it when the details were added
    await r1("POST", `${base}/notifications`, { ids: [id], shouldSendEmail: can.email, shouldSendSms: can.sms });
    return can;
  } catch (e) {
    console.error(`Couldn't send the DPSK password by email/text: ${e.message}`);
    return none;
  }
}

async function createDpsk(v, net, delivery = {}) {
  const d = cfg.dpsk || {};
  if (!d.poolId) throw new Error("No DPSK service chosen. Pick one under RUCKUS One connection in the admin panel");
  const base = `/dpskServices/${encodeURIComponent(d.poolId)}/passphrases`;
  const password = await dpskPassword(d.poolId, net.codeStyle);
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 12);
  const slug = v.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  const expiration = d.expirationFormat === "date" ? net.expiresAt.slice(0, 10) : net.expiresAt;
  const devices = net.devices || 1;
  // The body is a plain array of passphrase ids (DPSK API deletePassphrases; {ids} is refused as malformed, live 2026-10-01).
  const remove = id => r1("DELETE", base, [id]).catch(e => console.error(`Couldn't delete DPSK passphrase ${id}: ${e.message}`));

  await r1("POST", base, { passphrase: password, numberOfDevices: devices, expirationDate: expiration });
  let rec = null;
  for (let i = 0; i < 8 && !rec; i++) {
    await new Promise(r => setTimeout(r, i ? 1000 : 500));
    rec = listOf(await r1("GET", `${base}?page=0&pageSize=50`)).find(x => x.passphrase === password);
  }
  if (!rec?.id) throw new Error("RUCKUS One accepted the password but it didn't show up in the DPSK service in time");
  if (rec.numberOfDevices !== devices || !(rec.expirationDate || rec.expiration)) {
    console.error(`DPSK passphrase ${rec.id} came back without the device limit or expiry: ${JSON.stringify({ numberOfDevices: rec.numberOfDevices, expirationDate: rec.expirationDate, expiration: rec.expiration })}`);
    await remove(rec.id);
    throw new Error("RUCKUS One didn't apply the device limit or expiry, so the password was removed");
  }

  // Visitor details are nice to have: if RUCKUS One rejects them (in the background), the pass still works.
  const phoneNumber = e164(v.phone);
  if (v.phone && !phoneNumber) console.log(`Phone number "${v.phone}" isn't a valid international number; not sent to RUCKUS One.`);
  const username = `${slug || "visitor"}-${stamp}`;
  const patched = await r1("PATCH", `${base}/${encodeURIComponent(rec.id)}`, {
    username, email: v.email || undefined, phoneNumber
  }).then(() => true, e => { console.error(`Couldn't add visitor details to DPSK passphrase ${rec.id}: ${e.message}`); return false; });

  const delivered = patched
    ? await sendDpskNotice(base, d.poolId, rec.id, { email: !!(delivery.email && v.email), sms: !!(delivery.sms && phoneNumber) })
    : { email: false, sms: false };
  return { ssid: net.ssid, password, expiresAt: net.expiresAt, ruckusId: rec.id, ruckusUsername: username, delivered,
    identityId: rec.identityId || undefined, identityGroupId: rec.identityGroupId || undefined };
}

// When the chosen RUCKUS One network is a shared-password (psk) network, its password and SSID are read from
// RUCKUS One (GET /wifiNetworks/{id}: wlan.passphrase for WPA2, wlan.saePassphrase for WPA3; confirmed live).
// Cached for 5 minutes, so a password change in RUCKUS One reaches the kiosk quickly.
let pskCache = null;
async function ruckusPsk() {
  const id = cfg.guestPass?.wifiNetworkId;
  if (!id || !R1.clientSecret) return null;
  if (pskCache && pskCache.id === id && Date.now() - pskCache.at < 300e3) return pskCache.value;
  const n = await r1("GET", `/wifiNetworks/${encodeURIComponent(id)}`);
  const value = String(n.type || "").toLowerCase() === "psk"
    ? { ssid: n.wlan?.ssid, password: n.wlan?.passphrase || n.wlan?.saePassphrase } : null;
  pskCache = { id, value, at: Date.now() };
  return value;
}

async function sharedPsk(net) {
  let fromRuckus = null;
  try { fromRuckus = await ruckusPsk(); }
  catch (e) {
    // Fall back to the last password read, then to one saved in the admin panel.
    console.error(`Couldn't read the Wi-Fi password from RUCKUS One: ${e.message}`);
    fromRuckus = pskCache?.value || null;
  }
  const password = fromRuckus?.password || cfg.psk?.password || net.sharedPassword;
  if (!password) throw new Error("No shared Wi-Fi password. Choose a password network under RUCKUS One connection, or save one under Wi-Fi access type");
  return { ssid: fromRuckus?.ssid || net.ssid, password, expiresAt: net.expiresAt, delivered: { email: false, sms: false } };
}

/* ---------------- Host alerts: email (SMTP), text (Twilio), Slack/Teams webhook ---------------- */
// Hosts live in config.json as { name, email, phone }. The kiosk only ever gets the names.
const hostList = () => Array.isArray(cfg.hosts) ? cfg.hosts : [];
const findHost = name => hostList().find(h => h.name.trim().toLowerCase() === String(name || "").trim().toLowerCase());

// Minimal SMTP client (no npm packages). Works with Microsoft 365 and Gmail (port 587, STARTTLS),
// port 465 (TLS from the start), and plain servers on the local network.
function smtpSend(o, { to, subject, text }) {
  return new Promise((resolve, reject) => {
    const port = Number(o.port) || 587, secure = o.security || (port === 465 ? "tls" : "starttls");
    let sock, buf = "", waiting = null, done = false;
    const fail = e => { if (done) return; done = true; try { sock.destroy(); } catch {} reject(e); };
    const attach = s => {
      s.setEncoding("utf8"); s.setTimeout(20000, () => fail(new Error("The mail server stopped answering")));
      s.on("data", d => { buf += d; pump(); }); s.on("error", e => fail(new Error(`Mail server: ${e.message}`)));
    };
    // A reply is complete at a line like "250 ok" (a dash, "250-", means more lines follow).
    const pump = () => {
      const m = buf.match(/(?:^|\r\n)(\d{3}) [^\r\n]*\r\n/);
      if (!m || !waiting) return;
      const end = buf.indexOf(m[0]) + m[0].length, reply = buf.slice(0, end);
      buf = buf.slice(end);
      const w = waiting; waiting = null; w({ code: Number(m[1]), text: reply.trim() });
    };
    const read = () => new Promise(r => { waiting = r; pump(); });
    const cmd = async (line, ok) => {
      if (line !== null) sock.write(line + "\r\n");
      const r = await read();
      if (!ok.includes(r.code)) throw new Error(`Mail server said: ${r.text.split("\r\n").pop()}`);
      return r;
    };
    const addr = a => (String(a).match(/<([^>]+)>/) || [, a])[1].trim();
    const b64 = t => Buffer.from(t, "utf8").toString("base64");
    const run = async () => {
      await cmd(null, [220]);
      await cmd("EHLO visitor-kiosk", [250]);
      if (secure === "starttls") {
        await cmd("STARTTLS", [220]);
        sock.removeAllListeners("data"); sock.removeAllListeners("error"); sock.setTimeout(0);
        sock = tls.connect({ socket: sock, servername: o.host });
        attach(sock);
        await new Promise((r, j) => { sock.once("secureConnect", r); sock.once("error", j); });
        await cmd("EHLO visitor-kiosk", [250]);
      }
      if (o.user) {
        await cmd("AUTH LOGIN", [334]);
        await cmd(b64(o.user), [334]);
        await cmd(b64(o.pass || ""), [235]).catch(() => { throw new Error("The mail server didn't accept the username or password"); });
      }
      await cmd(`MAIL FROM:<${addr(o.from)}>`, [250]);
      await cmd(`RCPT TO:<${addr(to)}>`, [250, 251]);
      await cmd("DATA", [354]);
      const body = b64(text).replace(/.{76}/g, "$&\r\n");
      const msg = [
        `From: ${o.from}`, `To: ${to}`, `Subject: =?UTF-8?B?${b64(subject)}?=`, `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${crypto.randomUUID()}@visitor-kiosk>`, "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", body
      ].join("\r\n");
      await cmd(msg + "\r\n.", [250]);
      sock.write("QUIT\r\n"); done = true; sock.end(); resolve();
    };
    sock = secure === "tls" ? tls.connect({ host: o.host, port, servername: o.host }) : net.connect({ host: o.host, port });
    attach(sock);
    sock.once(secure === "tls" ? "secureConnect" : "connect", () => run().catch(fail));
  });
}

async function sendEmail(to, subject, text) {
  const m = cfg.notifications?.email || {};
  if (!m.host || !m.from) throw new Error("Email sending isn't set up");
  await smtpSend(m, { to, subject, text });
}

async function sendText(to, body) {
  const t = cfg.notifications?.sms || {};
  const missing = [!t.accountSid && "Account SID", !t.authToken && "auth token", !t.from && "Twilio phone number"].filter(Boolean);
  if (missing.length) throw new Error(`Text messages need the ${missing.join(", ").replace(/, ([^,]*)$/, " and $1")}`);
  const num = e164(to);
  if (!num) throw new Error(`"${to}" isn't a mobile number with area code`);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(t.accountSid)}/Messages.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${t.accountSid}:${t.authToken}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded" },
    // "From" can be a Twilio number or a Messaging Service SID (MG…).
    body: new URLSearchParams({ To: num, Body: body,
      ...(/^MG[0-9a-f]{32}$/i.test(t.from.trim()) ? { MessagingServiceSid: t.from.trim() } : { From: e164(t.from) || t.from }) })
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Twilio: ${j.message || res.status}`);
}

// Returns true if at least one alert went out.
async function notifyHost(v, location, onWayUrl) {
  if (!v.host) return false;
  const who = `${v.name}${v.company ? ` from ${v.company}` : ""}`;
  const where = location ? ` at ${location}` : "";
  const why = v.purpose ? ` (${v.purpose})` : "";
  const h = findHost(v.host), sent = [];
  const jobs = [];
  if (h?.email && cfg.notifications?.email?.host)
    jobs.push(sendEmail(h.email, `Your visitor is here: ${v.name}`,
      `Hi ${h.name.split(/\s+/)[0]},\n\n${who} is here to see you${where}${why}.\nThey checked in at ${new Date(v.checkedInAt || Date.now()).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.${onWayUrl ? `\n\nOn your way? Let them know: ${onWayUrl}` : ""}\n\nSent by Visitor Desk.`)
      .then(() => sent.push("email"), e => console.error(`Host email to ${h.name} failed: ${e.message}`)));
  if (h?.phone && cfg.notifications?.sms?.accountSid)
    jobs.push(sendText(h.phone, `${who} is here to see you${where}${why}.${onWayUrl ? ` On your way? ${onWayUrl}` : ""}`)
      .then(() => sent.push("text"), e => console.error(`Host text to ${h.name} failed: ${e.message}`)));
  const hook = cfg.notifications?.hostWebhookUrl;
  if (hook)
    jobs.push(fetch(hook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `${who} has arrived to see ${v.host}${where}${why}.` }) })
      .then(r => r.ok ? sent.push("webhook") : console.error(`Host webhook failed (${r.status})`), e => console.error(`Host webhook failed: ${e.message}`)));
  if (!h && !hook) console.log(`No contact details for host "${v.host}", so they weren't told.`);
  await Promise.all(jobs);
  return sent.length > 0;
}

/* ---------------- Visitor records ---------------- */
function saveVisit(v, result, mode, retentionDays) {
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}_${crypto.randomBytes(3).toString("hex")}`;
  const dir = path.join(DATA_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const writeImg = (dataUrl, name) => {
    if (!dataUrl || !dataUrl.startsWith("data:image/")) return null;
    fs.writeFileSync(path.join(dir, name), Buffer.from(dataUrl.split(",")[1], "base64"));
    return name;
  };
  const record = {
    id, mode,
    name: v.name, email: v.email, phone: v.phone, company: v.company, host: v.host, purpose: v.purpose,
    extra: cleanExtra(v.extra),
    consented: v.consented, checkedInAt: v.checkedInAt || new Date().toISOString(),
    // From the license barcode, scanned on the tablet. Only these fields are kept (never birth date, address or number).
    license: v.license && typeof v.license === "object" ? {
      first: String(v.license.first || "").slice(0, 60), last: String(v.license.last || "").slice(0, 60),
      state: String(v.license.state || "").slice(0, 2), country: String(v.license.country || "").slice(0, 3),
      expires: /^\d{4}-\d{2}-\d{2}$/.test(v.license.expires) ? v.license.expires : null,
      expired: v.license.expired === true, nameMatches: v.license.nameMatches === true
    } : null,
    ssid: result.ssid, passExpiresAt: result.expiresAt, ruckusId: result.ruckusId || null,
    wifiNetworkId: mode === "portal" ? cfg.guestPass?.wifiNetworkId || null : undefined,
    dpskPoolId: mode === "dpsk" ? cfg.dpsk?.poolId || null : undefined,
    status: result.blocked ? "blocked" : undefined,
    photo: writeImg(v.photo, "photo.jpg"),
    idImage: cfg.storage?.storeIdImages === false ? (v.idImage ? "checked, not stored" : null) : writeImg(v.idImage, "id.jpg"),
    ruckusUsername: result.ruckusUsername || undefined,
    // The RUCKUS One identity behind a DPSK passphrase (every passphrase has one; confirmed live 2026-10-08): blocking
    // it shows the visitor as Blocked under Clients > Identities.
    identityId: result.identityId, identityGroupId: result.identityGroupId,
    // RUCKUS One gives a guest pass code out only once, at creation, so it's kept here for reprinting / resending.
    // Removed when the pass expires or access is ended; never sent to the visitor records screen or the export.
    passCode: mode === "portal" ? result.password || undefined : undefined,
    // Typed at the kiosk (or printed on the badge) to check out.
    checkoutCode: result.blocked ? undefined : newCheckoutCode(),
    signature: typeof v.signature === "string" && v.signature.startsWith("data:image/png;base64,") ? writeImg(v.signature, "signature.png") : null,
    inviteId: v.inviteId || undefined, returningFrom: v.returningFrom || undefined, photoFrom: v.photoFrom || undefined,
    lang: /^[a-z]{2}$/.test(v.lang || "") && v.lang !== "en" ? v.lang : undefined,
    hostToken: v.hostToken || undefined, statusToken: v.statusToken || undefined
  };
  fs.writeFileSync(path.join(dir, "visit.json"), JSON.stringify(record, null, 2));
  return record;
}

// Answers to the extra questions an admin added on the tablet ("What visitors fill in"), kept with the label as the
// visitor saw it, since each tablet has its own list. Text only, limited in size.
function cleanExtra(x) {
  if (!Array.isArray(x)) return undefined;
  const out = x.slice(0, 20).filter(e => e && typeof e === "object")
    .map(e => ({ label: String(e.label ?? "").replace(/\s+/g, " ").trim().slice(0, 80), value: String(e.value ?? "").trim().slice(0, 1000) }))
    .filter(e => e.label && e.value);
  return out.length ? out : undefined;
}

const VISIT_ID = /^\d{4}-\d{2}-\d{2}T[\dTZ-]+_[0-9a-f]{6}$/;

// How long visits are kept (server settings, so "forever" is possible): records and their photos / license scans
// separately. 0 means keep forever; imageDays null means the same as records. Applied to every record by its age,
// so changing the setting also changes what happens to older records.
function retention() {
  const st = cfg.storage || {};
  const recordDays = Number.isFinite(st.recordDays) ? st.recordDays : Number.isFinite(st.retentionDays) ? st.retentionDays : 30;
  const imageDays = st.imageDays === null || st.imageDays === undefined ? recordDays : st.imageDays;
  return { recordDays, imageDays };
}
const ageDays = rec => (Date.now() - new Date(rec.checkedInAt || 0)) / 86400e3;
function deleteAfterOf(rec) {
  const { recordDays } = retention();
  return recordDays > 0 ? new Date(new Date(rec.checkedInAt || 0).getTime() + recordDays * 86400e3).toISOString() : null;
}
function cleanupOldVisits() {
  if (!fs.existsSync(DATA_DIR)) return;
  const { recordDays, imageDays } = retention();
  let removed = 0, images = 0;
  for (const name of fs.readdirSync(DATA_DIR)) {
    const dir = path.join(DATA_DIR, name), file = path.join(dir, "visit.json");
    try {
      const rec = JSON.parse(fs.readFileSync(file, "utf8")), age = ageDays(rec);
      if (recordDays > 0 && age > recordDays) { fs.rmSync(dir, { recursive: true, force: true }); removed++; continue; }
      if (rec.passCode && new Date(rec.passExpiresAt || 0) < new Date()) { delete rec.passCode; fs.writeFileSync(file, JSON.stringify(rec, null, 2)); }
      if (imageDays > 0 && age > imageDays && (rec.photo === "photo.jpg" || rec.idImage === "id.jpg")) {
        for (const f of ["photo.jpg", "id.jpg"]) fs.rmSync(path.join(dir, f), { force: true });
        if (rec.photo === "photo.jpg") rec.photo = "deleted";
        if (rec.idImage === "id.jpg") rec.idImage = "deleted";
        fs.writeFileSync(file, JSON.stringify(rec, null, 2)); images++;
      }
    } catch { /* skip unreadable folders */ }
  }
  if (removed) console.log(`Deleted ${removed} expired visitor record(s).`);
  if (images) console.log(`Deleted the photos and license scans of ${images} older visit(s).`);
}
function listVisits(limit = 100) {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs.readdirSync(DATA_DIR).sort().reverse().slice(0, limit).map(n => {
    try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, n, "visit.json"), "utf8")); } catch { return null; }
  }).filter(Boolean);
}

// Numbers for the top of the admin panel. The page sends where today, this week and this month start in its own
// time zone (ISO times); days in the 14-day chart are the page's local dates (tz = minutes from getTimezoneOffset).
function visitStats(q) {
  const iso = k => { const d = new Date(q.get(k) || ""); return isNaN(d) ? null : d.toISOString(); };
  const now = Date.now(), nowIso = new Date(now).toISOString();
  const today = iso("today") || new Date(now - 864e5).toISOString(), week = iso("week") || new Date(now - 7 * 864e5).toISOString();
  const month = iso("month") || new Date(now - 30 * 864e5).toISOString(), tz = Number(q.get("tz")) || 0;
  const all = listVisits(1e6), at = r => String(r.checkedInAt || "");
  const localDay = t => new Date(new Date(t).getTime() - tz * 60e3).toISOString().slice(0, 10);
  const inMonth = all.filter(r => at(r) >= month);
  const count = since => { const l = all.filter(r => at(r) >= since && r.status !== "blocked"); return { total: l.length, byMode: tally(l.map(r => r.mode), 5) }; };
  function tally(values, n) {
    const m = new Map();
    for (const v of values) { const k = String(v || "").trim(); if (k) m.set(k, (m.get(k) || 0) + 1); }
    return [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));
  }
  const active = all.filter(r => r.status !== "blocked" && !r.revokedAt && String(r.passExpiresAt || "") > nowIso);
  // Visitors this month who had also checked in before (same email, phone or name).
  const key = r => String(r.email || r.phone || r.name || "").trim().toLowerCase();
  const earlier = new Set(all.filter(r => at(r) < month).map(key));
  const days = new Map();
  for (let i = 13; i >= 0; i--) days.set(localDay(now - i * 864e5), 0);
  for (const r of all) { const d = r.checkedInAt && localDay(r.checkedInAt); if (d && days.has(d) && r.status !== "blocked") days.set(d, days.get(d) + 1); }
  const hours = Array(24).fill(0);
  for (const r of inMonth) if (r.status !== "blocked") hours[new Date(new Date(r.checkedInAt).getTime() - tz * 60e3).getUTCHours()]++;
  let devices = 0, online = 0;
  for (const r of active) for (const d of Object.values(readDevices(r.id))) { devices++; if (onlineNow(d)) online++; }
  const tablets = kiosks();
  return {
    checkIns: { today: count(today), week: count(week), month: count(month), kept: all.length },
    onSite: all.filter(r => onSite(r)).length, probablyLeft: all.filter(r => probablyLeft(r)).length,
    invitesToday: readInvites().filter(i => inviteOpen(i, localDay(now))).length,
    activePasses: { total: active.length, byMode: tally(active.map(r => r.mode), 5), endingSoon: active.filter(r => new Date(r.passExpiresAt) - now < 3600e3).length },
    devices: { online, onActivePasses: devices, tracking: TRACK_STATUS() },
    month: {
      hosts: tally(inMonth.filter(r => r.status !== "blocked").map(r => r.host), 5),
      companies: tally(inMonth.filter(r => r.status !== "blocked").map(r => r.company), 5),
      purposes: tally(inMonth.filter(r => r.status !== "blocked").map(r => r.purpose), 5),
      returning: new Set(inMonth.filter(r => r.status !== "blocked" && earlier.has(key(r))).map(key)).size,
      blocked: inMonth.filter(r => r.status === "blocked").length,
      ended: inMonth.filter(r => r.revokedAt).length,
      busiestHour: hours.some(Boolean) ? hours.indexOf(Math.max(...hours)) : null
    },
    days: [...days].map(([day, count]) => ({ day, count })),
    lastCheckIn: all.filter(r => r.status !== "blocked").map(r => String(r.checkedInAt || "")).sort().pop() || null,
    tablets: { paired: tablets.length, lastSeen: tablets.map(k => k.lastSeen).filter(Boolean).sort().pop() || null },
    problems24h: loadProblems().filter(x => now - new Date(x.at) < 864e5).length
  };
}

/* ---------------- HTTPS (so tablet cameras work) ---------------- */
// Browsers only allow the camera on https:// (or localhost). The server makes its own small certificate
// authority (CA) with openssl, and a certificate for this computer's addresses signed by it. The tablet
// installs and trusts the CA once, from /setup. The CA is name-constrained to local names and private IPs,
// so a tablet that trusts it can't be fooled about any real website. The CA key never leaves this computer.
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list || []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
  return out;
}
function certNames() {
  const host = os.hostname().replace(/\.local$/i, "").replace(/[^A-Za-z0-9-]/g, "-");
  return { dns: ["localhost", `${host}.local`], ips: ["127.0.0.1", ...lanAddresses()] };
}
function openssl(args, cwd) { execFileSync("openssl", args, { cwd, stdio: ["ignore", "ignore", "pipe"] }); }
function ensureCerts() {
  fs.mkdirSync(CERT_DIR, { recursive: true, mode: 0o700 });
  const f = n => path.join(CERT_DIR, n);
  // Renamed to Visitor Desk (1.6.1): a CA from before is replaced once (no tablet trusted the old one yet).
  if (fs.existsSync(f("ca.crt")) && /^Visitor Kiosk CA/.test(caName())) {
    for (const n of ["ca.crt", "ca.key", "ca.srl", "server.crt", "server.key", "server.json"]) fs.rmSync(f(n), { force: true });
    console.log("Replacing the old \"Visitor Kiosk CA\" with a \"Visitor Desk CA\". Install the new one on tablets from /setup.");
  }
  const tmp = (name, text) => { fs.writeFileSync(f(name), text); return name; };
  if (!fs.existsSync(f("ca.crt")) || !fs.existsSync(f("ca.key"))) {
    const cn = `Visitor Desk CA (${os.hostname()}) ${new Date().toISOString().slice(0, 10)}`;
    tmp("ca.cnf", `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=${cn}\nO=Visitor Desk\n[ext]
basicConstraints=critical,CA:TRUE,pathlen:0
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
nameConstraints=critical,permitted;DNS:localhost,permitted;DNS:local,permitted;IP:127.0.0.0/255.0.0.0,permitted;IP:10.0.0.0/255.0.0.0,permitted;IP:172.16.0.0/255.240.0.0,permitted;IP:192.168.0.0/255.255.0.0,permitted;IP:169.254.0.0/255.255.0.0\n`);
    openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "3650", "-keyout", "ca.key", "-out", "ca.crt", "-config", "ca.cnf"], CERT_DIR);
    fs.rmSync(f("server.crt"), { force: true });
    console.log("Created a certificate authority for the kiosk (certs/ca.crt). Install it on the tablet from /setup.");
  }
  // A new server certificate when the addresses change or it's within 30 days of expiring.
  // Apple devices reject server certificates valid for more than 825 days.
  const want = certNames(), metaFile = f("server.json");
  const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, "utf8")) : {};
  const covered = [...want.dns, ...want.ips].every(n => [...(meta.dns || []), ...(meta.ips || [])].includes(n));
  if (!fs.existsSync(f("server.crt")) || !covered || Date.now() > (meta.expires || 0) - 30 * 86400e3) {
    const san = [...want.dns.map(d => `DNS:${d}`), ...want.ips.map(i => `IP:${i}`)].join(",");
    tmp("server.cnf", `[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=${want.dns[1]}\n[ext]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=${san}\n`);
    openssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-config", "server.cnf"], CERT_DIR);
    openssl(["x509", "-req", "-sha256", "-days", "825", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial",
      "-out", "server.crt", "-extfile", "server.cnf", "-extensions", "ext"], CERT_DIR);
    fs.writeFileSync(metaFile, JSON.stringify({ ...want, expires: Date.now() + 825 * 86400e3 }, null, 2));
    for (const n of ["server.csr", "server.cnf", "ca.cnf", "ca.srl"]) fs.rmSync(f(n), { force: true });
    console.log(`Created an HTTPS certificate for ${[...want.dns, ...want.ips].join(", ")}.`);
  }
  for (const n of ["ca.key", "server.key"]) fs.chmodSync(f(n), 0o600);
  return { key: fs.readFileSync(f("server.key")), cert: fs.readFileSync(f("server.crt")) };
}
let HTTPS_PORT = 0;   // set once the HTTPS server is listening

const esc = t => String(t ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// The name tablets see under Certificate Trust Settings: "Visitor Desk CA (<host>) <date>".
function caName() {
  try { return new crypto.X509Certificate(fs.readFileSync(path.join(CERT_DIR, "ca.crt"))).subject.match(/CN=([^\n]+)/)[1]; }
  catch { return "Visitor Desk CA"; }
}
function setupPage(req) {
  const host = (req.headers.host || "").replace(/:\d+$/, "");
  const kiosk = HTTPS_PORT ? `https://${host}:${HTTPS_PORT}/` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Visitor Desk: tablet setup</title><style>
:root{--bg:#f4f4f4;--card:#fff;--ink:#231f20;--muted:#5d5a5b;--brand:#f47920}
@media (prefers-color-scheme:dark){:root{--bg:#121111;--card:#1d1b1c;--ink:#f1efef;--muted:#b0acad}}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:40rem;margin:0 auto;padding:1.5rem 1rem 3rem}h1{font-size:1.9rem;margin:.5rem 0}
section{background:var(--card);border-radius:14px;padding:1.1rem 1.25rem;margin:1rem 0}h2{font-size:1.15rem;margin:0 0 .5rem}
ol{padding-left:1.25rem;margin:.25rem 0}li{margin:.3rem 0}p{color:var(--muted)}
a.btn{display:inline-block;background:var(--brand);color:#1a1718;font-weight:700;text-decoration:none;padding:.8rem 1.2rem;border-radius:10px;margin:.25rem 0}
code{font-size:.95em;word-break:break-all}</style></head><body><main>
<h1>Set up the kiosk tablet</h1>
<p>The camera only works when the kiosk opens over a secure (https) connection. Do this once on each tablet.</p>
<section><h2>1. Download the kiosk certificate</h2>
<a class="btn" href="/ca.crt">Download certificate</a>
<p>It only works for this kiosk and other devices on your local network, not for websites.</p></section>
<section><h2>2a. iPad or iPhone</h2><ol>
<li>Open this page in <b>Safari</b> and tap <b>Download certificate</b>, then <b>Allow</b>.</li>
<li>Open <b>Settings</b>, tap <b>Profile Downloaded</b> near the top, then <b>Install</b> (twice).</li>
<li>Go to <b>Settings → General → About → Certificate Trust Settings</b> and turn on <b>${esc(caName())}</b>.</li></ol></section>
<section><h2>2b. Android</h2><ol>
<li>Tap <b>Download certificate</b>.</li>
<li>Open <b>Settings → Security → More security settings → Encryption &amp; credentials → Install a certificate → CA certificate</b>
(names vary by phone), then pick the downloaded file.</li></ol></section>
<section><h2>3. Open the kiosk</h2>
${kiosk ? `<a class="btn" href="${kiosk}">Open the kiosk</a><p>Bookmark or add <code>${kiosk}</code> to the home screen.</p>`
  : `<p>HTTPS isn't running on the kiosk server. Check the server window for the reason.</p>`}</section>
</main></body></html>`;
}

/* ---------------- HTTP server ---------------- */
// Security headers on every response. Pages get their own Content-Security-Policy (see kioskPage).
function secHeaders(res, extra = {}) {
  const h = { "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(self), microphone=(), geolocation=(), payment=()",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", ...extra };
  if (res.req?.socket?.encrypted) h["Strict-Transport-Security"] = "max-age=31536000";
  return h;
}
function send(res, status, body, type = "application/json", headers = {}) {
  res.writeHead(status, secHeaders(res, { "Content-Type": type, "Cache-Control": "no-store", ...headers }));
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}
// The kiosk page: scripts only run with this response's nonce (and the QR library is pinned by its hash).
function kioskPage(res) {
  const nonce = crypto.randomBytes(16).toString("base64");
  const html = fs.readFileSync(KIOSK_HTML, "utf8")
    .replace("</head>", `<script>window.KIOSK_BACKEND="/api/guest-pass";</script>\n</head>`)
    .replace(/<script(?=[\s>])/g, `<script nonce="${nonce}"`);
  send(res, 200, html, "text/html; charset=utf-8", { "Content-Security-Policy": [
    "default-src 'self'", `script-src 'nonce-${nonce}'`, "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com", "img-src 'self' data: blob:", "media-src 'self' blob:", "connect-src 'self'",
    "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join("; ") });
}
function readBody(req, limit = 15 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > limit) { reject(new Error("Request too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolve({});   // e.g. a POST with no body
      try { resolve(JSON.parse(text)); } catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}
function clientIp(req) { return (req.socket.remoteAddress || "").replace(/^::ffff:/, ""); }
function allowed(req) {
  const list = cfg.security?.allowedIps || [];
  const ip = clientIp(req);
  return !list.length || list.includes(ip) || ip === "127.0.0.1" || ip === "::1";
}

/* ---------------- Visitor devices: which devices used a pass, where they are, where they've been ---------------- */
// Every 2 minutes (while RUCKUS One is connected) the connected Wi-Fi clients are matched to visitors with an active
// pass: DPSK by the passphrase's username and its device list, guest passes by the guest user's MAC addresses.
// Shared-password devices can't be told apart, so they aren't tracked. Access point changes are written to the
// visit's devices.json, so a device's timeline is kept as long as the visit record (RUCKUS One keeps client events
// only a couple of days). When a device is first found, those recent events fill in its earlier moves.
// Client fields (POST /venues/aps/clients/query, 1-indexed pages), per-device event filter (entity_id) and the short
// event history were confirmed on the live tenant on 2026-10-01.
const devicesFile = id => path.join(DATA_DIR, id, "devices.json");
// mac -> device. Older files may have MACs in another form (e.g. "f244cd8432ee"): merge them under one key.
function readDevices(id) {
  let raw; try { raw = JSON.parse(fs.readFileSync(devicesFile(id), "utf8")); } catch { return {}; }
  const out = {};
  for (const d of Object.values(raw)) {
    const mac = normMac(d.mac), cur = out[mac];
    if (!cur) { out[mac] = { ...d, mac }; continue; }
    cur.timeline = [...cur.timeline, ...(d.timeline || [])].sort((a, b) => String(a.from).localeCompare(String(b.from)));
    for (const k of Object.keys(d)) if (cur[k] === undefined || cur[k] === null) cur[k] = d[k];
  }
  return out;
}
// A device's "online" flag is only trusted while tracking keeps seeing it: once a pass expires it stops being checked,
// so its last flag would otherwise stay "online" forever. Tracking runs every 2 minutes.
const onlineNow = d => !!d.online && Date.now() - new Date(d.lastSeen || 0) < 10 * 60e3;
const writeDevices = (id, d) => fs.writeFileSync(devicesFile(id), JSON.stringify(d, null, 2));
// One form for every MAC: "f2:44:cd:84:32:ee". RUCKUS One writes them as "F2:44:CD:84:32:EE" (clients),
// "f244cd8432ee" (guest pass device list, seen live 2026-10-01) or with dashes.
const normMac = m => {
  const hex = String(m || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  return hex.length === 12 ? hex.match(/../g).join(":") : String(m || "").trim().toLowerCase();
};
// For the visitor records list ("On site now"): each device's name, whether it's connected, and which access point.
// Only for visits from the last month (older ones have no live devices). MAC addresses are left out.
function deviceBrief(r) {
  if (r.status === "blocked" || Date.now() - new Date(r.checkedInAt || 0) > 31 * 864e5) return undefined;
  const list = Object.values(readDevices(r.id));
  if (!list.length) return undefined;
  const fresh = onlineNow;
  return list.map(d => ({ name: devLabel(d), online: !!fresh(d), ap: fresh(d) ? d.current?.ap || "" : "", venue: fresh(d) ? d.current?.venue || "" : "",
    lastSeen: d.lastSeen || null })).sort((a, b) => b.online - a.online);
}
// A device name people recognise: its own name unless that's just the MAC address, else the model without the OS
// version ("Apple iPhone/iOS 26.6.2" → "Apple iPhone"), else its type.
const looksLikeMac = t => /^([0-9a-f]{2}[:-]?){5}[0-9a-f]{2}$/i.test(String(t || "").trim());
const devLabel = d => [d.hostname, String(d.model || "").split("/")[0].trim(), d.type, d.os].find(x => x && !looksLikeMac(x)) || "Device";
const connectedNow = r => (deviceBrief(r) || []).some(d => d.online);
const deviceSummary = id => Object.values(readDevices(id)).map(d => d.mac + (d.hostname || d.model ? ` (${d.hostname || d.model})` : "")).join("; ");
const TRACK = { running: false, lastRun: null, lastError: "", tracked: 0, online: 0, apNames: new Map(), apNamesAt: 0 };
const SEGMENT_GAP = 6 * 60e3;
const TRACK_STATUS = () => ({ connected: !!R1.clientSecret, lastRun: TRACK.lastRun, lastError: TRACK.lastError, tracked: TRACK.tracked, online: TRACK.online });   // not seen for longer than this: the next sighting starts a new stay

async function connectedClients() {
  const out = [];
  for (let page = 1; page <= 40; page++) {
    const d = await r1("POST", "/venues/aps/clients/query", { page, pageSize: 500 });
    const rows = listOf(d); out.push(...rows);
    if (rows.length < 500 || (d.totalCount && out.length >= d.totalCount)) break;
  }
  return out;
}
// Access point MAC -> name, for events (refreshed hourly).
async function apNames(maxAge = 3600e3) {
  if (TRACK.apNames.size && Date.now() - TRACK.apNamesAt < maxAge) return TRACK.apNames;
  const m = new Map();
  try {
    for (let page = 1; page <= 20; page++) {
      const rows = listOf(await r1("POST", "/venues/aps/query", { page, pageSize: 500 }));
      // Also where each AP is drawn on its venue's floor plan (floorPosition, confirmed live 2026-10-02: percent of the image).
      for (const a of rows) for (const mac of [a.apMac, a.macAddress]) if (mac) m.set(normMac(mac), { name: a.name, serial: a.serialNumber, venue: a.venueName,
        venueId: a.venueId, mac: normMac(a.macAddress || a.apMac), plan: a.floorPosition?.floorplanId || a.floorplanId || null,
        x: a.floorPosition?.xPercent, y: a.floorPosition?.yPercent });
      if (rows.length < 500) break;
    }
  } catch (e) { printError(`Couldn't list access points: ${e.message}`); }
  TRACK.apNames = m; TRACK.apNamesAt = Date.now(); return m;
}
// MAC addresses RUCKUS One links to a visitor's pass (also devices that aren't online right now).
async function passDevices(rec) {
  try {
    if (rec.mode === "dpsk") {
      const pool = rec.dpskPoolId || cfg.dpsk?.poolId;
      const d = await r1("GET", `/dpskServices/${encodeURIComponent(pool)}/passphrases/${encodeURIComponent(rec.ruckusId)}/devices`);
      return (Array.isArray(d) ? d : listOf(d)).map(x => ({ mac: normMac(x.mac || x.macAddress), lastSeen: x.lastConnectedTime || null })).filter(x => x.mac);
    }
    if (rec.mode === "portal") {
      const net = rec.wifiNetworkId || cfg.guestPass?.wifiNetworkId;
      const d = await r1("GET", `/wifiNetworks/${encodeURIComponent(net)}/guestUsers/${encodeURIComponent(rec.ruckusId)}`);
      return ((d.response || d).macAddresses || []).map(m => ({ mac: normMac(typeof m === "object" ? m.mac || m.macAddress : m), lastSeen: null })).filter(x => x.mac);
    }
  } catch (e) { if (!/\(404\)/.test(e.message)) printError(`Couldn't list the devices on ${rec.name}'s pass: ${e.message}`); }
  return [];
}
// RUCKUS One times come as ISO with Z (events, clients), "YYYY-MM-DD HH:MM:SS.mmm +0000" (session history) or epoch
// numbers. Anything without a zone is UTC.
function r1Time(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" || /^\d+$/.test(v)) { const n = Number(v); return new Date(n < 1e12 ? n * 1000 : n).toISOString(); }
  let t = String(v).trim().replace(" ", "T").replace(/\s*([+-]\d{2}):?(\d{2})$/, "$1:$2");
  if (!/(Z|[+-]\d{2}:\d{2})$/i.test(t)) t += "Z";
  const d = new Date(t); return isNaN(d) ? null : d.toISOString();
}
// Earlier moves from RUCKUS One's client events (connected / roamed / left), as closed stays.
async function eventStays(mac, since) {
  const names = await apNames(), stays = [];
  let events = [];
  try {
    events = listOf(await r1("POST", "/events/query", { page: 1, pageSize: 500, sortField: "event_datetime", sortOrder: "asc",
      fields: ["event_datetime", "entity_id", "macAddress", "apMac", "name", "message"], filters: { entity_type: ["CLIENT"], entity_id: [mac] } }));
  } catch (e) { printError(`Couldn't read RUCKUS One events for ${mac}: ${e.message}`); return []; }
  let open = null;
  for (const e of events) {
    const at = r1Time(e.event_datetime); if (!at) continue;
    if (since && at < since) continue;
    let t = ""; try { t = JSON.parse(e.message).message_template || ""; } catch { t = String(e.message || ""); }
    const ap = names.get(normMac(e.apMac));
    if (/connected/i.test(t) && !/disconnected/i.test(t)) {
      if (open) { open.to = at; stays.push(open); }
      open = { ap: ap?.name || e.apMac || "Unknown access point", apMac: normMac(e.apMac), venue: ap?.venue || "", from: at, to: at, source: "RUCKUS One events" };
    } else if (/left|disconnected/i.test(t) && open) { open.to = at; stays.push(open); open = null; }
  }
  if (open) stays.push({ ...open, ongoing: true });   // joined and never left: may still be there
  return stays;
}

async function trackDevices() {
  if (TRACK.running || !R1.clientSecret || !fs.existsSync(DATA_DIR)) return;
  TRACK.running = true;
  try {
    const now = new Date().toISOString(), soon = Date.now() - 3600e3;
    const active = listVisits(5000).filter(r => (r.mode === "dpsk" || r.mode === "portal") && r.ruckusId && !r.revokedAt
      && r.status !== "blocked" && new Date(r.passExpiresAt || 0).getTime() > soon);
    if (!active.length) { TRACK.tracked = TRACK.online = 0; TRACK.lastRun = now; TRACK.lastError = ""; return; }
    const clients = await connectedClients();
    const byMac = new Map(clients.map(c => [normMac(c.macAddress), c]));
    let tracked = 0, online = 0;
    for (const rec of active) {
      const devices = readDevices(rec.id);
      const known = await passDevices(rec);
      const macs = new Set([...Object.keys(devices), ...known.map(k => k.mac)]);
      if (rec.ruckusUsername) for (const c of clients) if (c.username === rec.ruckusUsername) macs.add(normMac(c.macAddress));
      for (const mac of macs) {
        const d = devices[mac] ||= { mac, firstSeen: null, timeline: [] }, c = byMac.get(mac);
        if (!d.backfilled && (c || known.some(k => k.mac === mac))) {   // first time: earlier moves from RUCKUS One
          d.backfilled = true;
          const earlier = await eventStays(mac, rec.checkedInAt);
          if (earlier.length) { d.timeline = [...earlier, ...d.timeline]; d.firstSeen ||= earlier[0].from; }
        }
        const k = known.find(x => x.mac === mac);
        if (k?.lastSeen && (!d.lastSeen || k.lastSeen > d.lastSeen)) d.lastSeen = k.lastSeen;
        if (!c) { d.online = false; for (const t of d.timeline) delete t.ongoing; continue; }
        online++;
        const ap = { ap: c.apInformation?.name || c.apInformation?.macAddress || "Unknown access point", apMac: normMac(c.apInformation?.macAddress),
          apSerial: c.apInformation?.serialNumber || "", venue: c.venueInformation?.name || "", ssid: c.networkInformation?.ssid || "" };
        Object.assign(d, { online: true, lastSeen: now, firstSeen: d.firstSeen || c.connectedTime || now,
          hostname: c.hostname || d.hostname, os: c.osType || d.os, model: c.modelName || d.model, type: c.deviceType || d.type,
          ip: c.ipAddress || d.ip, rssi: c.signalStatus?.rssi, connectedSince: c.connectedTime || d.connectedSince, current: ap });
        const last = d.timeline[d.timeline.length - 1];
        // Still on the access point RUCKUS One's history says it joined (no "left" event since): same stay.
        if (last?.ongoing && last.apMac === ap.apMac) last.to = now;
        for (const t of d.timeline) delete t.ongoing;
        if (last && last.apMac === ap.apMac && Date.now() - new Date(last.to) < SEGMENT_GAP) last.to = now;
        else d.timeline.push({ ...ap, from: now, to: now });
        if (d.timeline.length > 2000) d.timeline = d.timeline.slice(-2000);
      }
      for (const d of Object.values(devices)) if (!byMac.has(d.mac)) d.online = false;
      if (Object.keys(devices).length) { writeDevices(rec.id, devices); tracked += Object.keys(devices).length; }
    }
    Object.assign(TRACK, { tracked, online, lastRun: now, lastError: "" });
  } catch (e) {
    if (e.message !== TRACK.lastError) recordProblem("Device tracking", e.message);   // once per new error, not every 2 minutes
    TRACK.lastError = e.message; TRACK.lastRun = new Date().toISOString();
  } finally { TRACK.running = false; }
}

// Everything RUCKUS One knows about one device right now (Details button): its live connection, its recent
// connect / roam / leave events, and its finished sessions. Each part is fetched separately, so one failing
// doesn't hide the others. The clients query filters by MAC (confirmed live); session history ignores filters
// (confirmed live 2026-10-01), so it's read and filtered here.
async function deviceReport(mac) {
  const names = await apNames(), apName = m => names.get(normMac(m))?.name || m || "";
  const out = { mac, client: null, events: [], sessions: [], errors: {} };
  const part = async (key, fn) => { try { await fn(); } catch (e) { out.errors[key] = e.message; } };
  await Promise.all([
    part("client", async () => {
      const c = listOf(await r1("POST", "/venues/aps/clients/query", { page: 1, pageSize: 10, filters: { macAddress: [mac] } })).find(x => normMac(x.macAddress) === mac);
      if (c) out.client = {
        hostname: c.hostname, os: c.osType, model: c.modelName, type: c.deviceType, username: c.username, identity: c.identityName,
        ip: c.ipAddress, ipv6: c.ipv6Address, connectedSince: r1Time(c.connectedTime), updated: r1Time(c.lastUpdatedTime),
        ap: c.apInformation?.name, apSerial: c.apInformation?.serialNumber, apMac: c.apInformation?.macAddress, bssid: c.apInformation?.bssid,
        venue: c.venueInformation?.name, ssid: c.networkInformation?.ssid, vlan: c.networkInformation?.vlan,
        security: [c.networkInformation?.authenticationMethod, c.networkInformation?.encryptionMethod].filter(Boolean).join(" / "),
        band: c.band, channel: c.radioStatus?.channel, radio: c.radioStatus?.type,
        rssi: c.signalStatus?.rssi, snr: c.signalStatus?.snr, noise: c.signalStatus?.noiseFloor,
        health: c.signalStatus?.health, healthNote: c.signalStatus?.healthDescription,
        down: c.trafficStatus?.trafficToClient, up: c.trafficStatus?.trafficFromClient, dropped: c.trafficStatus?.framesDropped
      };
    }),
    part("events", async () => {
      const rows = listOf(await r1("POST", "/events/query", { page: 1, pageSize: 50, sortField: "event_datetime", sortOrder: "desc",
        fields: ["event_datetime", "apMac", "message"], filters: { entity_type: ["CLIENT"], entity_id: [mac] } }));
      out.events = rows.map(e => {
        let t = ""; try { t = JSON.parse(e.message).message_template || ""; } catch { t = String(e.message || ""); }
        const what = /another AP/i.test(t) ? "Moved to" : /lack of activity/i.test(t) ? "Disconnected (inactive)" : /disconnected/i.test(t) ? "Disconnected"
          : /left/i.test(t) ? "Left" : /connected/i.test(t) ? "Connected" : t.replace(/@@\w+|%%\w+/g, "").trim();
        return { at: r1Time(e.event_datetime), what, ap: apName(e.apMac) };
      });
    }),
    part("sessions", async () => {
      const F = ["clientMac", "hostname", "apMac", "ssid", "event_datetime", "disconnectTime", "rxBytes", "txBytes"];
      for (let page = 1; page <= 4; page++) {
        const rows = listOf(await r1("POST", "/historicalClients/query", { page, pageSize: 500, fields: F }));
        for (const r of rows) if (normMac(r.clientMac) === mac)
          out.sessions.push({ start: r1Time(r.event_datetime), end: r1Time(r.disconnectTime), ap: apName(r.apMac), ssid: r.ssid, down: r.txBytes, up: r.rxBytes });
        if (rows.length < 500) break;
      }
      out.sessions.sort((a, b) => String(b.start).localeCompare(String(a.start)));
      out.sessions = out.sessions.slice(0, 50);
    })
  ]);
  return out;
}

// Search across all visits: MAC, hostname, model, visitor name or company, or access point / venue name.
// Without a search: the visitor devices online right now.
function searchDevices(q) {
  q = String(q || "").trim().toLowerCase();
  const out = [];
  for (const rec of listVisits(1e6)) {
    if (!fs.existsSync(devicesFile(rec.id))) continue;
    for (const d of Object.values(readDevices(rec.id))) {
      const hit = q ? [d.mac, d.hostname, d.model, d.os, rec.name, rec.company, ...d.timeline.flatMap(t => [t.ap, t.venue])]
        .some(x => String(x || "").toLowerCase().includes(q)) : onlineNow(d);
      if (hit) out.push({ visit: { id: rec.id, name: rec.name, company: rec.company, host: rec.host, checkedInAt: rec.checkedInAt, mode: rec.mode }, device: { ...d, online: onlineNow(d) } });
      if (out.length >= 300) return out;
    }
  }
  return out;
}

/* ---------------- Floor plans: where visitors' devices are now ---------------- */
// Confirmed live (2026-10-02, and in RuckusNetworkMap): GET /venues/{v}/floorplans → [{id, name, floorNumber, imageId}];
// GET /venues/{v}/signurls/{imageId}/urls → {signedUrl} on storage.googleapis.com (PNG served as application/image).
// A device's spot is the access point it's connected to, not an exact position.
const FLOOR_DIR = path.join(ROOT, "data", "floorplans");
const planCache = new Map();   // venueId -> { at, plans }
async function venuePlans(venueId) {
  const c = planCache.get(venueId);
  if (c && Date.now() - c.at < 3600e3) return c.plans;
  const d = await r1("GET", `/venues/${encodeURIComponent(venueId)}/floorplans`);
  const plans = listOf(d).map(p => ({ id: p.id, name: p.name || "Floor", floorNumber: p.floorNumber, imageId: p.imageId }));
  planCache.set(venueId, { at: Date.now(), plans });
  return plans;
}
const IMAGE_TYPES = [["89504e47", "image/png"], ["ffd8ff", "image/jpeg"], ["47494638", "image/gif"], ["52494646", "image/webp"]];
async function floorImage(venueId, imageId) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(imageId)) throw Object.assign(new Error("Unknown floor plan image"), { status: 404 });
  const file = path.join(FLOOR_DIR, imageId + ".img");
  let buf = null; try { buf = fs.readFileSync(file); } catch {}
  if (!buf) {
    const { signedUrl } = await r1("GET", `/venues/${encodeURIComponent(venueId)}/signurls/${encodeURIComponent(imageId)}/urls`);
    if (!signedUrl || new URL(signedUrl).host !== "storage.googleapis.com") throw new Error("RUCKUS One returned no floor plan image link");
    const res = await fetch(signedUrl);
    if (!res.ok) throw new Error(`Floor plan image download failed (${res.status})`);
    buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 15 * 1024 * 1024) throw new Error("Floor plan image is too large");
    fs.mkdirSync(FLOOR_DIR, { recursive: true }); fs.writeFileSync(file, buf);
  }
  // Only real raster images (never SVG, which can carry script). Storage serves them without a proper type.
  const type = IMAGE_TYPES.find(([magic]) => buf.slice(0, magic.length / 2).toString("hex") === magic)?.[1];
  if (!type) throw new Error("The floor plan isn't a PNG, JPEG, GIF or WebP image");
  return { buf, type };
}
// Every floor plan with its placed APs, and the visitors whose devices are connected to each AP right now.
async function floorMap() {
  const aps = await apNames(10 * 60e3), byPlan = new Map(), venues = new Map();
  for (const a of new Map([...aps.values()].map(a => [a.serial || a.mac, a])).values()) {
    if (!a.plan || !Number.isFinite(a.x) || !Number.isFinite(a.y)) continue;
    if (!byPlan.has(a.plan)) byPlan.set(a.plan, []);
    byPlan.get(a.plan).push({ serial: a.serial, mac: a.mac, name: a.name, x: a.x, y: a.y, people: [] });
    venues.set(a.venueId, a.venue);
  }
  const apAt = new Map(); for (const list of byPlan.values()) for (const a of list) apAt.set(a.mac, a);
  for (const r of listVisits(5000)) {
    if (r.status === "blocked" || Date.now() - new Date(r.checkedInAt || 0) > 31 * 864e5) continue;
    for (const d of Object.values(readDevices(r.id))) {
      const a = onlineNow(d) && apAt.get(normMac(d.current?.apMac));
      if (a) a.people.push({ visitId: r.id, name: r.name, company: r.company || "", device: devLabel(d), mac: d.mac });
    }
  }
  const floors = [];
  for (const [venueId, venueName] of venues) {
    for (const p of await venuePlans(venueId)) {
      const list = byPlan.get(p.id); if (!list) continue;
      floors.push({ venueId, venueName: venueName || "", plan: p, aps: list, people: list.reduce((n, a) => n + a.people.length, 0) });
    }
  }
  floors.sort((a, b) => b.people - a.people || String(a.venueName).localeCompare(String(b.venueName)) || (a.plan.floorNumber ?? 0) - (b.plan.floorNumber ?? 0));
  return { floors, tracking: TRACK_STATUS() };
}

/* ---------------- Shared look (same colors/logo/background on every kiosk) ---------------- */
let lookCache = { mtime: -1, value: null };
function readSharedLook() {
  try {
    const m = fs.statSync(LOOK_PATH).mtimeMs;
    if (m !== lookCache.mtime) lookCache = { mtime: m, value: JSON.parse(fs.readFileSync(LOOK_PATH, "utf8")) };
    return lookCache.value;
  } catch { return null; }
}
function cleanLook(b) {
  const l = b.look || {}, img = v => typeof v === "string" && /^data:image\/(png|jpeg|webp|gif);base64,/.test(v) ? v : "";
  const hex = v => /^#[0-9a-f]{6}$/i.test(v) ? v : undefined;
  return {
    theme: ["auto", "light", "dark"].includes(b.theme) ? b.theme : "auto",
    orgName: typeof b.orgName === "string" ? b.orgName.trim().slice(0, 80) : undefined,
    headline: typeof b.headline === "string" ? b.headline.trim().slice(0, 160) : undefined,
    look: { v: 2, palette: /^[a-z]{2,20}$/.test(l.palette) ? l.palette : "ruckus", brand: hex(l.brand), accent: hex(l.accent),
      logo: img(l.logo), logoPlate: l.logoPlate === true, logoSize: ["small", "medium", "large"].includes(l.logoSize) ? l.logoSize : "medium",
      background: img(l.background), bgFade: ["soft", "medium", "strong"].includes(l.bgFade) ? l.bgFade : "soft", poweredBy: l.poweredBy !== false,
      showName: l.showName === true }
  };
}

/* ---------------- Shared questions ("What visitors fill in" on every kiosk) ---------------- */
let questionsCache = { mtime: -1, value: null };
function readSharedQuestions() {
  try {
    const m = fs.statSync(QUESTIONS_PATH).mtimeMs;
    if (m !== questionsCache.mtime) questionsCache = { mtime: m, value: JSON.parse(fs.readFileSync(QUESTIONS_PATH, "utf8")) };
    return questionsCache.value;
  } catch { return null; }
}
// Only known settings, in the shapes the kiosk page uses (fields, custom, fieldOrder, hostMode, reasons).
const BUILTIN_FIELDS = ["name", "email", "phone", "company", "host", "purpose", "photo", "idScan", "signature"];
const CUSTOM_KEY = /^c_[a-z0-9]{4,12}$/, CUSTOM_TYPES = ["text", "longtext", "number", "date", "choice", "checkbox"];
function cleanQuestions(b = {}) {
  const str = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const custom = (Array.isArray(b.custom) ? b.custom : []).filter(c => c && CUSTOM_KEY.test(c.key) && CUSTOM_TYPES.includes(c.type) && str(c.label, 80))
    .slice(0, 20).map(c => ({ key: c.key, label: str(c.label, 80), type: c.type, step: c.step === "visit" ? "visit" : "you",
      choices: c.type === "choice" && Array.isArray(c.choices) ? [...new Set(c.choices.map(x => str(x, 80)).filter(Boolean))].slice(0, 30) : [] }))
    .filter(c => c.type !== "choice" || c.choices.length >= 2);
  const known = new Set([...BUILTIN_FIELDS, ...custom.map(c => c.key)]), fields = {};
  for (const [k, v] of Object.entries(b.fields && typeof b.fields === "object" ? b.fields : {}))
    if (known.has(k) && ["required", "optional", "hidden"].includes(v)) fields[k] = v;
  fields.name = "required";   // always asked
  return { fields, custom,
    fieldOrder: [...new Set((Array.isArray(b.fieldOrder) ? b.fieldOrder : []).filter(k => known.has(k)))],
    hostMode: b.hostMode === "list" ? "list" : "suggest",
    reasons: (Array.isArray(b.reasons) ? b.reasons : []).map(x => str(x, 80)).filter(Boolean).slice(0, 30) };
}

/* ---------------- Sign-in: named users, roles, optional 2FA ---------------- */
// Users live in config.json (security.users): { id, name, role, salt, hash, totp }. Passwords are 8-20 characters,
// stored as scrypt hashes. 2FA is TOTP (RFC 6238: 30-second steps, 6 digits, SHA-1), per user.
// Roles: "admin" can do everything; "reception" can only see visitor records, end a visitor's Wi-Fi access and
// block or unblock visitors. Signing in gives a random session token kept in memory (30 idle minutes, 12 hours max).
// Recovery: `node server.js reset-admin` removes the admin users (reception users stay); then create a new admin.
function isLocal(req) { const ip = clientIp(req); return ip === "127.0.0.1" || ip === "::1"; }
const PW_MIN = 8, PW_MAX = 20;
const pwProblem = pw => typeof pw !== "string" || pw.length < PW_MIN || pw.length > PW_MAX ? `The admin password needs ${PW_MIN} to ${PW_MAX} characters` : "";
const SCRYPT = { N: 16384, r: 8, p: 1 };
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return { salt: salt.toString("base64"), hash: crypto.scryptSync(pw, salt, 32, SCRYPT).toString("base64") };
}
function passwordMatches(a, pw) {
  if (!a?.hash || typeof pw !== "string" || pw.length > 64) return false;
  const got = crypto.scryptSync(pw, Buffer.from(a.salt, "base64"), 32, SCRYPT), want = Buffer.from(a.hash, "base64");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32(buf) {
  let bits = 0, val = 0, out = "";
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  return bits ? out + B32[(val << (5 - bits)) & 31] : out;
}
function unbase32(s) {
  let bits = 0, val = 0; const out = [];
  for (const c of s.toUpperCase()) { const i = B32.indexOf(c); if (i < 0) continue; val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function totp(secret, step) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac("sha1", unbase32(secret)).update(msg).digest(), o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, "0");
}
// The time step a code belongs to (one step either side allowed for clock drift), or -1.
function totpStep(secret, code) {
  code = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) return -1;
  const now = Math.floor(Date.now() / 30000);
  for (const d of [0, -1, 1]) if (crypto.timingSafeEqual(Buffer.from(totp(secret, now + d)), Buffer.from(code))) return now + d;
  return -1;
}
const ROLES = { admin: "Admin", reception: "Reception" };
const users = () => ((cfg.security ||= {}).users ||= []);
const userById = id => users().find(u => u.id === id);
const userByName = name => users().find(u => u.name.toLowerCase() === String(name || "").trim().toLowerCase());
const hasAdmin = () => users().some(u => u.role === "admin");
const nameProblem = n => /^[A-Za-z0-9._-]{2,32}$/.test(String(n || "")) ? "" : "User names are 2 to 32 letters, numbers, dots, dashes or underscores";
// Earlier versions had one admin password (security.admin) or an admin key; move them over.
function migrateUsers() {
  const sec = cfg.security || {};
  if (sec.admin?.hash && !users().length) { sec.users = [{ id: crypto.randomUUID(), name: "admin", role: "admin", ...sec.admin }]; delete sec.admin; saveConfig(); }
  if (sec.adminKey) { delete sec.adminKey; saveConfig(); }
}

const lastTotpStep = new Map();   // user id -> last step used, so a code can't be used twice
function useTotp(userId, secret, code) {
  const step = totpStep(secret, code);
  if (step < 0 || step <= (lastTotpStep.get(userId) ?? -1)) return false;
  lastTotpStep.set(userId, step); return true;
}

const sessions = new Map();   // token -> { userId, created, last, pending2fa }
const SESSION_IDLE = 30 * 60e3, SESSION_MAX = 12 * 3600e3;
function newSession(user) { const t = crypto.randomBytes(32).toString("base64url"); sessions.set(t, { userId: user.id, created: Date.now(), last: Date.now() }); return t; }
function sessionOf(req) {
  const t = String(req.headers.authorization || "").replace(/^Bearer /, "");
  const s = t && sessions.get(t), u = s && userById(s.userId);
  if (!s || !u) { if (s) sessions.delete(t); return null; }
  if (Date.now() - s.last > SESSION_IDLE || Date.now() - s.created > SESSION_MAX) { sessions.delete(t); return null; }
  s.last = Date.now(); s.token = t; s.user = u; return s;
}
const endSessionsOf = (userId, except) => { for (const [t, s] of sessions) if (s.userId === userId && t !== except) sessions.delete(t); };

// 5 wrong tries from one device locks it out for 5 minutes.
const failures = new Map();
function lockedOut(req) { const f = failures.get(clientIp(req)); return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 60000) : 0; }
function recordFailure(req) {
  const ip = clientIp(req), f = failures.get(ip) || { n: 0, until: 0 };
  f.n = f.until && f.until < Date.now() ? 1 : f.n + 1;
  if (f.n >= 5) { f.until = Date.now() + 5 * 60e3; f.n = 0; console.log(`Sign-in locked for 5 minutes for ${ip} after 5 wrong tries.`); }
  failures.set(ip, f);
}

// Before an admin exists: the kiosk computer itself can create one; another device also needs this code,
// printed in the server window (so nobody else on the network can claim the admin account first).
let SETUP_CODE = "";
function ensureSetupCode() {
  const file = path.join(ROOT, "setup-code.txt");
  if (hasAdmin()) { SETUP_CODE = ""; fs.rmSync(file, { force: true }); return; }
  if (!SETUP_CODE) SETUP_CODE = String(crypto.randomInt(10000000, 100000000)).replace(/(\d{4})(\d{4})/, "$1-$2");
  try { fs.writeFileSync(file, SETUP_CODE + "\n", { mode: 0o600 }); } catch {}
}

async function handleAuth(req, res, p) {
  if (req.method === "GET" && p === "/auth") {
    const s = sessionOf(req);
    return send(res, 200, { adminExists: hasAdmin(), local: isLocal(req), signedIn: !!s, min: PW_MIN, max: PW_MAX,
      user: s ? { name: s.user.name, role: s.user.role, twoFactor: !!s.user.totp } : null });
  }
  if (req.method === "POST" && p === "/setup") {
    if (hasAdmin()) return send(res, 409, { error: "An admin already exists. Sign in instead." });
    const b = await readBody(req, 4096);
    if (!isLocal(req)) {
      if (lockedOut(req)) return send(res, 429, { error: `Too many tries. Wait ${lockedOut(req)} minutes.` });
      if (String(b.setupCode || "").replace(/\D/g, "") !== SETUP_CODE.replace(/\D/g, "")) { recordFailure(req); return send(res, 401, { error: "That setup code isn't right. It's shown in the kiosk server's window, or on the VM console." }); }
    }
    const name = String(b.username || "admin").trim();
    const bad = nameProblem(name) || pwProblem(b.password) || (userByName(name) ? "That user name is taken" : "");
    if (bad) return send(res, 400, { error: bad });
    const u = { id: crypto.randomUUID(), name, role: "admin", ...hashPassword(b.password) };
    users().push(u); saveConfig(); ensureSetupCode();
    console.log(`Admin user "${name}" created.`); audit(req, name, "Created the first admin user");
    return send(res, 200, { token: newSession(u) });
  }
  if (req.method === "POST" && p === "/login") {
    const wait = lockedOut(req); if (wait) return send(res, 429, { error: `Too many wrong tries. Wait ${wait} minute${wait === 1 ? "" : "s"}.` });
    const b = await readBody(req, 4096), u = userByName(b.username);
    if (!u || !passwordMatches(u, b.password)) { recordFailure(req); audit(req, String(b.username || "").slice(0, 32), "Sign-in failed (wrong user name or password)"); return send(res, 401, { error: "That user name or password isn't right." }); }
    if (u.totp) {
      if (!b.code) return send(res, 401, { error: "Enter the 6-digit code from your authenticator app.", needCode: true });
      if (!useTotp(u.id, u.totp, b.code)) { recordFailure(req); audit(req, u.name, "Sign-in failed (wrong two-step code)"); return send(res, 401, { error: "That code isn't right, or it was already used. Wait for the next one.", needCode: true }); }
    }
    failures.delete(clientIp(req));
    console.log(`${ROLES[u.role]} "${u.name}" signed in from ${clientIp(req)}.`); audit(req, u.name, "Signed in", ROLES[u.role]);
    return send(res, 200, { token: newSession(u), role: u.role });
  }
  return null;
}

// Your own password and 2FA (any signed-in user), and managing users (admins).
async function handleAccount(req, res, p, session) {
  const me = session.user;
  if (req.method === "POST" && p === "/logout") { sessions.delete(session.token); return send(res, 200, { ok: true }); }
  if (req.method === "POST" && p === "/password") {
    const b = await readBody(req, 4096);
    if (!passwordMatches(me, b.current)) { recordFailure(req); return send(res, 401, { error: "The current password isn't right." }); }
    const bad = pwProblem(b.next); if (bad) return send(res, 400, { error: bad });
    Object.assign(me, hashPassword(b.next)); saveConfig(); endSessionsOf(me.id, session.token);
    console.log(`User "${me.name}" changed their password.`); audit(req, me.name, "Changed their password");
    return send(res, 200, { ok: true });
  }
  if (req.method === "POST" && p === "/2fa/start") {
    session.pending2fa = base32(crypto.randomBytes(20));
    const label = encodeURIComponent(`Visitor Desk (${os.hostname().replace(/\.local$/i, "")})`);
    return send(res, 200, { secret: session.pending2fa, uri: `otpauth://totp/${label}:${encodeURIComponent(me.name)}?secret=${session.pending2fa}&issuer=${encodeURIComponent("Visitor Desk")}&algorithm=SHA1&digits=6&period=30` });
  }
  if (req.method === "POST" && p === "/2fa/confirm") {
    const b = await readBody(req, 4096);
    if (!session.pending2fa) return send(res, 400, { error: "Start again: turn on two-step sign-in." });
    if (!useTotp(me.id, session.pending2fa, b.code)) return send(res, 400, { error: "That code isn't right. Check the phone's time is set automatically, and try the next code." });
    me.totp = session.pending2fa; delete session.pending2fa; saveConfig();
    console.log(`User "${me.name}" turned on two-step sign-in.`); audit(req, me.name, "Turned on two-step sign-in");
    return send(res, 200, { ok: true });
  }
  if (req.method === "POST" && p === "/2fa/disable") {
    const b = await readBody(req, 4096);
    if (!passwordMatches(me, b.password) || (me.totp && !useTotp(me.id, me.totp, b.code))) { recordFailure(req); return send(res, 401, { error: "The password or code isn't right." }); }
    delete me.totp; saveConfig();
    console.log(`User "${me.name}" turned off two-step sign-in.`); audit(req, me.name, "Turned off two-step sign-in");
    return send(res, 200, { ok: true });
  }

  const um = p.match(/^\/users(?:\/([0-9a-f-]{36}))?$/);
  if (um) {
    if (me.role !== "admin") return send(res, 403, { error: "Only an admin can manage users." });
    const list = () => users().map(u => ({ id: u.id, name: u.name, role: u.role, twoFactor: !!u.totp, me: u.id === me.id }));
    if (!um[1] && req.method === "GET") return send(res, 200, list());
    if (!um[1] && req.method === "POST") {
      const b = await readBody(req, 4096), name = String(b.name || "").trim();
      const bad = nameProblem(name) || (ROLES[b.role] ? "" : "Pick a role") || pwProblem(b.password) || (userByName(name) ? "That user name is taken" : "");
      if (bad) return send(res, 400, { error: bad });
      users().push({ id: crypto.randomUUID(), name, role: b.role, ...hashPassword(b.password) }); saveConfig();
      console.log(`User "${name}" (${ROLES[b.role]}) added by "${me.name}".`); audit(req, me.name, "Added a user", `${name} (${ROLES[b.role]})`);
      return send(res, 200, list());
    }
    const u = um[1] && userById(um[1]);
    if (!u) return send(res, 404, { error: "No such user" });
    if (req.method === "DELETE") {
      if (u.id === me.id) return send(res, 400, { error: "You can't remove yourself." });
      if (u.role === "admin" && users().filter(x => x.role === "admin").length < 2) return send(res, 400, { error: "Keep at least one admin." });
      cfg.security.users = users().filter(x => x.id !== u.id); endSessionsOf(u.id); saveConfig();
      console.log(`User "${u.name}" removed by "${me.name}".`); audit(req, me.name, "Removed a user", u.name);
      return send(res, 200, list());
    }
    if (req.method === "PATCH") {   // new password (also clears their 2FA, for a lost phone) and/or role
      const b = await readBody(req, 4096);
      if (b.password !== undefined) { const bad = pwProblem(b.password); if (bad) return send(res, 400, { error: bad }); Object.assign(u, hashPassword(b.password)); delete u.totp; endSessionsOf(u.id); }
      if (b.role !== undefined) {
        if (!ROLES[b.role]) return send(res, 400, { error: "Pick a role" });
        if (u.role === "admin" && b.role !== "admin" && users().filter(x => x.role === "admin").length < 2) return send(res, 400, { error: "Keep at least one admin." });
        u.role = b.role; endSessionsOf(u.id, u.id === me.id ? session.token : undefined);
      }
      saveConfig(); console.log(`User "${u.name}" updated by "${me.name}".`);
      audit(req, me.name, "Changed a user", `${u.name}: ${[b.password !== undefined && "new password (two-step sign-in off)", b.role !== undefined && "role " + ROLES[b.role]].filter(Boolean).join(", ")}`);
      return send(res, 200, list());
    }
  }
  return null;
}

// What the reception role may do: visitor records, their images, ending Wi-Fi access, blocking.
function receptionAllowed(req, p) {
  if (req.method === "GET" && (p === "/visits" || p === "/blocks" || p === "/stats" || p === "/visits.csv" || p === "/visits.pdf" || p === "/devices/status" || p === "/analytics")) return true;
  if (p === "/emergency" || /^\/emergency\/[0-9a-f-]{36}\/(safe|end)$/.test(p)) return true;
  if (req.method === "POST" && p === "/devices/refresh") return true;
  if (req.method === "GET" && /^\/floormap(\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+)?$/.test(p)) return true;
  if (req.method === "GET" && /^\/visits\/[^/]+\/(photo\.jpg|id\.jpg|signature\.png)$/.test(p)) return true;
  if (req.method === "POST" && /^\/visits\/[^/]+\/(revoke|block|checkout)$/.test(p)) return true;
  if (/^\/invites(\/import|\/[0-9a-f-]{36}(\/email|\/text)?)?$/.test(p)) return true;
  if (req.method === "DELETE" && /^\/blocks\/[0-9a-f-]{36}$/.test(p)) return true;
  return false;
}

/* ---------------- Paired kiosk tablets + check-in rate limits ---------------- */
// An admin pairs each tablet once (from its own admin panel). The tablet keeps a random token and sends it with
// every check-in; only its SHA-256 is stored (config.json kiosks[]). Once at least one tablet is paired, check-ins and
// the host name list are accepted only from paired tablets (and from this computer). Before that, things work as
// before and the admin panel warns about it, so updating doesn't stop existing tablets.
const kiosks = () => ((cfg.security ||= {}).kiosks ||= []);
const tokenHash = t => crypto.createHash("sha256").update(String(t)).digest("hex");
const pairingRequired = () => kiosks().length > 0;
function kioskOf(req) {
  const t = req.headers["x-kiosk-token"];
  if (typeof t !== "string" || t.length < 20) return null;
  const h = tokenHash(t); return kiosks().find(k => k.hash === h) || null;
}
const fromPairedKiosk = req => isLocal(req) || !pairingRequired() || !!kioskOf(req);
// At most 20 check-ins per tablet (or device) in 10 minutes, and 150 per hour in total.
const RATE = { per: new Map(), all: [] };
function rateLimited(key) {
  const now = Date.now(), recent = (RATE.per.get(key) || []).filter(t => now - t < 10 * 60e3);
  RATE.all = RATE.all.filter(t => now - t < 3600e3);
  if (recent.length >= 20 || RATE.all.length >= 150) return true;
  recent.push(now); RATE.per.set(key, recent); RATE.all.push(now); return false;
}

/* ---------------- Blocked visitors ---------------- */
// data/blocked.json: [{ id, name, email, phone, reason, by, at }]. A check-in is refused when the email, the phone
// number (last 10 digits) or the full name matches. Kept until someone unblocks (not deleted with visit records).
const BLOCK_PATH = path.join(ROOT, "data", "blocked.json");
const readBlocks = () => { try { return JSON.parse(fs.readFileSync(BLOCK_PATH, "utf8")); } catch { return []; } };
function writeBlocks(list) { fs.mkdirSync(path.dirname(BLOCK_PATH), { recursive: true }); fs.writeFileSync(BLOCK_PATH, JSON.stringify(list, null, 2), { mode: 0o600 }); }
const normName = n => String(n || "").toLowerCase().normalize("NFD").replace(/[^a-z\s]/g, "").split(/\s+/).filter(Boolean).join(" ");
const normPhone = n => String(n || "").replace(/\D/g, "").slice(-10);
function blockedMatch(v) {
  const name = normName(v.name), email = String(v.email || "").trim().toLowerCase(), phone = normPhone(v.phone);
  return readBlocks().find(b => (b.email && b.email === email) || (b.phone && phone.length >= 7 && b.phone === phone) || (b.name && b.name === name)) || null;
}

// End a visitor's Wi-Fi access in RUCKUS One (guest pass or DPSK passphrase). A shared password can't be ended per visitor.
// Deleting a pass only stops new connections: a phone that's already on stays on until it reconnects (seen live
// 2026-10-08: a blocked guest kept working). So the visitor's devices are found first (afterwards RUCKUS One can't say
// which devices used the pass), and each one still connected is disconnected after the pass is gone.
async function visitMacs(rec) {
  const macs = new Set(Object.keys(readDevices(rec.id)).map(normMac));
  try { for (const k of await passDevices(rec)) macs.add(normMac(k.mac)); } catch {}
  return [...macs].filter(Boolean);
}
// "Patch AP Client" (PATCH /venues/{venue}/aps/{serial}/clients/{mac} {status: "DISCONNECTED"}, from the RUCKUS One docs,
// as DwellLink uses it): a one-time kick from the AP the device is on now.
async function disconnectDevices(macs) {
  const out = { disconnected: 0, failed: 0 };
  if (!macs.length || !R1.clientSecret) return out;
  const names = await apNames();
  for (const mac of macs) {
    try {
      const c = listOf(await r1("POST", "/venues/aps/clients/query", { page: 1, pageSize: 10, filters: { macAddress: [mac] } })).find(x => normMac(x.macAddress) === mac);
      if (!c) continue;   // not connected now
      const ap = names.get(normMac(c.apInformation?.macAddress)) || {};
      const venueId = c.venueInformation?.id || c.venueId || ap.venueId, serial = c.apInformation?.serialNumber || ap.serial;
      if (!venueId || !serial) throw new Error("RUCKUS One didn't say which venue and access point it's on");
      await r1("PATCH", `/venues/${encodeURIComponent(venueId)}/aps/${encodeURIComponent(serial)}/clients/${encodeURIComponent(c.macAddress)}`, { status: "DISCONNECTED" });
      out.disconnected++;
    } catch (e) { out.failed++; recordProblem("Ending Wi-Fi access", `Couldn't disconnect device ${mac}: ${e.message}`); }
  }
  return out;
}
// The RUCKUS One identity of a DPSK visit: saved at check-in (since 1.9.0), else read from the passphrase, else (the
// passphrase was deleted; its identity stays behind, confirmed live 2026-10-08) found in the pool's identity group by dpskGuid.
async function dpskIdentity(rec) {
  if (rec.identityId && rec.identityGroupId) return { groupId: rec.identityGroupId, id: rec.identityId };
  const pool = rec.dpskPoolId || cfg.dpsk?.poolId;
  try {
    const pp = await r1("GET", `/dpskServices/${encodeURIComponent(pool)}/passphrases/${encodeURIComponent(rec.ruckusId)}`);
    if (pp?.identityId && pp?.identityGroupId) return { groupId: pp.identityGroupId, id: pp.identityId };
  } catch {}
  const group = listOf(await r1("GET", "/identityGroups?page=0&size=100")).find(g => g.dpskPoolId === pool);
  if (!group) return null;
  for (let page = 0; page < 10; page++) {
    const rows = listOf(await r1("GET", `/identityGroups/${encodeURIComponent(group.id)}/identities?page=${page}&size=500`));
    const hit = rows.find(i => i.dpskGuid === rec.ruckusId);
    if (hit) return { groupId: group.id, id: hit.id };
    if (rows.length < 500) break;
  }
  return null;
}
// Block or unblock an identity: PATCH {revoked} (confirmed live 2026-10-08: 202, then GET shows revoked; RUCKUS One's
// Identities list shows "Blocked"). A blocked identity's passphrase can't connect.
const setIdentityBlocked = (ident, revoked) =>
  r1("PATCH", `/identityGroups/${encodeURIComponent(ident.groupId)}/identities/${encodeURIComponent(ident.id)}`, { revoked });

// End a visitor's Wi-Fi. block: for DPSK, block their RUCKUS One identity (visible there, and the property manager can
// undo it) instead of deleting the passphrase. Otherwise the pass is deleted (and a DPSK passphrase's identity, which
// RUCKUS One would leave behind). Either way their devices still on the Wi-Fi are disconnected.
async function revokeAccess(rec, { block = false } = {}) {
  const now = () => new Date().toISOString();
  if (rec.revokedAt) {
    if (!rec.ruckusId) return "already";
    const macs = await visitMacs(rec);
    if (block && rec.mode === "dpsk" && !rec.identityBlocked) {   // ended earlier: block the identity that was left behind
      try { const ident = await dpskIdentity(rec); if (ident) { await setIdentityBlocked(ident, true); rec.identityBlocked = { ...ident, at: now() }; } }
      catch (e) { recordProblem("Ending Wi-Fi access", `Couldn't block the RUCKUS One identity of ${rec.name}: ${e.message}`); }
    }
    rec.lastDisconnect = { at: now(), ...await disconnectDevices(macs) };
    return "already";
  }
  if (!rec.ruckusId) throw new Error(rec.mode === "psk" ? "Everyone shares this Wi-Fi password, so one visitor's access can't be ended. Change the network password in RUCKUS One instead." : "This visit has no RUCKUS One pass to end.");
  const macs = await visitMacs(rec);
  if (rec.mode === "dpsk") {
    let ident = null;
    try { ident = await dpskIdentity(rec); } catch (e) { recordProblem("Ending Wi-Fi access", `Couldn't find the RUCKUS One identity of ${rec.name}: ${e.message}`); }
    if (block && ident) {
      try {
        await setIdentityBlocked(ident, true);
        rec.identityBlocked = { ...ident, at: now() };
        rec.lastDisconnect = { at: now(), ...await disconnectDevices(macs) };
        return "ended";
      } catch (e) { recordProblem("Ending Wi-Fi access", `Couldn't block the RUCKUS One identity of ${rec.name}, so the password is deleted instead: ${e.message}`); }
    }
    const pool = rec.dpskPoolId || cfg.dpsk?.poolId;
    await r1("DELETE", `/dpskServices/${encodeURIComponent(pool)}/passphrases`, [rec.ruckusId]);   // plain array of ids
    if (ident) await r1("DELETE", `/identityGroups/${encodeURIComponent(ident.groupId)}/identities/${encodeURIComponent(ident.id)}`)
      .catch(e => recordProblem("Ending Wi-Fi access", `Couldn't remove the RUCKUS One identity of ${rec.name}: ${e.message}`, true));
    rec.lastDisconnect = { at: now(), ...await disconnectDevices(macs) };
    return "ended";
  }
  if (rec.mode === "portal") {
    const net = rec.wifiNetworkId || cfg.guestPass?.wifiNetworkId;
    await r1("DELETE", `/wifiNetworks/${encodeURIComponent(net)}/guestUsers/${encodeURIComponent(rec.ruckusId)}`);
  } else throw new Error("This visit has no RUCKUS One pass to end.");
  rec.lastDisconnect = { at: new Date().toISOString(), ...await disconnectDevices(macs) };
  return "ended";
}
// The visitor's current Wi-Fi details, read from RUCKUS One (the kiosk doesn't keep passwords), for reprinting a badge
// or resending them.
async function passDetails(rec) {
  const refuse = m => Object.assign(new Error(m), { status: 409 });
  if (rec.status === "blocked") throw refuse("This person was blocked and never got Wi-Fi access.");
  if (rec.revokedAt) throw refuse("Wi-Fi access for this visit was ended, so there's nothing to print or send.");
  let password = null, expiresAt = rec.passExpiresAt, ssid = rec.ssid;
  if (rec.mode === "dpsk") {
    const pool = rec.dpskPoolId || cfg.dpsk?.poolId;
    const d = await r1("GET", `/dpskServices/${encodeURIComponent(pool)}/passphrases/${encodeURIComponent(rec.ruckusId)}`);
    password = d.passphrase; expiresAt = r1Time(d.expirationDate || d.expiration) || expiresAt;
  } else if (rec.mode === "portal") {
    const net = rec.wifiNetworkId || cfg.guestPass?.wifiNetworkId;
    const d = await r1("GET", `/wifiNetworks/${encodeURIComponent(net)}/guestUsers/${encodeURIComponent(rec.ruckusId)}`), u = d.response || d;
    password = u.password || rec.passCode; ssid = u.ssid || ssid; expiresAt = r1Time(u.expirationDate) || expiresAt;
    if (!password) throw refuse("RUCKUS One only gives out a guest pass code when the pass is made, and this pass is from before the kiosk kept codes. Passes made from now on can be reprinted and resent.");
  } else {
    password = (await sharedPsk({ ssid, expiresAt })).password;
  }
  if (!password) throw new Error("RUCKUS One didn't return the password for this pass.");
  return { mode: rec.mode, ssid, password, expiresAt, expired: !!expiresAt && new Date(expiresAt) < new Date() };
}
async function resendPass(rec, channel, timeZone, who) {
  const to = channel === "email" ? rec.email : rec.phone;
  if (!to) throw Object.assign(new Error(`This visitor didn't give ${channel === "email" ? "an email address" : "a phone number"}.`), { status: 400 });
  const p = await passDetails(rec);
  if (p.expired) throw Object.assign(new Error("This pass has expired, so the details wouldn't work any more."), { status: 400 });
  let until = p.expiresAt;
  try { until = new Date(p.expiresAt).toLocaleString("en-US", { timeZone: timeZone || undefined, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch {}
  const place = readSharedLook()?.orgName, code = p.mode === "portal" ? "Guest pass code" : "Password";
  const text = `Your Wi-Fi${place ? ` at ${place}` : ""}: network ${p.ssid}, ${code.toLowerCase()} ${p.password}, valid until ${until}.`;
  const mine = channel === "email" ? cfg.notifications?.email?.host : cfg.notifications?.sms?.accountSid;
  if (mine) {
    if (channel === "email") await sendEmail(to, `Your Wi-Fi details${place ? ` for ${place}` : ""}`, `Hi ${String(rec.name).split(/\s+/)[0]},\n\n${text}\n\nNetwork: ${p.ssid}\n${code}: ${p.password}\nValid until: ${until}\n`);
    else await sendText(to, text);
  } else if (rec.mode === "dpsk") {   // no email/text set up here: RUCKUS One sends its own DPSK message
    const pool = rec.dpskPoolId || cfg.dpsk?.poolId;
    await r1("POST", `/dpskServices/${encodeURIComponent(pool)}/passphrases/notifications`, { ids: [rec.ruckusId], shouldSendEmail: channel === "email", shouldSendSms: channel === "sms" });
  } else {
    throw Object.assign(new Error(`Set up ${channel === "email" ? "email" : "text messages"} under Email and text messages (admin panel) first, so the kiosk can send this.`), { status: 400 });
  }
  (rec.resent ||= []).push({ at: new Date().toISOString(), channel, to, by: who });
  writeVisit(rec);
  console.log(`Wi-Fi details for ${rec.name} resent by ${channel} by "${who}".`);
  return rec;
}
const visitFile = id => path.join(DATA_DIR, id, "visit.json");
const readVisit = id => JSON.parse(fs.readFileSync(visitFile(id), "utf8"));
const writeVisit = rec => fs.writeFileSync(visitFile(rec.id), JSON.stringify(rec, null, 2));

// IDs and secrets are never sent to the browser. IDs come back as their last 4 characters so the admin can
// tell which account is saved.
const tail = v => v ? String(v).slice(-4) : "";
function publicConfig(req) {
  const c = cfg.ruckus || {};
  return {
    region: R1.region, tenantIdEnd: tail(R1.tenantId), clientIdEnd: tail(R1.clientId), hasSecret: !!R1.clientSecret,
    delegatedTenantIdEnd: tail(R1.delegatedTenantId), connected: !!(R1.tenantId && R1.clientId && R1.clientSecret),
    venueId: c.venueId || "",
    wifiNetworkId: cfg.guestPass?.wifiNetworkId || "", dpskPoolId: cfg.dpsk?.poolId || "",
    local: isLocal(req),
    email: (({ host = "", port = 587, security = "", user = "", from = "" }) => ({ host, port, security, user, from }))(cfg.notifications?.email || {}),
    hasEmailPass: !!cfg.notifications?.email?.pass,
    sms: { accountSidEnd: tail(cfg.notifications?.sms?.accountSid), from: cfg.notifications?.sms?.from || "" },
    hasSmsToken: !!cfg.notifications?.sms?.authToken,
    hasPskPassword: !!cfg.psk?.password,
    storage: { ...retention(), imageSameAsRecords: cfg.storage?.imageDays === null || cfg.storage?.imageDays === undefined },
    hostWebhookUrl: cfg.notifications?.hostWebhookUrl || "",
    alerts: alertCfg(), summary: { frequency: "off", hour: 7, weekday: 1, to: [], ...(cfg.summary || {}) },
    checkout: { endAccess: cfg.checkout?.endAccess !== false }, autoLeave: autoLeaveCfg(),
    fromEnv: Object.keys(ENV_KEYS).filter(k => env[ENV_KEYS[k]])
  };
}

const listOf = d => Array.isArray(d) ? d : (d.data || d.content || d.list || d.response || []);
// Lookup calls below were confirmed against a live tenant in the DwellLink project
// (~/Documents/RuckusPropertyPortal/lib/ruckus/discovery.js, 2026-09-25):
// - POST /venues/query works, response { data }.
// - POST /dpskServices/query 500s whenever page/pageSize are sent; plain GET /dpskServices works, response { content }.
// - Filtering /wifiNetworks/query by venueId returns nothing; a network's venues are in venueApGroups[].venueId,
//   so the whole list is fetched and filtered in the kiosk.
// Network types in RUCKUS One, and the kiosk access type each one works with.
const NET_MODES = { guest: "portal", dpsk: "dpsk", psk: "psk" };
function netSummary(n) {
  const type = String(n.nwSubType || n.type || "").toLowerCase();
  const venueIds = (n.venueApGroups || []).map(v => v.venueId).filter(Boolean);
  return { id: n.id, name: n.name || n.ssid, ssid: n.ssid || n.name, type, mode: NET_MODES[type] || null,
    dpskServiceId: n.dpskServiceProfileId || n.dpskServiceId || null, venueIds: [...new Set(venueIds)] };
}
async function discover() {
  const result = { venues: [], networks: [], dpskServices: [], errors: {} };
  const tryList = async (key, fn) => { try { result[key] = await fn(); } catch (e) { result.errors[key] = e.message; } };
  const byName = { page: 0, sortField: "name", sortOrder: "ASC" };
  await Promise.all([
    tryList("venues", async () => listOf(await r1("POST", "/venues/query", { ...byName, pageSize: 200 })).map(v => ({ id: v.id, name: v.name }))),
    tryList("networks", async () => {
      const raw = listOf(await r1("POST", "/wifiNetworks/query", { ...byName, pageSize: 500 }));
      if (raw[0]) console.log(`Wi-Fi network fields from RUCKUS One: ${Object.keys(raw[0]).join(", ")}`);
      return raw.map(netSummary);
    }),
    tryList("dpskServices", async () => Promise.all(listOf(await r1("GET", "/dpskServices")).map(async d => {
      let pool = d; if (!d.passphraseFormat) { try { pool = await dpskPool(d.id); } catch {} }
      const rule = poolRule(pool);
      return { id: d.id, name: d.name, rule, strength: ruleStrength(rule) };
    })))
  ]);
  return result;
}

async function handleAdmin(req, res, url) {
  const p = url.pathname.slice("/api/admin".length);
  if ((await handleAuth(req, res, p)) !== null) return;
  const session = sessionOf(req);
  if (!session) return send(res, 401, { error: "Sign in again.", signIn: true });
  if ((await handleAccount(req, res, p, session)) !== null) return;
  if (session.user.role !== "admin" && !receptionAllowed(req, p)) return send(res, 403, { error: "Your account can only see visitor records." });

  // End a visitor's Wi-Fi access, and/or block them from checking in again.
  const act = p.match(/^\/visits\/([^/]+)\/(revoke|block)$/);
  if (act && req.method === "POST") {
    if (!VISIT_ID.test(act[1]) || !fs.existsSync(visitFile(act[1]))) return send(res, 404, { error: "That visit is gone" });
    const b = await readBody(req, 4096), rec = readVisit(act[1]), who = session.user.name;
    let ended = null;
    if (act[2] === "revoke" || b.revoke) {
      try { ended = await revokeAccess(rec, { block: act[2] === "block" || (!!rec.blockedAt && !rec.unblockedAt) }); }
      catch (e) { if (act[2] === "revoke") return send(res, 400, { error: e.message }); ended = "not ended: " + e.message; }
      const kicked = rec.lastDisconnect ? `; ${rec.lastDisconnect.disconnected} device(s) disconnected${rec.lastDisconnect.failed ? `, ${rec.lastDisconnect.failed} couldn't be` : ""}` : "";
      if (ended === "ended") { rec.revokedAt = new Date().toISOString(); rec.revokedBy = who; delete rec.passCode; console.log(`Wi-Fi access for ${rec.name} ended by "${who}"${kicked}.`); audit(req, who, "Ended Wi-Fi access", `${rec.name} (${rec.id})${kicked}`); }
      else if (ended === "already" && rec.lastDisconnect) audit(req, who, "Disconnected a visitor's devices", `${rec.name} (${rec.id})${kicked}`);
    }
    if (act[2] === "block") {
      const list = readBlocks();
      if (!list.some(x => x.visitId === rec.id && !rec.unblockedAt)) list.push({ id: crypto.randomUUID(), visitId: rec.id, name: normName(rec.name), displayName: rec.name,
        email: String(rec.email || "").trim().toLowerCase(), phone: normPhone(rec.phone), reason: String(b.reason || "").slice(0, 200), by: who, at: new Date().toISOString() });
      writeBlocks(list); rec.blockedAt = new Date().toISOString(); rec.blockedBy = who; delete rec.unblockedAt; delete rec.unblockedBy;
      console.log(`${rec.name} blocked by "${who}".`); audit(req, who, "Blocked a visitor", `${rec.name}${b.reason ? `: ${b.reason}` : ""}`);
    }
    writeVisit(rec);
    return send(res, 200, { ok: true, ended, record: { ...rec, passCode: undefined, hostToken: undefined, statusToken: undefined, hasPhoto: rec.photo === "photo.jpg", hasId: rec.idImage === "id.jpg", hasSignature: rec.signature === "signature.png" } });
  }
  // Reprint a badge / resend the Wi-Fi details (admins).
  const pm = p.match(/^\/visits\/([^/]+)\/(pass|resend)$/);
  if (pm) {
    if (!VISIT_ID.test(pm[1]) || !fs.existsSync(visitFile(pm[1]))) return send(res, 404, { error: "That visit is gone" });
    const rec = readVisit(pm[1]);
    try {
      if (pm[2] === "pass" && req.method === "GET") { const d = await passDetails(rec); audit(req, session.user.name, "Viewed Wi-Fi details to print a badge", rec.name); return send(res, 200, d); }
      if (pm[2] === "resend" && req.method === "POST") {
        const b = await readBody(req, 4096);
        if (!["email", "sms"].includes(b.channel)) return send(res, 400, { error: "Choose email or text" });
        const out = await resendPass(rec, b.channel, String(b.timeZone || "").slice(0, 60), session.user.name);
        audit(req, session.user.name, "Resent Wi-Fi details", `${rec.name} by ${b.channel === "email" ? "email" : "text"}`);
        return send(res, 200, { ok: true, record: { ...out, passCode: undefined, hostToken: undefined, statusToken: undefined, deleteAfter: deleteAfterOf(out), hasPhoto: out.photo === "photo.jpg", hasId: out.idImage === "id.jpg", hasSignature: out.signature === "signature.png" } });
      }
    } catch (e) { if (e.status) return send(res, e.status, { error: e.message }); throw e; }
  }
  const dv = p.match(/^\/visits\/([^/]+)\/devices$/);
  if (dv && req.method === "GET") {
    if (!VISIT_ID.test(dv[1])) return send(res, 400, { error: "Unknown visit" });
    return send(res, 200, { devices: Object.values(readDevices(dv[1])).sort((a, b) => (b.online - a.online) || String(b.lastSeen).localeCompare(String(a.lastSeen))), tracking: TRACK_STATUS() });
  }
  if (p === "/devices" && req.method === "GET") {
    const q = url.searchParams.get("q") || "";
    if (q) audit(req, session.user.name, "Searched visitor devices", q);
    return send(res, 200, { results: searchDevices(q), tracking: TRACK_STATUS() });
  }
  if (p === "/devices/refresh" && req.method === "POST") { await trackDevices(); return send(res, 200, { tracking: TRACK_STATUS() }); }
  const lm = decodeURIComponent(p).match(/^\/devices\/([0-9a-fA-F:-]{12,17})\/live$/);   // the page encodes ":" as %3A
  if (lm && req.method === "GET") {
    if (!R1.clientSecret) return send(res, 409, { error: "RUCKUS One isn't connected, so there's nothing to look up." });
    audit(req, session.user.name, "Looked up a device in RUCKUS One", normMac(lm[1]));
    return send(res, 200, await deviceReport(normMac(lm[1])));
  }
  if (p === "/stats" && req.method === "GET") return send(res, 200, visitStats(url.searchParams));
  if (p === "/analytics" && req.method === "GET") return send(res, 200, await analytics(url.searchParams));
  // Updates (admins only; on the VM).
  if (p.startsWith("/update")) {
    if (session.user.role !== "admin") return send(res, 403, { error: "Only an admin can update Visitor Desk." });
    if (p === "/update" && req.method === "GET") return send(res, 200, updateInfo());
    if (!updatesOn()) return send(res, 409, { error: "Updates from the admin panel work on the Visitor Desk VM." });
    fs.mkdirSync(UPDATE_DIR, { recursive: true });
    if (p === "/update/upload" && req.method === "POST") {
      try {
        const buf = await readRaw(req, 200 * 1024 * 1024), info = readKup(buf);
        fs.writeFileSync(path.join(UPDATE_DIR, "staged.kup"), buf, { mode: 0o600 });
        const staged = { ...info, at: new Date().toISOString(), by: session.user.name };
        fs.writeFileSync(path.join(UPDATE_DIR, "staged.json"), JSON.stringify(staged));
        audit(req, session.user.name, "Uploaded an update", `${info.version} (build ${info.build})`);
        return send(res, 200, updateInfo());
      } catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }
    if (p === "/update/staged" && req.method === "DELETE") {
      for (const f of ["staged.kup", "staged.json"]) fs.rmSync(path.join(UPDATE_DIR, f), { force: true });
      return send(res, 200, updateInfo());
    }
    if (p === "/update/install" && req.method === "POST") {
      const staged = readJson(path.join(UPDATE_DIR, "staged.json"));
      if (!staged || !fs.existsSync(path.join(UPDATE_DIR, "staged.kup"))) return send(res, 400, { error: "Upload the update file first." });
      fs.writeFileSync(path.join(UPDATE_DIR, "status.json"), JSON.stringify({ state: "queued", from: updateInfo().current.version, to: staged.version, at: new Date().toISOString() }));
      fs.renameSync(path.join(UPDATE_DIR, "staged.kup"), path.join(UPDATE_DIR, "incoming.kup"));
      fs.rmSync(path.join(UPDATE_DIR, "staged.json"), { force: true });
      audit(req, session.user.name, "Started an update", `to ${staged.version} (build ${staged.build})`);
      console.log(`Update to ${staged.version} started by "${session.user.name}". The server restarts in a moment.`);
      return send(res, 200, { ok: true });
    }
    if (p === "/update/rollback" && req.method === "POST") {
      const prev = updateInfo().previous;
      if (!prev) return send(res, 400, { error: "There's no earlier version to go back to." });
      fs.writeFileSync(path.join(UPDATE_DIR, "status.json"), JSON.stringify({ state: "queued", from: updateInfo().current.version, to: prev.version, rollback: true, at: new Date().toISOString() }));
      fs.writeFileSync(path.join(UPDATE_DIR, "rollback.request"), new Date().toISOString());
      audit(req, session.user.name, "Went back to the previous version", prev.version);
      return send(res, 200, { ok: true });
    }
  }
  // Network settings (admins only; on the VM).
  if (p.startsWith("/network")) {
    if (session.user.role !== "admin") return send(res, 403, { error: "Only an admin can change the network settings." });
    if (p === "/network" && req.method === "GET") return send(res, 200, netInfo());
    if (!netOn()) return send(res, 409, { error: "Network settings from the admin panel work on the Visitor Desk VM." });
    fs.mkdirSync(NET_DIR, { recursive: true });
    const st = netInfo().status, busy = ["queued", "applying", "waiting"].includes(st?.state);
    if (p === "/network" && req.method === "PUT") {
      if (busy) return send(res, 409, { error: "A network change is still in progress. Wait for it to finish." });
      let s; try { s = netSettings(await readBody(req, 4096)); } catch (e) { return send(res, e.status || 400, { error: e.message }); }
      const by = session.user.name;
      fs.writeFileSync(path.join(NET_DIR, "network-status.json"), JSON.stringify({ state: "queued", to: s, by, at: new Date().toISOString() }));
      fs.writeFileSync(path.join(NET_DIR, "network.request"), JSON.stringify({ settings: s, by, at: new Date().toISOString() }));
      audit(req, by, "Changed the network settings", s.mode === "static" ? `static ${s.address}/${s.prefix} via ${s.gateway}` : "DHCP");
      return send(res, 200, netInfo());
    }
    if ((p === "/network/confirm" || p === "/network/revert") && req.method === "POST") {
      if (st?.state !== "waiting") return send(res, 400, { error: "There's no network change waiting to be kept." });
      const keep = p.endsWith("confirm");
      fs.writeFileSync(path.join(NET_DIR, keep ? "network.confirm" : "network.revert"), new Date().toISOString());
      audit(req, session.user.name, keep ? "Kept the new network settings" : "Went back to the previous network settings", "");
      return send(res, 200, { ok: true });
    }
  }
  // Emergency message and roll call (admins and front desk).
  if (p === "/emergency" && req.method === "GET") {
    const list = readEmerg(), last = list[list.length - 1] || null, count = mode => { const l = emergencyPeople(mode);
      return { people: l.length, phones: l.filter(r => r.phone).length, emails: l.filter(r => r.email).length }; };
    return send(res, 200, { current: last && !last.endedAt ? last : null, last, canSms: !!cfg.notifications?.sms?.accountSid, canEmail: !!cfg.notifications?.email?.host,
      preview: { checkedin: count("checkedin"), connected: count("connected") } });
  }
  if (p === "/emergency" && req.method === "POST") {
    const b = await readBody(req, 16 * 1024);
    try { const ev = await startEmergency(b, session.user.name);
      audit(req, session.user.name, "Sent an emergency message", `"${ev.message}" to ${ev.recipients.length} visitors`); return send(res, 200, ev); }
    catch (e) { return send(res, e.status || 502, { error: e.message }); }
  }
  const em = p.match(/^\/emergency\/([0-9a-f-]{36})\/(safe|end)$/);
  if (em && req.method === "POST") {
    const list = readEmerg(), ev = list.find(x => x.id === em[1]);
    if (!ev) return send(res, 404, { error: "That emergency message is gone" });
    if (em[2] === "end") { ev.endedAt ||= new Date().toISOString(); ev.endedBy ||= session.user.name; audit(req, session.user.name, "Ended the emergency roll call"); }
    else {
      const b = await readBody(req, 4096);
      if (!ev.recipients.some(x => x.visitId === b.visitId)) return send(res, 404, { error: "That visitor isn't on this roll call" });
      if (b.safe) ev.safe[b.visitId] = { at: new Date().toISOString(), by: session.user.name }; else delete ev.safe[b.visitId];
    }
    writeEmerg(list); return send(res, 200, ev);
  }
  // Hosts' own invite links (admins).
  if (p === "/hostlinks" && req.method === "GET" && session.user.role === "admin")
    return send(res, 200, hostList().map(h => ({ name: h.name, email: !!h.email, phone: !!h.phone, url: hostLink(req, h.name, false) })));
  if ((p === "/hostlinks/send" || p === "/hostlinks/reset") && req.method === "POST" && session.user.role === "admin") {
    const b = await readBody(req, 4096), pick = hostList().filter(h => !b.name || h.name === b.name);
    if (!pick.length) return send(res, 404, { error: "No such host" });
    if (p === "/hostlinks/reset") { delete hostLinks()[pick[0].name.trim().toLowerCase()]; hostLink(req, pick[0].name); audit(req, session.user.name, "Made a new host link", pick[0].name); return send(res, 200, { url: hostLink(req, pick[0].name, false) }); }
    const results = [];
    for (const h of pick) { try { results.push({ name: h.name, sent: await sendHostLink(req, h) }); } catch (e) { results.push({ name: h.name, error: e.message }); } }
    audit(req, session.user.name, "Sent hosts their invite links", results.filter(r => r.sent).map(r => r.name).join(", "));
    return send(res, 200, { results });
  }
  const co = p.match(/^\/visits\/([^/]+)\/checkout$/);
  if (co && req.method === "POST") {
    if (!VISIT_ID.test(co[1]) || !fs.existsSync(visitFile(co[1]))) return send(res, 404, { error: "That visit is gone" });
    const rec = readVisit(co[1]);
    if (!rec.checkedOutAt) { await checkOut(rec, session.user.name); audit(req, session.user.name, "Checked a visitor out", rec.name); }
    return send(res, 200, { ok: true, record: { ...rec, passCode: undefined, hostToken: undefined, statusToken: undefined, deleteAfter: deleteAfterOf(rec), hasPhoto: rec.photo === "photo.jpg", hasId: rec.idImage === "id.jpg", hasSignature: rec.signature === "signature.png" } });
  }
  // Expected visitors (pre-registered). Admins and reception.
  if (p === "/invites" && req.method === "GET") return send(res, 200, readInvites().sort((a, b) => a.from.localeCompare(b.from)));
  if (p === "/invites" && req.method === "POST") {
    const b = await readBody(req, 16 * 1024);
    try {
      const inv = cleanInvite(b), list = readInvites(), today = new Date().toISOString().slice(0, 10);
      const used = new Set(list.filter(i => !i.usedAt && i.until >= today).map(i => i.code));
      let code; do code = sixDigits(); while (used.has(code));
      Object.assign(inv, { id: crypto.randomUUID(), code, by: session.user.name, at: new Date().toISOString() });
      let emailError = "", textError = "";
      if (b.sendEmail && inv.email) { try { await emailInvite(inv); } catch (e) { emailError = e.message; } }
      if (b.sendText && inv.phone) { try { await textInvite(inv); } catch (e) { textError = e.message; } }
      list.push(inv); writeInvites(list);
      audit(req, session.user.name, "Added an expected visitor", `${inv.name}, ${inv.from}${inv.until > inv.from ? " to " + inv.until : ""}`);
      return send(res, 200, { invite: inv, emailError, textError });
    } catch (e) { if (e.status) return send(res, e.status, { error: e.message }); throw e; }
  }
  // Import expected visitors (rows already read from a CSV file by the page). Each row is checked like a single add.
  if (p === "/invites/import" && req.method === "POST") {
    const b = await readBody(req, 2 * 1024 * 1024), rows = Array.isArray(b.rows) ? b.rows.slice(0, 500) : [];
    if (!rows.length) return send(res, 400, { error: "No rows to import" });
    const list = readInvites(), today = new Date().toISOString().slice(0, 10), yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    const used = new Set(list.filter(i => !i.usedAt && i.until >= today).map(i => i.code)), results = [];
    for (const row of rows) {
      try {
        const inv = cleanInvite(row || {});
        if (inv.until < yesterday) throw new Error("That day has already passed");
        let code; do code = sixDigits(); while (used.has(code)); used.add(code);
        Object.assign(inv, { id: crypto.randomUUID(), code, by: session.user.name, at: new Date().toISOString() });
        let emailError = "", textError = "";
        if (b.sendEmail && inv.email) { try { await emailInvite(inv); } catch (e) { emailError = e.message; } }
        if (b.sendText && inv.phone) { try { await textInvite(inv); } catch (e) { textError = e.message; } }
        list.push(inv);
        results.push({ name: inv.name, code, emailed: !!inv.emailedAt, texted: !!inv.textedAt, emailError, textError });
      } catch (e) { results.push({ name: String(row?.name || ""), error: e.message }); }
    }
    writeInvites(list);
    const added = results.filter(r => r.code).length;
    audit(req, session.user.name, "Imported expected visitors", `${added} added, ${results.length - added} skipped`);
    return send(res, 200, { results, added });
  }
  const im = p.match(/^\/invites\/([0-9a-f-]{36})(\/email|\/text)?$/);
  if (im) {
    const list = readInvites(), inv = list.find(i => i.id === im[1]);
    if (!inv) return send(res, 404, { error: "That invite is gone" });
    if (req.method === "DELETE" && !im[2]) {
      writeInvites(list.filter(i => i.id !== inv.id)); audit(req, session.user.name, "Removed an expected visitor", inv.name);
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && im[2]) {
      const byText = im[2] === "/text";
      try { await (byText ? textInvite(inv) : emailInvite(inv)); } catch (e) { return send(res, e.status || 502, { error: e.message }); }
      writeInvites(list); audit(req, session.user.name, byText ? "Texted an invite code" : "Emailed an invite code", inv.name);
      return send(res, 200, { invite: inv });
    }
  }
  // Privacy requests (admins): find everything about one person, download it, or delete it.
  if (p === "/person" && req.method === "GET") {
    const m = personMatches(url.searchParams.get("q"));
    audit(req, session.user.name, "Searched for a person's data", `${m.kind}: ${url.searchParams.get("q")}`);
    return send(res, 200, { kind: m.kind, invites: m.invites, blocks: m.blocks,
      visits: m.visits.map(({ passCode, hostToken, statusToken, ...r }) => ({ ...r, hasPhoto: r.photo === "photo.jpg", hasId: r.idImage === "id.jpg", hasSignature: r.signature === "signature.png" })) });
  }
  if ((p === "/person/export" || p === "/person/delete") && req.method === "POST") {
    const b = await readBody(req, 256 * 1024);
    const ids = (Array.isArray(b.visitIds) ? b.visitIds : []).filter(id => VISIT_ID.test(id) && fs.existsSync(visitFile(id)));
    const inviteIds = new Set(Array.isArray(b.inviteIds) ? b.inviteIds : []), blockIds = new Set(Array.isArray(b.blockIds) ? b.blockIds : []);
    if (p === "/person/export") {
      const img = (id, f, type) => { const file = path.join(DATA_DIR, id, f); return fs.existsSync(file) ? `data:${type};base64,` + fs.readFileSync(file).toString("base64") : undefined; };
      const out = { exportedAt: new Date().toISOString(), exportedBy: session.user.name,
        visits: ids.map(id => { const { passCode, hostToken, statusToken, ...r } = readVisit(id);
          return { ...r, photo: img(id, "photo.jpg", "image/jpeg"), idImage: img(id, "id.jpg", "image/jpeg"), signature: img(id, "signature.png", "image/png"), devices: Object.values(readDevices(id)) }; }),
        invites: readInvites().filter(i => inviteIds.has(i.id)), blocked: readBlocks().filter(x => blockIds.has(x.id)) };
      audit(req, session.user.name, "Exported a person's data", `${ids.length} visits`);
      res.writeHead(200, secHeaders(res, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="visitor-data-${new Date().toISOString().slice(0, 10)}.json"` }));
      return res.end(JSON.stringify(out, null, 2));
    }
    for (const id of ids) fs.rmSync(path.join(DATA_DIR, id), { recursive: true, force: true });
    if (inviteIds.size) writeInvites(readInvites().filter(i => !inviteIds.has(i.id)));
    if (blockIds.size) writeBlocks(readBlocks().filter(x => !blockIds.has(x.id)));
    audit(req, session.user.name, "Deleted a person's data", `${ids.length} visits, ${inviteIds.size} invites, ${blockIds.size} blocks`);
    return send(res, 200, { deleted: ids.length });
  }
  if (p === "/alerts/test" && req.method === "POST") {
    const a = alertCfg();
    if (!a.emails.length && !a.phones.length) return send(res, 400, { error: "Add an email address or mobile number first" });
    const prev = { ...cfg.alerts }; cfg.alerts = { ...a, test: true };
    const ok = await staffAlert("test", "Test staff alert", "This is a test. Staff alerts from Visitor Desk are working.");
    cfg.alerts = prev;
    return ok ? send(res, 200, { ok: true }) : send(res, 502, { error: "Nothing could be sent. Check Recent problems, and the settings under Email and text messages." });
  }
  if (p === "/summary/send" && req.method === "POST") {
    try { const label = await sendSummary(cfg.summary || {}, true); return send(res, 200, { ok: true, label }); }
    catch (e) { return send(res, e.status || 502, { error: e.message }); }
  }
  if (p === "/blocks" && req.method === "GET") return send(res, 200, readBlocks());
  const bm = p.match(/^\/blocks\/([0-9a-f-]{36})$/);
  if (bm && req.method === "DELETE") {
    const list = readBlocks(), gone = list.find(x => x.id === bm[1]);
    writeBlocks(list.filter(x => x.id !== bm[1]));
    if (gone){
      console.log(`${gone.displayName || gone.name} unblocked by "${session.user.name}".`); audit(req, session.user.name, "Unblocked a visitor", gone.displayName || gone.name);
      if (gone.visitId && VISIT_ID.test(gone.visitId) && fs.existsSync(visitFile(gone.visitId))) {
        const rec = readVisit(gone.visitId); rec.unblockedAt = new Date().toISOString(); rec.unblockedBy = session.user.name;
        // Blocked in RUCKUS One too: unblock the identity. If the password still exists and hasn't run out, their Wi-Fi works again.
        if (rec.identityBlocked) {
          try {
            await setIdentityBlocked(rec.identityBlocked, false); delete rec.identityBlocked;
            if (rec.revokedAt && new Date(rec.passExpiresAt || 0) > new Date()) {
              const pool = rec.dpskPoolId || cfg.dpsk?.poolId;
              const still = await r1("GET", `/dpskServices/${encodeURIComponent(pool)}/passphrases/${encodeURIComponent(rec.ruckusId)}`).then(() => true, () => false);
              if (still) { delete rec.revokedAt; delete rec.revokedBy; rec.accessRestoredAt = rec.unblockedAt; }
            }
          } catch (e) { recordProblem("Unblocking", `Couldn't unblock the RUCKUS One identity of ${rec.name}: ${e.message}`); }
        }
        writeVisit(rec);
      }
    }
    return send(res, 200, readBlocks());
  }

  if (req.method === "GET" && p === "/config") return send(res, 200, publicConfig(req));
  if (req.method === "GET" && p === "/hosts") return send(res, 200, hostList());

  // Paired tablets: list (marks the one asking), pair the tablet this admin panel is on, remove.
  if (p === "/kiosks" && req.method === "GET") {
    const me = kioskOf(req);
    return send(res, 200, { required: pairingRequired(), thisKiosk: me ? me.id : null, local: isLocal(req),
      kiosks: kiosks().map(({ hash, ...k }) => ({ ...k, lastPing: PINGS.has(k.id) ? new Date(PINGS.get(k.id)).toISOString() : null, offline: OFFLINE.has(k.id) })) });
  }
  if (p === "/kiosks" && req.method === "POST") {
    const b = await readBody(req, 4096), name = String(b.name || "").trim().slice(0, 40) || "Kiosk tablet";
    const token = crypto.randomBytes(32).toString("base64url");
    kiosks().push({ id: crypto.randomUUID(), name, hash: tokenHash(token), created: new Date().toISOString(), by: session.user.name });
    saveConfig(); audit(req, session.user.name, "Paired a kiosk tablet", name);
    console.log(`Kiosk tablet "${name}" paired by "${session.user.name}".`);
    return send(res, 200, { token, name });
  }
  const km = p.match(/^\/kiosks\/([0-9a-f-]{36})$/);
  if (km && req.method === "DELETE") {
    const k = kiosks().find(x => x.id === km[1]); if (!k) return send(res, 404, { error: "No such tablet" });
    cfg.security.kiosks = kiosks().filter(x => x.id !== k.id); saveConfig();
    audit(req, session.user.name, "Removed a kiosk tablet", k.name);
    return send(res, 200, { ok: true });
  }
  if (p === "/audit" && req.method === "GET") return send(res, 200, readAudit(url.searchParams.get("q") || "", Math.min(Number(url.searchParams.get("limit")) || 300, 5000)));
  if (req.method === "GET" && p === "/errors") return send(res, 200, loadProblems());
  if (req.method === "DELETE" && p === "/errors") { audit(req, session.user.name, "Cleared Recent problems"); problems = []; fs.rmSync(ERRORS_PATH, { force: true }); return send(res, 200, []); }

  if (p === "/look" && req.method === "PUT") {
    const b = await readBody(req, 12 * 1024 * 1024);
    const shared = { ...cleanLook(b), version: Date.now() };
    const tmp = LOOK_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(shared)); fs.renameSync(tmp, LOOK_PATH);
    console.log("Saved the shared kiosk look. Other kiosks pick it up within 2 minutes."); audit(req, session.user.name, "Changed the shared kiosk look");
    return send(res, 200, { version: shared.version });
  }
  if (p === "/questions" && req.method === "PUT") {
    const shared = { ...cleanQuestions(await readBody(req, 256 * 1024)), version: Date.now() };
    const tmp = QUESTIONS_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(shared)); fs.renameSync(tmp, QUESTIONS_PATH);
    console.log("Saved the shared visitor questions. Other kiosks pick them up within 2 minutes."); audit(req, session.user.name, "Changed the shared visitor questions", `${shared.custom.length} extra question(s)`);
    return send(res, 200, { version: shared.version });
  }
  if (p === "/questions" && req.method === "DELETE") {
    fs.rmSync(QUESTIONS_PATH, { force: true });
    console.log("Turned off the shared visitor questions. Each kiosk keeps its current questions."); audit(req, session.user.name, "Turned off the shared visitor questions");
    return send(res, 200, { ok: true });
  }
  if (p === "/look" && req.method === "DELETE") {
    fs.rmSync(LOOK_PATH, { force: true });
    console.log("Turned off the shared kiosk look. Each kiosk keeps its current look."); audit(req, session.user.name, "Turned off the shared kiosk look");
    return send(res, 200, { ok: true });
  }

  // Visitor records: list, images, delete. Folder names are checked strictly so no other path can be reached.
  if (p === "/visits" && req.method === "GET") {
    audit(req, session.user.name, "Opened visitor records");
    return send(res, 200, listVisits(Math.min(Number(url.searchParams.get("limit")) || 500, 5000)).map(({ passCode, hostToken, statusToken, ...r }) => ({
      ...r, deleteAfter: deleteAfterOf(r), hasPhoto: r.photo === "photo.jpg", hasId: r.idImage === "id.jpg", hasSignature: r.signature === "signature.png",
      devices: deviceBrief(r), probablyLeft: probablyLeft(r) || undefined, lastDeviceSeen: onSite(r) && lastDeviceSeen(r) ? new Date(lastDeviceSeen(r)).toISOString() : undefined })));
  }
  if (p === "/devices/status" && req.method === "GET") return send(res, 200, TRACK_STATUS());
  if (p === "/floormap" && req.method === "GET") {
    if (!R1.clientSecret) return send(res, 409, { error: "RUCKUS One isn't connected, so there are no floor plans." });
    return send(res, 200, await floorMap());
  }
  const fi = p.match(/^\/floormap\/([A-Za-z0-9_-]{1,100})\/([A-Za-z0-9_-]{1,100})$/);
  if (fi && req.method === "GET") {
    if (!(await venuePlans(fi[1]).catch(() => [])).some(x => x.imageId === fi[2])) return send(res, 404, { error: "Unknown floor plan" });
    try { const { buf, type } = await floorImage(fi[1], fi[2]);
      res.writeHead(200, secHeaders(res, { "Content-Type": type, "Cache-Control": "private, max-age=3600" })); return res.end(buf); }
    catch (e) { return send(res, e.status || 502, { error: e.message }); }
  }
  // Visitor report as CSV (opens in Excel). Same filters as the records screen: from/to dates (YYYY-MM-DD) and a search.
  // Same filters as the records screen: from/to dates (YYYY-MM-DD), since (ISO), onsite=1 and a search. Newest first.
  const reportRows = () => {
    const from = url.searchParams.get("from"), to = url.searchParams.get("to"), q = (url.searchParams.get("q") || "").toLowerCase();
    const since = url.searchParams.get("since"), here = url.searchParams.get("onsite") === "1", conn = url.searchParams.get("connected") === "1";
    const rows = listVisits(1e6).filter(r => {
      const d = (r.checkedInAt || "").slice(0, 10);
      if (conn ? !connectedNow(r) : here && !onSite(r)) return false;
      if (from && d < from) return false;
      if (to && d > to) return false;
      if (since && String(r.checkedInAt || "") < since) return false;
      return !q || [r.name, r.company, r.host, r.email, r.phone, r.purpose, ...(r.extra || []).map(e => e.value)].some(x => String(x || "").toLowerCase().includes(q));
    }).sort((a, b) => String(b.checkedInAt).localeCompare(String(a.checkedInAt)));
    const filters = [conn ? "with a device connected now" : here && "on site now", from && "from " + from, to && "to " + to, since && "since " + since.slice(0, 16).replace("T", " "), q && `"${q}"`].filter(Boolean);
    return { rows, filters };
  };
  if (p === "/visits.pdf" && req.method === "GET") {
    const { rows, filters } = reportRows();
    let tz = url.searchParams.get("tz") || "UTC"; try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { tz = "UTC"; }
    const when = t => t ? new Date(t).toLocaleString("en-US", { timeZone: tz, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "";
    const MODES = { portal: "Guest pass", dpsk: "DPSK", psk: "Shared" };
    const status = r => r.status === "blocked" ? "Blocked" : r.checkedOutAt ? "Checked out" : onSite(r) ? "On site" : r.revokedAt ? "Wi-Fi ended" : "Pass expired";
    const place = readSharedLook()?.orgName;
    const pdf = pdfTable({
      title: `Visitor report${place ? `: ${place}` : ""}`,
      lines: [`${rows.length} visit${rows.length === 1 ? "" : "s"}${filters.length ? ` (${filters.join(", ")})` : ""}. Times in ${tz}.`],
      footer: `Made by ${session.user.name}, ${when(new Date().toISOString())}`,
      columns: [
        { label: "Checked in", width: 98, get: r => when(r.checkedInAt) }, { label: "Name", width: 104, get: r => r.name },
        { label: "Company", width: 84, get: r => r.company }, { label: "Visiting", width: 92, get: r => r.host },
        url.searchParams.get("onsite") === "1" || url.searchParams.get("connected") === "1"
          ? { label: "Connected at", width: 82, get: r => [...new Set((deviceBrief(r) || []).filter(d => d.online).map(d => d.ap))].join(", ") }
          : { label: "Reason", width: 82, get: r => r.purpose },
        { label: "Phone", width: 70, get: r => r.phone },
        { label: "Wi-Fi", width: 60, get: r => MODES[r.mode] || r.mode }, { label: "Status", width: 66, get: status },
        { label: "Checked out", width: 64, get: r => r.checkedOutAt ? new Date(r.checkedOutAt).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }) : "" }
      ], rows });
    audit(req, session.user.name, "Exported the visitor report (PDF)", `${rows.length} visits${filters.length ? ` (${filters.join(", ")})` : ""}`);
    res.writeHead(200, secHeaders(res, { "Content-Type": "application/pdf", "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="visitor-report-${new Date().toISOString().slice(0, 10)}.pdf"` }));
    return res.end(pdf);
  }
  if (p === "/visits.csv" && req.method === "GET") {
    const { rows } = reportRows(), from = url.searchParams.get("from"), to = url.searchParams.get("to"), since = url.searchParams.get("since"), q = url.searchParams.get("q");
    const MODES = { portal: "Guest pass", dpsk: "DPSK", psk: "Shared password" };
    const cols = [
      ["Checked in", r => r.checkedInAt], ["Name", r => r.name], ["Company", r => r.company], ["Email", r => r.email], ["Phone", r => r.phone],
      ["Visiting", r => r.host], ["Reason", r => r.purpose], ["Wi-Fi", r => MODES[r.mode] || r.mode], ["SSID", r => r.ssid],
      ["Pass expires", r => r.passExpiresAt], ["Status", r => r.status === "blocked" ? "Blocked at check-in" : r.revokedAt ? "Wi-Fi ended" : ""],
      ["Wi-Fi ended", r => r.revokedAt], ["Ended by", r => r.revokedBy], ["Blocked", r => r.blockedAt && !r.unblockedAt ? r.blockedAt : ""],
      ["Blocked by", r => r.blockedAt && !r.unblockedAt ? r.blockedBy : ""],
      ["License name", r => r.license ? `${r.license.first} ${r.license.last}` : ""], ["License state", r => r.license?.state],
      ["License expires", r => r.license?.expires], ["License expired", r => r.license ? (r.license.expired ? "Yes" : "No") : ""],
      ["Name matches license", r => r.license ? (r.license.nameMatches ? "Yes" : "No") : ""],
      ["Photo", r => r.photo === "photo.jpg" ? "Yes" : ""], ["License scan", r => r.idImage === "id.jpg" ? "Yes" : r.idImage || ""],
      ["Agreed to terms", r => r.consented ? "Yes" : ""], ["Signed", r => r.signature === "signature.png" ? "Yes" : ""],
      ["Checked out", r => r.checkedOutAt], ["Checked out by", r => r.checkedOutBy], ["Invited", r => r.inviteId ? "Yes" : ""], ["Devices", r => deviceSummary(r.id)], ["Visit ID", r => r.id]
    ];
    // One column per extra question asked, after Reason (in the order first seen).
    const extraLabels = [...new Set(rows.flatMap(r => (r.extra || []).map(e => e.label)))];
    cols.splice(cols.findIndex(c => c[0] === "Reason") + 1, 0, ...extraLabels.map(l => [l, r => (r.extra || []).find(e => e.label === l)?.value]));
    // Quote every field; a leading = + - @ is prefixed with ' so spreadsheets don't run it as a formula.
    const cell = v => { let t = v === undefined || v === null ? "" : String(v); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return '"' + t.replace(/"/g, '""') + '"'; };
    const csv = "\ufeff" + [cols.map(c => cell(c[0])).join(","), ...rows.map(r => cols.map(c => cell(c[1](r))).join(","))].join("\r\n") + "\r\n";
    console.log(`Visitor report exported by "${session.user.name}" (${rows.length} visits).`);
    audit(req, session.user.name, "Exported the visitor report", `${rows.length} visits${from || to || since || q ? ` (filtered: ${[from && "from " + from, to && "to " + to, since && "since " + since.slice(0, 16), q && `"${q}"`].filter(Boolean).join(", ")})` : ""}`);
    res.writeHead(200, secHeaders(res, { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="visitor-report-${new Date().toISOString().slice(0, 10)}.csv"` }));
    return res.end(csv);
  }
  if (p === "/visits" && req.method === "DELETE") {
    let n = 0;
    if (fs.existsSync(DATA_DIR)) for (const name of fs.readdirSync(DATA_DIR))
      if (VISIT_ID.test(name)) { fs.rmSync(path.join(DATA_DIR, name), { recursive: true, force: true }); n++; }
    console.log(`Deleted all visitor records (${n}) from the admin panel.`); audit(req, session.user.name, "Deleted ALL visitor records", `${n} visits`);
    return send(res, 200, { deleted: n });
  }
  const vm = p.match(/^\/visits\/([^/]+)(?:\/(photo\.jpg|id\.jpg|signature\.png))?$/);
  if (vm) {
    if (!VISIT_ID.test(vm[1])) return send(res, 400, { error: "Unknown visit" });
    const dir = path.join(DATA_DIR, vm[1]);
    if (!fs.existsSync(dir)) return send(res, 404, { error: "That visit is gone" });
    if (req.method === "GET" && vm[2]) {
      const file = path.join(dir, vm[2]);
      if (!fs.existsSync(file)) return send(res, 404, { error: "No image" });
      res.writeHead(200, secHeaders(res, { "Content-Type": vm[2].endsWith(".png") ? "image/png" : "image/jpeg", "Cache-Control": "no-store" }));
      return res.end(fs.readFileSync(file));
    }
    if (req.method === "DELETE" && !vm[2]) {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`Deleted visitor record ${vm[1]} from the admin panel.`); audit(req, session.user.name, "Deleted a visit", vm[1]);
      return send(res, 200, { deleted: 1 });
    }
  }

  // Send a test email or text with the saved settings.
  if (req.method === "POST" && p === "/notify-test") {
    const b = await readBody(req, 64 * 1024), to = String(b.to || "").trim();
    if (!to) return send(res, 400, { error: "Enter where to send the test" });
    if (b.channel === "email") await sendEmail(to, "Visitor Desk test", "This is a test from Visitor Desk. Email is working.");
    else if (b.channel === "sms") await sendText(to, "Visitor Desk test: text messages are working.");
    else return send(res, 400, { error: "Unknown channel" });
    return send(res, 200, { ok: true });
  }

  // Test new credentials, and save them only if RUCKUS One accepts them.
  if (req.method === "POST" && p === "/connect") {
    const b = await readBody(req, 64 * 1024);
    // Blank means "keep the saved value" (the screen never has the saved IDs or secret).
    const keep = (k) => String(b[k] || "").trim() || R1[k];
    const next = {
      region: String(b.region || "na").toLowerCase(), tenantId: keep("tenantId"), clientId: keep("clientId"),
      clientSecret: keep("clientSecret"),
      delegatedTenantId: b.clearDelegatedTenantId ? "" : keep("delegatedTenantId")
    };
    const t = await login(next);
    cfg.ruckus = { ...(cfg.ruckus || {}), ...next };
    saveConfig();
    R1 = r1FromConfig(); token = t.token; tokenExpires = t.expires;
    console.log(`RUCKUS One connected from the admin panel. Region: ${R1.region}  Tenant: …${tail(R1.tenantId)}`);
    audit(req, session.user.name, "Connected RUCKUS One", `region ${R1.region}, tenant …${tail(R1.tenantId)}`);
    return send(res, 200, { ok: true, config: publicConfig(req), ...(await discover()) });
  }

  if (req.method === "POST" && p === "/discover") {
    await getToken();
    return send(res, 200, await discover());
  }

  // Save the chosen venue, network and DPSK service (and optionally the admin key).
  if (req.method === "PUT" && p === "/config") {
    const b = await readBody(req, 64 * 1024);
    const str = v => typeof v === "string" ? v.trim() : undefined;
    if (str(b.venueId) !== undefined) cfg.ruckus = { ...(cfg.ruckus || {}), venueId: str(b.venueId) };
    if (str(b.wifiNetworkId) !== undefined) pskCache = null;
    if (str(b.wifiNetworkId) !== undefined) cfg.guestPass = { ...(cfg.guestPass || {}), wifiNetworkId: str(b.wifiNetworkId) };
    if (str(b.dpskPoolId) !== undefined) cfg.dpsk = { ...(cfg.dpsk || {}), poolId: str(b.dpskPoolId) };
    const n = cfg.notifications = cfg.notifications || {};
    if (b.email && typeof b.email === "object") {
      const e = b.email, cur = n.email || {};
      n.email = { host: str(e.host) ?? cur.host ?? "", port: Number(e.port) || cur.port || 587,
        security: ["starttls", "tls", "none"].includes(e.security) ? e.security : cur.security || "starttls",
        user: str(e.user) ?? cur.user ?? "", pass: str(e.pass) || cur.pass || "", from: str(e.from) ?? cur.from ?? "" };
    }
    if (b.sms && typeof b.sms === "object") {
      const t = b.sms, cur = n.sms || {};
      n.sms = { accountSid: str(t.accountSid) || cur.accountSid || "", authToken: str(t.authToken) || cur.authToken || "",
        from: str(t.from) ?? cur.from ?? "" };
    }
    if (str(b.hostWebhookUrl) !== undefined) {
      if (b.hostWebhookUrl.trim() && !/^https:\/\//.test(b.hostWebhookUrl.trim())) return send(res, 400, { error: "The Slack/Teams webhook must start with https://" });
      n.hostWebhookUrl = str(b.hostWebhookUrl);
    }
    if (b.storage && typeof b.storage === "object") {
      const days = v => v === null ? null : Number.isInteger(v) && v >= 0 && v <= 36500 ? v : undefined;
      const rd = days(b.storage.recordDays), id = days(b.storage.imageDays);
      if (rd === undefined || rd === null) return send(res, 400, { error: "Keep visit records: choose a number of days, or forever" });
      if (id === undefined) return send(res, 400, { error: "Keep photos and license scans: choose a number of days, forever, or the same as records" });
      cfg.storage = { ...(cfg.storage || {}), recordDays: rd, imageDays: id };
      delete cfg.storage.retentionDays;
      setTimeout(cleanupOldVisits, 1000);
    }
    if (str(b.pskPassword)) {
      const pw = b.pskPassword.trim();
      if (pw.length < 8 || pw.length > 63) return send(res, 400, { error: "The shared Wi-Fi password needs 8 to 63 characters" });
      cfg.psk = { ...(cfg.psk || {}), password: pw };
    }
    const lines = (v, ok) => (Array.isArray(v) ? v : []).map(x => String(x).trim()).filter(Boolean).slice(0, 20).filter(ok);
    if (b.alerts && typeof b.alerts === "object") {
      const a = b.alerts, bad = lines(a.emails, () => true).find(e => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
      if (bad) return send(res, 400, { error: `Staff alerts: "${bad}" isn't an email address` });
      cfg.alerts = { emails: lines(a.emails, () => true), phones: lines(a.phones, () => true), blocked: a.blocked !== false, tabletOffline: a.tabletOffline !== false,
        problems: a.problems !== false, offlineMinutes: Math.min(240, Math.max(5, Number(a.offlineMinutes) || 15)) };
    }
    if (b.summary && typeof b.summary === "object") {
      const m = b.summary, bad = lines(m.to, () => true).find(e => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
      if (bad) return send(res, 400, { error: `Summary email: "${bad}" isn't an email address` });
      let tz = String(m.timeZone || "UTC"); try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { tz = "UTC"; }
      cfg.summary = { ...(cfg.summary || {}), frequency: ["off", "daily", "weekly"].includes(m.frequency) ? m.frequency : "off",
        hour: Math.min(23, Math.max(0, Number(m.hour) || 0)), weekday: Math.min(6, Math.max(0, Number(m.weekday) || 0)), to: lines(m.to, () => true), timeZone: tz };
    }
    if (b.checkout && typeof b.checkout === "object") cfg.checkout = { endAccess: b.checkout.endAccess !== false };
    if (b.autoLeave && typeof b.autoLeave === "object")
      cfg.autoLeave = { enabled: b.autoLeave.enabled !== false, checkout: b.autoLeave.checkout === true, hours: Math.min(24, Math.max(0.5, Number(b.autoLeave.hours) || 2)) };
    if (Array.isArray(b.hosts)) {
      cfg.hosts = b.hosts.filter(h => h && typeof h.name === "string" && h.name.trim()).slice(0, 500)
        .map(h => ({ name: h.name.trim(), email: String(h.email || "").trim(), phone: String(h.phone || "").trim() }));
    }
    saveConfig();
    const changed = { venueId: "venue", wifiNetworkId: "visitor network", dpskPoolId: "DPSK service", email: "host alert email", sms: "host alert texts",
      hostWebhookUrl: "Slack/Teams webhook", hosts: "host list", pskPassword: "shared Wi-Fi password", storage: "how long visits are kept",
      alerts: "staff alerts", summary: "summary email", checkout: "check-out", autoLeave: "leaving without checking out" };
    const what = Object.keys(b).filter(k => changed[k]).map(k => changed[k]);
    if (what.length) audit(req, session.user.name, "Changed settings", what.join(", ") + (b.storage ? ` (records ${b.storage.recordDays === 0 ? "forever" : b.storage.recordDays + " days"})` : ""));
    return send(res, 200, publicConfig(req));
  }
  send(res, 404, { error: "Not found" });
}

async function handlePass(req, res) {
  const k = kioskOf(req);
  if (!fromPairedKiosk(req)) return send(res, 401, { error: "This kiosk isn't paired with the kiosk server. Ask staff to pair it in the admin panel.", pairing: true });
  if (k) { k.lastSeen = new Date().toISOString(); k.lastIp = clientIp(req); }
  if (rateLimited(k ? "kiosk:" + k.id : "ip:" + clientIp(req))) {
    audit(req, k ? `tablet "${k.name}"` : "", "Check-in refused: too many in a short time");
    return send(res, 429, { error: "Too many check-ins in a short time. Please ask reception for help." });
  }
  const body = await readBody(req);
  const { visitor: v, network: net, delivery = {}, retentionDays } = body;
  if (!v?.name || !net?.mode) return send(res, 400, { error: "Missing visitor name or network mode" });
  for (const f of ["inviteId", "returningFrom", "photoFrom", "hostToken", "statusToken"]) delete v[f];   // only ever set here, from a lookup token

  // Details from an invite code or an earlier visit ("Been here before?"): email and phone stay on the server, so the
  // kiosk sends the fields empty and they're filled in here. An invite can also set a multi-day pass.
  const invL = useLookup(body.inviteToken, "invite"), retL = useLookup(body.returningToken, "visit");
  let invite = null, earlier = null;
  if (invL) {
    invite = readInvites().find(i => i.id === invL.id && !i.usedAt);
    if (invite) {
      v.email ||= invite.email; v.phone ||= invite.phone; v.inviteId = invite.id;
      const last = new Date(invite.until + "T23:59:59Z").getTime() + 14 * 3600e3;   // end of the last day, any time zone
      if (!net.expiresAt || new Date(net.expiresAt).getTime() > last) net.expiresAt = new Date(Math.min(last, Date.now() + MAX_PASS_DAYS * 864e5)).toISOString();
    }
  } else if (net.expiresAt && new Date(net.expiresAt) - Date.now() > 31 * 864e5) net.expiresAt = new Date(Date.now() + 31 * 864e5).toISOString();
  if (retL && VISIT_ID.test(retL.id) && fs.existsSync(visitFile(retL.id))) {
    earlier = readVisit(retL.id);
    v.email ||= earlier.email; v.phone ||= earlier.phone; v.returningFrom = earlier.id;
    if (body.reusePhoto && !v.photo && earlier.photo === "photo.jpg") v.photoFrom = earlier.id;
  }

  const blocked = blockedMatch(v);
  if (blocked) {
    const rec = saveVisit(v, { blocked: true }, net.mode, retentionDays);
    console.log(`${new Date().toLocaleString()}  BLOCKED ${v.name} tried to check in (${rec.id})`);
    audit(req, k ? `tablet "${k.name}"` : "", "Blocked visitor tried to check in", v.name);
    staffAlert("blocked", `Blocked visitor at the kiosk: ${v.name}`, `${v.name}${v.company ? ` (${v.company})` : ""} tried to check in${k ? ` on "${k.name}"` : ""}${v.host ? ` to see ${v.host}` : ""} and was refused.${blocked.reason ? ` Reason they were blocked: ${blocked.reason}.` : ""} They were asked to see reception.`).catch(() => {});
    return send(res, 403, { blocked: true, error: "Please see reception to finish checking in." });
  }

  let result;
  if (net.mode === "portal") result = await createGuestPass(v, net, delivery);
  else if (net.mode === "dpsk") result = await createDpsk(v, net, delivery);
  else if (net.mode === "psk") result = await sharedPsk(net);
  else return send(res, 400, { error: `Unknown mode ${net.mode}` });

  // "On my way" link for the host, and a token the kiosk's pass screen uses to show it.
  v.statusToken = crypto.randomBytes(18).toString("base64url");
  if (delivery.notifyHost && v.host) v.hostToken = crypto.randomBytes(18).toString("base64url");
  result.delivered.notifyHost = delivery.notifyHost ? await notifyHost(v, body.location, v.hostToken && `${publicBase(req)}/onmyway/${v.hostToken}`) : false;
  const rec = saveVisit(v, result, net.mode, retentionDays);
  if (v.photoFrom) {   // the photo from their last visit, which they agreed to reuse
    try { fs.copyFileSync(path.join(DATA_DIR, v.photoFrom, "photo.jpg"), path.join(DATA_DIR, rec.id, "photo.jpg")); rec.photo = "photo.jpg"; writeVisit(rec); } catch {}
  }
  if (invite) {
    const list = readInvites(), i = list.find(x => x.id === invite.id);
    if (i) { i.usedAt = rec.checkedInAt; i.visitId = rec.id; writeInvites(list); }
    LOOKUPS.delete(body.inviteToken);
  }
  if (retL) LOOKUPS.delete(body.returningToken);
  console.log(`${new Date().toLocaleString()}  ${net.mode.padEnd(6)}  ${v.name}${v.host ? " → " + v.host : ""}${invite ? " (invited)" : ""}  (${rec.id})`);
  // A reused photo isn't sent back: anyone who knows someone's email could otherwise see their face.
  send(res, 200, { ssid: result.ssid, password: result.password, expiresAt: result.expiresAt, delivered: result.delivered, checkoutCode: rec.checkoutCode,
    statusToken: rec.statusToken });
}

// Kiosk-side lookups: check-out, invite codes, "Been here before?". Paired tablets only, and the same rate limit as
// check-ins, so codes and contact details can't be guessed in bulk.
async function handleKioskLookup(req, res, what) {
  const k = kioskOf(req);
  if (!fromPairedKiosk(req)) return send(res, 401, { error: "This kiosk isn't paired.", pairing: true });
  if (rateLimited((k ? "kiosk:" + k.id : "ip:" + clientIp(req)) + ":lookup")) return send(res, 429, { error: "Too many tries. Please ask reception for help." });
  const b = await readBody(req, 4096), q = String(b.q || "").trim().slice(0, 200);
  if (what === "checkout/find") {
    const found = findForCheckout(q);
    if (!found.length) return send(res, 404, { error: "not found" });
    return send(res, 200, { token: lookupToken({ kind: "checkout", ids: found.map(r => r.id) }), firstName: firstName(found[0].name) });
  }
  if (what === "checkout") {
    const l = useLookup(b.token, "checkout"); if (!l) return send(res, 410, { error: "expired" });
    for (const id of l.ids) if (fs.existsSync(visitFile(id))) { const rec = readVisit(id); if (!rec.checkedOutAt) await checkOut(rec, k ? `kiosk "${k.name}"` : "kiosk"); }
    LOOKUPS.delete(b.token);
    return send(res, 200, { ok: true });
  }
  if (what === "invite") {
    const today = String(b.today || "").match(DAY)?.[0] || new Date().toISOString().slice(0, 10);
    const inv = /^\d{6}$/.test(q) && readInvites().find(i => i.code === q && inviteOpen(i, today));
    if (!inv) return send(res, 404, { error: "not found" });
    return send(res, 200, { token: lookupToken({ kind: "invite", id: inv.id }), name: inv.name, company: inv.company, host: inv.host, purpose: inv.purpose,
      hasEmail: !!inv.email, hasPhone: !!inv.phone, until: inv.until > today ? inv.until : null });
  }
  if (what === "returning") {
    const email = q.includes("@") ? q.toLowerCase() : "", phone = normPhone(q);
    const r = (email || phone.length >= 7) && listVisits(1e6).find(x => x.status !== "blocked"
      && (email ? String(x.email || "").toLowerCase() === email : normPhone(x.phone) === phone));
    if (!r || blockedMatch(r)) return send(res, 404, { error: "not found" });
    return send(res, 200, { token: lookupToken({ kind: "visit", id: r.id }), name: r.name, company: r.company || "",
      hasEmail: !!r.email, hasPhone: !!r.phone, hasPhoto: r.photo === "photo.jpg" });
  }
  send(res, 404, { error: "Not found" });
}

// Pages and API for hosts (their invite link, "On my way") and the kiosk's pass-screen status. No staff sign-in: the
// random token in the address is the key. Rate-limited like kiosk lookups.
async function handleHostPages(req, res, url) {
  const p = url.pathname, m = req.method;
  if (rateLimited("hostpage:" + clientIp(req))) return send(res, 429, { error: "Too many tries. Wait a few minutes." });
  let mm;
  if ((mm = p.match(/^\/api\/pass-status\/([A-Za-z0-9_-]+)$/)) && m === "GET") {
    if (!fromPairedKiosk(req)) return send(res, 401, { error: "This kiosk isn't paired.", pairing: true });
    const r = recentVisitBy("statusToken", mm[1]);
    return r ? send(res, 200, { hostOnWay: !!r.hostOnWayAt, host: r.host || "" }) : send(res, 404, { error: "not found" });
  }
  if ((mm = p.match(/^\/onmyway\/([A-Za-z0-9_-]+)$/)) && m === "GET") {
    const r = recentVisitBy("hostToken", mm[1]);
    if (!r) return hostPage(res, "Visitor Desk", `<h1>This link has expired</h1><p class="muted">It's for a visitor who has already left.</p>`);
    // A button, not an automatic action: link previews in mail and chat apps open links by themselves.
    return hostPage(res, "On my way", `<h1>${esc(r.name)} is here</h1><p class="muted">${esc([r.company, "checked in " + new Date(r.checkedInAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })].filter(Boolean).join(", "))}</p>
      <div class="card" id="box">${r.hostOnWayAt ? `<p class="ok">They know you're on your way.</p>` : `<p>Let them know you're coming to meet them?</p><button class="primary" id="go">I'm on my way</button>`}</div>`,
      r.hostOnWayAt ? "" : `document.getElementById("go").onclick=async()=>{const b=document.getElementById("go");b.disabled=true;const res=await fetch(location.pathname.replace("/onmyway/","/api/onmyway/"),{method:"POST"});
        document.getElementById("box").innerHTML=res.ok?'<p class="ok">Done. They\'ve been told you\'re on your way.</p>':'<p class="err">That didn\'t work. Please call reception.</p>';};`);
  }
  if ((mm = p.match(/^\/api\/onmyway\/([A-Za-z0-9_-]+)$/)) && m === "POST") {
    const r = recentVisitBy("hostToken", mm[1]);
    if (!r) return send(res, 404, { error: "This link has expired" });
    await hostOnWay(r); audit(req, `host "${r.host}"`, "Said they're on the way", r.name);
    return send(res, 200, { ok: true });
  }
  // A host's own page: their expected visitors, today's arrivals, add a visitor.
  if ((mm = p.match(/^\/host\/([A-Za-z0-9_-]+)$/)) && m === "GET") {
    const h = hostByToken(mm[1]);
    if (!h) return hostPage(res, "Visitor Desk", `<h1>This link doesn't work any more</h1><p class="muted">Ask reception for a new one.</p>`);
    return hostPage(res, `Visitor Desk: ${h.name}`, `<p class="muted">Visitor Desk${readSharedLook()?.orgName ? " · " + esc(readSharedLook().orgName) : ""}</p><h1>Your visitors, ${esc(firstName(h.name))}</h1>
      <h2>Arrived today</h2><div id="arrived"><p class="muted">Loading…</p></div>
      <h2>Add an expected visitor</h2><div class="card">
        <label for="name">Name</label><input id="name" maxlength="100" autocomplete="off">
        <div class="row"><div><label for="email">Email (to send their code)</label><input id="email" type="email" maxlength="200"></div><div><label for="phone">Mobile (optional)</label><input id="phone" type="tel" maxlength="40"></div></div>
        <div class="row"><div><label for="company">Company (optional)</label><input id="company" maxlength="100"></div><div><label for="purpose">Reason (optional)</label><input id="purpose" maxlength="100"></div></div>
        <div class="row"><div><label for="from">Day they're coming</label><input id="from" type="date"></div><div><label for="until">Last day (more than one day)</label><input id="until" type="date"></div></div>
        <label for="note">Note in the email (optional)</label><input id="note" maxlength="300" placeholder="Parking is behind the building.">
        <p><label class="check"><input type="checkbox" id="sendEmail" checked> Email them their code</label><label class="check"><input type="checkbox" id="sendText"> Text them their code</label></p>
        <button class="primary" id="add">Add visitor</button> <span id="msg" class="muted" aria-live="polite"></span></div>
      <h2>Your expected visitors</h2><div id="list"><p class="muted">Loading…</p></div>
      <p class="muted">At the kiosk, your visitor taps "I have an invite code" and enters their code. Keep this page's link to yourself: anyone with it can add visitors for you.</p>`, HOST_SCRIPT);
  }
  const hm = p.match(/^\/api\/host\/([A-Za-z0-9_-]+)(\/.*)?$/);
  if (hm) {
    const h = hostByToken(hm[1]), sub = hm[2] || "", who = h && `host "${h.name}"`;
    if (!h) return send(res, 404, { error: "This link doesn't work any more. Ask reception for a new one." });
    const mine = i => String(i.host || "").trim().toLowerCase() === h.name.trim().toLowerCase();
    if (!sub && m === "GET") {
      const today = new Date().toISOString().slice(0, 10), since = new Date(Date.now() - 18 * 3600e3).toISOString();
      return send(res, 200, { host: { name: h.name },
        invites: readInvites().filter(i => mine(i) && (i.until >= today || (i.usedAt && i.usedAt >= since))).sort((a, b) => a.from.localeCompare(b.from)),
        arrivals: listVisits(500).filter(r => mine(r) && r.checkedInAt >= since && r.status !== "blocked").map(r => ({ id: r.id, name: r.name, company: r.company || "", checkedInAt: r.checkedInAt, onWayAt: r.hostOnWayAt || null })) });
    }
    if (sub === "/invites" && m === "POST") {
      const b = await readBody(req, 16 * 1024);
      try {
        const inv = cleanInvite({ ...b, host: h.name }), list = readInvites(), today = new Date().toISOString().slice(0, 10);
        if (inv.until < today) throw Object.assign(new Error("That day has already passed"), { status: 400 });
        const used = new Set(list.filter(i => !i.usedAt && i.until >= today).map(i => i.code));
        let code; do code = sixDigits(); while (used.has(code));
        Object.assign(inv, { id: crypto.randomUUID(), code, by: who, at: new Date().toISOString() });
        let emailError = "", textError = "";
        if (b.sendEmail && inv.email) { try { await emailInvite(inv); } catch (e) { emailError = e.message; } }
        if (b.sendText && inv.phone) { try { await textInvite(inv); } catch (e) { textError = e.message; } }
        list.push(inv); writeInvites(list); audit(req, who, "Added an expected visitor", inv.name);
        return send(res, 200, { invite: inv, emailError, textError });
      } catch (e) { return send(res, e.status || 502, { error: e.message }); }
    }
    let im;
    if ((im = sub.match(/^\/invites\/([0-9a-f-]{36})(\/email|\/text)?$/))) {
      const list = readInvites(), inv = list.find(i => i.id === im[1] && mine(i));
      if (!inv) return send(res, 404, { error: "That visitor isn't on your list" });
      if (m === "DELETE" && !im[2]) { writeInvites(list.filter(i => i !== inv)); audit(req, who, "Removed an expected visitor", inv.name); return send(res, 200, { ok: true }); }
      if (m === "POST" && im[2]) {
        try { await (im[2] === "/text" ? textInvite(inv) : emailInvite(inv)); } catch (e) { return send(res, e.status || 502, { error: e.message }); }
        writeInvites(list); return send(res, 200, { invite: inv });
      }
    }
    if ((im = sub.match(/^\/arrivals\/([^/]+)\/onmyway$/)) && m === "POST") {
      if (!VISIT_ID.test(im[1]) || !fs.existsSync(visitFile(im[1]))) return send(res, 404, { error: "That visit is gone" });
      const r = readVisit(im[1]); if (!mine(r)) return send(res, 404, { error: "That visitor isn't yours" });
      await hostOnWay(r); audit(req, who, "Said they're on the way", r.name); return send(res, 200, { ok: true });
    }
  }
  send(res, 404, { error: "Not found" });
}

async function handle(req, res) {
  try {
    if (!allowed(req)) return send(res, 403, { error: "This device isn't allowed to use the kiosk server" });
    const url = new URL(req.url, "http://localhost");

    if (req.method === "GET" && url.pathname === "/setup") return send(res, 200, setupPage(req), "text/html; charset=utf-8",
      { "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" });
    if (req.method === "GET" && url.pathname === "/ca.crt" && fs.existsSync(path.join(CERT_DIR, "ca.crt"))) {
      res.writeHead(200, secHeaders(res, { "Content-Type": "application/x-x509-ca-cert", "Content-Disposition": 'attachment; filename="visitor-kiosk-ca.crt"', "Cache-Control": "no-store" }));
      return res.end(fs.readFileSync(path.join(CERT_DIR, "ca.crt")));
    }
    // The API only over https from other devices (visitor details, photos, sign-ins). This computer can use http.
    if (url.pathname.startsWith("/api/") && HTTPS_PORT && !req.socket.encrypted && !isLocal(req))
      return send(res, 403, { error: "Use the kiosk's https:// address." });
    // Other devices opening the kiosk over plain http go to https (the camera needs it). This computer can stay on http.
    if (req.method === "GET" && (url.pathname === "/" || /^\/(host|onmyway)\//.test(url.pathname)) && HTTPS_PORT && !req.socket.encrypted && !isLocal(req)) {
      const host = (req.headers.host || "").replace(/:\d+$/, "");
      res.writeHead(302, secHeaders(res, { Location: `https://${host}:${HTTPS_PORT}${url.pathname === "/" ? "/" : url.pathname}`, "Cache-Control": "no-store" }));
      return res.end();
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) return kioskPage(res);
    if (req.method === "GET" && url.pathname === "/api/kiosk-info") return send(res, 200, { recordDays: retention().recordDays });
    if (req.method === "GET" && url.pathname === "/api/look/version") { kioskPing(req); return send(res, 200, { version: readSharedLook()?.version || 0, questions: readSharedQuestions()?.version || 0 }); }
    if (req.method === "GET" && url.pathname === "/api/questions") return send(res, 200, readSharedQuestions() || { version: 0 });
    if (req.method === "POST" && /^\/api\/(checkout|checkout\/find|invite|returning)$/.test(url.pathname)) return await handleKioskLookup(req, res, url.pathname.slice(5));
    if (req.method === "GET" && url.pathname === "/api/look") return send(res, 200, readSharedLook() || { version: 0 });
    // Staff names: paired tablets, this computer, or a signed-in admin panel only (once pairing is in use).
    if (req.method === "GET" && url.pathname === "/api/hosts") {
      if (!fromPairedKiosk(req) && !sessionOf(req)) return send(res, 401, { error: "This kiosk isn't paired.", pairing: true });
      return send(res, 200, hostList().map(h => h.name));
    }
    if (/^\/(host|onmyway)\/|^\/api\/(host|onmyway|pass-status)\//.test(url.pathname)) return await handleHostPages(req, res, url);
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, region: R1.region });
    if (req.method === "POST" && url.pathname === "/api/guest-pass") return await handlePass(req, res);
    if (url.pathname.startsWith("/api/admin/")) return await handleAdmin(req, res, url);
    send(res, 404, { error: "Not found" });
  } catch (err) {
    printError(`${new Date().toLocaleString()}  ERROR  ${err.message}`);
    const p = new URL(req.url, "http://localhost").pathname;
    recordProblem(p === "/api/guest-pass" ? "Check-in" : p === "/api/admin/connect" ? "RUCKUS One connection"
      : p === "/api/admin/discover" ? "Loading RUCKUS One lists" : p === "/api/admin/notify-test" ? "Test message"
      : /\/(revoke|block)$/.test(p) ? "Ending Wi-Fi access" : "Admin panel", err.message);
    send(res, 502, { error: err.message });
  }
}
const server = http.createServer(handle);

/* ---------------- Check-out, invites, returning visitors ---------------- */
// Everything the kiosk can look up about a person goes through a short-lived token, so the kiosk never gets an
// email address, phone number or photo back: only a first name, the company and who they're visiting.
const LOOKUPS = new Map();   // token -> { kind: "checkout"|"invite"|"visit", ids|id, until, at }
const lookupToken = data => { const t = crypto.randomBytes(18).toString("base64url"); LOOKUPS.set(t, { ...data, at: Date.now() }); return t; };
function useLookup(t, kind) {
  const l = t && LOOKUPS.get(String(t));
  if (!l || l.kind !== kind || Date.now() - l.at > 15 * 60e3) return null;
  return l;
}
setInterval(() => { for (const [t, l] of LOOKUPS) if (Date.now() - l.at > 15 * 60e3) LOOKUPS.delete(t); }, 5 * 60e3).unref();
// "Jordan Lee" → Jordan; "Lee, Jordan" (spreadsheet style) → Jordan.
const firstName = n => { const t = String(n || "").trim(), m = t.match(/^[^,]+,\s*(\S+)/); return m ? m[1] : t.split(/\s+/)[0] || ""; };
const sixDigits = () => String(crypto.randomInt(0, 1e6)).padStart(6, "0");
// Visitors who haven't checked out and whose pass hasn't run out (shared-password visits: checked in within a day).
function onSite(r, now = Date.now()) {
  if (r.status === "blocked" || r.checkedOutAt) return false;
  const exp = r.passExpiresAt ? new Date(r.passExpiresAt).getTime() : new Date(r.checkedInAt || 0).getTime() + 864e5;
  return exp > now && !r.revokedAt;
}
function newCheckoutCode() {
  const used = new Set(listVisits(5000).filter(r => onSite(r)).map(r => r.checkoutCode));
  for (let i = 0; i < 50; i++) { const c = sixDigits(); if (!used.has(c)) return c; }
  return sixDigits();
}
// Code from the badge, or the email / phone number they checked in with. Recent visits that haven't checked out.
function findForCheckout(q) {
  const s = String(q || "").trim(), email = s.includes("@") ? s.toLowerCase() : "", digits = s.replace(/\D/g, "");
  if (!s) return [];
  return listVisits(5000).filter(r => r.status !== "blocked" && !r.checkedOutAt && (onSite(r) || Date.now() - new Date(r.checkedInAt || 0) < 864e5))
    .filter(r => /^\d{6}$/.test(s) ? r.checkoutCode === s
      : email ? String(r.email || "").toLowerCase() === email
      : digits.length >= 7 && normPhone(r.phone) === normPhone(digits));
}
async function checkOut(rec, by) {
  rec.checkedOutAt = new Date().toISOString(); rec.checkedOutBy = by;
  if (cfg.checkout?.endAccess !== false && rec.ruckusId && !rec.revokedAt && rec.status !== "blocked") {
    try { if ((await revokeAccess(rec)) === "ended") { rec.revokedAt = rec.checkedOutAt; rec.revokedBy = "Checked out"; delete rec.passCode; } }
    catch (e) { console.error(`Checked ${rec.name} out, but couldn't end their Wi-Fi access: ${e.message}`); }
  }
  writeVisit(rec);
  console.log(`${new Date().toLocaleString()}  checkout ${rec.name} (${by})`);
}

// Pre-registered visitors: data/invites.json [{ id, code, name, email, phone, company, host, purpose, from, until,
// note, by, at, usedAt, visitId, emailedAt }]. from/until are dates (YYYY-MM-DD); until after from = multi-day pass.
const INVITE_PATH = path.join(ROOT, "data", "invites.json");
const readInvites = () => { try { return JSON.parse(fs.readFileSync(INVITE_PATH, "utf8")); } catch { return []; } };
function writeInvites(list) { fs.mkdirSync(path.dirname(INVITE_PATH), { recursive: true }); fs.writeFileSync(INVITE_PATH, JSON.stringify(list, null, 2), { mode: 0o600 }); }
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PASS_DAYS = 31;
const inviteOpen = (i, today) => !i.usedAt && i.from <= today && today <= i.until;
function cleanupInvites() {   // a month after their last day
  const cut = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10), list = readInvites();
  const keep = list.filter(i => i.until >= cut);
  if (keep.length !== list.length) writeInvites(keep);
}
function cleanInvite(b) {
  const s = (v, n) => String(v || "").trim().slice(0, n);
  const inv = { name: s(b.name, 100), email: s(b.email, 200).toLowerCase(), phone: s(b.phone, 40), company: s(b.company, 100),
    host: s(b.host, 100), purpose: s(b.purpose, 100), note: s(b.note, 300), from: s(b.from, 10), until: s(b.until, 10) || s(b.from, 10) };
  if (inv.name.length < 2) throw Object.assign(new Error("Enter the visitor's name"), { status: 400 });
  if (!DAY.test(inv.from) || !DAY.test(inv.until) || inv.until < inv.from) throw Object.assign(new Error("Choose the day they're coming (and the last day, for more than one day)"), { status: 400 });
  if ((new Date(inv.until) - new Date(inv.from)) / 864e5 + 1 > MAX_PASS_DAYS) throw Object.assign(new Error(`A visit can last up to ${MAX_PASS_DAYS} days`), { status: 400 });
  if (inv.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inv.email)) throw Object.assign(new Error("That email address doesn't look right"), { status: 400 });
  return inv;
}
function fmtDay(d, opts = { weekday: "long", month: "long", day: "numeric" }) { return new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { ...opts, timeZone: "UTC" }); }
// The same invite code by text message (Twilio, set up under Email and text messages).
async function textInvite(inv) {
  if (!inv.phone) throw Object.assign(new Error("This visitor has no phone number"), { status: 400 });
  const place = readSharedLook()?.orgName, days = inv.until > inv.from ? `${fmtDay(inv.from, { month: "short", day: "numeric" })} to ${fmtDay(inv.until, { month: "short", day: "numeric" })}` : fmtDay(inv.from, { weekday: "short", month: "short", day: "numeric" });
  await sendText(inv.phone, `Hi ${firstName(inv.name)}, you're expected${place ? ` at ${place}` : ""} ${days}${inv.host ? ` to see ${inv.host}` : ""}. At the check-in kiosk, tap "I have an invite code" and enter ${inv.code}.`);
  inv.textedAt = new Date().toISOString();
}
async function emailInvite(inv) {
  if (!inv.email) throw Object.assign(new Error("This visitor has no email address"), { status: 400 });
  const place = readSharedLook()?.orgName, days = inv.until > inv.from ? `from ${fmtDay(inv.from)} to ${fmtDay(inv.until)}` : `on ${fmtDay(inv.from)}`;
  await sendEmail(inv.email, `You're expected${place ? ` at ${place}` : ""}`, [
    `Hi ${firstName(inv.name)},`, "",
    `You're expected${place ? ` at ${place}` : ""} ${days}${inv.host ? `, to see ${inv.host}` : ""}.`, "",
    `When you arrive, tap "I have an invite code" on the check-in kiosk and enter:`, "", `    ${inv.code}`, "",
    `Your details are already filled in, so check-in takes a few seconds.${inv.until > inv.from ? " Your Wi-Fi access lasts for the whole visit." : ""}`,
    inv.note ? `\n${inv.note}` : "", "", "Sent by Visitor Desk."].join("\n"));
  inv.emailedAt = new Date().toISOString();
}

/* ---------------- Staff alerts and the summary email ---------------- */
// cfg.alerts: { emails: [], phones: [], blocked, tabletOffline, offlineMinutes, problems }. Off unless someone is listed.
const alertCfg = () => ({ emails: [], phones: [], blocked: true, tabletOffline: true, offlineMinutes: 15, problems: true, ...(cfg.alerts || {}), emergency: true });
const lastAlert = new Map();
async function staffAlert(kind, subject, text, { throttleMin = 0 } = {}) {
  const a = alertCfg();
  if (!a[kind] || (!a.emails.length && !a.phones.length)) return false;
  if (throttleMin && Date.now() - (lastAlert.get(kind) || 0) < throttleMin * 60e3) return false;
  lastAlert.set(kind, Date.now());
  const place = readSharedLook()?.orgName, subj = `${place ? place + ": " : ""}${subject}`;
  const jobs = [
    ...(cfg.notifications?.email?.host ? a.emails.map(to => sendEmail(to, subj, `${text}\n\nSent by Visitor Desk. Change these alerts in Admin > Staff alerts.`)) : []),
    ...(cfg.notifications?.sms?.accountSid ? a.phones.map(to => sendText(to, `${subj}. ${text}`.slice(0, 600))) : [])
  ];
  const out = await Promise.allSettled(jobs);
  // printError, not console.error: a failing alert must not raise another "problem" alert.
  for (const r of out) if (r.status === "rejected") { printError(`Staff alert failed: ${r.reason?.message}`); recordProblemQuiet("Staff alert", r.reason?.message); }
  return out.some(r => r.status === "fulfilled");
}
// Tablets ping the server every 2 minutes (shared look check). One that stops gets an alert, and another when it's back.
const PINGS = new Map(), STARTED = Date.now();
function kioskPing(req) { const k = kioskOf(req); if (k) PINGS.set(k.id, Date.now()); }
const OFFLINE = new Set();
function checkTablets() {
  const a = alertCfg(), limit = Math.max(5, Number(a.offlineMinutes) || 15) * 60e3;
  for (const k of kiosks()) {
    const last = PINGS.get(k.id) || STARTED, quiet = Date.now() - last > limit;
    if (quiet && !OFFLINE.has(k.id)) {
      OFFLINE.add(k.id);
      staffAlert("tabletOffline", `Kiosk tablet "${k.name}" is offline`, `The kiosk tablet "${k.name}" hasn't been in touch for ${Math.round((Date.now() - last) / 60000)} minutes. Check that it's on, charged and on the network, with the kiosk page open.`).catch(() => {});
    } else if (!quiet && OFFLINE.has(k.id)) {
      OFFLINE.delete(k.id);
      staffAlert("tabletOffline", `Kiosk tablet "${k.name}" is back`, `The kiosk tablet "${k.name}" is in touch again.`).catch(() => {});
    }
  }
}
// The summary email: cfg.summary { frequency: off|daily|weekly, hour, weekday (0 Sunday), to: [], timeZone, lastSent }.
function zoned(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" }).formatToParts(date).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, s: +p.second, wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
}
function zonedMidnight(y, m, d, tz) {   // the moment local midnight starts on that date, in that time zone
  let t = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 2; i++) { const z = zoned(new Date(t), tz); t -= (Date.UTC(z.y, z.m - 1, z.d, z.h, z.min, z.s) - Date.UTC(y, m - 1, d)); }
  return new Date(t);
}
function summaryText(from, to, label, tz) {
  const all = listVisits(1e6), inRange = all.filter(r => r.checkedInAt >= from.toISOString() && r.checkedInAt < to.toISOString());
  const ok = inRange.filter(r => r.status !== "blocked");
  const tally = (vals, n = 5) => { const m = new Map(); for (const v of vals) if (v) m.set(v, (m.get(v) || 0) + 1); return [...m].sort((a, b) => b[1] - a[1]).slice(0, n); };
  const MODES = { portal: "guest pass", dpsk: "DPSK", psk: "shared password" };
  const list = (title, rows) => rows.length ? `\n${title}:\n${rows.map(([k, n]) => `  ${k}: ${n}`).join("\n")}` : null;
  let devices = 0; for (const r of all.filter(r => onSite(r))) for (const d of Object.values(readDevices(r.id))) if (onlineNow(d)) devices++;
  const place = readSharedLook()?.orgName;
  // false/null lines are left out; "" lines are the gaps between sections.
  return [`Visitor summary${place ? ` for ${place}` : ""}: ${label}`, "",
    `Check-ins: ${ok.length}${ok.length ? ` (${tally(ok.map(r => MODES[r.mode] || r.mode)).map(([k, n]) => `${n} ${k}`).join(", ")})` : ""}`,
    inRange.length - ok.length && `Blocked check-ins: ${inRange.length - ok.length}`,
    `Checked out at the kiosk: ${ok.filter(r => r.checkedOutAt).length}`,
    `Invited visitors who came: ${ok.filter(r => r.inviteId).length}`,
    list("Top hosts", tally(ok.map(r => r.host))), list("Companies", tally(ok.map(r => r.company))), list("Visit reasons", tally(ok.map(r => r.purpose))),
    "", `Right now: ${all.filter(r => onSite(r)).length} on site, ${devices} guest device${devices === 1 ? "" : "s"} online.`,
    `Problems in the last 24 hours: ${loadProblems().filter(x => Date.now() - new Date(x.at) < 864e5).length}`,
    "", `Times are in ${tz}. Change this email in Admin > Summary email.`].filter(x => x !== false && x !== null && x !== 0).join("\n");
}
function summaryPeriod(s, now = new Date()) {
  const tz = s.timeZone || "UTC", z = zoned(now, tz), today = zonedMidnight(z.y, z.m, z.d, tz);
  const back = days => { const t = new Date(Date.UTC(z.y, z.m - 1, z.d) - days * 864e5); return zonedMidnight(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), tz); };
  if (s.frequency === "weekly") {
    const from = back(7), label = `the week of ${from.toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric" })}`;
    return { from, to: today, label, key: `w${today.toISOString().slice(0, 10)}`, z };
  }
  const from = back(1);
  return { from, to: today, label: from.toLocaleDateString("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric" }), key: `d${today.toISOString().slice(0, 10)}`, z };
}
async function sendSummary(s = cfg.summary || {}, force = false) {
  const to = (s.to || []).filter(Boolean);
  if (!to.length) throw Object.assign(new Error("Add at least one email address for the summary"), { status: 400 });
  if (!cfg.notifications?.email?.host) throw Object.assign(new Error("Set up email under Email and text messages first"), { status: 400 });
  const p = summaryPeriod(s.frequency === "weekly" ? s : { ...s, frequency: "daily" });
  const text = summaryText(p.from, p.to, p.label, s.timeZone || "UTC");
  for (const addr of to) await sendEmail(addr, `Visitor summary: ${p.label}`, text);
  if (!force) { cfg.summary = { ...s, lastSent: p.key }; saveConfig(); }
  return p.label;
}
function maybeSendSummary() {
  const s = cfg.summary || {};
  if (!["daily", "weekly"].includes(s.frequency) || !(s.to || []).length) return;
  const p = summaryPeriod(s);
  if (s.lastSent === p.key || p.z.h < (Number(s.hour) || 0)) return;
  if (s.frequency === "weekly" && p.z.wd !== (Number(s.weekday) || 0)) return;
  sendSummary(s).then(l => console.log(`Summary email sent (${l}).`), e => printError(`Summary email failed: ${e.message}`));
}

/* ---------------- Visitor report as PDF (no packages: a small PDF writer with the built-in Helvetica fonts) ---------------- */
// Helvetica widths (1/1000 em) for ASCII 32-126, from the standard Adobe font metrics. Other characters: 556.
const HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,
  1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,
  333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const WINANSI = { "€": 0x80, "…": 0x85, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97 };
const pdfChars = t => Array.from(String(t ?? "").normalize("NFC")).map(c => { const n = c.codePointAt(0);
  return WINANSI[c] ?? (n >= 32 && n < 127 || n >= 160 && n <= 255 ? n : n === 9 || n === 10 ? 32 : 63); });
const textWidth = (codes, size, bold) => codes.reduce((w, n) => w + (n >= 32 && n <= 126 ? HELV[n - 32] : 556), 0) * size / 1000 * (bold ? 1.06 : 1);
function fitText(t, size, max, bold) {   // cut to the column width, with an ellipsis
  let c = pdfChars(t);
  if (textWidth(c, size, bold) <= max) return c;
  while (c.length && textWidth([...c, 0x85], size, bold) > max) c = c.slice(0, -1);
  return [...c, 0x85];
}
const pdfStr = codes => "(" + codes.map(n => n === 40 || n === 41 || n === 92 ? "\\" + String.fromCharCode(n) : String.fromCharCode(n)).join("") + ")";
// columns: [{ label, width (points), get(row) }]. Letter, landscape. Returns a Buffer.
function pdfTable({ title, lines = [], columns, rows, footer = "" }) {
  const W = 792, H = 612, M = 36, rowH = 15, size = 8.5;
  const pages = [];
  let ops = [], y = 0;
  const text = (x, yy, codes, sz, bold, gray) => ops.push(`BT /${bold ? "F2" : "F1"} ${sz} Tf ${gray ? "0.35 0.35 0.35 rg" : "0 0 0 rg"} ${x.toFixed(1)} ${yy.toFixed(1)} Td ${pdfStr(codes)} Tj ET`);
  const head = () => {
    let x = M; ops.push(`0.93 0.94 0.95 rg ${M} ${y - 4} ${W - 2 * M} ${rowH} re f`);
    for (const c of columns) { text(x + 3, y, fitText(c.label, size, c.width - 10, true), size, true); x += c.width; }
    y -= rowH;
  };
  const newPage = () => {
    if (ops.length) pages.push(ops);
    ops = []; y = H - M - 4;
    if (!pages.length) {
      text(M, y - 12, pdfChars(title), 16, true); y -= 30;
      for (const l of lines) { text(M, y, fitText(l, 9, W - 2 * M), 9, false, true); y -= 13; }
      y -= 8;
    }
    head();
  };
  newPage();
  rows.forEach((r, i) => {
    if (y < M + 24) newPage();
    if (i % 2) ops.push(`0.975 0.98 0.98 rg ${M} ${y - 4} ${W - 2 * M} ${rowH} re f`);
    let x = M;
    for (const c of columns) { text(x + 3, y, fitText(c.get(r), size, c.width - 10), size, false); x += c.width; }
    y -= rowH;
  });
  if (!rows.length) text(M + 3, y, pdfChars("No visits match."), size, false, true);
  pages.push(ops);
  // Assemble: catalog, page tree, two fonts, then a page + content stream per page.
  const objs = [], n = pages.length;
  const font = name => `<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`;
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${5 + i * 2} 0 R`).join(" ")}] >>`;
  objs[3] = font("Helvetica"); objs[4] = font("Helvetica-Bold");
  pages.forEach((p, i) => {
    const foot = `BT /F1 7.5 Tf 0.45 0.45 0.45 rg ${M} 20 Td ${pdfStr(pdfChars(footer))} Tj ET BT /F1 7.5 Tf ${W - M - 60} 20 Td ${pdfStr(pdfChars(`Page ${i + 1} of ${n}`))} Tj ET`;
    const data = require("zlib").deflateSync(Buffer.from([...p, foot].join("\n"), "latin1"));
    objs[5 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`;
    objs[6 + i * 2] = Buffer.concat([Buffer.from(`<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream", "latin1")]);
  });
  const parts = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")], offsets = [];
  let len = parts[0].length;
  for (let i = 1; i < objs.length; i++) {
    const body = Buffer.isBuffer(objs[i]) ? objs[i] : Buffer.from(objs[i], "latin1");
    const chunk = Buffer.concat([Buffer.from(`${i} 0 obj\n`, "latin1"), body, Buffer.from("\nendobj\n", "latin1")]);
    offsets[i] = len; parts.push(chunk); len += chunk.length;
  }
  const xref = `xref\n0 ${objs.length}\n0000000000 65535 f \n` + offsets.slice(1).map(o => String(o).padStart(10, "0") + " 00000 n \n").join("")
    + `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${len}\n%%EOF\n`;
  parts.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(parts);
}

/* ---------------- Leaving without checking out ("probably left") ---------------- */
// cfg.autoLeave { enabled, hours, checkout }: a visitor whose devices haven't been on the Wi-Fi for `hours` is shown as
// "probably left"; with checkout on, they're checked out (and their access ended). Only visits with tracked devices.
const autoLeaveCfg = () => ({ enabled: true, hours: 2, checkout: false, ...(cfg.autoLeave || {}) });
function lastDeviceSeen(r) {
  let last = 0;
  for (const d of Object.values(readDevices(r.id))) { const t = new Date(d.lastSeen || 0).getTime(); if (t > last) last = t; }
  return last || null;
}
function probablyLeft(r, now = Date.now()) {
  const a = autoLeaveCfg();
  if (!a.enabled || !onSite(r)) return false;
  const seen = lastDeviceSeen(r), limit = Math.max(0.5, Number(a.hours) || 2) * 3600e3;
  return !!seen && now - seen > limit && now - new Date(r.checkedInAt || 0) > limit;
}
async function autoCheckOut() {
  const a = autoLeaveCfg();
  if (!a.enabled || !a.checkout) return;
  for (const r of listVisits(5000)) if (probablyLeft(r)) {
    await checkOut(r, `automatically (no device on the Wi-Fi for ${a.hours} h)`);
    audit(null, "Visitor Desk", "Checked a visitor out automatically", `${r.name}: no device seen for ${a.hours} h`);
  }
}

/* ---------------- Emergency message and roll call ---------------- */
// data/emergencies.json (newest last, last 50 kept): [{ id, at, by, message, mode, recipients: [{ visitId, name, company,
// host, phone, email, sms, emailed, error }], safe: { visitId: { at, by } }, endedAt, endedBy }].
// Visitors can't answer back (their phones usually can't reach the kiosk server), so staff mark people safe.
const EMERG_PATH = path.join(ROOT, "data", "emergencies.json");
const readEmerg = () => { try { return JSON.parse(fs.readFileSync(EMERG_PATH, "utf8")); } catch { return []; } };
function writeEmerg(list) { fs.mkdirSync(path.dirname(EMERG_PATH), { recursive: true }); fs.writeFileSync(EMERG_PATH, JSON.stringify(list.slice(-50), null, 2), { mode: 0o600 }); }
const emergencyPeople = mode => listVisits(5000).filter(r => mode === "connected" ? connectedNow(r) : onSite(r));
async function startEmergency(b, by) {
  const message = String(b.message || "").trim().slice(0, 300);
  if (message.length < 5) throw Object.assign(new Error("Write the message to send"), { status: 400 });
  const canSms = !!cfg.notifications?.sms?.accountSid, canEmail = !!cfg.notifications?.email?.host;
  if (!(b.sms && canSms) && !(b.email && canEmail)) throw Object.assign(new Error("Choose text or email (set up under Email and text messages)"), { status: 400 });
  const mode = b.mode === "connected" ? "connected" : "checkedin", place = readSharedLook()?.orgName;
  const ev = { id: crypto.randomUUID(), at: new Date().toISOString(), by, message, mode, recipients: [], safe: {}, endedAt: null };
  const text = `${place ? place + ": " : ""}${message}`;
  const people = emergencyPeople(mode);
  for (let i = 0; i < people.length; i += 5) {   // five at a time
    await Promise.all(people.slice(i, i + 5).map(async r => {
      const x = { visitId: r.id, name: r.name, company: r.company || "", host: r.host || "", phone: r.phone || "", email: r.email || "",
        sms: false, emailed: false, probablyLeft: probablyLeft(r), error: "" };
      if (b.sms && canSms && r.phone) await sendText(r.phone, text).then(() => x.sms = true, e => x.error = e.message);
      if (b.email && canEmail && r.email) await sendEmail(r.email, `${place ? place + ": " : ""}Important message`, `${message}\n\nSent to visitors on site by ${place || "Visitor Desk"}.`)
        .then(() => x.emailed = true, e => x.error = x.error || e.message);
      ev.recipients.push(x);
    }));
  }
  ev.recipients.sort((a, b) => a.name.localeCompare(b.name));
  // A follow-up message (for example "All clear") replaces the open roll call and keeps who was already marked safe.
  const list = readEmerg(), open = list.filter(x => !x.endedAt).pop();
  if (open) { for (const [id, mark] of Object.entries(open.safe)) if (ev.recipients.some(x => x.visitId === id)) ev.safe[id] = mark; open.endedAt = ev.at; open.endedBy = by; }
  list.push(ev); writeEmerg(list);
  staffAlert("emergency", `Emergency message sent by ${by}`, `"${message}" was sent to ${ev.recipients.length} visitor${ev.recipients.length === 1 ? "" : "s"} on site. Roll call: Visitor records > On site now.`).catch(() => {});
  console.log(`EMERGENCY message sent by "${by}" to ${ev.recipients.length} visitors.`);
  return ev;
}

/* ---------------- Hosts' own invite links, and "On my way" ---------------- */
// cfg.hostLinks { "<host name, lower case>": token }. A host's link opens a small page (/host/<token>) where they add
// their own expected visitors. Arrival alerts carry an "On my way" link (/onmyway/<visit hostToken>); the kiosk's pass
// screen shows it, and the visitor gets a text when one can be sent.
const hostLinks = () => (cfg.hostLinks ||= {});
function hostByToken(token) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || ""))) return null;
  for (const [key, t] of Object.entries(hostLinks()))
    if (t.length === token.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token))) return hostList().find(h => h.name.trim().toLowerCase() === key) || null;
  return null;
}
function hostLink(req, name, make = true) {
  const key = name.trim().toLowerCase(), links = hostLinks();
  if (!links[key] && make) { links[key] = crypto.randomBytes(24).toString("base64url"); saveConfig(); }
  return links[key] ? `${publicBase(req)}/host/${links[key]}` : null;
}
// The address people use to reach this server (from the request), always https when it's on.
function publicBase(req) {
  const host = String(req.headers.host || "localhost").replace(/:\d+$/, "");
  return HTTPS_PORT ? `https://${host}${HTTPS_PORT === 443 ? "" : ":" + HTTPS_PORT}` : `http://${req.headers.host || "localhost"}`;
}
async function sendHostLink(req, h) {
  const url = hostLink(req, h.name), place = readSharedLook()?.orgName;
  const text = `Hi ${firstName(h.name)}, add your own expected visitors${place ? ` at ${place}` : ""} here: ${url}\nThey get a code so checking in takes seconds. Keep this link to yourself.`;
  if (h.email && cfg.notifications?.email?.host) { await sendEmail(h.email, "Your link for adding visitors", text + "\n\nSent by Visitor Desk."); return "email"; }
  if (h.phone && cfg.notifications?.sms?.accountSid) { await sendText(h.phone, text); return "text"; }
  throw new Error("No email or mobile for this host, or email and texts aren't set up");
}
const recentVisitBy = (field, token) => {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || ""))) return null;
  return listVisits(3000).find(r => r[field] && r[field].length === token.length && crypto.timingSafeEqual(Buffer.from(r[field]), Buffer.from(token))) || null;
};
async function hostOnWay(rec) {
  if (rec.hostOnWayAt) return rec;
  rec.hostOnWayAt = new Date().toISOString(); writeVisit(rec);
  if (rec.phone && cfg.notifications?.sms?.accountSid)
    await sendText(rec.phone, `${rec.host || "Your host"} is on the way to meet you.`).catch(e => printError(`"On my way" text to ${rec.name} failed: ${e.message}`));
  console.log(`${rec.host} is on the way to meet ${rec.name}.`);
  return rec;
}
// Small self-contained pages for hosts (no staff sign-in): their visitors page and the "On my way" button.
function hostPage(res, title, bodyHtml, script) {
  const nonce = crypto.randomBytes(16).toString("base64");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>
:root{--bg:#f4f5f5;--card:#fff;--ink:#1d2526;--muted:#5c6667;--line:#d9dede;--brand:#F47920;--ok:#1F7A4D;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#121616;--card:#1b2121;--ink:#eef2f2;--muted:#a3adae;--line:#2f3838;--ok:#6FD39C;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:44rem;margin:0 auto;padding:1.25rem 1rem 3rem}h1{font-size:1.6rem;margin:.25rem 0}h2{font-size:1.15rem;margin:1.5rem 0 .5rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1rem;margin:.6rem 0}
label{display:block;font-weight:600;font-size:.9rem;margin:.6rem 0 .25rem}input,select{width:100%;font:inherit;padding:.65rem .7rem;border:1.5px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}
.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(12rem,1fr));gap:0 .8rem}.muted{color:var(--muted);font-size:.9rem}
button{font:600 1rem system-ui,sans-serif;border-radius:8px;padding:.7rem 1.1rem;border:1.5px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer}
button.primary{background:var(--brand);border-color:var(--brand);color:#fff}.code{font:700 1.3rem ui-monospace,monospace;letter-spacing:.08em}
.item{display:flex;gap:1rem;justify-content:space-between;align-items:center;flex-wrap:wrap}.ok{color:var(--ok);font-weight:700}.err{color:#c0392b}
.check{display:flex;gap:.5rem;align-items:center;font-weight:400}.check input{width:auto}
</style></head><body><main>${bodyHtml}</main>${script ? `<script nonce="${nonce}">${script}</script>` : ""}</body></html>`;
  res.writeHead(200, secHeaders(res, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` }));
  res.end(html);
}
const HOST_SCRIPT = `
const $ = s => document.querySelector(s), api = (m, p, b) => fetch(location.pathname.replace(/^\\/host\\//, "/api/host/") + p, { method: m,
  headers: b ? { "Content-Type": "application/json" } : {}, body: b ? JSON.stringify(b) : undefined }).then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || "Something went wrong"); return j; });
const esc = t => String(t ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const day = d => new Date(d + "T12:00").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
const time = t => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
async function load() {
  let j; try { j = await api("GET", ""); } catch (e) { $("#list").innerHTML = '<p class="err">' + esc(e.message) + '</p>'; return; }
  $("#arrived").innerHTML = j.arrivals.length ? j.arrivals.map(a => '<div class="card item"><span><b>' + esc(a.name) + '</b>' + (a.company ? ' · ' + esc(a.company) : '') + '<br><span class="muted">Checked in ' + time(a.checkedInAt) + '</span></span>'
    + (a.onWayAt ? '<span class="ok">You\\'re on your way</span>' : '<button data-way="' + a.id + '">On my way</button>') + '</div>').join("") : '<p class="muted">Nobody yet today.</p>';
  $("#list").innerHTML = j.invites.length ? j.invites.map(i => '<div class="card item"><span><b>' + esc(i.name) + '</b>' + (i.company ? ' · ' + esc(i.company) : '')
    + '<br><span class="muted">' + day(i.from) + (i.until > i.from ? ' to ' + day(i.until) : '') + (i.usedAt ? ' · checked in' : '') + '</span></span>'
    + (i.usedAt ? '' : '<span><span class="muted">Code</span> <span class="code">' + esc(i.code) + '</span> ' + (i.email ? '<button data-send="email" data-id="' + i.id + '">Email code</button> ' : '') + (i.phone ? '<button data-send="text" data-id="' + i.id + '">Text code</button> ' : '') + '<button data-del="' + i.id + '">Remove</button></span>') + '</div>').join("") : '<p class="muted">No expected visitors yet.</p>';
  document.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => { if (!confirm("Remove this visitor? Their code stops working.")) return; await api("DELETE", "/invites/" + b.dataset.del).catch(e => alert(e.message)); load(); });
  document.querySelectorAll("[data-send]").forEach(b => b.onclick = async () => { b.disabled = true; try { await api("POST", "/invites/" + b.dataset.id + "/" + b.dataset.send); b.textContent = "Sent"; } catch (e) { alert(e.message); b.disabled = false; } });
  document.querySelectorAll("[data-way]").forEach(b => b.onclick = async () => { b.disabled = true; try { await api("POST", "/arrivals/" + b.dataset.way + "/onmyway"); load(); } catch (e) { alert(e.message); b.disabled = false; } });
}
$("#from").value = new Date(Date.now() - new Date().getTimezoneOffset() * 60e3).toISOString().slice(0, 10);
$("#add").onclick = async () => {
  const v = id => $(id).value.trim(); $("#msg").textContent = "Adding…";
  try { const r = await api("POST", "/invites", { name: v("#name"), email: v("#email"), phone: v("#phone"), company: v("#company"), purpose: v("#purpose"),
      from: v("#from"), until: v("#until") || v("#from"), note: v("#note"), sendEmail: $("#sendEmail").checked, sendText: $("#sendText").checked });
    $("#msg").textContent = r.invite.name + "'s code is " + r.invite.code + "." + (r.invite.emailedAt ? " Emailed." : "") + (r.invite.textedAt ? " Texted." : "") + (r.emailError || r.textError ? " Not sent: " + (r.emailError || r.textError) : "");
    ["#name", "#email", "#phone", "#company", "#until", "#note"].forEach(id => $(id).value = ""); load();
  } catch (e) { $("#msg").textContent = e.message; }
};
load(); setInterval(load, 60000);`;

/* ---------------- Visit analytics ---------------- */
// Visits between two dates (the browser's local days; tz = getTimezoneOffset minutes). Visit length: check-out, else the
// last time a device was seen on the Wi-Fi; visits with neither aren't measured. Wi-Fi data from RUCKUS One's session
// history (about 4 weeks; read in bulk and matched by MAC, cached 10 minutes).
let historyCache = { at: 0, rows: [] };
async function sessionHistory() {
  if (Date.now() - historyCache.at < 10 * 60e3) return historyCache.rows;
  const rows = [];
  for (let page = 1; page <= 6; page++) {
    const r = listOf(await r1("POST", "/historicalClients/query", { page, pageSize: 500, fields: ["clientMac", "rxBytes", "txBytes", "event_datetime"] }));
    rows.push(...r); if (r.length < 500) break;
  }
  historyCache = { at: Date.now(), rows }; return rows;
}
async function analytics(q) {
  const tz = Number(q.get("tz")) || 0, DAY = /^\d{4}-\d{2}-\d{2}$/;
  const to = DAY.test(q.get("to") || "") ? q.get("to") : new Date(Date.now() - tz * 60e3).toISOString().slice(0, 10);
  const from = DAY.test(q.get("from") || "") ? q.get("from") : new Date(new Date(to).getTime() - 29 * 864e5).toISOString().slice(0, 10);
  const local = t => new Date(new Date(t).getTime() - tz * 60e3);
  const all = listVisits(1e6).filter(r => r.status !== "blocked");
  const rows = all.filter(r => { const d = local(r.checkedInAt).toISOString().slice(0, 10); return d >= from && d <= to; });
  const who = r => String(r.email || "").toLowerCase() || normPhone(r.phone) || normName(r.name);
  const counts = new Map(); for (const r of rows) counts.set(who(r), (counts.get(who(r)) || 0) + 1);
  const firstSeen = new Map(); for (const r of all) { const k = who(r), t = r.checkedInAt; if (!firstSeen.has(k) || t < firstSeen.get(k)) firstSeen.set(k, t); }
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0)), byDay = new Map();
  for (let d = new Date(from); d <= new Date(to) && byDay.size < 400; d = new Date(d.getTime() + 864e5)) byDay.set(d.toISOString().slice(0, 10), 0);
  const durations = [], apMinutes = new Map(), macs = new Map();
  let devTotal = 0, tracked = 0;
  for (const r of rows) {
    const t = local(r.checkedInAt); heat[t.getUTCDay()][t.getUTCHours()]++;
    const dk = t.toISOString().slice(0, 10); if (byDay.has(dk)) byDay.set(dk, byDay.get(dk) + 1);
    const devs = Object.values(readDevices(r.id));
    if (devs.length) { tracked++; devTotal += devs.length; }
    for (const d of devs) {
      macs.set(d.mac, r);
      for (const s of d.timeline || []) apMinutes.set(s.ap, (apMinutes.get(s.ap) || 0) + Math.max(0, (new Date(s.to) - new Date(s.from)) / 60000));
    }
    const end = r.checkedOutAt ? new Date(r.checkedOutAt).getTime() : lastDeviceSeen(r);
    if (end && end > new Date(r.checkedInAt).getTime()) durations.push((end - new Date(r.checkedInAt).getTime()) / 60000);
  }
  durations.sort((a, b) => a - b);
  const tally = (vals, n = 8) => { const m = new Map(); for (const v of vals) if (v) m.set(v, (m.get(v) || 0) + 1); return [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count })); };
  const buckets = [["Under 30 min", 30], ["30 min to 1 h", 60], ["1 to 2 h", 120], ["2 to 4 h", 240], ["4 to 8 h", 480], ["8 h or more", Infinity]]
    .map(([label, max], i, a) => ({ label, count: durations.filter(m => m >= (i ? a[i - 1][1] : 0) && m < max).length }));
  let wifi = null;
  if (R1.clientSecret && macs.size) {
    try {
      const per = new Map();
      for (const h of await sessionHistory()) { const r = macs.get(normMac(h.clientMac)); if (!r) continue;
        const k = r.id, cur = per.get(k) || { name: r.name, mode: r.mode, bytes: 0 }; cur.bytes += (Number(h.rxBytes) || 0) + (Number(h.txBytes) || 0); per.set(k, cur); }
      const list = [...per.values()];
      wifi = { total: list.reduce((n, x) => n + x.bytes, 0), visitors: list.length, top: list.sort((a, b) => b.bytes - a.bytes).slice(0, 8) };
    } catch (e) { wifi = { error: e.message }; }
  }
  const repeat = [...counts.values()].filter(n => n > 1).length;
  return { from, to, visits: rows.length, unique: counts.size, repeat, returning: [...counts.keys()].filter(k => firstSeen.get(k) < from).length,
    firstTime: [...counts.keys()].filter(k => local(firstSeen.get(k)).toISOString().slice(0, 10) >= from).length,
    length: { measured: durations.length, average: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
      median: durations.length ? Math.round(durations[Math.floor(durations.length / 2)]) : null, buckets },
    heat, days: [...byDay].map(([day, count]) => ({ day, count })),
    hosts: tally(rows.map(r => r.host)), companies: tally(rows.map(r => r.company)), reasons: tally(rows.map(r => r.purpose)),
    modes: tally(rows.map(r => ({ portal: "Guest pass", dpsk: "Personal password", psk: "Shared password" })[r.mode] || r.mode)),
    devices: { tracked, perVisitor: tracked ? Math.round(devTotal / tracked * 10) / 10 : null },
    places: [...apMinutes].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, minutes]) => ({ name, hours: Math.round(minutes / 6) / 10 })),
    checkouts: { kiosk: rows.filter(r => /kiosk/.test(r.checkedOutBy || "")).length, staff: rows.filter(r => r.checkedOutAt && !/kiosk|automatic/.test(r.checkedOutBy || "")).length,
      automatic: rows.filter(r => /automatic/.test(r.checkedOutBy || "")).length, none: rows.filter(r => !r.checkedOutAt).length },
    invited: rows.filter(r => r.inviteId).length, wifi };
}

/* ---------------- Updates from the admin panel (the VM) ---------------- */
// An admin uploads a signed .kup; it's checked here (same Ed25519 key as `kiosk update`) and staged. "Install" drops it
// in data/updates/incoming.kup, where the VM's kiosk-web-update.path (root) picks it up and runs kiosk-update, which
// checks the signature again, installs, restarts and rolls back on failure. This server never installs anything itself.
const UPDATE_DIR = env.KIOSK_UPDATE_DIR || path.join(ROOT, "data", "updates");
const UPDATE_PUB = env.KIOSK_UPDATE_PUB || "/etc/visitor-kiosk/update-signing.pub";
const updatesOn = () => fs.existsSync(UPDATE_PUB) && (!!env.KIOSK_UPDATE_PUB || fs.existsSync("/etc/systemd/system/kiosk-web-update.path"));
function tarEntries(buf) {   // USTAR: 512-byte headers, octal sizes, data padded to 512
  const out = [];
  for (let o = 0; o + 512 <= buf.length;) {
    const name = buf.toString("utf8", o, o + 100).replace(/\0.*$/s, ""), prefix = buf.toString("utf8", o + 345, o + 500).replace(/\0.*$/s, "");
    if (!name) break;
    const size = parseInt(buf.toString("utf8", o + 124, o + 136).replace(/\0.*$/s, "").trim() || "0", 8), type = buf.toString("utf8", o + 156, o + 157);
    out.push({ name: (prefix ? prefix + "/" : "") + name, type, data: buf.subarray(o + 512, o + 512 + size) });
    o += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}
function readKup(buf) {
  const bad = m => Object.assign(new Error(m), { status: 400 });
  let parts; try { parts = tarEntries(buf); } catch { throw bad("That isn't a Visitor Desk update file (.kup)."); }
  const tgz = parts.find(p => p.name === "update.tar.gz")?.data, sig = parts.find(p => p.name === "update.sig")?.data;
  if (!tgz || !sig) throw bad("That isn't a Visitor Desk update file (.kup).");
  let ok = false; try { ok = crypto.verify(null, tgz, crypto.createPublicKey(fs.readFileSync(UPDATE_PUB)), sig); } catch {}
  if (!ok) throw bad("This update isn't signed with this VM's update key, so it can't be installed.");
  let inner; try { inner = tarEntries(require("zlib").gunzipSync(tgz)); } catch { throw bad("The update file is damaged."); }
  let ver = {}; try { ver = JSON.parse(inner.find(p => p.name === "app/.version.json").data.toString()); } catch { throw bad("The update has no version information."); }
  return { version: String(ver.version || "?"), build: String(ver.build || ""), node: inner.some(p => p.name.startsWith("node/bin/node")), size: buf.length };
}
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", c => { n += c.length; if (n > limit) { reject(Object.assign(new Error("That file is too big for an update."), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks))); req.on("error", reject);
  });
}
// The version this process runs: read once at start. During an update the new files are copied in before the restart,
// so reading .version.json later would report the new version while the old one still runs.
const RUNNING = readJson(path.join(ROOT, ".version.json")) || { version: require(path.join(ROOT, "package.json")).version, build: "" };
function updateInfo() {
  const cur = RUNNING;
  let log = ""; try { log = fs.readFileSync(path.join(UPDATE_DIR, "last.log"), "utf8").trim().split("\n").slice(-40).join("\n"); } catch {}
  return { available: updatesOn(), current: cur, node: process.version,
    previous: readJson("/opt/visitor-kiosk-previous/app/.version.json"),
    staged: fs.existsSync(path.join(UPDATE_DIR, "staged.kup")) ? readJson(path.join(UPDATE_DIR, "staged.json")) : null,
    status: settled(readJson(path.join(UPDATE_DIR, "status.json")), cur), log };
}
// Right after the restart the installer may not have written "done" yet: if the new version is already running, say so.
function settled(st, cur) {
  if (!st || !["queued", "installing", "rolling-back"].includes(st.state) || !st.from || st.from === cur.version) return st;
  return { ...st, state: st.rollback || st.state === "rolling-back" ? "rolled-back" : "done", to: cur.version };
}

/* ---------------- Network settings (admins, on the VM) ----------------
   Like updates: the server only drops a request in data/system; root's kiosk-netcfg (vm/files) checks it again and
   applies it. A new address, gateway or DHCP/static must be confirmed within 3 minutes or it's undone. */
const NET_DIR = env.KIOSK_NET_DIR || path.join(ROOT, "data", "system");
const netOn = () => !!env.KIOSK_NET_DIR || (fs.existsSync("/usr/local/sbin/kiosk-netcfg") && fs.existsSync("/etc/systemd/system/kiosk-netcfg.path"));
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
// The same checks as validate() in vm/files/kiosk-netcfg (test/network.test.js keeps them in step).
function netSettings(s = {}) {
  const bad = m => { throw Object.assign(new Error(m), { status: 400 }); };
  const ipNum = ip => ip.split(".").reduce((n, o) => n * 256 + Number(o), 0);
  const list = v => (Array.isArray(v) ? v : String(v ?? "").split(/[\s,]+/)).map(x => String(x).trim()).filter(Boolean);
  const out = { mode: s.mode === "static" ? "static" : s.mode === "dhcp" ? "dhcp" : bad("Choose DHCP or a static address.") };
  out.dns = list(s.dns); out.search = list(s.search).map(d => d.toLowerCase()); out.ntp = list(s.ntp).map(d => d.toLowerCase());
  if (out.mode === "static") {
    let addr = String(s.address || "").trim(), prefix = s.prefix;
    if (addr.includes("/")) [addr, prefix] = addr.split("/");
    prefix = Number(prefix);
    if (!IPV4_RE.test(addr)) bad("Use an IP address like 192.168.10.50.");
    if (!Number.isInteger(prefix) || prefix < 8 || prefix > 30) bad("Use a prefix from 8 to 30 (24 is 255.255.255.0).");
    const first = Number(addr.split(".")[0]);
    if (first === 0 || first === 127 || first >= 224) bad(`${addr} can't be used as this VM's address.`);
    const mask = (0xffffffff << (32 - prefix)) >>> 0, net = (ipNum(addr) & mask) >>> 0, bcast = (net | ~mask) >>> 0;
    if (ipNum(addr) === net || ipNum(addr) === bcast) bad(`${addr}/${prefix} is the network's own or broadcast address. Pick another address.`);
    const gw = String(s.gateway || "").trim();
    if (!IPV4_RE.test(gw)) bad("Use a gateway like 192.168.10.1.");
    if (((ipNum(gw) & mask) >>> 0) !== net) bad(`The gateway ${gw} isn't on the ${addr}/${prefix} network.`);
    if (gw === addr) bad("The gateway can't be this VM's own address.");
    if (!out.dns.length) bad("Add at least one DNS server.");
    Object.assign(out, { address: addr, prefix, gateway: gw });
  }
  if (out.dns.length > 3) bad("Use at most 3 DNS servers.");
  for (const d of out.dns) if (!IPV4_RE.test(d)) bad(`"${d}" isn't an IPv4 address (DNS servers are addresses, like 1.1.1.1).`);
  if (out.search.length > 3) bad("Use at most 3 search domains.");
  for (const d of out.search) if (!HOST_RE.test(d)) bad(`"${d}" isn't a domain name.`);
  if (out.ntp.length > 4) bad("Use at most 4 time (NTP) servers.");
  for (const d of out.ntp) if (!HOST_RE.test(d)) bad(`"${d}" isn't a server name or address.`);
  return out;
}
function netInfo() {
  let st = readJson(path.join(NET_DIR, "network-status.json"));
  // Picked up within seconds on the VM; a request still waiting after 2 minutes means the watcher isn't running.
  if (st?.state === "queued" && Date.now() - Date.parse(st.at) > 120e3)
    st = { ...st, state: "failed", message: "The VM didn't pick up the change. Restart the VM, or use \"kiosk network\" on the console." };
  return { available: netOn(), state: readJson(path.join(NET_DIR, "network-state.json")), status: st };
}

/* ---------------- Privacy requests: everything about one person ---------------- */
function personMatches(q) {
  const s = String(q || "").trim();
  const kind = s.includes("@") ? "email" : s.replace(/\D/g, "").length >= 7 ? "phone" : "name";
  const want = kind === "email" ? s.toLowerCase() : kind === "phone" ? normPhone(s) : normName(s);
  if (!want || (kind === "name" && want.length < 3)) return { kind, visits: [], invites: [], blocks: [] };
  const hit = (email, phone, name) => kind === "email" ? String(email || "").toLowerCase() === want : kind === "phone" ? normPhone(phone) === want : normName(name) === want;
  return { kind,
    visits: listVisits(1e6).filter(r => hit(r.email, r.phone, r.name)),
    invites: readInvites().filter(i => hit(i.email, i.phone, i.name)),
    blocks: readBlocks().filter(b => kind === "email" ? b.email === want : kind === "phone" ? b.phone === want : b.name === want) };
}

/* ---------------- "check" command ---------------- */
async function check() {
  const show = (title, items, fmt) => {
    console.log(`\n${title}`);
    if (!items.length) return console.log("  (none found)");
    for (const x of items) console.log("  " + fmt(x));
  };
  console.log(`Region: ${R1.region}   Tenant: ${R1.tenantId}`);
  await getToken();
  console.log("Login OK.");
  const d = await discover();
  show("Venues:", d.venues, v => `${String(v.name).padEnd(32)} ${v.id}`);
  show("Wi-Fi networks:", d.networks, n => `${String(n.ssid).padEnd(32)} ${n.id}  ${n.type}`);
  show("DPSK services:", d.dpskServices, x => `${String(x.name).padEnd(32)} ${x.id}`);
  for (const [k, e] of Object.entries(d.errors)) console.log(`\nCouldn't list ${k}: ${e}`);
}

// Loaded by the tests (require), it only provides its functions; run with node, it starts the kiosk server.
if (require.main !== module) {
  module.exports = { makePassword, poolRule, passwordFromRule, ruleStrength, e164, normMac, r1Time, firstName, onSite, onlineNow,
    pdfTable, fitText, pdfChars, zoned, zonedMidnight, summaryPeriod, cleanInvite, blockedMatch, normName, normPhone, totp, base32, unbase32,
    hashPassword, passwordMatches, esc, deviceBrief, devLabel, tarEntries, readKup, netSettings, cleanExtra, cleanQuestions };
} else if (process.argv[2] === "check") {
  check().catch(e => { console.error(e.message); process.exit(1); });
} else if (process.argv[2] === "reset-admin") {
  const before = users().length;
  if (cfg.security) { cfg.security.users = users().filter(u => u.role !== "admin"); delete cfg.security.admin; delete cfg.security.adminKey; }
  saveConfig();
  audit(null, "console", "Reset admin users (kiosk reset-admin)", `${before - users().length} removed`);
  console.log(`Removed ${before - users().length} admin user(s); reception users kept. Restart the server, then create a new admin in the admin panel.`);
} else {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  cleanupOldVisits();
  if (!R1.tenantId) console.log("RUCKUS One isn't connected yet. Open http://localhost:" + Number(env.PORT || cfg.port || 3000) + " on this computer, then Admin > RUCKUS One connection.");
  setInterval(cleanupOldVisits, 6 * 3600e3);
  setTimeout(trackDevices, 20e3); setInterval(trackDevices, 2 * 60e3);
  // Every minute (the tests shorten it with KIOSK_TICK_MS).
  setInterval(() => { checkTablets(); maybeSendSummary(); autoCheckOut().catch(e => printError(`Automatic check-out: ${e.message}`)); }, Number(env.KIOSK_TICK_MS) || 60e3);
  cleanupInvites(); setInterval(cleanupInvites, 6 * 3600e3);
  migrateUsers(); ensureSetupCode();
  if (SETUP_CODE) console.log(`No admin user yet. Create one in the admin panel. From another device you'll need this setup code: ${SETUP_CODE}`);
  const port = Number(env.PORT || cfg.port || 3000);
  const httpsPort = Number(env.HTTPS_PORT || cfg.https?.port || 3443);
  let tlsOpts = null;
  if (cfg.https?.enabled !== false) {
    try { tlsOpts = ensureCerts(); }
    catch (e) { console.error(`HTTPS is off: couldn't make certificates with openssl (${e.stderr?.toString().trim() || e.message}). The tablet camera needs HTTPS.`); }
  }
  server.listen(port, "0.0.0.0", () => {
    console.log(`Kiosk server running. Region: ${R1.region}`);
    console.log(`  On this computer:  http://localhost:${port}`);
    if (!tlsOpts) for (const ip of lanAddresses()) console.log(`  On the kiosk tablet: http://${ip}:${port}`);
  });
  if (tlsOpts) {
    const secure = https.createServer(tlsOpts, handle);
    secure.listen(httpsPort, "0.0.0.0", () => {
      HTTPS_PORT = httpsPort;
      for (const ip of lanAddresses()) {
        console.log(`  On the kiosk tablet: https://${ip}:${httpsPort}`);
        console.log(`  First time on a tablet, open http://${ip}:${port}/setup to install the kiosk certificate.`);
      }
    });
    // Pick up a new network address (new certificate) without a restart.
    setInterval(() => { try { const t = ensureCerts(); secure.setSecureContext(t); } catch {} }, 10 * 60e3);
  }
}
