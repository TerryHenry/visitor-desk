#!/bin/bash
# Create the update signing key pair (Ed25519) once. The private key signs updates; keep it safe and backed up.
# VMs built from this folder trust only updates signed with it. If it's lost, deployed VMs need a redeploy.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p keys; chmod 700 keys
[ -f keys/update-signing.key ] && exit 0
node -e '
  const c = require("crypto"), fs = require("fs");
  const { privateKey, publicKey } = c.generateKeyPairSync("ed25519");
  fs.writeFileSync("keys/update-signing.key", privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  fs.writeFileSync("keys/update-signing.pub", publicKey.export({ type: "spki", format: "pem" }));'
echo "Created the update signing key: vm/keys/update-signing.key (keep it private, and back it up)."
