const ESCAPE_MAP: Record<string, string> = {
  "\\n": "\n",
  "\\t": "\t",
  "\\r": "\r",
  "\\\\": "\\",
};

function expandEscapes(value: string): string {
  return value.replace(/\\[ntr\\]/g, (match) => ESCAPE_MAP[match] ?? match);
}

/**
 * Parse .env / .xenv file content into key-value pairs.
 *
 * Supports:
 *   KEY=value
 *   KEY="value with spaces"
 *   KEY='value with spaces'
 *   KEY=`value`
 *   export KEY=value
 *   # comments
 *   blank lines
 *   multiline values in double/single quotes
 */
// keys that must never be set from .env files
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function parseEnvContent(content: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null);

  // strip BOM and normalize CRLF to LF for cross-platform consistency
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();
    i++;

    // skip empty lines and comments
    if (line === "" || line.startsWith("#")) continue;

    // strip optional `export ` prefix
    const stripped = line.startsWith("export ") ? line.slice(7) : line;

    const eqIdx = stripped.indexOf("=");
    if (eqIdx === -1) continue;

    const key = stripped.slice(0, eqIdx).trim();
    let value = stripped.slice(eqIdx + 1);

    // detect quoted multiline
    const quote = value[0];
    if (quote === '"' || quote === "'" || quote === "`") {
      // check if the last char on this line is the closing quote
      // (and the value is more than just the quote char itself)
      if (value.length > 1 && value[value.length - 1] === quote) {
        // single-line quoted
        value = value.slice(1, -1);
      } else {
        // multiline: accumulate until a line ends with the closing quote
        const parts = [value.slice(1)];
        while (i < lines.length) {
          const nextLine = lines[i];
          i++;
          if (nextLine.trimEnd().endsWith(quote)) {
            parts.push(nextLine.trimEnd().slice(0, -1));
            break;
          }
          parts.push(nextLine);
        }
        value = parts.join("\n");
      }
    } else {
      // unquoted: strip inline comments
      const commentIdx = value.indexOf(" #");
      if (commentIdx !== -1) {
        value = value.slice(0, commentIdx);
      }
      value = value.trim();
    }

    // expand escape sequences in double-quoted values
    if (quote === '"') {
      value = expandEscapes(value);
    }

    if (!FORBIDDEN_KEYS.has(key)) {
      result[key] = value;
    }
  }

  return result;
}
