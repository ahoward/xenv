<?php

// Custom Exception for xenv errors
class XenvException extends Exception {}

// Error handling function (now throws XenvException)
function error_exit($message) {
    throw new XenvException($message);
}

// Helper functions for hex conversion
function bin_to_hex($data) {
    return bin2hex($data);
}

function hex_to_bin($hex_string) {
    if (!is_string($hex_string) || !ctype_xdigit($hex_string) || strlen($hex_string) % 2 !== 0) {
        error_exit("Invalid hex string format for conversion.");
    }
    return hex2bin($hex_string);
}

// Passphrase resolution
function get_passphrase($env_name) {
    $env_var_name = "XENV_KEY_" . strtoupper(str_replace('-', '_', $env_name));
    $passphrase = getenv($env_var_name);
    if ($passphrase !== false) {
        return $passphrase;
    }
    $passphrase = getenv("XENV_KEY");
    if ($passphrase !== false) {
        return $passphrase;
    }
    error_exit("Passphrase not found. Tried: $" . $env_var_name . ", $XENV_KEY");
}

// Xenv root resolution
function get_xenv_root() {
    $xenv_root = getenv("XENV_ROOT");
    if ($xenv_root !== false) {
        return $xenv_root;
    }
    // Default to ./xenv relative to current working directory
    return rtrim(getcwd(), DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . 'xenv';
}

// Read and parse env README.md frontmatter
function read_env_config($env_name) {
    $xenv_root = get_xenv_root();
    $readme_path = $xenv_root . DIRECTORY_SEPARATOR . 'envs' . DIRECTORY_SEPARATOR . $env_name . DIRECTORY_SEPARATOR . 'README.md';

    if (!file_exists($readme_path)) {
        error_exit("Environment config file not found: " . $readme_path);
    }

    $content = file_get_contents($readme_path);
    if ($content === false) {
        error_exit("Failed to read environment config file: " . $readme_path);
    }

    $lines = explode("\n", $content);
    $in_frontmatter = false;
    $config = [];

    foreach ($lines as $line) {
        $trimmed_line = trim($line);
        if ($trimmed_line === '---') {
            $in_frontmatter = !$in_frontmatter;
            if (!$in_frontmatter) { // End of frontmatter
                break;
            }
            continue;
        }
        if ($in_frontmatter && $trimmed_line !== '' && $trimmed_line[0] !== '#') {
            $parts = explode(':', $trimmed_line, 2);
            if (count($parts) === 2) {
                $key = trim($parts[0]);
                $value = trim($parts[1]);
                $config[$key] = $value;
            }
        }
    }

    if (!isset($config['version']) || $config['version'] !== 'v3') {
        error_exit("Unsupported xenv version or missing version in config.");
    }
    if (!isset($config['iter']) || !ctype_digit($config['iter'])) {
        error_exit("Missing or invalid iteration count in config.");
    }
    if (!isset($config['salt']) || strlen($config['salt']) !== 32 || !ctype_xdigit($config['salt'])) {
        error_exit("Missing or invalid salt (must be 32 hex chars) in config.");
    }

    $config['iter'] = (int)$config['iter'];
    $config['salt'] = hex_to_bin($config['salt']);

    return $config;
}

// Key derivation
function derive_keys($passphrase, $salt, $iter) {
    $derived_key = hash_pbkdf2('sha256', $passphrase, $salt, $iter, 64, true);
    if ($derived_key === false || strlen($derived_key) !== 64) {
        error_exit("Failed to derive keys.");
    }
    $enc_key = substr($derived_key, 0, 32);
    $mac_key = substr($derived_key, 32, 32);
    return [$enc_key, $mac_key];
}

// Parse value envelope
function parse_envelope($envelope_line) {
    $parts = explode(':', trim($envelope_line));
    if (count($parts) !== 5) {
        error_exit("Malformed envelope: Incorrect number of fields.");
    }

    list($tag, $version, $iv_hex, $ct_hex, $mac_hex) = $parts;

    if ($tag !== 'xenv' || $version !== 'v3') {
        error_exit("Malformed envelope: Unsupported tag or version.");
    }
    if (strlen($iv_hex) !== 32 || !ctype_xdigit($iv_hex)) {
        error_exit("Malformed envelope: Invalid IV hex (must be 32 hex chars).");
    }
    // Check if ct_hex is a positive multiple of 32 hex characters (16-byte block size * 2 for hex)
    if (strlen($ct_hex) === 0 || strlen($ct_hex) % 32 !== 0 || !ctype_xdigit($ct_hex)) {
        error_exit("Malformed envelope: Invalid ciphertext hex length or format (must be positive multiple of 32 hex chars).");
    }
    if (strlen($mac_hex) !== 64 || !ctype_xdigit($mac_hex)) {
        error_exit("Malformed envelope: Invalid MAC hex (must be 64 hex chars).");
    }

    return [$iv_hex, $ct_hex, $mac_hex];
}

// Decryption logic
function xenv_get($env_name, $key_name) {
    $passphrase = get_passphrase($env_name);
    $config = read_env_config($env_name);
    list($enc_key, $mac_key) = derive_keys($passphrase, $config['salt'], $config['iter']);

    $xenv_root = get_xenv_root();
    $value_path = $xenv_root . DIRECTORY_SEPARATOR . 'envs' . DIRECTORY_SEPARATOR . $env_name . DIRECTORY_SEPARATOR . $key_name . '.value.enc';

    if (!file_exists($value_path)) {
        error_exit("Key not found: " . $key_name);
    }

    $envelope_line = file_get_contents($value_path);
    if ($envelope_line === false) {
        error_exit("Failed to read value file: " . $value_path);
    }

    list($iv_hex, $ct_hex, $mac_hex) = parse_envelope($envelope_line);

    $iv = hex_to_bin($iv_hex);
    $ciphertext = hex_to_bin($ct_hex);
    $expected_mac = hex_to_bin($mac_hex);

    $mac_scope = "v3:" . $iv_hex . ":" . $ct_hex;
    $computed_mac = hash_hmac('sha256', $mac_scope, $mac_key, true);

    if (!hash_equals($computed_mac, $expected_mac)) {
        error_exit("MAC verification failed for key: " . $key_name);
    }

    // openssl_decrypt with OPENSSL_RAW_DATA handles PKCS#7 unpadding automatically in most PHP versions.
    $plaintext = openssl_decrypt($ciphertext, 'aes-256-cbc', $enc_key, OPENSSL_RAW_DATA, $iv);
    if ($plaintext === false) {
        error_exit("Decryption failed for key: " . $key_name);
    }

    return $plaintext;
}

// Encryption logic
function xenv_set($env_name, $key_name, $plaintext) {
    $passphrase = get_passphrase($env_name);
    $config = read_env_config($env_name);
    list($enc_key, $mac_key) = derive_keys($passphrase, $config['salt'], $config['iter']);

    $iv = random_bytes(16); // 16-byte IV for AES-256-CBC
    if ($iv === false) {
        error_exit("Failed to generate random IV.");
    }
    $iv_hex = bin_to_hex($iv);

    // openssl_encrypt with OPENSSL_RAW_DATA handles PKCS#7 padding automatically.
    $ciphertext = openssl_encrypt($plaintext, 'aes-256-cbc', $enc_key, OPENSSL_RAW_DATA, $iv);
    if ($ciphertext === false) {
        error_exit("Encryption failed for key: " . $key_name);
    }
    $ct_hex = bin_to_hex($ciphertext);

    $mac_scope = "v3:" . $iv_hex . ":" . $ct_hex;
    $mac = hash_hmac('sha256', $mac_scope, $mac_key, true);
    $mac_hex = bin_to_hex($mac);

    $envelope_line = "xenv:v3:" . $iv_hex . ":" . $ct_hex . ":" . $mac_hex . "\n";

    $xenv_root = get_xenv_root();
    $env_dir = $xenv_root . DIRECTORY_SEPARATOR . 'envs' . DIRECTORY_SEPARATOR . $env_name;
    
    // Check if the environment directory exists. The README spec states:
    // "If the env directory or its README doesn't exist, error."
    // We already read the README successfully, so here we only need to verify the directory itself.
    if (!is_dir($env_dir)) {
        error_exit("Environment directory not found: " . $env_dir);
    }

    $value_path = $env_dir . DIRECTORY_SEPARATOR . $key_name . '.value.enc';
    $temp_path = $value_path . '.tmp';

    if (file_put_contents($temp_path, $envelope_line) === false) {
        error_exit("Failed to write to temporary file: " . $temp_path);
    }

    // Attempt atomic rename
    if (!rename($temp_path, $value_path)) {
        // If rename fails, try to clean up the temp file
        if (file_exists($temp_path)) {
            unlink($temp_path);
        }
        error_exit("Failed to atomically write value file: " . $value_path);
    }
}

// Load all env vars
function xenv_load($env_name) {
    $xenv_root = get_xenv_root();
    $env_dir = $xenv_root . DIRECTORY_SEPARATOR . 'envs' . DIRECTORY_SEPARATOR . $env_name;

    if (!is_dir($env_dir)) {
        error_exit("Environment directory not found: " . $env_dir);
    }

    $files = glob($env_dir . DIRECTORY_SEPARATOR . '*.value.enc');
    $vars = [];

    foreach ($files as $file) {
        $basename = basename($file, '.value.enc');
        // Exclude README.md, as it's not a value file itself
        if ($basename === 'README') {
            continue;
        }
        try {
            $plaintext = xenv_get($env_name, $basename);
            $vars[$basename] = $plaintext;
        } catch (XenvException $e) {
            // Log error but continue to load other variables
            fwrite(STDERR, "xenv: Error decrypting " . $basename . ": " . $e->getMessage() . "\n");
        }
    }

    foreach ($vars as $key => $value) {
        echo $key . "=" . $value . "\n";
    }
}

// CLI entry point
if (php_sapi_name() === 'cli') {
    global $argv;
    $command = $argv[1] ?? null;
    $env_name = $argv[2] ?? null;
    $key_name = $argv[3] ?? null;
    $value = $argv[4] ?? null;

    try {
        if (!$command || !$env_name) {
            error_exit("Usage: php xenv.php {get|set|load} <env> [<key>] [<value>]");
        }

        switch ($command) {
            case 'get':
                if (!$key_name) {
                    error_exit("Usage: php xenv.php get <env> <key>");
                }
                echo xenv_get($env_name, $key_name) . "\n";
                break;
            case 'set':
                // Note: $value can be an empty string, so check if it's explicitly null
                if (!$key_name || $value === null) {
                    error_exit("Usage: php xenv.php set <env> <key> <value>");
                }
                xenv_set($env_name, $key_name, $value);
                break;
            case 'load':
                xenv_load($env_name);
                break;
            default:
                error_exit("Unknown command: " . $command);
        }
    } catch (XenvException $e) {
        fwrite(STDERR, "xenv: " . $e->getMessage() . "\n");
        exit(1);
    } catch (Exception $e) { // Catch any other unexpected exceptions
        fwrite(STDERR, "xenv: An unexpected error occurred: " . $e->getMessage() . "\n");
        exit(1);
    }
}

?>
