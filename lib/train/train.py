import json
import math
import os
import random
import re
import sys
import time
import urllib.request
from multiprocessing import Pool

OUT = "/srv/burn402"
SCHEMA = "burn402/model-v2"
CONFIG = json.load(open(os.path.join(OUT, "job.json")))
START = time.time()
STATE = {
    "phase": "starting",
    "message": "",
    "log": [],
    "started_at": START,
    "elapsed": 0.0,
    "progress": 0.0,
    "rows": 0,
    "vcpus": os.cpu_count() or 1,
    "configs_total": 0,
    "configs_done": 0,
    "best": None,
    "metrics": None,
    "done": False,
    "error": None,
}
TOKEN = re.compile(r"[a-z0-9']+")


def metric(key, label, value, fmt, better=None, headline=False, detail=None):
    entry = {"key": key, "label": label, "value": value, "format": fmt}
    if better:
        entry["better"] = better
    if headline:
        entry["headline"] = True
    if detail:
        entry["detail"] = detail
    return entry


def emit(phase=None, message=None, progress=None, **extra):
    if phase:
        STATE["phase"] = phase
    if message:
        STATE["message"] = message
        STATE["log"].append({"at": round(time.time() - START, 1), "text": message})
        STATE["log"] = STATE["log"][-60:]
    if progress is not None:
        STATE["progress"] = round(progress, 3)
    STATE.update(extra)
    STATE["elapsed"] = round(time.time() - START, 1)
    tmp = os.path.join(OUT, "status.tmp")
    with open(tmp, "w") as f:
        json.dump(STATE, f)
    os.replace(tmp, os.path.join(OUT, "status.json"))


def fetch(url, limit):
    with urllib.request.urlopen(url, timeout=60) as r:
        return r.read(limit).decode("utf-8", "replace")


def load_text():
    source = CONFIG["dataset"]
    try:
        raw = fetch(source["url"], source.get("maxBytes", 4_000_000))
        emit(message="downloaded %s (%.1f KB)" % (source["name"], len(raw) / 1024))
        return raw
    except Exception as error:
        fallback = source.get("fallback", "")
        if not fallback:
            raise
        emit(message="download failed (%s), using the built-in sample" % error)
        return fallback


def parse_passages(raw, source):
    rows = []
    text_field = source.get("textField", "text")
    url_field = source.get("urlField", "url")
    title_field = source.get("titleField")
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        text = str(d.get(text_field, "")).strip()
        url = str(d.get(url_field, "")).strip()
        if not text or not url:
            continue
        title = str(d.get(title_field, "")).strip() if title_field else ""
        rows.append({"text": text, "url": url, "title": title})
    seen_per_url = {}
    for row in rows:
        pos = seen_per_url.get(row["url"], 0)
        row["pos"] = pos
        seen_per_url[row["url"]] = pos + 1
    return rows


def passage_fold_job(args):
    config, fold, folds = args
    passages = SHARED["passages"]
    probes = [p for i, p in enumerate(SHARED["probes"]) if i % folds == fold]
    indexed = [indexed_text(p) for p in passages]
    vocab, idf, terms = build_vocab([("p", t) for t in indexed], config["maxTerms"], config["minCount"])
    vectors = [vectorize(t, vocab, idf) for t in indexed]
    hits = 0
    for probe in probes:
        query = vectorize(probe["query"], vocab, idf)
        if not query:
            continue
        weights = {i: v for i, v in query}
        best = -1.0
        best_index = -1
        for index, vector in enumerate(vectors):
            score = 0.0
            for i, v in vector:
                w = weights.get(i)
                if w is not None:
                    score += w * v
            if score > best:
                best = score
                best_index = index
        if best_index == probe["index"]:
            hits += 1
    return config["id"], hits / max(1, len(probes))


def probe_for(text):
    sentence = re.split(r"(?<=[.!?])\s+", text.strip())[0]
    words = sentence.split()
    if len(words) < 6:
        words = text.split()
    return " ".join(words[:14])


def indexed_text(passage):
    title = passage.get("title", "")
    return "%s %s %s" % (title, title, passage["text"])


LEAD_BOOST = 0.4
VAGUE_IDF_RATIO = 0.35
VAGUE_LEAD_POWER = 4


def lead_weight(passage):
    return round(1.0 + LEAD_BOOST / (1.0 + passage.get("pos", 0)), 4)


QUESTION_WORDS = {
    "a", "about", "an", "and", "are", "can", "do", "does", "explain", "for", "how", "in", "is",
    "it", "me", "of", "on", "tell", "that", "the", "to", "what", "when", "where", "which", "who",
    "why", "with", "you", "your",
}


def subject_of(text):
    return {w for w in re.findall(r"[a-z0-9']+", text.lower()) if w not in QUESTION_WORDS}


def title_match(title, subject):
    # a page whose title is exactly the thing being asked about is the page that
    # says what it is
    return bool(subject) and subject_of(title) == subject


def lead_power(query_vector, idf, idf_max):
    # a question like "what is X" over a corpus all about X matches nothing
    # informative, so fall back to where a page opens, which is where it says
    # what it is
    best = max((idf[i] for i, _ in query_vector), default=0.0)
    return VAGUE_LEAD_POWER if idf_max <= 0 or best / idf_max < VAGUE_IDF_RATIO else 1


def run_retrieval(passages):
    cap = CONFIG.get("maxPassages", 4000)
    if len(passages) > cap:
        random.Random(5).shuffle(passages)
        passages = passages[:cap]
    emit(phase="training", message="%d passages from %d pages" % (len(passages), len({p["url"] for p in passages})), progress=0.12, rows=len(passages))

    order = list(range(len(passages)))
    random.Random(11).shuffle(order)
    probes = [{"index": i, "query": probe_for(passages[i]["text"])} for i in order[: CONFIG.get("probeCount", 600)]]
    probes = [p for p in probes if len(p["query"].split()) >= 4]

    grid = []
    cid = 0
    for max_terms in CONFIG.get("termsGrid", [20000, 40000]):
        for min_count in CONFIG.get("minCountGrid", [1, 2]):
            grid.append({"id": cid, "maxTerms": max_terms, "minCount": min_count})
            cid += 1
    folds = CONFIG.get("folds", 4)
    jobs = [(config, fold, folds) for config in grid for fold in range(folds)]
    scores = grid_search(jobs, {"passages": passages, "probes": probes}, STATE["vcpus"], "retrieval")
    best = max(grid, key=lambda c: scores[c["id"]])
    emit(phase="training", message="best settings: %d terms, min count %d" % (best["maxTerms"], best["minCount"]), progress=0.88)

    indexed = [indexed_text(p) for p in passages]
    vocab, idf, terms = build_vocab([("p", t) for t in indexed], best["maxTerms"], best["minCount"])
    keep_n = CONFIG.get("maxWeightsPerPassage", 60)
    vectors = []
    used = set()
    for p in passages:
        full = vectorize(indexed[len(vectors)], vocab, idf)
        # the words in a page's title are how people ask for it, even when they
        # are common enough to be pruned on weight alone
        title_terms = {vocab[t] for t in tokenize(p.get("title", "")) if t in vocab}
        vector = sorted(full, key=lambda pair: -pair[1])[:keep_n]
        chosen = {i for i, _ in vector}
        vector += [(i, v) for i, v in full if i in title_terms and i not in chosen]
        vectors.append(vector)
        used.update(i for i, _ in vector)
    keep = sorted(used)
    remap = {old: new for new, old in enumerate(keep)}

    leads = [lead_weight(p) for p in passages]
    idf_max = max(idf) if idf else 0.0

    hits = 0
    top3 = 0
    for probe in probes:
        query = vectorize(probe["query"], vocab, idf)
        weights = {i: v for i, v in query}
        power = lead_power(query, idf, idf_max)
        subject = subject_of(probe["query"]) if power > 1 else set()
        titled = [3.0 if subject and title_match(p.get("title", ""), subject) else 1.0 for p in passages] if subject else None
        ranked = sorted(
            range(len(vectors)),
            key=lambda index: -(leads[index] ** power)
            * (titled[index] if titled else 1.0)
            * sum(w * v for i, v in vectors[index] for w in [weights.get(i)] if w is not None),
        )[:3]
        if ranked and ranked[0] == probe["index"]:
            hits += 1
        if probe["index"] in ranked:
            top3 += 1
    recall1 = hits / max(1, len(probes))
    recall3 = top3 / max(1, len(probes))

    model = {
        "schema": SCHEMA,
        "runtime": "tfidf-passages",
        "kind": "retrieval",
        "trainedAt": int(time.time()),
        "interface": {
            "input": {"type": "text", "label": "Ask it something", "placeholder": "Ask a question and it finds the passage that answers it", "lines": 2},
            "output": {"type": "passages", "label": "It returns the passages that match, with a link to the page each came from"},
        },
        "metrics": [
            metric(
                "recallAt1",
                "accuracy",
                round(recall1, 4),
                "percent",
                better="higher",
                headline=True,
                detail="based on %d test questions" % len(probes),
            ),
            metric("recallAt3", "accuracy when its top three answers all count", round(recall3, 4), "percent", better="higher"),
            metric("crossValidated", "average score across the %d folds used to pick settings" % folds, round(scores[best["id"]], 4), "percent", better="higher"),
            metric("passages", "passages from your file it can answer from", len(passages), "count"),
            metric("pages", "source pages those passages came from", len({p["url"] for p in passages}), "count"),
            metric("terms", "words and word pairs it matches on", len(keep), "count"),
            metric("probes", "test questions it was scored with", len(probes), "count"),
            metric("configs", "settings it compared before choosing", len(grid), "count"),
        ],
        "settings": [
            metric("maxTerms", "most words it will keep", best["maxTerms"], "count"),
            metric("minCount", "minimum times a word must appear", best["minCount"], "count"),
            metric("weightsPerPassage", "words kept per passage", keep_n, "count"),
        ],
        "candidates": {
            "columns": [
                {"key": "maxTerms", "label": "vocabulary", "format": "count"},
                {"key": "minCount", "label": "min count", "format": "count"},
                {"key": "score", "label": "cross-validated", "format": "percent", "better": "higher"},
            ],
            "rows": [{"maxTerms": c["maxTerms"], "minCount": c["minCount"], "score": round(scores[c["id"]], 4)} for c in grid],
        },
        "terms": [terms[i] for i in keep],
        "idf": [round(idf[i], 4) for i in keep],
        "vagueIdfRatio": VAGUE_IDF_RATIO,
        "vagueLeadPower": VAGUE_LEAD_POWER,
        "titleBoost": 3.0,
        "passages": [
            {
                "title": p["title"][:120],
                "url": p["url"],
                "text": p["text"][:600],
                "lead": leads[n],
                "vector": [[remap[i], round(v, 4)] for i, v in vectors[n] if i in remap],
            }
            for n, p in enumerate(passages)
        ],
    }
    return model, model["metrics"]


def parse_rows(raw, source):
    rows = []
    fmt = source.get("format", "tsv")
    text_col = source.get("textColumn", 1)
    label_col = source.get("labelColumn", 0)
    lines = raw.splitlines()
    if fmt == "jsonl":
        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            text = str(d.get(source.get("textField", "text"), "")).strip()
            label = str(d.get(source.get("labelField", "label"), "")).strip()
            if text and label:
                rows.append((label, text))
        return rows
    sep = "\t" if fmt == "tsv" else ","
    if source.get("header"):
        lines = lines[1:]
    for line in lines:
        if not line.strip():
            continue
        parts = split_row(line, sep)
        if len(parts) <= max(text_col, label_col):
            continue
        label = parts[label_col].strip().strip('"')
        text = parts[text_col].strip().strip('"')
        if text and label:
            rows.append((label, text))
    return rows


def split_row(line, sep):
    if sep == "\t":
        return line.split("\t")
    out = []
    field = ""
    quoted = False
    for ch in line:
        if ch == '"':
            quoted = not quoted
        elif ch == sep and not quoted:
            out.append(field)
            field = ""
        else:
            field += ch
    out.append(field)
    return out


def tokenize(text):
    words = TOKEN.findall(text.lower())
    return words + [words[i] + "_" + words[i + 1] for i in range(len(words) - 1)]


def build_vocab(rows, max_terms, min_count):
    counts = {}
    for _, text in rows:
        for t in set(tokenize(text)):
            counts[t] = counts.get(t, 0) + 1
    terms = [t for t, c in counts.items() if c >= min_count]
    terms.sort(key=lambda t: -counts[t])
    terms = terms[:max_terms]
    n = len(rows)
    vocab = {t: i for i, t in enumerate(terms)}
    idf = [math.log((1 + n) / (1 + counts[t])) + 1.0 for t in terms]
    return vocab, idf, terms


def vectorize(text, vocab, idf):
    tf = {}
    for t in tokenize(text):
        i = vocab.get(t)
        if i is not None:
            tf[i] = tf.get(i, 0.0) + 1.0
    vec = [(i, (1.0 + math.log(c)) * idf[i]) for i, c in tf.items()]
    norm = math.sqrt(sum(v * v for _, v in vec)) or 1.0
    return [(i, v / norm) for i, v in vec]


def train_logistic(samples, labels, dim, lr, l2, epochs, seed):
    k = len(labels)
    weights = [[0.0] * dim for _ in range(k)]
    bias = [0.0] * k
    index = {label: i for i, label in enumerate(labels)}
    order = list(range(len(samples)))
    rng = random.Random(seed)
    for epoch in range(epochs):
        rng.shuffle(order)
        step = lr / (1.0 + epoch)
        for n in order:
            label, vec = samples[n]
            scores = [bias[c] + sum(weights[c][i] * v for i, v in vec) for c in range(k)]
            top = max(scores)
            exps = [math.exp(s - top) for s in scores]
            total = sum(exps)
            target = index[label]
            for c in range(k):
                g = exps[c] / total - (1.0 if c == target else 0.0)
                if g == 0.0:
                    continue
                bias[c] -= step * g
                row = weights[c]
                for i, v in vec:
                    row[i] -= step * (g * v + l2 * row[i])
    return weights, bias


def predict(weights, bias, vec):
    scores = [bias[c] + sum(weights[c][i] * v for i, v in vec) for c in range(len(bias))]
    best = max(range(len(scores)), key=lambda c: scores[c])
    return best, scores


def accuracy(weights, bias, samples, labels):
    index = {label: i for i, label in enumerate(labels)}
    hits = 0
    for label, vec in samples:
        best, _ = predict(weights, bias, vec)
        if best == index[label]:
            hits += 1
    return hits / max(1, len(samples))


def fold_job(args):
    config, fold, folds = args
    train = [s for i, s in enumerate(SHARED["samples"]) if i % folds != fold]
    test = [s for i, s in enumerate(SHARED["samples"]) if i % folds == fold]
    weights, bias = train_logistic(train, SHARED["labels"], SHARED["dim"], config["lr"], config["l2"], config["epochs"], fold)
    return config["id"], accuracy(weights, bias, test, SHARED["labels"])


def lm_fold_job(args):
    config, fold, folds = args
    text = SHARED["text"]
    size = len(text) // folds
    test = text[fold * size : (fold + 1) * size]
    train = text[: fold * size] + text[(fold + 1) * size :]
    model = fit_ngram(train, config["order"])
    return config["id"], -perplexity(model, test, config["order"], config["smoothing"])


def fit_ngram(text, order):
    counts = {}
    for n in range(1, order + 1):
        for i in range(len(text) - n):
            context = text[i : i + n]
            nxt = text[i + n]
            row = counts.get(context)
            if row is None:
                row = {}
                counts[context] = row
            row[nxt] = row.get(nxt, 0) + 1
    return counts


def perplexity(model, text, order, smoothing):
    vocab = 96.0
    total = 0.0
    n = 0
    for i in range(order, len(text)):
        nxt = text[i]
        p = None
        for width in range(order, 0, -1):
            row = model.get(text[i - width : i])
            if row and (row.get(nxt, 0) > 0 or width == 1):
                p = (row.get(nxt, 0) + smoothing) / (sum(row.values()) + smoothing * vocab)
                break
        if p is None:
            p = 1.0 / vocab
        total += math.log(p)
        n += 1
    return math.exp(-total / max(1, n))


SHARED = {}


def init_worker(shared):
    SHARED.update(shared)


def grid_search(jobs, shared, workers, label):
    results = {}
    total = len(jobs)
    done = 0
    worker = fold_job if label == "classifier" else lm_fold_job if label == "generator" else passage_fold_job
    with Pool(workers, initializer=init_worker, initargs=(shared,)) as pool:
        for config_id, score in pool.imap_unordered(worker, jobs):
            results.setdefault(config_id, []).append(score)
            done += 1
            emit(
                phase="training",
                message="cross-validation %d of %d" % (done, total),
                progress=0.15 + 0.7 * done / total,
                configs_done=done,
                configs_total=total,
            )
    return {k: sum(v) / len(v) for k, v in results.items()}


def run_classifier(rows):
    random.Random(7).shuffle(rows)
    cut = max(1, int(len(rows) * 0.15))
    holdout_rows = rows[:cut]
    train_rows = rows[cut:]
    vocab, idf, terms = build_vocab(train_rows, CONFIG.get("maxTerms", 12000), CONFIG.get("minCount", 2))
    labels = sorted({label for label, _ in train_rows})
    emit(phase="training", message="%d rows, %d terms, %d labels" % (len(rows), len(terms), len(labels)), progress=0.12, rows=len(rows))
    samples = [(label, vectorize(text, vocab, idf)) for label, text in train_rows]
    holdout = [(label, vectorize(text, vocab, idf)) for label, text in holdout_rows]
    grid = []
    cid = 0
    for lr in CONFIG.get("lrGrid", [0.5, 0.2]):
        for l2 in CONFIG.get("l2Grid", [0.0, 1e-5]):
            grid.append({"id": cid, "lr": lr, "l2": l2, "epochs": CONFIG.get("epochs", 4)})
            cid += 1
    folds = CONFIG.get("folds", 4)
    shared = {"samples": samples, "labels": labels, "dim": len(terms)}
    jobs = [(config, fold, folds) for config in grid for fold in range(folds)]
    scores = grid_search(jobs, shared, STATE["vcpus"], "classifier")
    best = max(grid, key=lambda c: scores[c["id"]])
    emit(phase="training", message="best settings: lr %.2f, l2 %g (cv %.3f)" % (best["lr"], best["l2"], scores[best["id"]]), progress=0.88)
    weights, bias = train_logistic(samples, labels, len(terms), best["lr"], best["l2"], best["epochs"], 99)
    held = accuracy(weights, bias, holdout, labels)
    kept = []
    for c in range(len(labels)):
        row = weights[c]
        top = sorted(range(len(row)), key=lambda i: -abs(row[i]))[: CONFIG.get("maxWeights", 6000)]
        kept.append(top)
    keep = sorted({i for top in kept for i in top})
    model = {
        "schema": SCHEMA,
        "runtime": "linear-bow",
        "kind": "classifier",
        "trainedAt": int(time.time()),
        "interface": {
            "input": {"type": "text", "label": "Give it something to read", "placeholder": "Type a line and it answers as you type", "lines": 3},
            "output": {"type": "labels", "label": "It answers with one of %d labels" % len(labels)},
        },
        "metrics": [
            metric(
                "heldOutAccuracy",
                "accuracy",
                round(held, 4),
                "percent",
                better="higher",
                headline=True,
                detail="based on %d rows from your file" % len(holdout_rows),
            ),
            metric("crossValidated", "average score across the %d folds used to pick settings" % folds, round(scores[best["id"]], 4), "percent", better="higher"),
            metric("rows", "rows from your file it trained on", len(rows) - len(holdout_rows), "count"),
            metric("holdOutRows", "rows kept back to test it", len(holdout_rows), "count"),
            metric("labels", "labels found in your file", len(labels), "count"),
            metric("terms", "words and word pairs it uses to decide", len(keep), "count"),
            metric("configs", "settings it compared before choosing", len(grid), "count"),
        ],
        "settings": [
            metric("lr", "learning rate", best["lr"], "number"),
            metric("l2", "regularization", best["l2"], "number"),
            metric("epochs", "passes over the data", best["epochs"], "count"),
        ],
        "candidates": {
            "columns": [
                {"key": "lr", "label": "learning rate", "format": "number"},
                {"key": "l2", "label": "regularization", "format": "number"},
                {"key": "score", "label": "cross-validated", "format": "percent", "better": "higher"},
            ],
            "rows": [{"lr": c["lr"], "l2": c["l2"], "score": round(scores[c["id"]], 4)} for c in grid],
        },
        "labels": labels,
        "terms": [terms[i] for i in keep],
        "idf": [round(idf[i], 4) for i in keep],
        "vagueIdfRatio": VAGUE_IDF_RATIO,
        "vagueLeadPower": VAGUE_LEAD_POWER,
        "titleBoost": 3.0,
        "weights": [[round(weights[c][i], 5) for i in keep] for c in range(len(labels))],
        "bias": [round(b, 5) for b in bias],
    }
    return model, model["metrics"]


def run_generator(text):
    limit = CONFIG.get("maxChars", 600_000)
    text = text[:limit]
    cut = int(len(text) * 0.9)
    train_text = text[:cut]
    holdout_text = text[cut:]
    emit(phase="training", message="%d characters of training text" % len(train_text), progress=0.12, rows=len(train_text))
    grid = []
    cid = 0
    for order in CONFIG.get("orderGrid", [3, 4, 5]):
        for smoothing in CONFIG.get("smoothingGrid", [0.05, 0.5]):
            grid.append({"id": cid, "order": order, "smoothing": smoothing})
            cid += 1
    folds = CONFIG.get("folds", 3)
    jobs = [(config, fold, folds) for config in grid for fold in range(folds)]
    scores = grid_search(jobs, {"text": train_text}, STATE["vcpus"], "generator")
    best = max(grid, key=lambda c: scores[c["id"]])
    emit(phase="training", message="best settings: order %d, smoothing %g" % (best["order"], best["smoothing"]), progress=0.88)
    counts = fit_ngram(train_text, best["order"])
    held = perplexity(counts, holdout_text, best["order"], best["smoothing"])
    ranked = sorted(counts.items(), key=lambda kv: (len(kv[0]) < 2, -sum(kv[1].values())))[: CONFIG.get("maxContexts", 20000)]
    table = {}
    for context, row in ranked:
        total = sum(row.values())
        top = sorted(row.items(), key=lambda kv: -kv[1])[: CONFIG.get("maxNext", 10)]
        table[context] = [[ch, round(c / total, 4)] for ch, c in top]
    model = {
        "schema": SCHEMA,
        "runtime": "char-ngram",
        "kind": "generator",
        "trainedAt": int(time.time()),
        "interface": {
            "input": {"type": "text", "label": "Start it off", "placeholder": "Write the first few words and it carries on", "lines": 1},
            "output": {
                "type": "continuation",
                "label": "It writes more text in the same style",
                "controls": [{"key": "length", "label": "characters to write", "value": 400, "min": 100, "max": 2000, "step": 100}],
            },
        },
        "metrics": [
            metric(
                "heldOutPerplexity",
                "perplexity, lower is better",
                round(held, 3),
                "number",
                better="lower",
                headline=True,
                detail="based on %d characters from your file" % len(holdout_text),
            ),
            metric("crossValidated", "average surprise across the %d folds used to pick settings" % folds, round(-scores[best["id"]], 3), "number", better="lower"),
            metric("characters", "characters from your file it trained on", len(train_text), "count"),
            metric("holdOutCharacters", "characters kept back to test it", len(holdout_text), "count"),
            metric("contexts", "character sequences it can continue", len(table), "count"),
            metric("configs", "settings it compared before choosing", len(grid), "count"),
        ],
        "settings": [
            metric("order", "characters of context it looks back at", best["order"], "count"),
            metric("smoothing", "smoothing", best["smoothing"], "number"),
        ],
        "candidates": {
            "columns": [
                {"key": "order", "label": "context", "format": "count"},
                {"key": "smoothing", "label": "smoothing", "format": "number"},
                {"key": "score", "label": "cross-validated perplexity", "format": "number", "better": "lower"},
            ],
            "rows": [{"order": c["order"], "smoothing": c["smoothing"], "score": round(-scores[c["id"]], 3)} for c in grid],
        },
        "order": best["order"],
        "table": table,
        "seed": train_text[: best["order"]],
    }
    return model, model["metrics"]


def main():
    emit(phase="downloading", message="fetching the dataset", progress=0.05)
    raw = load_text()
    if CONFIG["kind"] == "retrieval":
        passages = parse_passages(raw, CONFIG["dataset"])
        if len(passages) < 20:
            raise ValueError("only %d usable passages in that file" % len(passages))
        model, metrics = run_retrieval(passages)
    elif CONFIG["kind"] == "classifier":
        rows = parse_rows(raw, CONFIG["dataset"])
        if len(rows) < 40:
            raise ValueError("only %d usable rows in the dataset" % len(rows))
        cap = CONFIG.get("maxRows", 6000)
        if len(rows) > cap:
            random.Random(3).shuffle(rows)
            rows = rows[:cap]
        model, metrics = run_classifier(rows)
    else:
        model, metrics = run_generator(raw)
    with open(os.path.join(OUT, "model.tmp"), "w") as f:
        json.dump(model, f)
    os.replace(os.path.join(OUT, "model.tmp"), os.path.join(OUT, "model.json"))
    emit(phase="done", message="model trained and published", progress=1.0, metrics=metrics, best=model.get("settings"), done=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit(phase="failed", message="training failed: %s" % error, error=str(error), done=True)
        sys.exit(1)
