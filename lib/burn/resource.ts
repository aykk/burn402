export type Spec = {
  plan: string;
  region: string;
  label?: string;
  userData?: string;
};

export interface Resource {
  readonly kind: string;
  quote(spec: Spec): Promise<number>;
  provision(spec: Spec): Promise<string>;
  consumed(handle: string): Promise<number>;
  destroy(handle: string): Promise<void>;
}

type FakeInstance = {
  spec: Spec;
  hourlyUsd: number;
  startedAt: number;
  destroyedAt: number | null;
};

export class FakeResource implements Resource {
  readonly kind = "fake";
  private readonly prices: Record<string, number>;
  private readonly now: () => number;
  private readonly instances = new Map<string, FakeInstance>();
  private counter = 0;
  private readonly prefix: string;

  constructor(prices: Record<string, number>, now: () => number, prefix = "fake") {
    this.prices = prices;
    this.now = now;
    this.prefix = prefix;
  }

  async quote(spec: Spec): Promise<number> {
    const price = this.prices[spec.plan];
    if (price === undefined) throw new Error(`unknown plan ${spec.plan}`);
    return price;
  }

  async provision(spec: Spec): Promise<string> {
    const hourlyUsd = await this.quote(spec);
    const handle = `${this.prefix}-${++this.counter}`;
    this.instances.set(handle, { spec, hourlyUsd, startedAt: this.now(), destroyedAt: null });
    return handle;
  }

  async consumed(handle: string): Promise<number> {
    const i = this.get(handle);
    const end = i.destroyedAt ?? this.now();
    return (i.hourlyUsd * (end - i.startedAt)) / 3600;
  }

  async destroy(handle: string): Promise<void> {
    const i = this.get(handle);
    if (i.destroyedAt === null) i.destroyedAt = this.now();
  }

  isRunning(handle: string): boolean {
    return this.get(handle).destroyedAt === null;
  }

  running(): string[] {
    return [...this.instances].filter(([, i]) => i.destroyedAt === null).map(([h]) => h);
  }

  private get(handle: string): FakeInstance {
    const i = this.instances.get(handle);
    if (!i) throw new Error(`unknown handle ${handle}`);
    return i;
  }
}
