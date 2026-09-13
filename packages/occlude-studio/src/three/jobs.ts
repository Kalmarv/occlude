import { abandonedThreeJob, type ThreeJobInput, type ThreeJobResult } from './protocol.js';

type Job = { id: number; input: ThreeJobInput; controller: AbortController };
/** One active GPU lease and one latest pending snapshot. Every publication is
 * checked against identity, including completions that ignored cancellation. */
export class ThreeJobQueue {
  private active: Job | null = null;
  private pending: Job | null = null;
  private disposed = false;
  private drain: Promise<void> | null = null;
  constructor(
    private run: (input: ThreeJobInput, signal: AbortSignal) => Promise<ThreeJobResult>,
    private publish: (id: number, result: ThreeJobResult) => void,
    private fail: (id: number, error: unknown) => void,
  ) {}
  submit(id: number, input: ThreeJobInput): void {
    if (this.disposed) { this.fail(id, abandonedThreeJob()); return; }
    this.active?.controller.abort();
    this.pending?.controller.abort();
    this.pending = { id, input, controller: new AbortController() };
    if (!this.drain) {
      this.start();
    }
  }
  private start(): void {
    this.drain = this.process().finally(() => {
      this.drain = null;
      if (this.pending && !this.disposed) this.start();
    });
  }
  cancel(id: number): void {
    if (this.active?.id === id) this.active.controller.abort();
    if (this.pending?.id === id) { this.pending.controller.abort(); this.pending = null; }
  }
  private async process(): Promise<void> {
    while (this.pending && !this.disposed) {
      const job = this.pending; this.pending = null; this.active = job;
      try {
        const result = await this.run(job.input, job.controller.signal);
        if (!this.disposed && !job.controller.signal.aborted) this.publish(job.id, result);
      } catch (error) {
        if (!this.disposed && !job.controller.signal.aborted) this.fail(job.id, error);
      } finally { this.active = null; }
    }
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.active?.controller.abort(); this.pending?.controller.abort(); this.pending = null;
    await this.drain;
  }
}
