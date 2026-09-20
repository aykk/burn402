import type { Resource } from "../burn";
import { VultrResource } from "../burn";

export type ServerStatus = "starting" | "booting" | "live" | "shut down";

export type ServerView = {
  handle: string;
  rentedBy: string;
  how: string;
  plan: string;
  specs: string;
  hourlyUsd: number;
  provider: string;
  region: string;
  status: ServerStatus;
  ip: string | null;
  url: string | null;
  createdAt: number;
  liveAt: number | null;
  shutDownAt: number | null;
  shutDownReason: string | null;
};

export function bootScript(info: { rentedBy: string; how: string; budget: string; plan: string }): string {
  const esc = (v: string) => v.replace(/[^A-Za-z0-9 ._:/$()>,-]/g, "").replace(/\$/g, "\\$");
  return `#!/bin/bash
MD=$(curl -s http://169.254.169.254/v1.json)
ID=$(echo "$MD" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("instance-v2-id") or d.get("instanceid") or "unknown")')
mkdir -p /srv/burn402
cat > /srv/burn402/index.html <<HTML
<!doctype html><meta charset="utf-8"><title>burn402 server</title><pre>
This is a real Vultr server rented during a burn402 demo.

vultr instance id: $ID
plan:              ${esc(info.plan)}
rented by:         ${esc(info.rentedBy)}
how:               ${esc(info.how)}
budget:            ${esc(info.budget)}
booted at:         $(date -u +%FT%TZ)

It gets shut down when the budget that paid for it runs out.
</pre>
HTML
ufw allow 80/tcp || true
cd /srv/burn402 && nohup python3 -m http.server 80 >/dev/null 2>&1 &
`;
}

const REGION_NAMES: Record<string, string> = { ewr: "New Jersey", ord: "Chicago", atl: "Atlanta", mia: "Miami", dfw: "Dallas", lax: "Los Angeles", sjc: "Silicon Valley" };

export class ServerTracker {
  readonly servers: ServerView[] = [];
  private readonly resource: Resource;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(resource: Resource) {
    this.resource = resource;
  }

  async add(handle: string, meta: { rentedBy: string; how: string; plan: string; region: string; hourlyUsd: number }): Promise<ServerView> {
    let specs = meta.plan;
    if (this.resource.kind === "vultr") {
      const p = await (this.resource as VultrResource).planInfo(meta.plan);
      specs = [
        p.vcpus ? `${p.vcpus} vCPU` : null,
        p.ramGb ? `${p.ramGb} GB RAM` : null,
        p.gpu ? `GPU ${p.gpuType ?? ""} ${p.gpuVramGb ?? ""} GB`.trim() : "no GPU",
      ]
        .filter(Boolean)
        .join(", ");
    }
    const view: ServerView = {
      handle,
      rentedBy: meta.rentedBy,
      how: meta.how,
      plan: meta.plan,
      specs,
      hourlyUsd: meta.hourlyUsd,
      provider: this.resource.kind === "vultr" ? "Vultr" : "simulated",
      region: REGION_NAMES[meta.region] ?? meta.region,
      status: "starting",
      ip: null,
      url: null,
      createdAt: Date.now() / 1000,
      liveAt: null,
      shutDownAt: null,
      shutDownReason: null,
    };
    this.servers.push(view);
    return view;
  }

  markShutDown(handle: string, reason: string): void {
    const s = this.servers.find((x) => x.handle === handle);
    if (s && s.status !== "shut down") {
      s.status = "shut down";
      s.shutDownAt = Date.now() / 1000;
      s.shutDownReason = reason;
    }
  }

  async refresh(): Promise<void> {
    if (this.resource.kind !== "vultr") return;
    const vultr = this.resource as VultrResource;
    await Promise.all(
      this.servers
        .filter((s) => s.status !== "shut down")
        .map(async (s) => {
          try {
            const st = await vultr.state(s.handle);
            if (st.ip && st.ip !== "0.0.0.0") {
              s.ip = st.ip;
              s.url = `http://${st.ip}/`;
            }
            if (s.status === "starting" && st.status === "active") s.status = "booting";
            if (s.url && s.status !== "live") {
              const page = await fetch(s.url, { signal: AbortSignal.timeout(2500) }).then((r) => (r.ok ? r.text() : ""), () => "");
              if (page.includes(s.handle)) {
                s.status = "live";
                s.liveAt = Date.now() / 1000;
              }
            }
          } catch {}
        }),
    );
  }

  start(everyMs = 5000): void {
    this.timer = setInterval(() => void this.refresh(), everyMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
