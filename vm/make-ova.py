#!/usr/bin/env python3
"""Turn Canonical's OVF and the kiosk VMDK into the Visitor Desk OVA (USTAR tar: .ovf, .mf, .vmdk in that order)."""
import argparse, hashlib, os, re, tarfile

ap = argparse.ArgumentParser()
ap.add_argument("--base", required=True); ap.add_argument("--vmdk", required=True); ap.add_argument("--out", required=True)
ap.add_argument("--version", required=True); ap.add_argument("--build", required=True)
ap.add_argument("--memory", type=int, default=2048); ap.add_argument("--cpus", type=int, default=2); ap.add_argument("--disk-gb", type=int, default=16)
a = ap.parse_args()

name = "visitor-kiosk"
vmdk_name = f"{name}-disk1.vmdk"
ovf = open(a.base, encoding="utf-8").read()

def sub(pattern, repl, text, count=1, flags=re.S):
    new, n = re.subn(pattern, repl, text, count=count, flags=flags)
    if n == 0: raise SystemExit(f"OVF edit failed: {pattern}")
    return new

# Canonical's cloud-init properties would give cloud-init an (empty) OVF configuration in place of ours.
ovf = sub(r"\s*<ProductSection.*?</ProductSection>", "", ovf)
ovf = ovf.replace(' ovf:transport="iso"', "")
# No floppy drive: Linux probes it at boot and logs "I/O error, dev fd0" (seen on ESXi).
ovf = sub(r'\s*<Item ovf:required="false">(?:(?!</Item>).)*?<rasd:ResourceType>14</rasd:ResourceType>\s*</Item>', "", ovf)
ovf = sub(r'<File ovf:href="[^"]+" ovf:id="file1" ovf:size="\d+"/>',
          f'<File ovf:href="{vmdk_name}" ovf:id="file1" ovf:size="{os.path.getsize(a.vmdk)}"/>', ovf)
ovf = sub(r'ovf:capacity="\d+"', f'ovf:capacity="{a.disk_gb * 1024**3}"', ovf)
ovf = re.sub(r'\s*ovf:populatedSize="\d+"', "", ovf)
ovf = re.sub(r"ubuntu-noble-24\.04-cloudimg-\d+", name, ovf)
ovf = sub(r"<rasd:ElementName>\d+MB of memory</rasd:ElementName>", f"<rasd:ElementName>{a.memory}MB of memory</rasd:ElementName>", ovf)
ovf = sub(r"(<rasd:ResourceType>4</rasd:ResourceType>\s*<rasd:VirtualQuantity>)\d+", rf"\g<1>{a.memory}", ovf)
ovf = sub(r"<rasd:ElementName>\d+ virtual CPU\(s\)</rasd:ElementName>", f"<rasd:ElementName>{a.cpus} virtual CPU(s)</rasd:ElementName>", ovf)
ovf = sub(r"(<rasd:ResourceType>3</rasd:ResourceType>\s*<rasd:VirtualQuantity>)\d+", rf"\g<1>{a.cpus}", ovf)
notes = (f"Visitor Desk for RUCKUS One {a.version} (build {a.build}). Ubuntu 24.04 LTS. "
         "After power-on, open the VM console: it shows the kiosk address and the admin setup code. "
         "Console login kioskadmin (password must be changed at first login); run 'kiosk' for maintenance commands.")
ovf = sub(r'(<VirtualSystem ovf:id="[^"]+">\s*<Info>[^<]*</Info>\s*<Name>[^<]*</Name>)',
          r"\1\n    <AnnotationSection>\n      <Info>Notes</Info>\n      <Annotation>" + notes + "</Annotation>\n    </AnnotationSection>"
          f"\n    <ProductSection>\n      <Info>Product</Info>\n      <Product>Visitor Desk for RUCKUS One</Product>\n      <Version>{a.version}</Version>\n      <FullVersion>{a.version} build {a.build}</FullVersion>\n    </ProductSection>", ovf)

work = os.path.dirname(os.path.abspath(a.vmdk))
ovf_path, mf_path = os.path.join(work, f"{name}.ovf"), os.path.join(work, f"{name}.mf")
open(ovf_path, "w", encoding="utf-8").write(ovf)

def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""): h.update(chunk)
    return h.hexdigest()
open(mf_path, "w").write(f"SHA256({name}.ovf)= {sha256(ovf_path)}\nSHA256({vmdk_name})= {sha256(a.vmdk)}\n")

os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
with tarfile.open(a.out, "w", format=tarfile.USTAR_FORMAT) as t:
    for path, arc in ((ovf_path, f"{name}.ovf"), (mf_path, f"{name}.mf"), (a.vmdk, vmdk_name)):
        info = t.gettarinfo(path, arcname=arc); info.uid = info.gid = 0; info.uname = info.gname = "root"; info.mode = 0o644
        with open(path, "rb") as f: t.addfile(info, f)
print(f"Wrote {a.out} ({os.path.getsize(a.out) / 1e6:.0f} MB)")
