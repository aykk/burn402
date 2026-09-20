import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogPlan } from "../burn";
import { trainingBootScript, UPLOAD_PATH } from "./boot";
import { CLASSIFIER_SIZING, GENERATOR_SIZING, detect, foldJobs, jobSpec, sniff, suggestRequest } from "./datasets";
import { coreSecondsPerFoldJob, pick, quote, quotes, ramNeededGb, shortlist, why } from "./estimate";
import { formatMetric, headlineMetric, run, runnerFor, tokenize } from "./infer";
import { filterQuotes, offerFor } from "./negotiate";
import type { DatasetSource, TrainedModel } from "./types";

const LIMITS = { budgetUsd: 20, rateUsdHr: 5, prepayHours: 1 / 12 };

function repeat<T>(rows: T[], times: number): T[] {
  return Array.from({ length: times }, () => rows).flat();
}

const PLANS: CatalogPlan[] = [
  { id: "vc2-1c-1gb", family: "vc2", vcpus: 1, ramGb: 1, diskGb: 25, hourlyUsd: 0.007, monthlyUsd: 5 },
  { id: "vc2-2c-2gb", family: "vc2", vcpus: 2, ramGb: 2, diskGb: 55, hourlyUsd: 0.021, monthlyUsd: 15 },
  { id: "vhf-4c-16gb", family: "vhf", vcpus: 4, ramGb: 16, diskGb: 320, hourlyUsd: 0.132, monthlyUsd: 96 },
  { id: "vhp-8c-16gb-amd", family: "vhp", vcpus: 8, ramGb: 16, diskGb: 320, hourlyUsd: 0.132, monthlyUsd: 96 },
  { id: "vcg-a16-2c-8g", family: "vcg", vcpus: 2, ramGb: 8, diskGb: 70, hourlyUsd: 0.059, monthlyUsd: 43 },
  { id: "vc2-24c-96gb", family: "vc2", vcpus: 24, ramGb: 96, diskGb: 1600, hourlyUsd: 0.657, monthlyUsd: 480 },
  { id: "vc2-1c-0.5gb-v6", family: "vc2", vcpus: 1, ramGb: 0.5, diskGb: 10, hourlyUsd: 0.003, monthlyUsd: 2.5 },
];

const LABELLED: DatasetSource = {
  id: "dataset",
  name: "tickets.tsv",
  note: "TSV, 2 labels in column 1, text in column 2",
  kind: "classifier",
  origin: "upload",
  url: "upload://up_1",
  uploadId: "up_1",
  format: "tsv",
  labelColumn: 0,
  textColumn: 1,
  labels: ["urgent", "normal"],
  maxBytes: 480000,
  rows: 5574,
  bytes: 480000,
  charsPerRow: 86,
};

const PLAIN: DatasetSource = {
  id: "dataset",
  name: "play.txt",
  note: "plain text",
  kind: "generator",
  origin: "url",
  url: "https://example.test/play.txt",
  maxBytes: 1100000,
  rows: 0,
  bytes: 1100000,
  charsPerRow: 0,
};

describe("job sizing", () => {
  it("uses each trainer's own fold count", () => {
    expect(jobSpec("x", LABELLED).folds).toBe(CLASSIFIER_SIZING.folds);
    expect(jobSpec("x", PLAIN).folds).toBe(GENERATOR_SIZING.folds);
    expect(foldJobs(jobSpec("x", LABELLED))).toBe(CLASSIFIER_SIZING.lrGrid.length * CLASSIFIER_SIZING.l2Grid.length * CLASSIFIER_SIZING.folds);
  });

  it("costs a fold job from the shape of the data, not from a table of known datasets", () => {
    const short = coreSecondsPerFoldJob(jobSpec("x", LABELLED));
    const long = coreSecondsPerFoldJob(jobSpec("x", { ...LABELLED, charsPerRow: 250, rows: 20000 }));
    expect(short).toBeGreaterThan(0);
    expect(long).toBeGreaterThan(short);
  });
});

describe("quotes", () => {
  it("keeps the families the estimator was measured on and drops what Ubuntu will not boot", () => {
    const list = shortlist(PLANS, { rateUsdHr: 5 }).map((p) => p.id);
    expect(list).not.toContain("vcg-a16-2c-8g");
    expect(list).not.toContain("vc2-1c-0.5gb-v6");
    expect(list).not.toContain("vc2-24c-96gb");
    expect(list).toContain("vhp-8c-16gb-amd");
  });

  it("gets faster and dearer as the plan gets bigger", () => {
    const spec = jobSpec("x", LABELLED);
    const small = quote(spec, PLANS[0], LIMITS);
    const big = quote(spec, PLANS[3], LIMITS);
    expect(big.trainSeconds).toBeLessThan(small.trainSeconds);
    expect(big.jobUsd).toBeGreaterThan(small.jobUsd);
    expect(small.budgetHours).toBeGreaterThan(big.budgetHours);
  });

  it("flags a plan whose RAM cannot hold one worker per vCPU", () => {
    const spec = jobSpec("x", PLAIN);
    const tight = quote(spec, { id: "tiny", family: "vc2", vcpus: 8, ramGb: 1, diskGb: 25, hourlyUsd: 0.05, monthlyUsd: 36 }, LIMITS);
    expect(tight.enoughRam).toBe(false);
    expect(ramNeededGb(spec, 8)).toBeGreaterThan(ramNeededGb(spec, 2));
  });

  it("picks the cheapest at preference 0 and the fastest at preference 1", () => {
    const list = quotes(jobSpec("x", LABELLED), PLANS, LIMITS);
    const cheapest = pick(list, 0)!;
    const fastest = pick(list, 1)!;
    expect(cheapest.jobUsd).toBeLessThanOrEqual(fastest.jobUsd);
    expect(fastest.totalSeconds).toBeLessThanOrEqual(cheapest.totalSeconds);
    expect(why(fastest, list)).toContain(fastest.plan);
  });

  it("returns nothing when every plan is over the hourly ceiling", () => {
    const list = quotes(jobSpec("x", LABELLED), PLANS, { ...LIMITS, rateUsdHr: 0.001 });
    expect(list).toEqual([]);
    expect(pick(list, 0.5)).toBeNull();
  });
});

describe("counter offers", () => {
  it("narrows the list to the limits the buyer asked for", () => {
    const list = quotes(jobSpec("x", LABELLED), PLANS, LIMITS);
    const ceiling = Math.min(...list.map((q) => q.jobUsd));
    expect(filterQuotes(list, { maxSeconds: null, maxUsd: ceiling }).every((q) => q.jobUsd <= ceiling)).toBe(true);
  });

  it("falls back to the full list when nothing meets the counter", () => {
    const spec = jobSpec("x", LABELLED);
    const brief = {
      request: spec.request,
      kind: spec.kind,
      dataset: { name: spec.dataset.name, note: spec.dataset.note, rows: spec.dataset.rows, bytes: spec.dataset.bytes },
      foldJobs: foldJobs(spec),
      budgetUsd: 20,
      rateUsdHr: 5,
      deadlineMinutes: 30,
      preference: 0.5,
      region: "ewr",
    };
    const offer = offerFor({ spec, plans: PLANS, brief, prepayHours: 1 / 12, limits: { maxSeconds: 1, maxUsd: null } });
    expect(offer.chosen).not.toBeNull();
    expect(offer.quotes.length).toBeGreaterThan(0);
  });
});

describe("the boot script", () => {
  it("carries the job, the trainer and the server the page polls", () => {
    const script = trainingBootScript({ spec: jobSpec("sort my tickets", LABELLED), rentedBy: "your agent", budget: "m_job_1, $5", plan: "vc2-2c-2gb" });
    expect(script).toContain("/srv/burn402/job.json");
    expect(script).toContain("/srv/burn402/train.py");
    expect(script).toContain("nohup python3 serve.py");
  });

  it("waits for an uploaded dataset instead of downloading one", () => {
    const script = trainingBootScript({ spec: jobSpec("x", LABELLED), rentedBy: "a", budget: "b", plan: "vc2-2c-2gb" });
    expect(script).toContain(`while [ ! -f ${UPLOAD_PATH} ]`);
    expect(script).toContain(`file://${UPLOAD_PATH}`);
    expect(script).toContain('"phase":"waiting"');
  });

  it("downloads the dataset itself when the job came from a URL", () => {
    const script = trainingBootScript({ spec: jobSpec("x", PLAIN), rentedBy: "a", budget: "b", plan: "vc2-2c-2gb" });
    expect(script).not.toContain("while [ ! -f");
    expect(script).toContain("https://example.test/play.txt");
  });
});

describe("running a model the page has never seen before", () => {
  const model: TrainedModel = {
    schema: "burn402/model-v2",
    runtime: "linear-bow",
    kind: "classifier",
    trainedAt: 1,
    interface: {
      input: { type: "text", label: "Give it something to read", placeholder: "…", lines: 3 },
      output: { type: "labels", label: "It answers with one of 2 labels" },
    },
    metrics: [
      { key: "heldOutAccuracy", label: "correct on rows it never saw", value: 0.98, format: "percent", better: "higher", headline: true },
      { key: "rows", label: "rows it learned from", value: 4738, format: "count" },
    ],
    labels: ["ham", "spam"],
    terms: ["free", "prize", "meeting", "free_prize"],
    idf: [2, 2, 2, 3],
    weights: [
      [-1, -1, 2, -1],
      [1, 1, -2, 1],
    ],
    bias: [0, 0],
  };

  it("tokenizes into words and adjacent pairs, like the trainer does", () => {
    expect(tokenize("Free prize")).toEqual(["free", "prize", "free_prize"]);
  });

  it("runs whatever runtime the model names", () => {
    const result = run(model, "free prize");
    expect(result?.type).toBe("labels");
    expect(result && result.type === "labels" && result.label).toBe("spam");
    expect(run(model, "xyzzy")).toBeNull();
  });

  it("has no runner for an unknown runtime, and says so instead of guessing", () => {
    expect(runnerFor({ ...model, runtime: "torch-transformer" })).toBeNull();
    expect(run({ ...model, runtime: "torch-transformer" }, "free")).toBeNull();
  });

  it("reads the headline metric and formats values from the trainer's own labels", () => {
    expect(headlineMetric(model)?.key).toBe("heldOutAccuracy");
    expect(formatMetric(0.98, "percent")).toBe("98.0%");
    expect(formatMetric(4738, "count")).toBe("4,738");
    expect(formatMetric(4.641, "number")).toBe("4.641");
    const other = headlineMetric({ ...model, metrics: [{ key: "rmse", label: "root mean squared error", value: 3.2, format: "number", better: "lower" }] });
    expect(other?.key).toBe("rmse");
  });

  it("writes text by backing off to shorter contexts", () => {
    const generator: TrainedModel = {
      schema: "burn402/model-v2",
      runtime: "char-ngram",
      kind: "generator",
      trainedAt: 1,
      interface: { input: { type: "text", label: "Start it off", placeholder: "…" }, output: { type: "continuation", label: "more text" } },
      metrics: [{ key: "heldOutPerplexity", label: "perplexity", value: 4.5, format: "number", better: "lower", headline: true }],
      order: 3,
      table: { abc: [["d", 1]], bcd: [["a", 1]], cda: [["b", 1]], dab: [["c", 1]] },
      seed: "abc",
    };
    const out = run(generator, "abc", { length: 20 });
    expect(out?.type).toBe("text");
    expect(out && out.type === "text" && out.text.startsWith("abcdabcd")).toBe(true);
  });
});

describe("document search", () => {
  const DOCS: DatasetSource = {
    id: "dataset",
    name: "vultr-docs.jsonl",
    note: "passages with a link back to the page each came from",
    kind: "retrieval",
    origin: "upload",
    url: "upload://up_docs",
    uploadId: "up_docs",
    format: "jsonl",
    textField: "text",
    urlField: "url",
    titleField: "title",
    maxBytes: 3000000,
    rows: 2089,
    bytes: 3000000,
    charsPerRow: 640,
  };

  it("detects a corpus of passages with links as a search job, not a classifier", () => {
    const body = repeat(
      [
        JSON.stringify({ title: "Deploy Redis", url: "https://docs.example/redis", text: "Install Redis on Ubuntu with apt and enable the service." }),
        JSON.stringify({ title: "Object storage", url: "https://docs.example/storage", text: "Create a bucket and upload files with the s3 compatible API." }),
      ],
      15,
    ).join("\n");
    const { dataset } = detect(body, { name: "docs.jsonl", bytes: body.length, origin: "upload", url: "upload://up_1", uploadId: "up_1" });
    expect(dataset.kind).toBe("retrieval");
    expect(dataset.urlField).toBe("url");
    expect(dataset.titleField).toBe("title");
  });

  it("prices a search job from passages and probe questions", () => {
    const spec = jobSpec("x", DOCS);
    const cheap = coreSecondsPerFoldJob(spec);
    const bigger = coreSecondsPerFoldJob(jobSpec("x", { ...DOCS, rows: 4000 }));
    expect(bigger).toBeGreaterThan(cheap);
    expect(quote(spec, PLANS[3], LIMITS).trainSeconds).toBeGreaterThan(0);
  });

  it("asks a question and gets passages back with their source links", () => {
    const model: TrainedModel = {
      schema: "burn402/model-v2",
      runtime: "tfidf-passages",
      kind: "retrieval",
      trainedAt: 1,
      interface: {
        input: { type: "text", label: "Ask it something", placeholder: "…", lines: 2 },
        output: { type: "passages", label: "passages with links" },
      },
      metrics: [{ key: "recallAt1", label: "answered by the right passage first", value: 0.81, format: "percent", better: "higher", headline: true }],
      terms: ["redis", "bucket", "install", "redis_install"],
      idf: [2, 2, 1.5, 3],
      passages: [
        { title: "Deploy Redis", url: "https://docs.example/redis", text: "Install Redis on Ubuntu.", vector: [[0, 0.8], [2, 0.6]] },
        { title: "Object storage", url: "https://docs.example/storage", text: "Create a bucket.", vector: [[1, 0.9]] },
      ],
    };
    const result = run(model, "how do I install redis", { answers: 2 });
    expect(result?.type).toBe("passages");
    if (result?.type !== "passages") throw new Error("expected passages");
    expect(result.passages[0].url).toBe("https://docs.example/redis");
    expect(result.passages[0].score).toBeGreaterThan(0);
    expect(run(model, "quantum tunnelling")).toBeNull();
  });

  it("suggests a request that mentions the source pages", () => {
    expect(suggestRequest(DOCS)).toContain("vultr-docs.jsonl");
  });
});

describe("reading data the user brought", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const serve = (body: string) =>
    vi.stubGlobal("fetch", async () => new Response(body, { status: 206, headers: { "content-range": `bytes 0-${body.length - 1}/${body.length}` } }));

  it("finds the label and text columns in a CSV", async () => {
    serve(
      repeat(
        [
          '"3","Stocks slip","Shares fell again as traders weighed the outlook for rates and earnings."',
          '"2","Cup final","The match went to penalties after ninety minutes of deadlock in the final."',
        ],
        30,
      ).join("\n"),
    );
    const { dataset } = await sniff("https://example.test/news.csv");
    expect(dataset.kind).toBe("classifier");
    expect(dataset.format).toBe("csv");
    expect(dataset.labelColumn).toBe(0);
    expect(dataset.textColumn).toBe(2);
    expect(dataset.charsPerRow).toBeGreaterThan(40);
  });

  it("reads JSONL by field name and reports the labels it found", async () => {
    serve(
      repeat([JSON.stringify({ label: "urgent", text: "the site is down for everyone" }), JSON.stringify({ label: "normal", text: "can you send the invoice" })], 30).join(
        "\n",
      ),
    );
    const { dataset, labels } = await sniff("https://example.test/tickets.jsonl");
    expect(dataset.format).toBe("jsonl");
    expect(dataset.labelField).toBe("label");
    expect(dataset.textField).toBe("text");
    expect(labels).toEqual(["urgent", "normal"]);
  });

  it("treats plain text as a language model job", async () => {
    serve(repeat(["To be or not to be, that is the question.", "Whether tis nobler in the mind to suffer."], 100).join("\n"));
    expect((await sniff("https://example.test/play.txt")).dataset.kind).toBe("generator");
  });

  it("refuses a URL that is not http", async () => {
    await expect(sniff("file:///etc/passwd")).rejects.toThrow("http");
  });

  it("refuses data too small to train on, before anyone pays for a server", async () => {
    serve(["urgent\tthe site is down", "normal\tsend the invoice"].join("\n"));
    await expect(sniff("https://example.test/tiny.tsv")).rejects.toThrow("at least");
  });

  it("refuses a file that is not text", async () => {
    serve(String.fromCharCode(...Array.from({ length: 400 }, (_, i) => (i * 7) % 12)));
    await expect(sniff("https://example.test/blob.bin")).rejects.toThrow("not text");
  });

  it("refuses a web page and says to use the data behind it", async () => {
    serve(`<!doctype html><html><body>${"<p>hello</p>".repeat(400)}</body></html>`);
    await expect(sniff("https://example.test/page.html")).rejects.toThrow("web page");
  });

  it("detects an uploaded file without fetching anything", () => {
    const body = repeat(["urgent\tthe site is down for everyone", "normal\tcan you send the invoice over"], 30).join("\n");
    const { dataset, labels } = detect(body, { name: "tickets.tsv", bytes: body.length, origin: "upload", url: "upload://up_9", uploadId: "up_9" });
    expect(dataset.origin).toBe("upload");
    expect(dataset.uploadId).toBe("up_9");
    expect(labels.sort()).toEqual(["normal", "urgent"]);
  });

  it("suggests a request from the data rather than from a canned list", () => {
    expect(suggestRequest(LABELLED)).toBe("sort text into urgent, normal");
    expect(suggestRequest(PLAIN)).toContain("play.txt");
    expect(suggestRequest({ ...LABELLED, labels: ["a", "b", "c", "d", "e"] })).toContain("5 labels");
  });
});
