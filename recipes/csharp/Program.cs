// xenv recipe for C# / .NET — minimal but complete (get / set / load).
//
// Reference implementation generated from ../README.md. Reads and writes
// the xenv on-disk format using only the BCL: System.Security.Cryptography
// covers PBKDF2-SHA256 (Rfc2898DeriveBytes.Pbkdf2), AES-256-CBC
// (Aes + EncryptCbc/DecryptCbc), HMAC-SHA256, and a constant-time compare
// (CryptographicOperations.FixedTimeEquals). No NuGet packages.
//
// Build once, then run the produced binary:
//   dotnet build -c Release
//   ./bin/Release/net8.0/xenv-recipe get  <env> <key>     # prints plaintext
//   ./bin/Release/net8.0/xenv-recipe set  <env> <key> <v> # writes value
//   ./bin/Release/net8.0/xenv-recipe load <env>           # prints KEY=value

using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

try
{
    if (args.Length == 3 && args[0] == "get")
    {
        byte[] pt = Xenv.Get(args[1], args[2]);
        using var so = Console.OpenStandardOutput();
        so.Write(pt, 0, pt.Length);
    }
    else if (args.Length == 4 && args[0] == "set")
    {
        Xenv.Set(args[1], args[2], Encoding.UTF8.GetBytes(args[3]));
    }
    else if (args.Length == 2 && args[0] == "load")
    {
        using var so = Console.OpenStandardOutput();
        foreach (var (key, value) in Xenv.Load(args[1]))
        {
            byte[] k = Encoding.UTF8.GetBytes(key + "=");
            so.Write(k, 0, k.Length);
            so.Write(value, 0, value.Length);
            so.WriteByte((byte)'\n');
        }
    }
    else
    {
        Console.Error.WriteLine("usage: xenv-recipe {get|set|load} <env> [<key>] [<value>]");
        Environment.Exit(2);
    }
}
catch (Exception e)
{
    Console.Error.WriteLine($"xenv: {e.Message}");
    Environment.Exit(1);
}

static class Xenv
{
    const string VaultVersion = "v3";
    const string ValueExt = ".value.enc";

    static string Root() =>
        Environment.GetEnvironmentVariable("XENV_ROOT") is { Length: > 0 } r ? r : "xenv";

    static string EnvVarName(string env) =>
        "XENV_KEY_" + env.ToUpperInvariant().Replace('-', '_');

    static string Passphrase(string env)
    {
        var v = Environment.GetEnvironmentVariable(EnvVarName(env));
        if (string.IsNullOrEmpty(v)) v = Environment.GetEnvironmentVariable("XENV_KEY");
        if (string.IsNullOrEmpty(v))
            throw new Exception($"no passphrase: set ${EnvVarName(env)} or $XENV_KEY");
        return v;
    }

    // Parse the per-env README frontmatter — naive split-on-first-colon.
    static (int iter, string salt) ReadParams(string env)
    {
        var readme = Path.Combine(Root(), "envs", env, "README.md");
        if (!File.Exists(readme)) throw new Exception($"no README at {readme}");

        var found = new Dictionary<string, string>();
        bool inBlock = false;
        foreach (var line in File.ReadAllLines(readme))
        {
            if (line == "---")
            {
                if (!inBlock) { inBlock = true; continue; }
                break;
            }
            if (!inBlock) continue;
            var s = line.Trim();
            if (s.Length == 0 || s.StartsWith('#')) continue;
            int colon = s.IndexOf(':');
            if (colon < 0) continue;
            found[s[..colon].Trim()] = s[(colon + 1)..].Trim();
        }

        if (!found.TryGetValue("version", out var ver) || ver != VaultVersion)
            throw new Exception($"params: unsupported or missing version: {found.GetValueOrDefault("version")}");
        var salt = found.GetValueOrDefault("salt", "");
        if (!Regex.IsMatch(salt, "^[0-9a-f]{32}$")) throw new Exception("params: invalid salt");
        var iter = found.GetValueOrDefault("iter", "");
        if (!Regex.IsMatch(iter, "^[0-9]+$")) throw new Exception("params: invalid iter");
        return (int.Parse(iter), salt);
    }

    static (byte[] enc, byte[] mac) DeriveKeys(string pass, string saltHex, int iter)
    {
        byte[] outb = Rfc2898DeriveBytes.Pbkdf2(
            Encoding.UTF8.GetBytes(pass), Convert.FromHexString(saltHex), iter, HashAlgorithmName.SHA256, 64);
        return (outb[..32], outb[32..]);
    }

    static string HexLower(byte[] b) => Convert.ToHexString(b).ToLowerInvariant();

    static byte[] DecryptEnvelope(string envelope, byte[] encKey, byte[] macKey)
    {
        var parts = envelope.Trim().Split(':');
        if (parts.Length != 5) throw new Exception("envelope: wrong field count");
        string tag = parts[0], ver = parts[1], ivHex = parts[2], ctHex = parts[3], macHex = parts[4];
        if (tag != "xenv" || ver != VaultVersion) throw new Exception($"envelope: unsupported {tag}:{ver}");
        if (ivHex.Length != 32 || macHex.Length != 64) throw new Exception("envelope: wrong iv/mac length");
        if (ctHex.Length == 0 || ctHex.Length % 32 != 0) throw new Exception("envelope: ct not block-aligned");
        if (!Regex.IsMatch(ivHex + ctHex + macHex, "^[0-9a-f]+$")) throw new Exception("envelope: non-hex content");

        // MAC verify FIRST (encrypt-then-MAC; constant-time compare).
        var macScope = $"{VaultVersion}:{ivHex}:{ctHex}";
        var expected = HMACSHA256.HashData(macKey, Encoding.ASCII.GetBytes(macScope));
        var provided = Convert.FromHexString(macHex);
        if (!CryptographicOperations.FixedTimeEquals(expected, provided))
            throw new Exception("MAC verification failed — wrong key or tampered vault");

        using var aes = Aes.Create();
        aes.Key = encKey;
        return aes.DecryptCbc(Convert.FromHexString(ctHex), Convert.FromHexString(ivHex), PaddingMode.PKCS7);
    }

    static string EncryptEnvelope(byte[] plaintext, byte[] encKey, byte[] macKey)
    {
        byte[] iv = RandomNumberGenerator.GetBytes(16);
        using var aes = Aes.Create();
        aes.Key = encKey;
        byte[] ct = aes.EncryptCbc(plaintext, iv, PaddingMode.PKCS7);

        var ivHex = HexLower(iv);
        var ctHex = HexLower(ct);
        var macScope = $"{VaultVersion}:{ivHex}:{ctHex}";
        var macHex = HexLower(HMACSHA256.HashData(macKey, Encoding.ASCII.GetBytes(macScope)));
        return $"xenv:{VaultVersion}:{ivHex}:{ctHex}:{macHex}\n";
    }

    public static byte[] Get(string env, string key)
    {
        var (iter, salt) = ReadParams(env);
        var (enc, mac) = DeriveKeys(Passphrase(env), salt, iter);
        var file = Path.Combine(Root(), "envs", env, key + ValueExt);
        if (!File.Exists(file)) throw new Exception($"no such key: {key}");
        return DecryptEnvelope(File.ReadAllText(file), enc, mac);
    }

    public static void Set(string env, string key, byte[] plaintext)
    {
        var (iter, salt) = ReadParams(env);
        var (enc, mac) = DeriveKeys(Passphrase(env), salt, iter);
        var dir = Path.Combine(Root(), "envs", env);
        if (!Directory.Exists(dir)) throw new Exception($"no env directory: {dir}");
        var dest = Path.Combine(dir, key + ValueExt);
        var tmp = dest + ".tmp";
        File.WriteAllText(tmp, EncryptEnvelope(plaintext, enc, mac));
        File.Move(tmp, dest, true);
    }

    public static List<(string Key, byte[] Value)> Load(string env)
    {
        var (iter, salt) = ReadParams(env);
        var (enc, mac) = DeriveKeys(Passphrase(env), salt, iter);
        var dir = Path.Combine(Root(), "envs", env);
        var res = new List<(string, byte[])>();
        foreach (var path in Directory.GetFiles(dir).OrderBy(p => Path.GetFileName(p), StringComparer.Ordinal))
        {
            var name = Path.GetFileName(path);
            if (!name.EndsWith(ValueExt)) continue;
            var key = name[..^ValueExt.Length];
            res.Add((key, DecryptEnvelope(File.ReadAllText(path), enc, mac)));
        }
        return res;
    }
}
