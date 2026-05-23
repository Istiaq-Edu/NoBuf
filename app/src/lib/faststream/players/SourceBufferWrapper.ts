/**
 * Wraps MediaSource SourceBuffer to queue append/remove operations,
 * preventing InvalidStateError from overlapping operations.
 *
 * Bug #4 fix: once HTMLMediaElement.error is set (after a
 * CHUNK_DEMUXER_ERROR_APPEND_FAILED), all subsequent appendBuffer
 * calls fail with InvalidStateError. The wrapper now detects this
 * fatal state and stops processing the queue entirely, preventing
 * the infinite cascade of InvalidStateError logs.
 */
export class SourceBufferWrapper {
  private sourceBuffer: SourceBuffer;
  private queue: Array<{ type: 'append' | 'remove'; data?: ArrayBuffer; start?: number; end?: number }> = [];
  private processing = false;
  /** Set when HTMLMediaElement.error is not null — all future appendBuffer
   *  calls will fail. Stop processing queue entirely to prevent infinite
   *  cascade of InvalidStateError logs (Bug #4 fix). */
  private fatalError = false;

  constructor(sourceBuffer: SourceBuffer) {
    this.sourceBuffer = sourceBuffer;
    this.sourceBuffer.addEventListener('updateend', () => {
      this.processing = false;
      this.processQueue();
    });
    this.sourceBuffer.addEventListener('error', (e) => {
      console.error('[SourceBuffer] error:', e);
      this.processing = false;
      // Don't retry after error event — check if it's fatal
      this.checkFatalError();
    });
  }

  get buffered(): TimeRanges {
    return this.sourceBuffer.buffered;
  }

  get updating(): boolean {
    return this.sourceBuffer.updating;
  }

  /** Returns true if the SourceBuffer is in a fatal error state where
   *  no more data can be appended (HTMLMediaElement.error is not null). */
  get hasFatalError(): boolean {
    return this.fatalError;
  }

  appendBuffer(data: ArrayBuffer): void {
    if (this.fatalError) return; // Don't queue if fatally broken
    this.queue.push({ type: 'append', data });
    this.processQueue();
  }

  remove(start: number, end: number): void {
    this.queue.push({ type: 'remove', start, end });
    this.processQueue();
  }

  /** Check if HTMLMediaElement.error is set — this means the video
   *  decoder encountered a fatal error (CHUNK_DEMUXER_ERROR_APPEND_FAILED)
   *  and no more data can be appended to the SourceBuffer. */
  private checkFatalError(): void {
    try {
      // appendBuffer throws InvalidStateError if HTMLMediaElement.error is not null.
      // We can detect this by checking if a tiny append fails with the specific error.
      // But a safer approach: just try the next queued operation and if it fails
      // with InvalidStateError mentioning HTMLMediaElement.error, mark as fatal.
      // This is done in processQueue's catch block.
    } catch (_) {}
  }

  private processQueue(): void {
    if (this.fatalError || this.processing || this.queue.length === 0) return;
    if (this.sourceBuffer.updating) return;

    this.processing = true;
    const op = this.queue.shift()!;

    try {
      if (op.type === 'append' && op.data) {
        this.sourceBuffer.appendBuffer(op.data);
      } else if (op.type === 'remove' && op.start !== undefined && op.end !== undefined) {
        this.sourceBuffer.remove(op.start, op.end);
      }
    } catch (e: any) {
      // Bug #4 fix: detect fatal error state. Once HTMLMediaElement.error
      // is set (from CHUNK_DEMUXER_ERROR_APPEND_FAILED), ALL subsequent
      // appendBuffer calls throw InvalidStateError mentioning "error attribute
      // is not null". Stop processing entirely to prevent infinite cascade.
      if (e instanceof DOMException && e.name === 'InvalidStateError' &&
          (e.message?.includes('error attribute is not null') || e.message?.includes('HTMLMediaElement'))) {
        this.fatalError = true;
        this.queue = [];
        this.processing = false;
        console.error('[SourceBuffer] Fatal error detected — stopping all append operations (Bug #4 fix)');
        return;
      }

      // Bug #16 fix: QuotaExceededError — SourceBuffer is full and cannot
      // append more data. Stop processing the queue to prevent the infinite
      // retry cascade where each failed append triggers another processQueue
      // call. The next onSegment callback will call evictOldBuffer() BEFORE
      // appendBuffer(), freeing space and resuming queue processing naturally.
      if (e instanceof DOMException && e.name === 'QuotaExceededError') {
        console.warn('[SourceBuffer] QuotaExceededError — buffer full, stopping queue. Eviction will free space before next append.');
        this.processing = false;
        return;
      }

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

  /** Remove all buffered data — for seeking to unbuffered positions.
   *  Does NOT set timestampOffset because mp4box produces absolute timestamps. */
  resetForSeek(): Promise<void> {
    return new Promise<void>((resolve) => {
      // Clear pending operations
      this.queue = [];
      this.processing = false;

      if (this.sourceBuffer.updating) {
        this.sourceBuffer.addEventListener('updateend', () => this._removeAllAndFinish(resolve), { once: true });
        try { this.sourceBuffer.abort(); } catch (_) {}
      } else {
        this._removeAllAndFinish(resolve);
      }
    });
  }

  private _removeAllAndFinish(callback: () => void): void {
    const buffered = this.sourceBuffer.buffered;
    if (buffered.length === 0) {
      callback();
      return;
    }

    const onDone = () => {
      this.sourceBuffer.removeEventListener('updateend', onDone);
      callback();
    };
    this.sourceBuffer.addEventListener('updateend', onDone, { once: true });
    try {
      this.sourceBuffer.remove(buffered.start(0), buffered.end(buffered.length - 1));
    } catch (_) {
      this.sourceBuffer.removeEventListener('updateend', onDone);
      callback();
    }
  }

  destroy(): void {
    this.abort();
  }
}
