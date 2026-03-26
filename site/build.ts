#!/usr/bin/env bun

/**
 * Static site builder for xenv.
 * Reads README.md, converts to HTML, wraps in template, outputs to site/dist/.
 * Zero external dependencies — uses a minimal inline markdown converter.
 */

import { mkdirSync, existsSync, copyFileSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { wrap_html } from "./template";
import pkg from "../package.json";

const ROOT = join(dirname(import.meta.dir), ".");
const SITE_DIR = dirname(import.meta.filename ?? import.meta.path);
const DIST = join(SITE_DIR, "dist");

async function main() {
  // ensure dist/
  if (!existsSync(DIST)) {
    mkdirSync(DIST, { recursive: true });
  }

  // read inputs
  const readme = await Bun.file(join(ROOT, "README.md")).text();
  const css = await Bun.file(join(SITE_DIR, "style.css")).text();

  // convert and wrap
  const body = md_to_html(readme);
  const html = wrap_html(body, css, pkg.version);

  // write outputs
  await Bun.write(join(DIST, "index.html"), html);
  console.log("  site/dist/index.html");

  // copy static files
  const statics = ["llms.txt", "robots.txt", "sitemap.xml", "og.svg", "og.png"];
  for (const file of statics) {
    const src = join(SITE_DIR, file);
    if (existsSync(src)) {
      copyFileSync(src, join(DIST, file));
      console.log(`  site/dist/${file}`);
    }
  }

  // copy AGENTS.md
  const agents_src = join(ROOT, "AGENTS.md");
  if (existsSync(agents_src)) {
    copyFileSync(agents_src, join(DIST, "AGENTS.md"));
    console.log("  site/dist/AGENTS.md");
  }

  // generate llms-full.txt (expanded version per llmstxt.org spec)
  const llms_full_parts: string[] = [readme];
  if (existsSync(agents_src)) {
    llms_full_parts.push("\n\n---\n\n" + readFileSync(agents_src, "utf-8"));
  }
  await Bun.write(join(DIST, "llms-full.txt"), llms_full_parts.join(""));
  console.log("  site/dist/llms-full.txt");

  console.log("\nsite built → site/dist/");
}

// ---------------------------------------------------------------------------
// minimal markdown → HTML converter
// handles: headings, code blocks, tables, bold, italic, inline code,
//          links, lists, blockquotes, horizontal rules, paragraphs
// ---------------------------------------------------------------------------

function md_to_html(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const lang_attr = lang ? ` class="language-${esc(lang)}"` : "";
      const code_lines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        code_lines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      out.push(`<pre><code${lang_attr}>${esc(code_lines.join("\n"))}</code></pre>`);
      continue;
    }

    // horizontal rule
    if (/^---+\s*$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }

    // heading
    const heading_match = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading_match) {
      const level = heading_match[1].length;
      const text = inline(heading_match[2]);
      const id = heading_match[2].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      out.push(`<h${level} id="${id}">${text}</h${level}>`);
      i++;
      continue;
    }

    // blockquote
    if (line.startsWith("> ") || line === ">") {
      const bq_lines: string[] = [];
      while (i < lines.length && (lines[i].startsWith("> ") || lines[i] === ">")) {
        bq_lines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push(`<blockquote><p>${inline(bq_lines.join(" "))}</p></blockquote>`);
      continue;
    }

    // table
    if (line.includes("|") && i + 1 < lines.length && /^\|?\s*[-:]+/.test(lines[i + 1])) {
      const table_lines: string[] = [];
      while (i < lines.length && lines[i].includes("|")) {
        table_lines.push(lines[i]);
        i++;
      }
      out.push(parse_table(table_lines));
      continue;
    }

    // unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const list_items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        list_items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      out.push("<ul>" + list_items.map(li => `<li>${inline(li)}</li>`).join("") + "</ul>");
      continue;
    }

    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const list_items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        list_items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      out.push("<ol>" + list_items.map(li => `<li>${inline(li)}</li>`).join("") + "</ol>");
      continue;
    }

    // blank line
    if (line.trim() === "") {
      i++;
      continue;
    }

    // paragraph — collect consecutive non-blank, non-special lines
    const para_lines: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !is_block_start(lines[i], lines[i + 1])) {
      para_lines.push(lines[i]);
      i++;
    }
    if (para_lines.length > 0) {
      out.push(`<p>${inline(para_lines.join(" "))}</p>`);
    }
  }

  return out.join("\n");
}

function is_block_start(line: string, next?: string): boolean {
  if (line.startsWith("```")) return true;
  if (/^#{1,6}\s+/.test(line)) return true;
  if (/^---+\s*$/.test(line)) return true;
  if (line.startsWith("> ")) return true;
  if (/^\s*[-*]\s+/.test(line)) return true;
  if (/^\s*\d+\.\s+/.test(line)) return true;
  if (line.includes("|") && next && /^\|?\s*[-:]+/.test(next)) return true;
  return false;
}

function parse_table(lines: string[]): string {
  const parse_row = (line: string) =>
    line.split("|").map(c => c.trim()).filter(c => c.length > 0);

  const headers = parse_row(lines[0]);
  // skip separator line (index 1)
  const rows = lines.slice(2).map(parse_row);

  let html = "<table><thead><tr>";
  for (const h of headers) html += `<th>${inline(h)}</th>`;
  html += "</tr></thead><tbody>";
  for (const row of rows) {
    html += "<tr>";
    for (const cell of row) html += `<td>${inline(cell)}</td>`;
    html += "</tr>";
  }
  html += "</tbody></table>";
  return html;
}

/** Convert inline markdown: bold, italic, code, links */
function inline(text: string): string {
  let s = text;
  // inline code (must come first to protect contents)
  s = s.replace(/`([^`]+)`/g, (_, code) => `<code>${esc(code)}</code>`);
  // linked images: [![alt](img-url)](link-url) — must come before plain images and links
  s = s.replace(/\[!\[([^\]]*)\]\(([^)]+)\)\]\(([^)]+)\)/g, '<a href="$3"><img src="$2" alt="$1"></a>');
  // images: ![alt](url)
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');
  // links: [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  // bold+italic
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  // bold
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  // italic
  s = s.replace(/\*(.+?)\*/g, "<em>$1</em>");
  return s;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

main();
