#!/usr/bin/env node
// verify.js — the Node twin of verify.rb. Checks a decrypt implementation
// against ./vectors.json using nothing but this file + that JSON. Proves the
// vectors are a language-neutral conformance oracle: same JSON, any language.
//
//   node verify.js     # PASS/FAIL per vector; non-zero exit on any failure

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function deriveKeys(pass, saltHex, iter) {
  const out = crypto.pbkdf2Sync(pass, Buffer.from(saltHex, "hex"), Number(iter), 64, "sha256");
  return { encKey: out.subarray(0, 32), macKey: out.subarray(32, 64) };
}

// Dual-read: v3 takes salt/iter from the caller; v4 is self-contained.
function decrypt(envelope, passphrase, v3Salt, v3Iter) {
  const parts = envelope.trim().split(":");
  if (parts[0] !== "xenv") throw new Error("envelope: not xenv");

  let saltHex, iter, ivHex, ctHex, macHex, scope, keys;
  if (parts[1] === "v3") {
    if (parts.length !== 5) throw new Error("envelope: wrong field count");
    [, , ivHex, ctHex, macHex] = parts;
    saltHex = v3Salt; iter = v3Iter;
    scope = `v3:${ivHex}:${ctHex}`;
  } else if (parts[1] === "v4") {
    if (parts.length !== 7) throw new Error("envelope: wrong field count");
    [, , saltHex, iter, ivHex, ctHex, macHex] = parts;
    if (!/^[0-9a-f]{32}$/.test(saltHex)) throw new Error("envelope: bad salt");
    // iter is attacker-controllable in v4 → bound it before PBKDF2 (DoS guard)
    if (!/^[0-9]+$/.test(iter) || Number(iter) < 1 || Number(iter) > 10000000) throw new Error("envelope: bad iter");
    scope = `v4:${saltHex}:${iter}:${ivHex}:${ctHex}`;
  } else if (parts[1] === "v5") {
    if (parts.length !== 8) throw new Error("envelope: wrong field count");
    let valueSalt;
    [, , saltHex, iter, valueSalt, ivHex, ctHex, macHex] = parts;
    if (!/^[0-9a-f]{32}$/.test(saltHex) || !/^[0-9a-f]{32}$/.test(valueSalt)) throw new Error("envelope: bad salt");
    if (!/^[0-9]+$/.test(iter) || Number(iter) < 1 || Number(iter) > 10000000) throw new Error("envelope: bad iter");
    // two-level KDF: PBKDF2 master over the shared salt, then HKDF per value.
    const master = crypto.pbkdf2Sync(passphrase, Buffer.from(saltHex, "hex"), Number(iter), 64, "sha256");
    const okm = Buffer.from(crypto.hkdfSync("sha256", master, Buffer.from(valueSalt, "hex"), Buffer.from("xenv:v5"), 64));
    keys = { encKey: okm.subarray(0, 32), macKey: okm.subarray(32, 64) };
    scope = `v5:${saltHex}:${iter}:${valueSalt}:${ivHex}:${ctHex}`;
  } else {
    throw new Error(`envelope: unsupported version ${parts[1]}`);
  }

  if (ivHex.length !== 32 || macHex.length !== 64) throw new Error("envelope: wrong iv/mac length");
  if (!ctHex || ctHex.length % 32 !== 0) throw new Error("envelope: ct not block-aligned");
  if (!/^[0-9a-f]+$/.test(saltHex + ivHex + ctHex + macHex)) throw new Error("envelope: non-hex");

  const { encKey, macKey } = keys || deriveKeys(passphrase, saltHex, iter);
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
  const label = `${v.name} (${v.wire} ${v.expect})`;
  try {
    const got = decrypt(v.envelope, data.passphrase, v.salt, v.iter);
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
