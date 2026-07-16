// xenv recipe for Java — minimal but complete (get / set / load).
//
// Reference implementation generated from ../README.md. Reads and writes
// the xenv on-disk format using only the JDK: javax.crypto (AES-256-CBC,
// HMAC-SHA256) plus a hand-rolled PBKDF2-SHA256. No external jars.
//
// PBKDF2 is implemented directly over Mac("HmacSHA256") rather than via
// SecretKeyFactory("PBKDF2WithHmacSHA256"): the SecretKeyFactory path
// takes the passphrase as a char[] and its byte-encoding of that char[]
// has varied across JDKs. Doing it by hand lets us feed the passphrase
// as UTF-8 bytes exactly, matching the spec and every other recipe.
//
// Run as a single-file source program (JDK 11+):
//   java Xenv.java get  <env> <key>          # prints plaintext
//   java Xenv.java set  <env> <key> <value>  # writes encrypted value
//   java Xenv.java load <env>                # prints KEY=value lines

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.regex.Pattern;
import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

public class Xenv {
  static final String VAULT_VERSION = "v3";
  static final String VALUE_EXT = ".value.enc";
  static final Pattern HEX = Pattern.compile("^[0-9a-f]+$");
  static final Pattern SALT = Pattern.compile("^[0-9a-f]{32}$");
  static final Pattern DIGITS = Pattern.compile("^[0-9]+$");

  static String root() {
    String r = System.getenv("XENV_ROOT");
    return (r == null || r.isEmpty()) ? "xenv" : r;
  }

  static String envVarName(String env) {
    return "XENV_KEY_" + env.toUpperCase().replace('-', '_');
  }

  static String passphrase(String env) {
    String v = System.getenv(envVarName(env));
    if (v == null || v.isEmpty()) v = System.getenv("XENV_KEY");
    if (v == null || v.isEmpty()) {
      throw new RuntimeException("no passphrase: set $" + envVarName(env) + " or $XENV_KEY");
    }
    return v;
  }

  // Parse the per-env README frontmatter — naive split-on-first-colon.
  static Map<String, String> readParams(String env) throws IOException {
    Path readme = Path.of(root(), "envs", env, "README.md");
    if (!Files.isRegularFile(readme)) throw new RuntimeException("no README at " + readme);

    Map<String, String> found = new TreeMap<>();
    boolean inBlock = false;
    for (String line : Files.readAllLines(readme, StandardCharsets.UTF_8)) {
      if (line.equals("---")) {
        if (!inBlock) { inBlock = true; continue; }
        break;
      }
      if (!inBlock) continue;
      String s = line.strip();
      if (s.isEmpty() || s.startsWith("#")) continue;
      int colon = s.indexOf(':');
      if (colon < 0) continue;
      found.put(s.substring(0, colon).strip(), s.substring(colon + 1).strip());
    }

    if (!VAULT_VERSION.equals(found.get("version"))) {
      throw new RuntimeException("params: unsupported or missing version: " + found.get("version"));
    }
    if (!SALT.matcher(found.getOrDefault("salt", "")).matches()) {
      throw new RuntimeException("params: invalid salt");
    }
    if (!DIGITS.matcher(found.getOrDefault("iter", "")).matches()) {
      throw new RuntimeException("params: invalid iter");
    }
    return found;
  }

  static Mac hmac(byte[] key) throws Exception {
    Mac mac = Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec(key, "HmacSHA256"));
    return mac;
  }

  // PBKDF2-SHA256 over UTF-8 password bytes. dkLen is a multiple of 32 here.
  static byte[] pbkdf2(byte[] password, byte[] salt, int iter, int dkLen) throws Exception {
    Mac prf = hmac(password);
    int hLen = 32;
    int blocks = (dkLen + hLen - 1) / hLen;
    byte[] dk = new byte[blocks * hLen];
    for (int i = 1; i <= blocks; i++) {
      byte[] intBE = new byte[] {
        (byte) (i >>> 24), (byte) (i >>> 16), (byte) (i >>> 8), (byte) i
      };
      prf.update(salt);
      byte[] u = prf.doFinal(intBE);      // U1 = PRF(pw, salt || INT(i))
      byte[] t = u.clone();
      for (int j = 1; j < iter; j++) {
        u = prf.doFinal(u);               // Uj = PRF(pw, Uj-1)
        for (int k = 0; k < hLen; k++) t[k] ^= u[k];
      }
      System.arraycopy(t, 0, dk, (i - 1) * hLen, hLen);
    }
    return Arrays.copyOf(dk, dkLen);
  }

  static byte[] pbkdf2Okm(String pass, String saltHex, int iter) throws Exception {
    return pbkdf2(pass.getBytes(StandardCharsets.UTF_8), hexDecode(saltHex), iter, 64);
  }

  static byte[][] deriveKeys(String pass, String saltHex, int iter) throws Exception {
    byte[] out = pbkdf2Okm(pass, saltHex, iter);
    return new byte[][] { Arrays.copyOfRange(out, 0, 32), Arrays.copyOfRange(out, 32, 64) };
  }

  // HKDF-SHA256 (RFC 5869), L=64. Matches the tool's construction.
  static byte[] hkdf64(byte[] ikm, byte[] salt) throws Exception {
    byte[] info = "xenv:v5".getBytes(StandardCharsets.US_ASCII);
    byte[] prk = hmac(salt).doFinal(ikm);
    Mac m = hmac(prk);
    m.update(info); m.update((byte) 0x01);
    byte[] t1 = m.doFinal();
    m = hmac(prk);
    m.update(t1); m.update(info); m.update((byte) 0x02);
    byte[] t2 = m.doFinal();
    byte[] out = new byte[64];
    System.arraycopy(t1, 0, out, 0, 32);
    System.arraycopy(t2, 0, out, 32, 32);
    return out;
  }

  // Dual-read v3/v4/v5. Caller precomputes envOkm = PBKDF2 over the env
  // README salt/iter ONCE; per value it's a slice (v3) or a cheap HKDF (v5).
  static byte[] decryptEnvelope(String envelope, String passphrase, String ctxSalt, int ctxIter, byte[] envOkm) throws Exception {
    String[] parts = envelope.strip().split(":", -1);
    if (parts.length < 2 || !parts[0].equals("xenv")) throw new RuntimeException("envelope: not xenv");

    byte[] encKey, macKey;
    String ivHex, ctHex, macHex, macScope;
    if (parts[1].equals("v3")) {
      if (parts.length != 5) throw new RuntimeException("envelope: wrong field count");
      ivHex = parts[2]; ctHex = parts[3]; macHex = parts[4];
      encKey = Arrays.copyOfRange(envOkm, 0, 32); macKey = Arrays.copyOfRange(envOkm, 32, 64);
      macScope = "v3:" + ivHex + ":" + ctHex;
    } else if (parts[1].equals("v4")) {
      if (parts.length != 7) throw new RuntimeException("envelope: wrong field count");
      String saltHex = parts[2], iterStr = parts[3];
      ivHex = parts[4]; ctHex = parts[5]; macHex = parts[6];
      if (saltHex.length() != 32) throw new RuntimeException("envelope: bad salt");
      if (!DIGITS.matcher(iterStr).matches()) throw new RuntimeException("envelope: bad iter");
      int iterVal = Integer.parseInt(iterStr);
      if (iterVal < 1 || iterVal > 10_000_000) throw new RuntimeException("envelope: bad iter");
      byte[] okm = pbkdf2Okm(passphrase, saltHex, iterVal);
      encKey = Arrays.copyOfRange(okm, 0, 32); macKey = Arrays.copyOfRange(okm, 32, 64);
      macScope = "v4:" + saltHex + ":" + iterStr + ":" + ivHex + ":" + ctHex;
    } else if (parts[1].equals("v5")) {
      if (parts.length != 8) throw new RuntimeException("envelope: wrong field count");
      String kdfSalt = parts[2], iterStr = parts[3], valueSalt = parts[4];
      ivHex = parts[5]; ctHex = parts[6]; macHex = parts[7];
      if (kdfSalt.length() != 32 || valueSalt.length() != 32) throw new RuntimeException("envelope: bad salt");
      if (!DIGITS.matcher(iterStr).matches()) throw new RuntimeException("envelope: bad iter");
      int iterVal = Integer.parseInt(iterStr);
      if (iterVal < 1 || iterVal > 10_000_000) throw new RuntimeException("envelope: bad iter");
      byte[] ikm = (kdfSalt.equals(ctxSalt) && iterVal == ctxIter) ? envOkm : pbkdf2Okm(passphrase, kdfSalt, iterVal);
      byte[] okm = hkdf64(ikm, hexDecode(valueSalt));
      encKey = Arrays.copyOfRange(okm, 0, 32); macKey = Arrays.copyOfRange(okm, 32, 64);
      macScope = "v5:" + kdfSalt + ":" + iterStr + ":" + valueSalt + ":" + ivHex + ":" + ctHex;
    } else {
      throw new RuntimeException("envelope: unsupported version " + parts[1]);
    }

    if (ivHex.length() != 32 || macHex.length() != 64) {
      throw new RuntimeException("envelope: wrong iv/mac length");
    }
    if (ctHex.isEmpty() || ctHex.length() % 32 != 0) {
      throw new RuntimeException("envelope: ct not block-aligned");
    }
    if (!HEX.matcher(ivHex + ctHex + macHex).matches()) {
      throw new RuntimeException("envelope: non-hex content");
    }

    // MAC verify FIRST (encrypt-then-MAC; constant-time compare).
    byte[] expected = hmac(macKey).doFinal(macScope.getBytes(StandardCharsets.US_ASCII));
    byte[] provided = hexDecode(macHex);
    if (!MessageDigest.isEqual(expected, provided)) {
      throw new RuntimeException("MAC verification failed — wrong key or tampered vault");
    }

    Cipher c = Cipher.getInstance("AES/CBC/PKCS5Padding");
    c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(encKey, "AES"), new IvParameterSpec(hexDecode(ivHex)));
    return c.doFinal(hexDecode(ctHex));
  }

  static String encryptEnvelope(byte[] plaintext, byte[] encKey, byte[] macKey) throws Exception {
    byte[] iv = new byte[16];
    new SecureRandom().nextBytes(iv);
    Cipher c = Cipher.getInstance("AES/CBC/PKCS5Padding");
    c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(encKey, "AES"), new IvParameterSpec(iv));
    byte[] ct = c.doFinal(plaintext);

    String ivHex = hexEncode(iv);
    String ctHex = hexEncode(ct);
    String macScope = VAULT_VERSION + ":" + ivHex + ":" + ctHex;
    String macHex = hexEncode(hmac(macKey).doFinal(macScope.getBytes(StandardCharsets.US_ASCII)));
    return "xenv:" + VAULT_VERSION + ":" + ivHex + ":" + ctHex + ":" + macHex + "\n";
  }

  static byte[] get(String env, String key) throws Exception {
    Map<String, String> p = readParams(env);
    String pass = passphrase(env);
    int iter = Integer.parseInt(p.get("iter"));
    byte[] envOkm = pbkdf2Okm(pass, p.get("salt"), iter);
    Path file = Path.of(root(), "envs", env, key + VALUE_EXT);
    if (!Files.isRegularFile(file)) throw new RuntimeException("no such key: " + key);
    return decryptEnvelope(new String(Files.readAllBytes(file), StandardCharsets.US_ASCII), pass, p.get("salt"), iter, envOkm);
  }

  static void set(String env, String key, byte[] plaintext) throws Exception {
    Map<String, String> p = readParams(env);
    byte[][] keys = deriveKeys(passphrase(env), p.get("salt"), Integer.parseInt(p.get("iter")));
    Path dir = Path.of(root(), "envs", env);
    if (!Files.isDirectory(dir)) throw new RuntimeException("no env directory: " + dir);
    Path dest = dir.resolve(key + VALUE_EXT);
    Path tmp = dir.resolve(key + VALUE_EXT + ".tmp");
    Files.write(tmp, encryptEnvelope(plaintext, keys[0], keys[1]).getBytes(StandardCharsets.US_ASCII));
    Files.move(tmp, dest, java.nio.file.StandardCopyOption.REPLACE_EXISTING,
               java.nio.file.StandardCopyOption.ATOMIC_MOVE);
  }

  static List<String[]> load(String env) throws Exception {
    Map<String, String> p = readParams(env);
    String pass = passphrase(env);
    int iter = Integer.parseInt(p.get("iter"));
    byte[] envOkm = pbkdf2Okm(pass, p.get("salt"), iter);   // ONE PBKDF2 for the env
    Path dir = Path.of(root(), "envs", env);
    List<String[]> names = new ArrayList<>();
    try (var stream = Files.list(dir)) {
      stream.sorted().forEach(pth -> {
        String name = pth.getFileName().toString();
        if (name.endsWith(VALUE_EXT)) names.add(new String[] { name.substring(0, name.length() - VALUE_EXT.length()), pth.toString() });
      });
    }
    List<String[]> out = new ArrayList<>();
    for (String[] n : names) {
      byte[] pt = decryptEnvelope(new String(Files.readAllBytes(Path.of(n[1])), StandardCharsets.US_ASCII), pass, p.get("salt"), iter, envOkm);
      out.add(new String[] { n[0], new String(pt, StandardCharsets.UTF_8) });
    }
    return out;
  }

  static final char[] HEXCH = "0123456789abcdef".toCharArray();

  static String hexEncode(byte[] b) {
    char[] out = new char[b.length * 2];
    for (int i = 0; i < b.length; i++) {
      out[i * 2] = HEXCH[(b[i] >> 4) & 0xf];
      out[i * 2 + 1] = HEXCH[b[i] & 0xf];
    }
    return new String(out);
  }

  static byte[] hexDecode(String s) {
    byte[] out = new byte[s.length() / 2];
    for (int i = 0; i < out.length; i++) {
      out[i] = (byte) Integer.parseInt(s.substring(i * 2, i * 2 + 2), 16);
    }
    return out;
  }

  public static void main(String[] args) {
    try {
      if (args.length == 3 && args[0].equals("get")) {
        System.out.write(get(args[1], args[2]));
        System.out.flush();
      } else if (args.length == 4 && args[0].equals("set")) {
        set(args[1], args[2], args[3].getBytes(StandardCharsets.UTF_8));
      } else if (args.length == 2 && args[0].equals("load")) {
        StringBuilder sb = new StringBuilder();
        for (String[] kv : load(args[1])) sb.append(kv[0]).append('=').append(kv[1]).append('\n');
        System.out.write(sb.toString().getBytes(StandardCharsets.UTF_8));
        System.out.flush();
      } else {
        System.err.println("usage: java Xenv.java {get|set|load} <env> [<key>] [<value>]");
        System.exit(2);
      }
    } catch (Exception e) {
      System.err.println("xenv: " + e.getMessage());
      System.exit(1);
    }
  }
}
