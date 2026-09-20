import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JobSpec } from "./types";

export const TRAIN_DIR = "/srv/burn402";
export const UPLOAD_PATH = `${TRAIN_DIR}/dataset.raw`;

export function trainerSource(root = process.cwd()): string {
  return readFileSync(join(root, "lib", "train", "train.py"), "utf8");
}

const SERVER = `import http.server
import os
import socketserver

DIR = "${TRAIN_DIR}"


class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIR, **kwargs)

    def handle_expect_100(self):
        self.send_response_only(100)
        self.end_headers()
        return True

    def read_body(self, out):
        if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            while True:
                line = self.rfile.readline(65536).strip()
                size = int(line.split(b";")[0] or b"0", 16)
                if size == 0:
                    self.rfile.readline()
                    return True
                left = size
                while left > 0:
                    chunk = self.rfile.read(min(262144, left))
                    if not chunk:
                        return False
                    out.write(chunk)
                    left -= len(chunk)
                self.rfile.readline()
        left = int(self.headers.get("Content-Length", "0"))
        if left <= 0:
            return False
        while left > 0:
            chunk = self.rfile.read(min(262144, left))
            if not chunk:
                return False
            out.write(chunk)
            left -= len(chunk)
        return True


    def do_PUT(self):
        if self.path != "/dataset":
            self.send_error(404)
            return
        part = os.path.join(DIR, "dataset.part")
        with open(part, "wb") as f:
            complete = self.read_body(f)
        if not complete:
            os.remove(part)
            self.send_error(400, "incomplete upload")
            return
        os.replace(part, os.path.join(DIR, "dataset.raw"))
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def log_message(self, *args):
        pass


socketserver.ThreadingTCPServer.allow_reuse_address = True
socketserver.ThreadingTCPServer(("", 80), Handler).serve_forever()
`;

function heredoc(path: string, body: string, marker: string): string {
  return `cat > ${path} <<'${marker}'\n${body}\n${marker}\n`;
}

export function trainingBootScript(options: { spec: JobSpec; rentedBy: string; budget: string; plan: string; root?: string }): string {
  const { spec } = options;
  const upload = spec.dataset.origin === "upload";
  const dataset = upload ? { ...spec.dataset, url: `file://${UPLOAD_PATH}` } : spec.dataset;
  const job = {
    kind: spec.kind,
    request: spec.request,
    dataset,
    folds: spec.folds,
    epochs: spec.epochs,
    maxRows: spec.maxRows,
    maxChars: spec.maxChars,
    maxTerms: spec.maxTerms,
    minCount: spec.minCount,
    lrGrid: spec.lrGrid,
    l2Grid: spec.l2Grid,
    orderGrid: spec.orderGrid,
    smoothingGrid: spec.smoothingGrid,
    maxWeights: spec.maxWeights,
    maxContexts: spec.maxContexts,
    maxNext: spec.maxNext,
  };
  const safe = (value: string) => value.replace(/[^\x20-\x7e]/g, "").replace(/[`$\\]/g, "");
  const waiting = upload ? "the box is up and waiting for the dataset" : "the box is booting";
  const wait = upload ? `while [ ! -f ${UPLOAD_PATH} ]; do sleep 1; done\n` : "";
  return `#!/bin/bash
mkdir -p ${TRAIN_DIR}
${heredoc(`${TRAIN_DIR}/job.json`, JSON.stringify(job), "JOBJSON")}${heredoc(`${TRAIN_DIR}/train.py`, trainerSource(options.root), "TRAINPY")}${heredoc(
    `${TRAIN_DIR}/serve.py`,
    SERVER,
    "SERVEPY",
  )}${heredoc(
    `${TRAIN_DIR}/index.html`,
    `<!doctype html><meta charset="utf-8"><title>burn402 training box</title><pre>
This is a real Vultr server rented during a burn402 demo.

plan:      ${safe(options.plan)}
rented by: ${safe(options.rentedBy)}
budget:    ${safe(options.budget)}
job:       ${safe(spec.kind)} on ${safe(spec.dataset.name)}
request:   ${safe(spec.request).slice(0, 160)}

status.json  training progress
model.json   the trained model, once it is done

It gets shut down when the budget that paid for it runs out.
</pre>`,
    "INDEXHTML",
  )}cat > ${TRAIN_DIR}/status.json <<'BOOTSTATUS'
{"phase":"${upload ? "waiting" : "starting"}","message":"${waiting}","log":[],"elapsed":0,"progress":0,"rows":0,"vcpus":0,"configs_total":0,"configs_done":0,"metrics":null,"done":false,"error":null}
BOOTSTATUS
ufw allow 80/tcp || true
cd ${TRAIN_DIR} && nohup python3 serve.py >/dev/null 2>&1 &
cd ${TRAIN_DIR} && nohup bash -c '${wait}python3 train.py' > train.log 2>&1 &
`;
}
