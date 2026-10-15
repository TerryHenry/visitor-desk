// Screenshots for the README (docs/images): a sandboxed server copy with the test suite's fake RUCKUS One and made-up
// sample visitors, driven by headless Chrome over the DevTools protocol. No real data is used.
//   node docs/screenshots.js        (needs Google Chrome; set CHROME=/path/to/chrome elsewhere than macOS)
const fs = require("fs"), path = require("path"), os = require("os"), { spawn } = require("child_process");
const ROOT = path.join(__dirname, "..");
const { startServer, adminToken, checkin } = require(ROOT + "/test/helpers");
const OUT = path.join(ROOT, "docs", "images");
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function cdp(port) {
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(200); } }
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const waiting = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
  const send = (method, params = {}) => new Promise(r => { const n = ++id; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const js = async expr => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result?.result?.value; };
  return { send, js, close: () => ws.close() };
}

(async () => {
  const s = await startServer();
  const admin = await adminToken(s, "admin", "Admin-Pass-1");
  await s.api("PUT", "/api/admin/config", { hosts: [
    { name: "Dana Ruiz", email: "dana@example.com", phone: "813-555-0142" }, { name: "Jordan Lee", email: "jordan@example.com", phone: "813-555-0143" },
    { name: "Priya Shah", email: "priya@example.com", phone: "813-555-0144" }, { name: "Marcus Webb", email: "marcus@example.com", phone: "813-555-0145" }] }, admin);
  await s.api("PUT", "/api/admin/look", { theme: "light", orgName: "Lakeside Offices", look: { palette: "ruckus", showName: false } }, admin);
  await s.api("PUT", "/api/admin/questions", { fields: { name: "required", email: "required", phone: "required", company: "optional", host: "required",
    purpose: "optional", photo: "hidden", idScan: "hidden", signature: "hidden", c_plate1: "optional" },
    custom: [{ key: "c_plate1", label: "Vehicle license plate", type: "text", step: "you" }], fieldOrder: ["name", "email", "phone", "company", "c_plate1"],
    hostMode: "suggest", reasons: ["Meeting", "Interview", "Delivery", "Contractor or service work", "Other"] }, admin);

  const people = [["Alex Morgan", "Northwind Traders", "Dana Ruiz", "Meeting"], ["Sam Patel", "Contoso Ltd", "Jordan Lee", "Interview"],
    ["Riley Chen", "Fabrikam", "Priya Shah", "Meeting"], ["Jamie Ortiz", "Tailspin Toys", "Marcus Webb", "Contractor or service work"],
    ["Taylor Brooks", "Adventure Works", "Dana Ruiz", "Delivery"], ["Casey Nguyen", "Wide World Importers", "Jordan Lee", "Meeting"]];
  for (const [i, [name, company, host, purpose]] of people.entries())
    await checkin(s, { name, mode: "dpsk", hours: 8, visitor: { company, host, purpose, email: name.split(" ")[0].toLowerCase() + "@example.com", phone: "813-555-01" + (50 + i),
      extra: i % 2 ? [] : [{ label: "Vehicle license plate", value: ["KLM 4821", "TRX 5530", "BNQ 7714"][i / 2] }] } });
  // Devices on the Wi-Fi for most of them (the fake RUCKUS One matches clients by the passphrase user name).
  const dirs = fs.readdirSync(s.file("data", "visits")), recs = dirs.map(d => JSON.parse(fs.readFileSync(s.file("data", "visits", d, "visit.json"), "utf8")));
  const aps = [["Lobby AP", "11:11:11:00:00:02"], ["Conference AP", "11:11:11:00:00:03"]];
  s.setState({ dpskDevices: [], clients: recs.slice(0, 5).map((r, i) => ({ macAddress: `AA:BB:CC:00:10:0${i}`, username: r.ruckusUsername,
    hostname: r.name.split(" ")[0] + "s-iPhone", modelName: "Apple iPhone", osType: "iOS", apInformation: { name: aps[i % 2][0], macAddress: aps[i % 2][1], serialNumber: "S" + (2 + i % 2) },
    venueInformation: { name: "HQ" }, networkInformation: { ssid: "Lakeside-Guest" } })) });
  await s.api("POST", "/api/admin/devices/refresh", undefined, admin);

  // Headless Chrome.
  const port = 9333, prof = fs.mkdtempSync(path.join(os.tmpdir(), "vd-chrome-"));
  const chrome = spawn(process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`,
    "--no-first-run", "--hide-scrollbars", "--force-color-profile=srgb", "--force-prefers-color-scheme=light", "about:blank"], { stdio: "ignore" });
  const c = await cdp(port);
  const size = (w, h) => c.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: false });
  const go = async url => { await c.send("Page.enable"); await c.send("Page.navigate", { url }); await sleep(1500); };
  const shot = async (name, clip) => { const r = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, "base64")); console.log("saved", name); };
  fs.mkdirSync(OUT, { recursive: true });

  // 1. Kiosk: first step, partly filled in.
  await size(1180, 820); await go(s.base + "/"); await sleep(1500);
  await c.js(`(async()=>{ const set=(id,v)=>{const e=document.getElementById(id); e.value=v; e.dispatchEvent(new Event('input',{bubbles:true}));};
    set('f-name','Morgan Ellis'); set('f-email','morgan@example.com'); set('f-phone','(813) 555-0188'); set('f-company','Blue Yonder Airlines'); document.activeElement.blur(); })()`);
  await sleep(300); await shot("kiosk-check-in.png");
  // 2. Kiosk: the pass after checking in.
  await c.js(`(async()=>{ const set=(id,v)=>{const e=document.getElementById(id); e.value=v; e.dispatchEvent(new Event('input',{bubbles:true}));};
    document.querySelector('.step.active [data-next]').click(); await new Promise(r=>setTimeout(r,400));
    set('f-host','Priya Shah'); const p=document.getElementById('f-purpose'); p.value='Meeting'; p.dispatchEvent(new Event('change',{bubbles:true}));
    const cb=document.getElementById('consent'); if (cb) cb.checked=true;
    document.querySelector('.step.active [data-next]').click(); })()`);
  await sleep(6000); await shot("kiosk-pass.png");

  // 3. Staff: Visitor records, on site now with devices.
  await size(1280, 860); await go(s.base + "/"); await sleep(1200);
  await c.js(`(async()=>{ openAdmin(); await new Promise(r=>setTimeout(r,500));
    const set=(id,v)=>{const e=document.getElementById(id); e.value=v; e.dispatchEvent(new Event('input',{bubbles:true}));};
    set('userIn','admin'); set('pwIn','Admin-Pass-1');
    [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Sign in').click(); await new Promise(r=>setTimeout(r,1500)); })()`);
  await c.js(`(async()=>{ await openVisits(); await new Promise(r=>setTimeout(r,1200)); document.querySelector('[data-range="onsite"]').click(); await new Promise(r=>setTimeout(r,1500)); })()`);
  await shot("visitor-records.png");
  // 4. Settings: What visitors fill in.
  await c.js(`(async()=>{ document.getElementById('visits').classList.remove('open'); await new Promise(r=>setTimeout(r,300));
    const h=[...document.querySelectorAll('.adm-sec h3')].find(x=>x.textContent==='What visitors fill in'); h.scrollIntoView({block:'start'}); window.scrollBy(0,-20); })()`);
  await sleep(800); await shot("settings-questions.png");

  c.close(); chrome.kill(); await s.stop(); fs.rmSync(prof, { recursive: true, force: true });
})().catch(e => { console.error(e); process.exit(1); });
