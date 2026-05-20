<?php

// --- Main CLI Dispatcher ---

if (php_sapi_name() !== 'cli') {
    http_response_code(400);
    exit("xenv: This script is intended for command-line use only.\n");
}

set_error_handler(function($severity, $message, $file, $line) {
    err("PHP Error: $message in $file on line $line");
});

if ($argc < 3) {
    err("Usage: php " . basename(__FILE__) . " {get|set|load} <env> [<key>] [<value>]");
}

$command = $argv[1];
$envName = $argv[2];

try {
    switch ($command) {
        case 'get':
            if ($argc !== 4) err("Usage: php " . basename(__FILE__) . " get <env> <key>");
            $key = $argv[3];
            $plaintext = xenv_get($envName, $key);
            echo $plaintext;
            break;

        case 'set':
            if ($argc !== 5) err("Usage: php " . basename(__FILE__) . " set <env> <key> <value>");
            $key = $argv[3];
            $plaintext = $argv[4];
            xenv_set($envName, $key, $plaintext);
            break;

        case 'load':
            if ($argc !== 3) err("Usage: php " . basename(__FILE__) . " load <env>");
            $envMap = xenv_load($envName);
            foreach ($envMap as $key => $value) {
                echo "$key=$value\n";
            }
            break;

        default:
            err("Unknown command: '$command'. Must be one of: get, set, load.");
    }
} catch (Exception $e) {
    err($e->getMessage());
}

exit(0);


// --- Core API Functions ---

/**
 * Decrypts and returns the plaintext for a single environment variable.
 * @throws Exception on any failure.
 */
function xenv_get(string $envName, string $key): string
{
    $xenvRoot = get_xenv_root();
    $valuePath = "{$xenvRoot}/envs/{$envName}/{$key}.value.enc";

    if (!is_readable($valuePath)) {
        throw new Exception("Variable file not found or not readable: $valuePath");
    }

    $envelope = trim(file_get_contents($valuePath));
    if ($envelope === false) {
        throw new Exception("Could not read variable file: $valuePath");
    }

    $passphrase = get_passphrase($envName);
    $params = parse_readme($envName, $xenvRoot);
    
    return decrypt_value($envelope, $passphrase, $params['salt'], $params['iter']);
}

/**
 * Encrypts and atomically writes a plaintext value for a single environment variable.
 * @throws Exception on any failure.
 */
function xenv_set(string $envName, string $key, string $plaintext): void
{
    $xenvRoot = get_xenv_root();
    $envDir = "{$xenvRoot}/envs/{$envName}";
    if (!is_dir($envDir)) {
        throw new Exception("Environment directory not found: $envDir");
    }

    $passphrase = get_passphrase($envName);
    $params = parse_readme($envName, $xenvRoot);
    
    $envelope = encrypt_value($plaintext, $passphrase, $params['salt'], $params['iter']);

    $targetPath = "{$envDir}/{$key}.value.enc";
    $tmpPath = "{$targetPath}.tmp." . bin2hex(random_bytes(8));

    if (file_put_contents($tmpPath, $envelope) === false) {
        throw new Exception("Failed to write to temporary file: $tmpPath");
    }

    if (!rename($tmpPath, $targetPath)) {
        unlink($tmpPath); // Clean up
        throw new Exception("Failed to atomically rename temp file to: $targetPath");
    }
}

/**
 * Decrypts all variables in an environment and returns them as a map.
 * @throws Exception on any failure.
 */
function xenv_load(string $envName): array
{
    $xenvRoot = get_xenv_root();
    $envDir = "{$xenvRoot}/envs/{$envName}";
    if (!is_dir($envDir)) {
        throw new Exception("Environment directory not found: $envDir");
    }

    $passphrase = get_passphrase($envName);
    $params = parse_readme($envName, $xenvRoot);

    $envMap = [];
    $files = scandir($envDir);
    if ($files === false) {
        throw new Exception("Could not scan environment directory: $envDir");
    }

    foreach ($files as $file) {
        if (substr($file, -10) === '.value.enc') {
            $key = substr($file, 0, -10);
            $envelope = trim(file_get_contents("{$envDir}/{$file}"));
            if ($envelope === false) {
                 throw new Exception("Could not read variable file: {$envDir}/{$file}");
            }
            $envMap[$key] = decrypt_value($envelope, $passphrase, $params['salt'], $params['iter']);
        }
    }
    
    return $envMap;
}


// --- Cryptography & File Helpers ---

function decrypt_value(string $envelope, string $passphrase, string $salt, int $iter): string
{
    // 1. Parse envelope
    $parts = explode(':', $envelope);
    if (count($parts) !== 5) {
        throw new Exception("Malformed envelope: expected 5 parts, found " . count($parts));
    }
    list($tag, $version, $ivHex, $ctHex, $macHex) = $parts;

    // 2. Validate fields
    if ($tag !== 'xenv' || $version !== 'v3') {
        throw new Exception("Unsupported envelope format: expected 'xenv:v3', got '$tag:$version'");
    }
    if (strlen($ivHex) !== 32) {
        throw new Exception("Invalid IV length: expected 32 hex chars, got " . strlen($ivHex));
    }
    if (strlen($ctHex) === 0 || strlen($ctHex) % 32 !== 0) {
        throw new Exception("Invalid ciphertext length: must be a positive multiple of 32 hex chars");
    }
    if (strlen($macHex) !== 64) {
        throw new Exception("Invalid MAC length: expected 64 hex chars, got " . strlen($macHex));
    }

    // 3. Derive keys
    list($encKey, $macKey) = derive_keys($passphrase, $salt, $iter);

    // 4. Verify MAC (BEFORE decrypting)
    $macData = "v3:{$ivHex}:{$ctHex}";
    $expectedMac = hash_hmac('sha256', $macData, $macKey, true);
    $envelopeMac = hex2bin($macHex);

    if (!hash_equals($expectedMac, $envelopeMac)) {
        throw new Exception("MAC verification failed. The variable may have been tampered with.");
    }
    
    // 5. Decrypt
    $iv = hex2bin($ivHex);
    $ciphertext = hex2bin($ctHex);
    $plaintext = openssl_decrypt($ciphertext, 'aes-256-cbc', $encKey, OPENSSL_RAW_DATA, $iv);

    if ($plaintext === false) {
        throw new Exception("Decryption failed. Check your passphrase and crypto parameters.");
    }

    return $plaintext;
}

function encrypt_value(string $plaintext, string $passphrase, string $salt, int $iter): string
{
    // 1. Derive keys
    list($encKey, $macKey) = derive_keys($passphrase, $salt, $iter);

    // 2. Random IV
    $iv = random_bytes(16);

    // 3. Encrypt
    $ciphertext = openssl_encrypt($plaintext, 'aes-256-cbc', $encKey, OPENSSL_RAW_DATA, $iv);
    if ($ciphertext === false) {
        throw new Exception("Encryption failed.");
    }

    $ivHex = bin2hex($iv);
    $ctHex = bin2hex($ciphertext);

    // 4. Compute MAC
    $macData = "v3:{$ivHex}:{$ctHex}";
    $macHex = hash_hmac('sha256', $macData, $macKey, false);

    // 5. Assemble
    return "xenv:v3:{$ivHex}:{$ctHex}:{$macHex}\n";
}

function derive_keys(string $passphrase, string $saltHex, int $iter): array
{
    $salt = hex2bin($saltHex);
    $derivedKey = hash_pbkdf2('sha256', $passphrase, $salt, $iter, 64, true);
    
    $encKey = substr($derivedKey, 0, 32);
    $macKey = substr($derivedKey, 32, 32);
    
    return [$encKey, $macKey];
}

function parse_readme(string $envName, string $xenvRoot): array
{
    $readmePath = "{$xenvRoot}/envs/{$envName}/README.md";
    if (!is_readable($readmePath)) {
        throw new Exception("Env README not found or not readable: $readmePath");
    }

    $lines = file($readmePath);
    if ($lines === false) {
        throw new Exception("Could not read env README: $readmePath");
    }

    $inFrontmatter = false;
    $params = [];
    foreach ($lines as $line) {
        $trimmedLine = trim($line);
        if ($trimmedLine === '---') {
            $inFrontmatter = !$inFrontmatter;
            if (!$inFrontmatter && !empty($params)) break; // Exit after second '---'
            continue;
        }

        if ($inFrontmatter) {
            if (empty($trimmedLine) || $trimmedLine[0] === '#') continue;
            
            $parts = explode(':', $trimmedLine, 2);
            if (count($parts) === 2) {
                $key = trim($parts[0]);
                $value = trim($parts[1]);
                $params[$key] = $value;
            }
        }
    }

    if (!isset($params['version'], $params['iter'], $params['salt'])) {
        throw new Exception("Missing required crypto parameters (version, iter, salt) in $readmePath");
    }
    if ($params['version'] !== 'v3') {
        throw new Exception("Unsupported xenv version: '{$params['version']}'. This recipe only supports 'v3'.");
    }
    if (!ctype_digit($params['iter']) || (int)$params['iter'] <= 0) {
        throw new Exception("Invalid iteration count: '{$params['iter']}'. Must be a positive integer.");
    }
    if (!ctype_xdigit($params['salt']) || strlen($params['salt']) !== 32) {
        throw new Exception("Invalid salt: '{$params['salt']}'. Must be 32 hex characters.");
    }

    $params['iter'] = (int)$params['iter'];
    return $params;
}

function get_passphrase(string $envName): string
{
    $envVarKeySpecific = 'XENV_KEY_' . strtoupper(str_replace('-', '_', $envName));
    $envVarKeyGlobal = 'XENV_KEY';

    $passphrase = getenv($envVarKeySpecific);
    if ($passphrase !== false && $passphrase !== '') {
        return $passphrase;
    }

    $passphrase = getenv($envVarKeyGlobal);
    if ($passphrase !== false && $passphrase !== '') {
        return $passphrase;
    }

    throw new Exception("Passphrase not found. Set {$envVarKeySpecific} or {$envVarKeyGlobal}.");
}

function get_xenv_root(): string
{
    $root = getenv('XENV_ROOT');
    if ($root === false || $root === '') {
        return getcwd() . '/xenv';
    }
    return $root;
}

function err(string $message): void
{
    fwrite(STDERR, "xenv: {$message}\n");
    exit(1);
}

