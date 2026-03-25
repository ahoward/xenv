/**
 * HTML template for the xenv static site.
 */
export function wrap_html(body: string, css: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>xenv — encrypted dotenv alternative with MCP server for AI agents</title>
  <meta name="description" content="The first secrets manager built for AI agents. AES-256-GCM encrypted vaults, built-in MCP server, single binary, zero deps. Install in seconds.">
  <meta name="keywords" content="dotenv alternative, secrets manager, environment variables encryption, mcp secrets tool, encrypted env files, xenv, dotenvx alternative, direnv alternative, ai agent secrets, environment runner, single binary">
  <meta name="theme-color" content="#0d1117">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="https://xenv.sh/">
  <link rel="alternate" type="text/plain" href="/llms.txt" title="LLM-readable documentation">

  <!-- Open Graph -->
  <meta property="og:type" content="website">
  <meta property="og:title" content="xenv — the first secrets manager built for AI agents">
  <meta property="og:description" content="Built-in MCP server with 11 tools. AES-256-GCM encrypted vaults. --json on every command. Works with Claude Code, Cursor, Windsurf, Copilot. Single binary, zero deps.">
  <meta property="og:url" content="https://xenv.sh/">
  <meta property="og:site_name" content="xenv">
  <meta property="og:image" content="https://xenv.sh/og.svg">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">

  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="xenv — the first secrets manager built for AI agents">
  <meta name="twitter:description" content="Built-in MCP server. AES-256-GCM encrypted vaults. --json everywhere. Works with Claude Code, Cursor, Windsurf, Copilot. Zero deps.">
  <meta name="twitter:image" content="https://xenv.sh/og.svg">

  <!-- Favicon -->
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🔐</text></svg>">

  <!-- JSON-LD Structured Data -->
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "name": "xenv",
    "applicationCategory": "DeveloperApplication",
    "operatingSystem": "Linux, macOS, Windows",
    "description": "AI-native environment runner and secrets manager. Single binary, zero dependencies, AES-256-GCM encrypted vaults, MCP server for AI coding agents.",
    "url": "https://xenv.sh/",
    "downloadUrl": "https://xenv.sh/install.sh",
    "softwareVersion": "1.0.0",
    "license": "https://opensource.org/licenses/MIT",
    "offers": {
      "@type": "Offer",
      "price": "0",
      "priceCurrency": "USD"
    },
    "author": {
      "@type": "Organization",
      "name": "mountainhigh.codes",
      "url": "https://github.com/ahoward"
    },
    "codeRepository": "https://github.com/ahoward/xenv",
    "programmingLanguage": "TypeScript"
  }
  </script>

  <style>${css}</style>
</head>
<body>
  <header class="site-header">
    <span style="color: var(--green); font-weight: 600;">xenv</span>
    <nav>
      <a href="https://github.com/ahoward/xenv">github</a>
      <a href="https://github.com/ahoward/xenv/blob/main/AGENTS.md">agents</a>
      <a href="/llms.txt">llms.txt</a>
    </nav>
  </header>

  <main>
${body}
  </main>

  <footer class="site-footer">
    xenv — MIT license — <a href="https://github.com/ahoward/xenv">github.com/ahoward/xenv</a>
  </footer>
</body>
</html>`;
}
