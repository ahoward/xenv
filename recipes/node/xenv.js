// xenv recipe for Node — minimal but complete (get / set / load).
//
// Reference implementation generated from ../README.md. Reads and
// writes the xenv on-disk format. Zero deps — only the built-in
// `crypto`, `fs`, `path`, `process` modules.
//
// Usage as a module:
//   const { get, set, load } = require('./xenv.js');
//   const v = get('production', 'API_KEY');                     // Buffer
//   set('production', 'NEW_KEY', Buffer.from('hello'));
//   const all = load('production');                              // { KEY: Buffer }
//
// Usage as a CLI:
//   node xenv.js get  <env> <key>           # prints plaintext
//   node xenv.js set  <env> <key> <value>   # writes encrypted value
//   node xenv.js load <env>                 # prints KEY=value lines

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
  const out = crypto.pbkdf2Sync(pass, salt, Number(iters), 64, 'sha256');
  return { encKey: out.subarray(0, 32), macKey: out.subarray(32, 64) };
}

// Dual-read: v3 uses the caller's README-derived keys; v4 is
// self-contained — salt/iter come from the envelope.
function decryptEnvelope(envelope, passphrase, v3EncKey, v3MacKey) {
  const parts = envelope.trim().split(':');
  if (parts[0] !== 'xenv') throw new Error('envelope: not xenv');

  let encKey, macKey, ivHex, ctHex, macHex, macScope;
  if (parts[1] === 'v3') {
    if (parts.length !== 5) throw new Error('envelope: wrong field count');
    [, , ivHex, ctHex, macHex] = parts;
    encKey = v3EncKey;
    macKey = v3MacKey;
    macScope = `v3:${ivHex}:${ctHex}`;
  } else if (parts[1] === 'v4') {
    if (parts.length !== 7) throw new Error('envelope: wrong field count');
    let saltHex, iter;
    [, , saltHex, iter, ivHex, ctHex, macHex] = parts;
    if (!/^[0-9a-f]{32}$/.test(saltHex)) throw new Error('envelope: bad salt');
    // iter is attacker-controllable in v4 → bound it before PBKDF2 (DoS guard)
    if (!/^[0-9]+$/.test(iter) || Number(iter) < 1 || Number(iter) > 10000000) {
      throw new Error('envelope: bad iter');
    }
    ({ encKey, macKey } = deriveKeys(passphrase, saltHex, iter));
    macScope = `v4:${saltHex}:${iter}:${ivHex}:${ctHex}`;
  } else {
    throw new Error(`envelope: unsupported version ${parts[1]}`);
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

function encryptEnvelope(plaintext, encKey, macKey) {
  const iv = crypto.randomBytes(16);
  const ivHex = iv.toString('hex');
  const cipher = crypto.createCipheriv('aes-256-cbc', encKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const ctHex = ct.toString('hex');
  const macScope = `${VAULT_VERSION}:${ivHex}:${ctHex}`;
  const macHex = crypto
    .createHmac('sha256', macKey)
    .update(macScope, 'ascii')
    .digest('hex');
  return `xenv:${VAULT_VERSION}:${ivHex}:${ctHex}:${macHex}\n`;
}

function atomicWrite(dest, content) {
  const tmp = dest + '.tmp';
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, dest);
}

function get(envName, key) {
  const { iter, salt } = readParams(envName);
  const pass = passphrase(envName);
  const { encKey, macKey } = deriveKeys(pass, salt, iter);
  const file = path.join(root(), 'envs', envName, key + VALUE_EXT);
  if (!fs.existsSync(file)) throw new Error(`no such key: ${key}`);
  return decryptEnvelope(fs.readFileSync(file, 'utf8'), pass, encKey, macKey);
}

function set(envName, key, plaintext) {
  if (typeof plaintext === 'string') plaintext = Buffer.from(plaintext, 'utf8');
  const { iter, salt } = readParams(envName);
  const { encKey, macKey } = deriveKeys(passphrase(envName), salt, iter);
  const envDir = path.join(root(), 'envs', envName);
  if (!fs.existsSync(envDir)) throw new Error(`no env directory: ${envDir}`);
  const envelope = encryptEnvelope(plaintext, encKey, macKey);
  atomicWrite(path.join(envDir, key + VALUE_EXT), envelope);
}

function load(envName) {
  const { iter, salt } = readParams(envName);
  const pass = passphrase(envName);
  const { encKey, macKey } = deriveKeys(pass, salt, iter);
  const envDir = path.join(root(), 'envs', envName);
  const out = {};
  for (const file of fs.readdirSync(envDir).sort()) {
    if (!file.endsWith(VALUE_EXT)) continue;
    const key = file.slice(0, -VALUE_EXT.length);
    const envelope = fs.readFileSync(path.join(envDir, file), 'utf8');
    out[key] = decryptEnvelope(envelope, pass, encKey, macKey);
  }
  return out;
}

module.exports = { get, set, load };

if (require.main === module) {
  const args = process.argv.slice(2);
  const [verb, envName, key, value] = args;
  const usage = 'usage: node xenv.js {get|set|load} <env> [<key>] [<value>]';

  try {
    if (verb === 'get' && envName && key && args.length === 3) {
      process.stdout.write(get(envName, key));
    } else if (verb === 'set' && envName && key && value !== undefined && args.length === 4) {
      set(envName, key, value);
    } else if (verb === 'load' && envName && args.length === 2) {
      for (const [k, v] of Object.entries(load(envName))) {
        process.stdout.write(`${k}=`);
        process.stdout.write(v);
        process.stdout.write('\n');
      }
    } else {
      process.stderr.write(usage + '\n');
      process.exit(2);
    }
  } catch (e) {
    process.stderr.write(`xenv: ${e.message}\n`);
    process.exit(1);
  }
}
