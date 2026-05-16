/**
 * Wraps MediaSource SourceBuffer to queue append/remove operations,
 * preventing InvalidStateError from overlapping operations.
 */
export class SourceBufferWrapper {
  private sourceBuffer: SourceBuffer;
  private queue: Array<{ type: 'append' | 'remove'; data?: ArrayBuffer; start?: number; end?: number }> = [];
  private processing = false;

  constructor(sourceBuffer: SourceBuffer) {
    this.sourceBuffer = sourceBuffer;
    this.sourceBuffer.addEventListener('updateend', () => {
      this.processing = false;
      this.processQueue();
    });
    this.sourceBuffer.addEventListener('error', (e) => {
      console.error('SourceBuffer error:', e);
      this.processing = false;
      this.processQueue();
    });
  }

  get buffered(): TimeRanges {
    return this.sourceBuffer.buffered;
  }

  get updating(): boolean {
    return this.sourceBuffer.updating;
  }

  appendBuffer(data: ArrayBuffer): void {
    this.queue.push({ type: 'append', data });
    this.processQueue();
  }

  remove(start: number, end: number): void {
    this.queue.push({ type: 'remove', start, end });
    this.processQueue();
  }

  private processQueue(): void {
    if (this.processing || this.queue.length === 0) return;
    if (this.sourceBuffer.updating) return;

    this.processing = true;
    const op = this.queue.shift()!;

    try {
      if (op.type === 'append' && op.data) {
        this.sourceBuffer.appendBuffer(op.data);
      } else if (op.type === 'remove' && op.start !== undefined && op.end !== undefined) {
        this.sourceBuffer.remove(op.start, op.end);
      }
    } catch (e) {
      console.error('SourceBuffer operation failed:', e);
      this.processing = false;
      this.processQueue();
    }
  }

  abort(): void {
    try {
      this.sourceBuffer.abort();
    } catch (e) {
      // Ignore
    }
    this.queue = [];
    this.processing = false;
  }

  destroy(): void {
    this.abort();
  }
}
