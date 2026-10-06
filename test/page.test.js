// Tests for the kiosk page (public/index.html): the script compiles, every translation is complete, and the pure
// helpers (CSV import, date reading, timeline merging) work. Helpers are pulled out of the page and run in a sandbox.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), path = require("path"), vm = require("vm");
const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const script = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join("\n");

// The source of a top-level `function name(` or `const name =` declaration, by matching braces/brackets.
function grab(name) {
  let i = script.search(new RegExp(`\\n(?:async )?function ${name}\\(|\\nconst ${name} = `));
  assert.ok(i >= 0, `${name} not found in the page`);
  i += 1;
  // One-line constants (`const MERGE_GAP = 30 * 60e3;`, short arrow functions) end with their line.
  const line = script.slice(i, script.indexOf("\n", i)).trim();
  if (line.endsWith(";")) { try { new vm.Script(line); return line; } catch {} }
  const open = script.slice(i).search(/[{[]/) + i;
  let depth = 0, quote = null;
  for (let j = open; j < script.length; j++) {
    const c = script[j];
    if (quote) { if (c === "\\") j++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "/" && script[j + 1] === "/") { j = script.indexOf("\n", j); continue; }
    if (c === "{" || c === "[" || c === "(") depth++;
    if (c === "}" || c === "]" || c === ")") { depth--; if (depth === 0) return script.slice(i, j + 1) + ";"; }
  }
  throw new Error("unbalanced " + name);
}
const ctx = vm.createContext({});
vm.runInContext(["todayStr", "parseCSV", "IMPORT_COLS", "csvDate", "inviteRows", "MERGE_GAP", "mergeStays", "eventRuns", "I18N", "LANGS", "HELP"].map(grab).join("\n")
  + "\nthis.out = { todayStr, parseCSV, csvDate, inviteRows, mergeStays, eventRuns, I18N, LANGS, HELP };", ctx);
const P = ctx.out;

test("the page script compiles", () => { new Function(script); });

test("the page loads its QR library with an integrity hash", () => {
  assert.match(html, /<script src="https:\/\/cdnjs\.cloudflare\.com[^"]+qrcode[^"]*" integrity="sha512-[^"]+"/);
});

test("no inline event handlers (they'd break the Content Security Policy)", () => {
  assert.doesNotMatch(html.replace(/<script[\s\S]*?<\/script>/g, ""), /\son[a-z]+="/i);
});

test("every visitor text is translated", () => {
  const en = Object.keys(P.I18N.en);
  for (const lang of Object.keys(P.LANGS)) {
    const missing = en.filter(k => !(k in P.I18N[lang]));
    assert.deepEqual(missing, [], `${lang} is missing ${missing.join(", ")}`);
    assert.equal(P.I18N[lang].reasons.length, P.I18N.en.reasons.length);
    // Placeholders like {name} must survive translation.
    for (const k of en) if (typeof P.I18N.en[k] === "string") {
      const want = (P.I18N.en[k].match(/\{\w+\}/g) || []).sort().join();
      assert.equal((P.I18N[lang][k].match(/\{\w+\}/g) || []).sort().join(), want, `${lang}.${k} placeholders`);
    }
  }
});

test("CSV reading: quotes, commas, BOM, semicolons, blank lines", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(P.parseCSV('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\n'))), [["a", "b"], ["x, y", 'say "hi"']]);
  assert.deepEqual(JSON.parse(JSON.stringify(P.parseCSV("Name;Email\nAnn;ann@x.com\n"))), [["Name", "Email"], ["Ann", "ann@x.com"]]);
});

test("CSV dates: ISO, US month/day, two-digit years", () => {
  assert.equal(P.csvDate("2026-10-03"), "2026-10-03");
  assert.equal(P.csvDate("10/3/2026"), "2026-10-03");
  assert.equal(P.csvDate("1/2/27"), "2027-01-02");
  assert.equal(P.csvDate(""), "");
  assert.equal(P.csvDate("not a date"), "?");
});

test("expected visitors from CSV: columns by name, problems flagged, 'Last, First' turned around", () => {
  const next = P.csvDate(new Date(Date.now() + 864e5).toLocaleDateString("en-US"));
  const rows = P.inviteRows(`Visitor Name,E-mail,Mobile,Host,Date,Last day\n"Lee, Jordan",jordan@acme.com,813-555-0142,Dana Ruiz,${next},\n`
    + `X,bad,,,,\nOld Timer,,,,2020-01-02,\nPriya Shah,priya@acme.com,,,${next},2020-01-01\n`);
  assert.equal(rows[0].name, "Jordan Lee"); assert.equal(rows[0].email, "jordan@acme.com"); assert.equal(rows[0].phone, "813-555-0142");
  assert.equal(rows[0].host, "Dana Ruiz"); assert.equal(rows[0].until, rows[0].from); assert.equal(rows[0].problem, "");
  assert.equal(rows[1].problem, "No name");
  assert.equal(rows[2].problem, "That day has passed");
  assert.match(rows[3].problem, /before the first day/);
  assert.match(P.inviteRows("Email\nx@y.com\n")[0].problem, /Name column/);
});

test("timeline: reconnects to the same access point are one stay", () => {
  const t = m => new Date(Date.UTC(2026, 9, 2, 13, m)).toISOString();
  const lobby = { ap: "Lobby", apMac: "a" }, conf = { ap: "Conference", apMac: "b" };
  const stays = [{ ...lobby, from: t(0), to: t(20) }, { ...lobby, from: t(25), to: t(40) }, { ...conf, from: t(42), to: t(60) },
    { ...lobby, from: t(150), to: t(170) }];
  const g = P.mergeStays(stays);
  assert.equal(g.length, 3);
  assert.equal(g[0].parts.length, 2); assert.equal(g[0].to, t(40));
  assert.equal(g[1].first.ap, "Conference");
  assert.equal(g[2].from, t(150), "a long gap starts a new stay");
});

test("events: connect/disconnect runs at one access point are grouped", () => {
  const e = (m, what, ap) => ({ at: new Date(Date.UTC(2026, 9, 2, 13, m)).toISOString(), what, ap });
  const runs = P.eventRuns([e(50, "Moved to", "Conference"), e(40, "Disconnected", "Lobby"), e(30, "Connected", "Lobby"), e(20, "Disconnected", "Lobby"), e(10, "Connected", "Lobby")]);
  assert.equal(runs.length, 2); assert.equal(runs[1].length, 4);
});

test("help: every topic has a title and text; front desk gets the everyday ones", () => {
  const ids = P.HELP.map(h => h.id);
  assert.equal(new Set(ids).size, ids.length, "topic ids are unique");
  for (const h of P.HELP) { assert.ok(h.title && h.body.length > 80, h.id); assert.ok(["all", "admin"].includes(h.who), h.id); }
  for (const id of ["onsite", "checkout", "expected", "trouble", "account"]) assert.equal(P.HELP.find(h => h.id === id).who, "all", id);
  // Topics opened from buttons must exist.
  for (const id of [...script.matchAll(/openHelp\("(\w+)"\)/g)].map(m => m[1])) assert.ok(ids.includes(id), `openHelp("${id}")`);
});

test("no doubled backslash escapes (they show as text like \\u00b7 on screen)", () => {
  const bad = [...script.matchAll(/\\\\u[0-9a-f]{4}/gi)].map(m => script.slice(Math.max(0, m.index - 40), m.index + 10));
  assert.deepEqual(bad, []);
});

test("every settings section has a place in the menu groups", () => {
  const groups = JSON.parse(JSON.stringify(vm.runInNewContext(grab("ADMIN_GROUPS").replace(/^const ADMIN_GROUPS = /, "(").replace(/;$/, ")"))));   // plain arrays (not the sandbox's)
  const placed = groups.flatMap(g => g[1]);
  const start = script.indexOf("function renderAdmin("), end = script.indexOf("\n}\n", start);
  const titles = [...script.slice(start, end).matchAll(/class="adm-sec"[^>]*><h3>([^<]+)<\/h3>/g)].map(m => m[1]);
  assert.ok(titles.length >= 15, `found ${titles.length} sections`);
  assert.deepEqual(titles.filter(t => !placed.includes(t)), [], "sections missing from ADMIN_GROUPS");
  assert.deepEqual(placed.filter(t => !titles.includes(t)), [], "groups name sections that don't exist");
});
