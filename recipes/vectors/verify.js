#!/usr/bin/env node
// verify.js — the Node twin of verify.rb. Checks a decrypt implementation
// against ./vectors.json using nothing but this file + that JSON. Proves the
// vectors are a language-neutral conformance oracle: same JSON, any language.
//
//   node verify.js     # PASS/FAIL per vector; non-zero exit on any failure

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const VAULT_VERSION = "v3";

function deriveKeys(pass, saltHex, iter) {
  const out = crypto.pbkdf2Sync(pass, Buffer.from(saltHex, "hex"), iter, 64, "sha256");
  return { encKey: out.subarray(0, 32), macKey: out.subarray(32, 64) };
}

function decrypt(envelope, encKey, macKey) {
  const parts = envelope.trim().split(":");
  if (parts.length !== 5) throw new Error("envelope: wrong field count");
  const [tag, ver, ivHex, ctHex, macHex] = parts;
  if (tag !== "xenv" || ver !== VAULT_VERSION) throw new Error(`envelope: unsupported ${tag}:${ver}`);
  if (ivHex.length !== 32 || macHex.length !== 64) throw new Error("envelope: wrong iv/mac length");
  if (!ctHex || ctHex.length % 32 !== 0) throw new Error("envelope: ct not block-aligned");
  if (!/^[0-9a-f]+$/.test(ivHex + ctHex + macHex)) throw new Error("envelope: non-hex");

  const scope = `${VAULT_VERSION}:${ivHex}:${ctHex}`;
  const expected = crypto.createHmac("sha256", macKey).update(scope, "ascii").digest();
  const provided = Buffer.from(macHex, "hex");
  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
    throw new Error("MAC verification failed");
  }
  const d = crypto.createDecipheriv("aes-256-cbc", encKey, Buffer.from(ivHex, "hex"));
  return Buffer.concat([d.update(Buffer.from(ctHex, "hex")), d.final()]);
}

const data = JSON.parse(fs.readFileSync(path.join(__dirname, "vectors.json"), "utf8"));
let fails = 0;

for (const v of data.vectors) {
  const { encKey, macKey } = deriveKeys(data.passphrase, v.salt, v.iter);
  const label = `${v.name} (${v.expect})`;
  try {
    const got = decrypt(v.envelope, encKey, macKey);
    if (v.expect === "ok") {
      const want = Buffer.from(v.plaintext_b64, "base64");
      if (got.equals(want)) console.log(`  ok    ${label}`);
      else { console.log(`  FAIL  ${label}: plaintext mismatch`); fails++; }
    } else {
      console.log(`  FAIL  ${label}: expected ${v.expect} but decrypt SUCCEEDED`); fails++;
    }
  } catch (e) {
    if (v.expect === "ok") { console.log(`  FAIL  ${label}: ${e.message}`); fails++; }
    else console.log(`  ok    ${label}: rejected (${e.message})`);
  }
}

console.log(fails === 0 ? "\nALL VECTORS PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
