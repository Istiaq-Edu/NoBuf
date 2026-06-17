import { StreamShadowCache } from './StreamShadowCache';

const TS_PACKET_SIZE = 188;

/** Align a byte offset to the next TS packet boundary (if not already aligned). */
function alignToPacket(size: number): number {
  return Math.floor(size / TS_PACKET_SIZE) * TS_PACKET_SIZE;
}

interface ChunkLoaderConfig {
  shadowCache?: StreamShadowCache;
  firstChunkSize?: number;
  chunkSize?: number;
  withCredentials?: boolean;
  headers?: Record<string, string>;
}

/**
 * mpegts.js custom loader that downloads a TS file as a sequence of finite chunks.
 *
 * Why this exists:
 *   mpegts.js's default FetchStreamLoader is built for live/continuous streams. It
 *   treats the first HTTP response as the whole stream, so when our backend returns
 *   a finite 5MB/10MB chunk it calls endOfStream() prematurely. The previous fix
 *   was a pile of patches (endOfStream guard, resume/suspend overrides, quota guard,
 *   fetch interceptor) that fight each other and cause resume-byte corruption and
 *   overlapping audio frames.
 *
 * This loader's contract:
 *   - Reports the real file length via onContentLengthKnown() so mpegts.js never
 *     thinks a chunk is the whole file.
 *   - Fetches one finite chunk at a time, concatenating them internally while
 *     feeding bytes to mpegts.js as a single continuous stream.
 *   - Only calls onComplete() at EOF, so MSE endOfStream() fires only once.
 *   - On abort (lazyLoad pause), the next resume() starts exactly from the byte
 *     after the last byte we delivered, because IOController._currentRange.to is
 *     updated on every onDataArrival() and IOController.pause() derives _resumeFrom
 *     from that.
 *   - Siphons every downloaded chunk into the StreamShadowCache so future requests
 *     (including seeks back) are served from memory.
 *
 * The class is returned from a factory because mpegts.js must be loaded dynamically
 * in the browser environment; importing it at the top level breaks tests and SSR.
 */
export function createChunkedFetchLoader(mpegts: any): any {
  class ChunkedFetchLoader extends mpegts.BaseLoader {
    private _config: ChunkLoaderConfig & any;
    private _abortController: AbortController | null = null;
    private _requestAbort = false;
    private _dataSource: any = null;
    private _range: { from: number; to: number } | null = null;
    private _fileLength = 0;
    private _currentByte = 0;
    private _isFirstChunk = true;

    private _firstChunkSize: number;
    private _chunkSize: number;
    private _shadowCache: StreamShadowCache | null;

    static isSupported() {
      return typeof self !== 'undefined' && typeof self.fetch === 'function' && typeof self.ReadableStream === 'function' && typeof self.AbortController === 'function';
    }

    constructor(_seekHandler: any, config: any) {
      super('chunked-fetch-loader');
      this._config = config || {};
      this._needStash = true;

      this._firstChunkSize = alignToPacket(this._config.firstChunkSize || 5 * 1024 * 1024);
      this._chunkSize = alignToPacket(this._config.chunkSize || 2 * 1024 * 1024);
      this._shadowCache = this._config.shadowCache || null;
    }

    destroy() {
      if (this.isWorking()) {
        this.abort();
      }
      super.destroy();
    }

    open(dataSource: any, range: { from: number; to: number }) {
      this._dataSource = dataSource;
      this._range = range;
      this._requestAbort = false;
      this._status = mpegts.LoaderStatus.kConnecting;

      this._fileLength = Number(dataSource.filesize) || 0;
      this._currentByte = range.from || 0;
      this._isFirstChunk = this._currentByte === 0;

      if (this._fileLength > 0) {
        this._onContentLengthKnown(this._fileLength);
      }

      this._pumpChunks();
    }

    abort() {
      this._requestAbort = true;
      if (this._abortController) {
        try {
          this._abortController.abort();
        } catch { /* ignore */ }
      }
    }

    private _chunkSizeFor(byte: number): number {
      if (byte === 0 && this._isFirstChunk) return this._firstChunkSize;
      return this._chunkSize;
    }

    private async _pumpChunks(): Promise<void> {
      if (this._requestAbort) return;

      while (true) {
        if (this._requestAbort) return;

        const from = this._currentByte;
        if (this._fileLength > 0 && from >= this._fileLength) {
          this._status = mpegts.LoaderStatus.kComplete;
          this._onComplete(this._range?.from ?? 0, this._fileLength - 1);
          return;
        }

        const chunkSize = this._chunkSizeFor(from);
        const to = Math.min(from + chunkSize - 1, this._fileLength > 0 ? this._fileLength - 1 : Number.MAX_SAFE_INTEGER);

        // Try to serve a full cached chunk from the shadow cache
        if (this._shadowCache && this._shadowCache.hasByte(from) && this._shadowCache.hasByte(to)) {
          const cached = this._shadowCache.getRange(from, to);
          if (cached && cached.byteLength === to - from + 1) {
            this._status = mpegts.LoaderStatus.kBuffering;
            this._onDataArrival(cached, from, cached.byteLength);
            this._currentByte = to + 1;
            this._isFirstChunk = false;
            continue;
          }
        }

        try {
          await this._fetchRange(from, to);
        } catch (err: any) {
          if (this._requestAbort || err.name === 'AbortError') return;
          this._status = mpegts.LoaderStatus.kError;
          this._onError(mpegts.LoaderErrors.EXCEPTION, { code: -1, msg: err.message });
          return;
        }
      }
    }

    private async _fetchRange(from: number, to: number): Promise<void> {
      const url = this._dataSource.url;
      this._abortController = new AbortController();

      const headers: Record<string, string> = {
        ...(this._config.headers || {}),
        Range: `bytes=${from}-${to}`,
      };

      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: this._abortController.signal,
        credentials: this._config.withCredentials ? 'include' : 'same-origin',
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      if (!response.body) {
        throw new Error('Response body missing');
      }

      this._status = mpegts.LoaderStatus.kBuffering;
      const reader = response.body.getReader();
      let offset = from;

      while (true) {
        const { done, value } = await reader.read();
        if (this._requestAbort) {
          await reader.cancel().catch(() => {});
          return;
        }
        if (done) break;

        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        if (this._shadowCache) {
          this._shadowCache.put(offset, chunk);
        }
        this._onDataArrival(chunk, offset, chunk.byteLength);
        offset += chunk.byteLength;
        this._currentByte = offset;
        this._isFirstChunk = false;
      }

      // Validate we got the expected number of bytes when file length is known
      if (this._fileLength > 0 && offset !== to + 1) {
        console.warn(`[ChunkedFetchLoader] Range ${from}-${to} ended at ${offset}, expected ${to + 1}`);
      }
    }
  }

  return ChunkedFetchLoader;
}
