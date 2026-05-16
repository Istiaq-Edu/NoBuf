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
      console.error('[SourceBuffer] error:', e);
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

  setTimestampOffset(offset: number): Promise<void> {
    return new Promise<void>((resolve) => {
      // Clear pending operations
      this.queue = [];
      this.processing = false;

      const apply = () => {
        try {
          this.sourceBuffer.timestampOffset = offset;
        } catch (e) {
          console.error('[SourceBuffer] Failed to set timestampOffset:', e);
        }
        resolve();
      };

      if (this.sourceBuffer.updating) {
        // Wait for current operation to finish before setting offset
        this.sourceBuffer.addEventListener('updateend', apply, { once: true });
        try {
          this.sourceBuffer.abort();
        } catch (_) {
          // abort may also trigger updateend, but we handle it with once: true
        }
      } else {
        apply();
      }
    });
  }

  destroy(): void {
    this.abort();
  }
}
