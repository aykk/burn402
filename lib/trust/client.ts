import type { Observation } from "./behavior";

export type TrustAgent = {
  agentId: string;
  dnsName: string;
  displayName: string;
  description: string;
  providerId: string;
  status: "ACTIVE" | "WARNING" | "DEPRECATED" | "EXPIRED" | "REVOKED";
  protocols: string[];
  transports: string[];
  tags: string[];
  capabilities: string[];
  firstSeen: string;
  lastUpdated: string;
};

export type TrustEvaluation = {
  trustVector: Record<string, number>;
  recommendedProfile: string;
  riskFactors: string[];
  dimensions: { dimension: string; score: number; signalScores: { signalId: string; rawScore: number; explanation: string }[] }[];
};

export class TrustIndexError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(path: string, status: number, body: string) {
    super(`trust index ${path} -> HTTP ${status}: ${body.slice(0, 500)}`);
    this.name = "TrustIndexError";
    this.status = status;
    this.body = body;
  }
}

export class TrustIndexClient {
  private readonly baseUrl: string;
  private readonly adminKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { baseUrl: string; adminKey?: string; fetch?: typeof fetch }) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.adminKey = options.adminKey;
    this.fetchImpl = options.fetch ?? fetch;
  }

  importAgents(agents: TrustAgent[]): Promise<unknown> {
    return this.call("POST", "/v1/internal/agents/import", { agents });
  }

  importObservations(observations: Observation[]): Promise<unknown> {
    return this.call("POST", "/v1/internal/observations/import", { observations });
  }

  async evaluation(agentId: string): Promise<TrustEvaluation> {
    const detail = (await this.call("GET", `/v1/ans/registered-agents/${encodeURIComponent(agentId)}`)) as { trustEvaluation: TrustEvaluation };
    return detail.trustEvaluation;
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.adminKey) headers.Authorization = `Bearer ${this.adminKey}`;
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    if (!response.ok) throw new TrustIndexError(path, response.status, text);
    return text ? JSON.parse(text) : {};
  }
}
