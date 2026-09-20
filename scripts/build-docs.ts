import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36";

type Row = { title: string; url: string; text: string };
type Page = { title: string; url: string; text: string };

type Source = { id: string } & (
  | { kind: "sitemap"; sitemaps: string[]; include?: RegExp; exclude?: RegExp; pages: number; delayMs?: number }
  | { kind: "crawl"; seeds: string[]; host: string; deny?: RegExp; pages: number; delayMs: number }
  | { kind: "wikipedia"; titles: string[] }
  | { kind: "files"; root: string; match: RegExp; urlFor: (path: string) => string }
);

type Corpus = { dir: string; name: string; request: string; about: string[]; sources: Source[] };

const CORPORA: Corpus[] = [
  {
    dir: "godaddy",
    name: "GoDaddy",
    request: "Answer questions about GoDaddy: what the company is, what it sells, its history, and how its developer APIs work.",
    about: [
      "A GoDaddy support agent. Ask it what GoDaddy is, what it sells, when it was founded, how domain",
      "registration works, or how to call any of its developer APIs.",
    ],
    sources: [
      { id: "godaddy-developer-api", kind: "sitemap", sitemaps: ["https://developer.godaddy.com/sitemap.xml"], pages: 400, delayMs: 120 },
      {
        id: "godaddy-company",
        kind: "crawl",
        seeds: [
          "https://aboutus.godaddy.net/about-us/overview/default.aspx",
          "https://aboutus.godaddy.net/newsroom/history-and-milestones/default.aspx",
          "https://aboutus.godaddy.net/newsroom/news-releases/default.aspx",
          "https://aboutus.godaddy.net/investor-relations/overview/default.aspx",
          "https://aboutus.godaddy.net/about-us/team/default.aspx",
          "https://aboutus.godaddy.net/site-map/default.aspx",
        ],
        host: "aboutus.godaddy.net",
        deny: /\.(pdf|zip|jpg|png|gif|xlsx?|docx?)$|\/files\/|GlobalBranding/i,
        pages: 45,
        delayMs: 10000,
      },
      { id: "godaddy-reference", kind: "wikipedia", titles: ["GoDaddy"] },
    ],
  },
  {
    dir: "mlh",
    name: "Major League Hacking",
    request: "Answer questions about Major League Hacking: what MLH is, what it does for students, and how its hackathons work.",
    about: [
      "An MLH support agent. Ask it what MLH is, what a hackathon is, how to run or prepare for one,",
      "what the community values say, or which companies sponsor the league.",
    ],
    sources: [
      { id: "mlh-site", kind: "sitemap", sitemaps: ["https://www.mlh.com/sitemaps/pages-1.xml"], pages: 80, delayMs: 200 },
      { id: "mlh-reference", kind: "wikipedia", titles: ["Hackathon"] },
    ],
  },
  {
    dir: "vultr",
    name: "Vultr",
    request: "Answer questions about Vultr: what the company is, what cloud products it sells, and how to use them.",
    about: [
      "A Vultr support agent. Ask it what Vultr is, what cloud compute or bare metal means, how its",
      "regions and plans work, or how to do anything its documentation covers.",
    ],
    sources: [
      { id: "vultr-docs", kind: "sitemap", sitemaps: ["https://docs.vultr.com/sitemap.xml"], pages: 600, delayMs: 100 },
      { id: "vultr-blog", kind: "sitemap", sitemaps: ["https://blogs.vultr.com/sitemap.xml"], pages: 220, delayMs: 150 },
      { id: "vultr-reference", kind: "wikipedia", titles: ["Vultr", "Virtual private server", "Infrastructure as a service"] },
    ],
  },
  {
    dir: "ans",
    name: "Agent Name Service",
    request: "Answer questions about the Agent Name Service: what it is, how agents get identities, and how those identities are verified.",
    about: [
      "An ANS support agent. Ask it what the Agent Name Service is, how an agent gets a name, how a",
      "transparency log proves who holds a key, or how any part of the protocol works.",
    ],
    sources: [
      { id: "ans-docs", kind: "files", root: "ans", match: /\.md$/, urlFor: (path) => `https://github.com/agentnameservice/ans/blob/main/${path}` },
      { id: "ans-reference", kind: "wikipedia", titles: ["Certificate Transparency"] },
    ],
  },
];

function hash(value: string): number {
  let h = 2166136261;
  for (const ch of value) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return Math.abs(h);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

function decode(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&#x27;|&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&mdash;|&ndash;/g, ", ")
    .replace(/&hellip;/g, "...")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

const NAVIGATION = /^(home|menu|search|sign in|log in|sign up|skip to|back to top|share|print|email|previous|next|all rights reserved|cookie|accept|©)/i;

function isNavigation(line: string): boolean {
  const trimmed = line.trim();
  if (NAVIGATION.test(trimmed)) return true;
  const words = trimmed.split(/\s+/);
  const capitalised = words.filter((w) => /^[A-Z]/.test(w)).length / words.length;
  if (words.length > 6 && capitalised > 0.75) return true;
  return words.length > 12 && !/[.?!:]/.test(trimmed) && capitalised > 0.55;
}

function proseOf(fragment: string): string {
  return decode(
    fragment
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
      .replace(/<header[\s\S]*?<\/header>/gi, " ")
      .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
      .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
      .replace(/<\/(p|div|li|h1|h2|h3|h4|section|article|tr|td)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter((l) => l.length > 0 && !isNavigation(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function textOf(html: string): { title: string; text: string } {
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const regions = [
    /<main\b[^>]*>([\s\S]*)<\/main>/i.exec(html)?.[1],
    /<article\b[^>]*>([\s\S]*)<\/article>/i.exec(html)?.[1],
  ].filter((r): r is string => typeof r === "string");
  const narrowed = regions.map(proseOf).filter((t) => t.length > 400);
  const whole = proseOf(html);
  const shortest = narrowed.sort((a, b) => a.length - b.length)[0];
  return { title: title.split(/\s+[|·]\s+/)[0] || title, text: shortest ?? whole };
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
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\n/g, " ").trim())
    .filter((p) => p.length > 80);
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

async function fromWikipedia(titles: string[]): Promise<Page[]> {
  const rows: Page[] = [];
  for (const title of titles) {
    const api = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&titles=${encodeURIComponent(title)}`;
    try {
      const body = JSON.parse(await get(api)) as { query?: { pages?: Record<string, { title?: string; extract?: string }> } };
      const page = Object.values(body.query?.pages ?? {})[0];
      const extract = page?.extract ?? "";
      if (extract.length < 500) {
        process.stdout.write(`  ${title}: only ${extract.length} characters, skipped\n`);
        continue;
      }
      const clean = extract
        .split("\n")
        .filter((l) => !/^(See also|References|External links|Further reading|Notes|Bibliography)$/i.test(l.trim()))
        .join("\n");
      const url = `https://en.wikipedia.org/wiki/${encodeURIComponent((page?.title ?? title).replace(/ /g, "_"))}`;
      rows.push({ title: page?.title ?? title, url, text: clean });
      process.stdout.write(`  ${page?.title ?? title}: ${Math.round(extract.length / 1024)} KB\n`);
    } catch (error) {
      process.stdout.write(`  ${title}: ${(error as Error).message}\n`);
    }
    await sleep(200);
  }
  return rows;
}

async function fromCrawl(source: Extract<Source, { kind: "crawl" }>): Promise<Page[]> {
  const rows: Page[] = [];
  const queue = [...source.seeds];
  const seen = new Set(source.seeds);
  let done = 0;
  while (queue.length > 0 && done < source.pages) {
    const url = queue.shift()!;
    let html: string;
    try {
      html = await get(url);
    } catch (error) {
      process.stdout.write(`  ${url}: ${(error as Error).message}\n`);
      continue;
    }
    const { title, text } = textOf(html);
    if (text.length > 200) rows.push({ title: title || url, url, text });
    done++;
    if (done % 10 === 0) process.stdout.write(`  ${done} pages, ${rows.length} passages\n`);
    for (const href of [...html.matchAll(/href="([^"#?]+)"/g)].map((m) => m[1])) {
      let next: URL;
      try {
        next = new URL(href, url);
      } catch {
        continue;
      }
      if (next.host !== source.host || next.protocol !== "https:") continue;
      if (source.deny?.test(next.pathname)) continue;
      const clean = `${next.origin}${next.pathname}`;
      if (seen.has(clean) || seen.size > source.pages * 6) continue;
      seen.add(clean);
      queue.push(clean);
    }
    await sleep(source.delayMs);
  }
  return rows;
}

async function fromSitemap(source: Extract<Source, { kind: "sitemap" }>): Promise<Page[]> {
  const rows: Page[] = [];
  let urls = await urlsFrom(source.sitemaps);
  if (source.include) urls = urls.filter((u) => source.include!.test(u));
  if (source.exclude) urls = urls.filter((u) => !source.exclude!.test(u));
  urls = urls.sort((a, b) => (hash(a) % 1000) - (hash(b) % 1000));
  process.stdout.write(`  ${urls.length} pages in the sitemap, taking ${Math.min(urls.length, source.pages)}\n`);
  let done = 0;
  for (const url of urls.slice(0, source.pages)) {
    try {
      const { title, text } = textOf(await get(url));
      if (text.length > 200) rows.push({ title: title || url, url, text });
      done++;
      if (done % 25 === 0) process.stdout.write(`  ${done} pages, ${rows.length} passages\n`);
    } catch (error) {
      process.stdout.write(`  ${url}: ${(error as Error).message}\n`);
    }
    await sleep(source.delayMs ?? 80);
  }
  return rows;
}

function boilerplate(pages: Page[]): Set<string> {
  if (pages.length < 8) return new Set();
  const seenOn = new Map<string, number>();
  for (const page of pages) {
    for (const line of new Set(page.text.split("\n").map((l) => l.trim()))) {
      if (line.length === 0) continue;
      seenOn.set(line, (seenOn.get(line) ?? 0) + 1);
    }
  }
  const limit = Math.max(3, Math.floor(pages.length * 0.25));
  return new Set(
    [...seenOn]
      .filter(([line, count]) => (line.split(/\s+/).length <= 5 ? count >= 3 : count >= limit))
      .map(([line]) => line),
  );
}

function toRows(pages: Page[]): Row[] {
  const repeated = boilerplate(pages);
  const rows: Row[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const page of pages) {
    const kept = page.text
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        if (trimmed.length === 0) return true;
        if (repeated.has(trimmed)) {
          dropped++;
          return false;
        }
        return true;
      })
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    for (const chunk of chunks(kept)) {
      const key = chunk.slice(0, 120).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ title: page.title, url: page.url, text: chunk });
    }
  }
  if (repeated.size > 0) process.stdout.write(`  stripped ${repeated.size} repeated lines from ${pages.length} pages (${dropped} removals)\n`);
  return rows;
}

async function buildSource(source: Source): Promise<Page[]> {
  process.stdout.write(`\n  ${source.id}\n`);
  if (source.kind === "wikipedia") return fromWikipedia(source.titles);
  if (source.kind === "crawl") return fromCrawl(source);
  if (source.kind === "sitemap") return fromSitemap(source);
  const rows: Page[] = [];
  for (const path of walk(source.root, source.match)) {
    const { title, text } = fromMarkdown(readFileSync(path, "utf8"));
    const rel = relative(source.root, path);
    if (text.length > 200) rows.push({ title: title || rel, url: source.urlFor(rel), text });
  }
  return rows;
}

async function build(corpus: Corpus, out: string): Promise<void> {
  process.stdout.write(`\n${corpus.name}\n`);
  const dir = join(out, corpus.dir);
  mkdirSync(dir, { recursive: true });
  const written: { file: string; passages: number }[] = [];

  const only = (process.env.DOCS_ONLY ?? "").split(",").filter(Boolean);
  for (const source of corpus.sources.filter((src) => only.length === 0 || only.includes(src.id))) {
    const rows = toRows(await buildSource(source));
    if (rows.length === 0) {
      process.stdout.write(`  ${source.id}: nothing collected, skipped\n`);
      continue;
    }
    const file = `${source.id}.jsonl`;
    writeFileSync(join(dir, file), rows.map((r) => JSON.stringify(r)).join("\n"));
    written.push({ file, passages: rows.length });
    process.stdout.write(`  wrote ${rows.length} passages to ${corpus.dir}/${file}\n`);
  }

  if (only.length > 0) return;
  writeFileSync(join(dir, "request.txt"), `${corpus.request}\n`);
  writeFileSync(
    join(dir, "README.txt"),
    [
      corpus.name,
      "",
      ...corpus.about,
      "",
      "Drag every .jsonl file in this folder in at once, then paste request.txt into",
      "the box asking what the model should learn to do.",
      "",
      "Files:",
      ...written.map((w) => `  ${w.file}  ${w.passages} passages`),
      "",
      `${written.reduce((sum, w) => sum + w.passages, 0)} passages in total.`,
      "",
    ].join("\n"),
  );
  process.stdout.write(`  ${corpus.dir}/: ${written.reduce((sum, w) => sum + w.passages, 0)} passages across ${written.length} files\n`);
}

async function main() {
  const out = process.env.DOCS_OUT ?? ".";
  const wanted = process.argv.slice(2);
  for (const corpus of CORPORA.filter((c) => wanted.length === 0 || wanted.includes(c.dir))) await build(corpus, out);
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});
