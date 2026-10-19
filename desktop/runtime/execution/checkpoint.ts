import {
  BaseCheckpointSaver,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
} from '@langchain/langgraph-checkpoint';
import type { RunnableConfig } from '@langchain/core/runnables';

/** Keep the native saver contract, including subgraph namespaces and task paths. */
export class TrackedCheckpointer extends BaseCheckpointSaver {
  private readonly pending = new Set<Promise<unknown>>();
  constructor(privateSaver: BaseCheckpointSaver, onError: (error: unknown) => void) {
    super(privateSaver.serde);
    this.saver = privateSaver;
    this.onError = onError;
  }
  private readonly saver: BaseCheckpointSaver;
  private readonly onError: (error: unknown) => void;

  private track<T>(work: () => Promise<T>): Promise<T> {
    const promise = Promise.resolve().then(work);
    this.pending.add(promise);
    void promise.then(() => this.pending.delete(promise), error => {
      this.pending.delete(promise);
      this.onError(error);
    });
    return promise;
  }

  getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    return this.track(() => this.saver.getTuple(config));
  }
  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    const iterator = this.saver.list(config, options);
    try {
      for (;;) {
        const next = await this.track(() => iterator.next());
        if (next.done) return;
        yield next.value;
      }
    } finally {
      if (iterator.return) await this.track(() => iterator.return(undefined));
    }
  }
  put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata, newVersions: ChannelVersions): Promise<RunnableConfig> {
    return this.track(() => this.saver.put(config, checkpoint, metadata, newVersions));
  }
  putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string, taskPath?: string): Promise<void> {
    return this.track(() => this.saver.putWrites(config, writes, taskId, taskPath));
  }
  deleteThread(threadId: string): Promise<void> {
    return this.track(() => this.saver.deleteThread(threadId));
  }
  override getNextVersion(current: number | undefined): number {
    try { return this.saver.getNextVersion(current); }
    catch (error) { this.onError(error); throw error; }
  }
  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}
