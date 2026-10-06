// Unit tests for the server's helper functions (loaded from a throwaway copy, so the real config.json isn't read).
const test = require("node:test"), assert = require("node:assert/strict"), path = require("path"), zlib = require("zlib");
const { loadServer } = require("./helpers");
const S = loadServer();

test("visitor passwords have the promised shapes", () => {
  assert.match(S.makePassword("words", 8), /^[a-z]+-[a-z]+-[a-z]+-\d{4}$/);
  assert.match(S.makePassword("digits", 8), /^\d{12}$/);
  assert.match(S.makePassword("mixed", 8), /^[A-Z2-9]{12}$/);
  const many = new Set(Array.from({ length: 200 }, () => S.makePassword("words", 8)));
  assert.ok(many.size > 195, "passwords repeat too often");
});

test("DPSK passwords follow the pool's passphrase format", () => {
  const words = S.poolRule({ passphraseFormat: "DICTIONARY_WORDS", wordCount: 4, numericSuffixEnabled: true });
  assert.match(S.passwordFromRule(words), /^[a-z]+(-[a-z]+){3}\d{3}$/);
  const digits = S.poolRule({ passphraseFormat: "NUMBERS_ONLY", passphraseLength: 8 });
  assert.match(S.passwordFromRule(digits), /^\d{8}$/);
  assert.equal(S.ruleStrength(digits).weak, true, "8 digits is easy to guess");
  const secure = S.poolRule({ passphraseFormat: "MOST_SECURED", passphraseLength: 16 });
  assert.equal(S.passwordFromRule(secure).length, 16);
  assert.equal(S.ruleStrength(secure).weak, false);
  assert.equal(S.poolRule({}), null, "no format: the kiosk's own style is used");
  assert.equal(S.poolRule({ passphraseFormat: "NUMBERS_ONLY", passphraseLength: 3 }).length, 8, "never shorter than 8");
});

test("phone numbers become E.164", () => {
  assert.equal(S.e164("813-555-0142"), "+18135550142");
  assert.equal(S.e164("(813) 555 0142"), "+18135550142");
  assert.equal(S.e164("+44 20 7946 0958"), "+442079460958");
  assert.equal(S.e164(""), undefined);
});

test("MAC addresses in any form become one form", () => {
  for (const m of ["F2:44:CD:84:32:EE", "f244cd8432ee", "f2-44-cd-84-32-ee"]) assert.equal(S.normMac(m), "f2:44:cd:84:32:ee");
});

test("RUCKUS One times: ISO, '+0000' and epoch", () => {
  assert.equal(S.r1Time("2026-10-01 13:05:00.000 +0000"), "2026-10-01T13:05:00.000Z");
  assert.equal(S.r1Time("2026-10-01T13:05:00"), "2026-10-01T13:05:00.000Z", "no zone means UTC");
  assert.equal(S.r1Time(1790000000), new Date(1790000000 * 1000).toISOString());
  assert.equal(S.r1Time(""), null);
});

test("first names, including 'Last, First'", () => {
  assert.equal(S.firstName("Jordan Lee"), "Jordan");
  assert.equal(S.firstName("Lee, Jordan"), "Jordan");
  assert.equal(S.firstName(""), "");
});

test("who is on site", () => {
  const soon = new Date(Date.now() + 3600e3).toISOString(), past = new Date(Date.now() - 3600e3).toISOString();
  assert.equal(S.onSite({ passExpiresAt: soon }), true);
  assert.equal(S.onSite({ passExpiresAt: past }), false);
  assert.equal(S.onSite({ passExpiresAt: soon, checkedOutAt: past }), false);
  assert.equal(S.onSite({ passExpiresAt: soon, status: "blocked" }), false);
  assert.equal(S.onSite({ passExpiresAt: soon, revokedAt: past }), false);
});

test("a device's 'online' flag goes stale when tracking stops seeing it", () => {
  assert.equal(S.onlineNow({ online: true, lastSeen: new Date().toISOString() }), true);
  assert.equal(S.onlineNow({ online: true, lastSeen: new Date(Date.now() - 30 * 60e3).toISOString() }), false);
  assert.equal(S.onlineNow({ online: false, lastSeen: new Date().toISOString() }), false);
});

test("two-step sign-in codes match RFC 6238", () => {
  const secret = S.base32(Buffer.from("12345678901234567890"));
  assert.equal(S.totp(secret, Math.floor(59 / 30)), "287082");          // RFC 6238 test vector (last 6 digits)
  assert.equal(S.totp(secret, Math.floor(1111111109 / 30)), "081804");
  assert.deepEqual(S.unbase32(secret), Buffer.from("12345678901234567890"));
});

test("passwords are hashed and checked", () => {
  const h = S.hashPassword("Correct-Horse-1");
  assert.ok(!JSON.stringify(h).includes("Correct-Horse-1"));
  assert.equal(S.passwordMatches(h, "Correct-Horse-1"), true);
  assert.equal(S.passwordMatches(h, "wrong"), false);
});

test("invites are checked", () => {
  const ok = S.cleanInvite({ name: "Jordan Lee", email: "JORDAN@ACME.COM", from: "2026-10-03" });
  assert.equal(ok.until, "2026-10-03"); assert.equal(ok.email, "jordan@acme.com");
  assert.throws(() => S.cleanInvite({ name: "J", from: "2026-10-03" }), /name/);
  assert.throws(() => S.cleanInvite({ name: "Jordan", from: "10/3/2026" }), /day/);
  assert.throws(() => S.cleanInvite({ name: "Jordan", from: "2026-10-05", until: "2026-10-03" }), /day/);
  assert.throws(() => S.cleanInvite({ name: "Jordan", from: "2026-10-01", until: "2026-12-01" }), /31 days/);
  assert.throws(() => S.cleanInvite({ name: "Jordan", email: "nope", from: "2026-10-03" }), /email/);
});

test("time zones for the summary email (daylight saving included)", () => {
  assert.equal(S.zonedMidnight(2026, 7, 1, "America/New_York").toISOString(), "2026-07-01T04:00:00.000Z");
  assert.equal(S.zonedMidnight(2026, 12, 1, "America/New_York").toISOString(), "2026-12-01T05:00:00.000Z");
  assert.equal(S.zonedMidnight(2026, 3, 8, "America/New_York").toISOString(), "2026-03-08T05:00:00.000Z");   // the day the clocks change
  const p = S.summaryPeriod({ frequency: "daily", timeZone: "America/New_York" }, new Date("2026-10-02T12:00:00Z"));
  assert.equal(p.from.toISOString(), "2026-10-01T04:00:00.000Z"); assert.equal(p.to.toISOString(), "2026-10-02T04:00:00.000Z");
});

test("PDF report: valid structure, cross-reference offsets point at their objects", () => {
  const pdf = S.pdfTable({ title: "Visitor report", lines: ["2 visits"], footer: "test",
    columns: [{ label: "Name", width: 100, get: r => r.name }, { label: "Company", width: 100, get: r => r.c }],
    rows: Array.from({ length: 60 }, (_, i) => ({ name: i ? `Visitor ${i}` : "José Ñúñez (Müller) — a very long name that gets cut", c: "Café" })) });
  const text = pdf.toString("latin1");
  assert.ok(text.startsWith("%PDF-1.4")); assert.ok(text.trimEnd().endsWith("%%EOF"));
  const at = text.lastIndexOf("\nxref\n") + 1, offsets = [...text.slice(at).matchAll(/^(\d{10}) 00000 n $/gm)].map(m => Number(m[1]));
  assert.ok(offsets.length >= 6, "catalog, pages, 2 fonts, 2 pages");
  offsets.forEach((o, i) => assert.ok(text.startsWith(`${i + 1} 0 obj`, o), `object ${i + 1} offset`));
  assert.equal(Number(text.match(/startxref\n(\d+)/)[1]), at);
  assert.match(text, /\/Count 2 /, "60 rows need two pages");
  // Page text is compressed; check a page has the cut-off name with the WinAnsi ellipsis (0x85).
  const first = text.indexOf("stream\n") + 7, raw = pdf.slice(first, text.indexOf("\nendstream", first));
  assert.ok(zlib.inflateSync(raw).toString("latin1").includes("\x85)"), "long text is cut with an ellipsis");
});

test("PDF text: accents kept, other characters replaced", () => {
  assert.deepEqual(S.pdfChars("é—€"), [0xe9, 0x97, 0x80]);
  assert.deepEqual(S.pdfChars("漢"), [63]);
});

test("HTML escaping", () => assert.equal(S.esc(`<b x="1">&'`), "&lt;b x=&quot;1&quot;&gt;&amp;&#39;"));

test("device names: the device's own name, not its MAC; else the model without the OS version", () => {
  assert.equal(S.devLabel({ hostname: "Cheryls-iPhone", model: "Apple iPhone/iOS 26.6.2" }), "Cheryls-iPhone");
  assert.equal(S.devLabel({ hostname: "46:f6:71:7e:40:55", model: "Apple iPhone/iOS 26.6.2" }), "Apple iPhone");
  assert.equal(S.devLabel({ hostname: "46f6717e4055", type: "Smartphone" }), "Smartphone");
  assert.equal(S.devLabel({}), "Device");
});
