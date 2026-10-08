#!/usr/bin/env python3
"""Pack the kiosk app and the VM helper files into update.tar.gz (app/ and system/ trees, like on the VM)."""
import argparse, io, json, os, tarfile

ap = argparse.ArgumentParser()
ap.add_argument("--root", required=True); ap.add_argument("--version", required=True)
ap.add_argument("--build", required=True); ap.add_argument("--out", required=True)
ap.add_argument("--node-dir", help="unpacked Node.js (e.g. node-v24.x-linux-x64) to ship as the new runtime")
a = ap.parse_args()
vm = os.path.join(a.root, "vm", "files")

# Only the app itself: never config.json, data/, certs/ or other local files.
app = ["server.js", "package.json", "README.md", "config.example.json"]
system = {  # path on the VM -> file in vm/files
    "usr/local/bin/kiosk": "kiosk", "usr/local/sbin/kiosk-console": "kiosk-console", "usr/local/sbin/kiosk-update": "kiosk-update", "usr/local/sbin/kiosk-harden": "kiosk-harden",
    "etc/systemd/system/visitor-kiosk.service": "visitor-kiosk.service",
    "etc/systemd/system/kiosk-console.service": "kiosk-console.service", "etc/systemd/system/kiosk-console.timer": "kiosk-console.timer",
    "etc/systemd/system/systemd-networkd-wait-online.service.d/10-visitor-kiosk.conf": "wait-online.conf",
    "usr/local/sbin/kiosk-web-update": "kiosk-web-update", "usr/local/sbin/kiosk-netcfg": "kiosk-netcfg",
    "etc/systemd/system/kiosk-netcfg.path": "kiosk-netcfg.path", "etc/systemd/system/kiosk-netcfg.service": "kiosk-netcfg.service",
    "etc/systemd/system/kiosk-web-update.path": "kiosk-web-update.path", "etc/systemd/system/kiosk-web-update.service": "kiosk-web-update.service",
}
EXEC = {"usr/local/bin/kiosk", "usr/local/sbin/kiosk-console", "usr/local/sbin/kiosk-update", "usr/local/sbin/kiosk-harden", "usr/local/sbin/kiosk-web-update", "usr/local/sbin/kiosk-netcfg"}

def add(t, src, arc, mode):
    i = t.gettarinfo(src, arcname=arc); i.uid = i.gid = 0; i.uname = i.gname = "root"; i.mode = mode
    with open(src, "rb") as f: t.addfile(i, f)

with tarfile.open(a.out, "w:gz", format=tarfile.USTAR_FORMAT) as t:
    for f in app: add(t, os.path.join(a.root, f), "app/" + f, 0o644)
    for d, _, files in os.walk(os.path.join(a.root, "public")):
        for f in sorted(files):
            src = os.path.join(d, f)
            add(t, src, "app/" + os.path.relpath(src, a.root), 0o644)
    ver = json.dumps({"version": a.version, "build": a.build}).encode() + b"\n"
    i = tarfile.TarInfo("app/.version.json"); i.size = len(ver); i.mode = 0o644
    t.addfile(i, io.BytesIO(ver))
    for dest, name in system.items(): add(t, os.path.join(vm, name), "system/" + dest, 0o755 if dest in EXEC else 0o644)
    if a.node_dir:   # whole runtime under node/ (keeps symlinks and file modes)
        t.add(a.node_dir, arcname="node", filter=lambda i: (setattr(i, "uid", 0), setattr(i, "gid", 0), setattr(i, "uname", "root"), setattr(i, "gname", "root"), i)[-1])
print(f"Packed {a.out}")
