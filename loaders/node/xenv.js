// xenv loader for Node — read-only, pure stdlib.
//
// Reference implementation generated from ../AGENT_PROMPT.md. Reads
// the xenv on-disk format and returns decrypted values. Zero deps —
// only the built-in `crypto`, `fs`, `path`, `process` modules.
//
// Usage as a module:
//   const { load, decryptOne } = require('./xenv.js');
//   const config = load('production');           // → { KEY: Buffer, ... }
//   const apiKey = decryptOne('production', 'API_KEY');
//
// Usage as a CLI (for loaders/test.sh):
//   node xenv.js production              # prints KEY=value lines
//   node xenv.js production API_KEY      # prints just that value

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VAULT_VERSION = 'v3';
const VALUE_EXT = '.value.enc';

const root = () => process.env.XENV_ROOT || 'xenv';

const envVarName = (envName) =>
  'XENV_KEY_' + envName.toUpperCase().replace(/-/g, '_');

function passphrase(envName) {
  const v = process.env[envVarName(envName)] || process.env.XENV_KEY;
  if (!v) {
    throw new Error(`no passphrase: set $${envVarName(envName)} or $XENV_KEY`);
  }
  return v;
}

function readParams(envName) {
  // Parse per-env README frontmatter — naive split-on-first-colon.
  const readme = path.join(root(), 'envs', envName, 'README.md');
  if (!fs.existsSync(readme)) throw new Error(`no README at ${readme}`);

  const found = {};
  let inBlock = false;
  for (const line of fs.readFileSync(readme, 'utf8').split('\n')) {
    if (line === '---') {
      if (!inBlock) { inBlock = true; continue; }
      break;
    }
    if (!inBlock) continue;
    const stripped = line.trim();
    if (!stripped || stripped.startsWith('#')) continue;
    const colon = stripped.indexOf(':');
    if (colon < 0) continue;
    found[stripped.slice(0, colon).trim()] = stripped.slice(colon + 1).trim();
  }

  if (found.version !== VAULT_VERSION) {
    throw new Error(`params: unsupported or missing version: ${found.version}`);
  }
  if (!/^[0-9a-f]{32}$/.test(found.salt || '')) {
    throw new Error('params: invalid salt');
  }
  if (!/^[0-9]+$/.test(found.iter || '')) {
    throw new Error('params: invalid iter');
  }
  return { iter: parseInt(found.iter, 10), salt: found.salt };
}

function deriveKeys(pass, saltHex, iters) {
  const salt = Buffer.from(saltHex, 'hex');
  const out = crypto.pbkdf2Sync(pass, salt, iters, 64, 'sha256');
  return { encKey: out.subarray(0, 32), macKey: out.subarray(32, 64) };
}

function decryptEnvelope(envelope, encKey, macKey) {
  const parts = envelope.trim().split(':');
  if (parts.length !== 5) throw new Error('envelope: wrong field count');
  const [tag, ver, ivHex, ctHex, macHex] = parts;
  if (tag !== 'xenv' || ver !== VAULT_VERSION) {
    throw new Error(`envelope: unsupported ${tag}:${ver}`);
  }
  if (ivHex.length !== 32 || macHex.length !== 64) {
    throw new Error('envelope: wrong iv/mac length');
  }
  if (!ctHex || ctHex.length % 32 !== 0) {
    throw new Error('envelope: ct not block-aligned');
  }
  if (!/^[0-9a-f]+$/.test(ivHex + ctHex + macHex)) {
    throw new Error('envelope: non-hex content');
  }

  // MAC verify FIRST (encrypt-then-MAC; constant-time compare)
  const macScope = `${VAULT_VERSION}:${ivHex}:${ctHex}`;
  const expected = crypto
    .createHmac('sha256', macKey)
    .update(macScope, 'ascii')
    .digest();
  const provided = Buffer.from(macHex, 'hex');
  if (expected.length !== provided.length ||
      !crypto.timingSafeEqual(expected, provided)) {
    throw new Error('MAC verification failed — wrong key or tampered vault');
  }

  const decipher = crypto.createDecipheriv(
    'aes-256-cbc',
    encKey,
    Buffer.from(ivHex, 'hex'),
  );
  return Buffer.concat([
    decipher.update(Buffer.from(ctHex, 'hex')),
    decipher.final(),
  ]);
}

function load(envName) {
  const { iter, salt } = readParams(envName);
  const { encKey, macKey } = deriveKeys(passphrase(envName), salt, iter);
  const envDir = path.join(root(), 'envs', envName);
  const out = {};
  for (const file of fs.readdirSync(envDir).sort()) {
    if (!file.endsWith(VALUE_EXT)) continue;
    const key = file.slice(0, -VALUE_EXT.length);
    const envelope = fs.readFileSync(path.join(envDir, file), 'utf8');
    out[key] = decryptEnvelope(envelope, encKey, macKey);
  }
  return out;
}

function decryptOne(envName, key) {
  const { iter, salt } = readParams(envName);
  const { encKey, macKey } = deriveKeys(passphrase(envName), salt, iter);
  const file = path.join(root(), 'envs', envName, key + VALUE_EXT);
  if (!fs.existsSync(file)) throw new Error(`no such key: ${key}`);
  return decryptEnvelope(fs.readFileSync(file, 'utf8'), encKey, macKey);
}

module.exports = { load, decryptOne };

if (require.main === module) {
  const [envName, key] = process.argv.slice(2);
  if (!envName) {
    process.stderr.write('usage: node xenv.js <env> [<key>]\n');
    process.exit(2);
  }
  if (key) {
    process.stdout.write(decryptOne(envName, key));
  } else {
    for (const [k, v] of Object.entries(load(envName))) {
      process.stdout.write(`${k}=`);
      process.stdout.write(v);
      process.stdout.write('\n');
    }
  }
}
