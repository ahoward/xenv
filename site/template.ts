/**
 * HTML template for the xenv static site.
 */
export function wrap_html(body: string, css: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>xenv — dotenv alternative with AES-256 encryption &amp; MCP server for AI agents</title>
  <meta name="description" content="Drop-in dotenv alternative with AES-256-GCM encrypted vaults, 7-layer environment cascade, and MCP secrets tool for AI coding agents. Single ~10MB binary, zero dependencies. Free and open source.">
  <meta name="keywords" content="dotenv alternative, secrets manager, environment variables encryption, mcp secrets tool, encrypted env files, xenv, dotenvx alternative, direnv alternative, ai agent secrets, environment runner, single binary">
  <meta name="theme-color" content="#0d1117">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="https://ahoward.github.io/xenv/">

  <!-- Open Graph -->
  <meta property="og:type" content="website">
  <meta property="og:title" content="xenv — dotenv alternative with encryption &amp; AI agent support">
  <meta property="og:description" content="AES-256-GCM encrypted vaults. 7-layer cascade. MCP server for AI agents. Single ~10MB binary, zero dependencies.">
  <meta property="og:url" content="https://ahoward.github.io/xenv/">
  <meta property="og:site_name" content="xenv">

  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="xenv — dotenv alternative with encryption &amp; AI agent support">
  <meta name="twitter:description" content="AES-256-GCM encrypted vaults. MCP secrets tool for AI agents. Single binary, zero deps.">

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
    "url": "https://ahoward.github.io/xenv/",
    "downloadUrl": "https://ahoward.github.io/xenv/install.sh",
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
      <a href="/xenv/llms.txt">llms.txt</a>
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
