import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36";

type Source =
  | { id: string; name: string; kind: "sitemap"; sitemaps: string[]; include?: RegExp; exclude?: RegExp; pages: number }
  | { id: string; name: string; kind: "files"; root: string; match: RegExp; urlFor: (path: string) => string };

const SOURCES: Source[] = [
  {
    id: "vultr",
    name: "Vultr documentation",
    kind: "sitemap",
    sitemaps: ["https://docs.vultr.com/sitemap.xml"],
    pages: 700,
  },
  {
    id: "mlh",
    name: "Major League Hacking",
    kind: "sitemap",
    sitemaps: ["https://www.mlh.com/sitemap.xml"],
    exclude: /\/(seasons|events)\//,
    pages: 80,
  },
  {
    id: "ans",
    name: "Agent Name Service",
    kind: "files",
    root: "ans",
    match: /\.md$/,
    urlFor: (path) => `https://github.com/webmeshtech/ans/blob/main/${path}`,
  },
  {
    id: "godaddy",
    name: "GoDaddy developer documentation",
    kind: "sitemap",
    sitemaps: ["https://developer.godaddy.com/sitemap.xml"],
    pages: 60,
  },
];

function hash(value: string): number {
  let h = 2166136261;
  for (const ch of value) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return Math.abs(h);
}

async function get(url: string): Promise<string> {
  const response = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(25000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function urlsFrom(sitemaps: string[], depth = 0): Promise<string[]> {
  const out: string[] = [];
  for (const sitemap of sitemaps) {
    let xml: string;
    try {
      xml = await get(sitemap);
    } catch (error) {
      process.stdout.write(`  ${sitemap}: ${(error as Error).message}\n`);
      continue;
    }
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
    const nested = locs.filter((l) => l.endsWith(".xml"));
    out.push(...locs.filter((l) => !l.endsWith(".xml")));
    if (nested.length > 0 && depth < 2) out.push(...(await urlsFrom(nested.slice(0, 12), depth + 1)));
  }
  return [...new Set(out)];
}

function textOf(html: string): { title: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<\/(p|div|li|h1|h2|h3|h4|section|article|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title: title.split(/\s+[|·-]\s+/)[0] || title, text: body };
}

function fromMarkdown(raw: string): { title: string; text: string } {
  const title = /^#\s+(.+)$/m.exec(raw)?.[1]?.trim() ?? "";
  const text = raw
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^[#>*-]+\s*/gm, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}

function chunks(text: string, target = 700): string[] {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.replace(/\n/g, " ").trim()).filter((p) => p.length > 80);
  const out: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (current.length + paragraph.length + 1 > target && current.length > 0) {
      out.push(current.trim());
      current = "";
    }
    current += `${paragraph} `;
    while (current.length > target * 1.8) {
      out.push(current.slice(0, target).trim());
      current = current.slice(target);
    }
  }
  if (current.trim().length > 80) out.push(current.trim());
  return out;
}

function walk(root: string, match: RegExp): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".git") continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) visit(path);
      else if (match.test(entry)) out.push(path);
    }
  };
  visit(root);
  return out;
}

async function build(source: Source): Promise<void> {
  process.stdout.write(`\n${source.name}\n`);
  const rows: { title: string; url: string; text: string }[] = [];

  if (source.kind === "files") {
    for (const path of walk(source.root, source.match)) {
      const { title, text } = fromMarkdown(readFileSync(path, "utf8"));
      const rel = relative(source.root, path);
      for (const chunk of chunks(text)) rows.push({ title: title || rel, url: source.urlFor(rel), text: chunk });
    }
  } else {
    let urls = await urlsFrom(source.sitemaps);
    if (source.include) urls = urls.filter((u) => source.include!.test(u));
    if (source.exclude) urls = urls.filter((u) => !source.exclude!.test(u));
    urls = urls.sort((a, b) => (hash(a) % 1000) - (hash(b) % 1000));
    process.stdout.write(`  ${urls.length} pages in the sitemap, taking ${Math.min(urls.length, source.pages)}\n`);
    let done = 0;
    for (const url of urls.slice(0, source.pages)) {
      try {
        const { title, text } = textOf(await get(url));
        for (const chunk of chunks(text)) rows.push({ title: title || url, url, text: chunk });
        done++;
        if (done % 20 === 0) process.stdout.write(`  ${done} pages, ${rows.length} passages\n`);
      } catch (error) {
        process.stdout.write(`  ${url}: ${(error as Error).message}\n`);
      }
      await new Promise((r) => setTimeout(r, 80));
    }
  }

  const seen = new Set<string>();
  const unique = rows.filter((r) => {
    const key = r.text.slice(0, 120);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const out = `${process.env.DOCS_OUT ?? "."}/${source.id}-docs.jsonl`;
  writeFileSync(out, unique.map((r) => JSON.stringify(r)).join("\n"));
  process.stdout.write(`  wrote ${unique.length} passages to ${out}\n`);
}

async function main() {
  const wanted = process.argv.slice(2);
  for (const source of SOURCES.filter((s) => wanted.length === 0 || wanted.includes(s.id))) await build(source);
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});
