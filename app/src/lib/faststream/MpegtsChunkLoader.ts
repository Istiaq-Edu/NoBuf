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
  // ── Pipe backpressure (non-seekable /remux ffmpeg pipe only) ──
  // For a byte-seekable source (/stream), mpegts.js lazyLoad throttles the
  // transmuxer by aborting the loader and later resuming via a byte-seek. On a
  // /remux pipe that resume re-opens the pipe and spawns a SECOND ffmpeg
  // transcode (proven: trace 17). Instead, the ss player runs with lazyLoad OFF
  // and throttles here by simply NOT reading: a stalled reader fills the TCP
  // window → ffmpeg's pipe write blocks → ffmpeg self-throttles. No abort, no
  // re-seek, no second transcode.
  //
  // getBufferedAheadSeconds: returns seconds buffered ahead of currentTime, or 0
  //   when currentTime is not yet inside any buffered range (pre-align warmup —
  //   must NOT throttle then, or the pipe stalls before playback starts).
  getBufferedAheadSeconds?: () => number;
  pipeBackpressureMaxAhead?: number;     // start throttling above this (default 60s)
  pipeBackpressureHysteresis?: number;   // resume reading below max-this (default 15s)
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
    private _postSeekFirstChunkSize: number;
    private _shadowCache: StreamShadowCache | null;
    private _isSeekStart = false;
    private _pumpGen = 0;

    // Pipe backpressure (see ChunkLoaderConfig). Disabled unless a
    // getBufferedAheadSeconds callback is supplied by the ss (/remux) player.
    private _bpAhead: (() => number) | null;
    private _bpMaxAhead: number;
    private _bpHysteresis: number;

    static isSupported() {
      return typeof self !== 'undefined' && typeof self.fetch === 'function' && typeof self.ReadableStream === 'function' && typeof self.AbortController === 'function';
    }

    constructor(_seekHandler: any, config: any) {
      super('chunked-fetch-loader');
      this._config = config || {};
      this._needStash = true;

      this._firstChunkSize = alignToPacket(this._config.firstChunkSize || 5 * 1024 * 1024);
      this._chunkSize = alignToPacket(this._config.chunkSize || 2 * 1024 * 1024);
      this._postSeekFirstChunkSize = alignToPacket(this._config.postSeekFirstChunkSize || 8 * 1024 * 1024);
      this._shadowCache = this._config.shadowCache || null;

      this._bpAhead = typeof this._config.getBufferedAheadSeconds === 'function'
        ? this._config.getBufferedAheadSeconds
        : null;
      this._bpMaxAhead = this._config.pipeBackpressureMaxAhead ?? 60;
      this._bpHysteresis = this._config.pipeBackpressureHysteresis ?? 15;
    }

    // Pipe backpressure gate: while more than _bpMaxAhead seconds are buffered
    // ahead of the playhead, stop reading (leave the fetch open) so TCP
    // backpressure stalls ffmpeg. Resume once the buffer drains to
    // (_bpMaxAhead - _bpHysteresis). Returns immediately (no throttle) when the
    // callback is absent or reports 0 (pre-align warmup / playhead not yet in a
    // buffered range). Bails on abort / stale pump.
    private async _awaitBackpressure(gen: number): Promise<void> {
      if (!this._bpAhead) return;
      let ahead = this._bpAhead();
      if (ahead <= this._bpMaxAhead) return;
      const resumeAt = Math.max(0, this._bpMaxAhead - this._bpHysteresis);
      const _diag = (window as any).__nobuf_diagLog || (() => {});
      _diag(`[LOADER] pipe backpressure: ${ahead.toFixed(1)}s buffered ahead > ${this._bpMaxAhead}s — pausing reads until ${resumeAt}s`);
      while (ahead > resumeAt) {
        if (this._requestAbort || gen !== this._pumpGen || (window as any).__nobuf_mpegtsFatalAbort) return;
        await new Promise<void>(resolve => setTimeout(resolve, 250));
        ahead = this._bpAhead();
      }
      _diag(`[LOADER] pipe backpressure: drained to ${ahead.toFixed(1)}s — resuming reads`);
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
      this._isSeekStart = !this._isFirstChunk;
      // Bump generation so any previous _pumpChunks loop bails on next iteration
      const gen = ++this._pumpGen;

      if (this._fileLength > 0) {
        this._onContentLengthKnown(this._fileLength);
      }

      this._pumpChunks(gen);
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
      if (this._isSeekStart) return this._postSeekFirstChunkSize;
      return this._chunkSize;
    }

    private async _pumpChunks(gen: number): Promise<void> {
      if (this._requestAbort || gen !== this._pumpGen) return;

      while (true) {
        if (this._requestAbort || gen !== this._pumpGen) return;

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
            try {
              this._onDataArrival(cached, from, cached.byteLength);
            } catch (err: any) {
              if (gen !== this._pumpGen) return; // stale pump — player already replaced
              this._status = mpegts.LoaderStatus.kError;
              try { this._onError(mpegts.LoaderErrors.EXCEPTION, { code: -1, msg: err.message }); } catch (_) {}
              return;
            }
            this._currentByte = to + 1;
            this._isFirstChunk = false;
            this._isSeekStart = false;
            // Yield to the event loop between cache chunks. Without this, serving
            // large cached ranges runs a synchronous tight loop through the full
            // transmuxer pipeline (TSDemuxer → MP4Remuxer → SourceBuffer.appendBuffer),
            // blocking the main thread and freezing the UI.
            await new Promise<void>(resolve => setTimeout(resolve, 0));
            // Hard-stop: if a fatal decode error occurred, stop feeding data to transmuxer
            if ((window as any).__nobuf_mpegtsFatalAbort || gen !== this._pumpGen) return;
            continue;
          }
        }

        try {
          await this._fetchRange(from, to, gen);
        } catch (err: any) {
          if (this._requestAbort || err.name === 'AbortError' || gen !== this._pumpGen) return;
          this._status = mpegts.LoaderStatus.kError;
          try { this._onError(mpegts.LoaderErrors.EXCEPTION, { code: -1, msg: err.message }); } catch (_) {}
          return;
        }
      }
    }

    private async _fetchRange(from: number, to: number, gen: number = this._pumpGen): Promise<void> {
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

      // DIAG (remove once remux-seek stall root-caused): the seek feed dies at
      // ~288KB while ffmpeg keeps producing. Instrument EVERY read so the log
      // states plainly whether reader.read() stops delivering (transport/WebView2
      // buffering) or the loop exits via done/abort. Logs response status +
      // headers once so we can see 200-vs-206 and any Content-Length.
      const _diag = (window as any).__nobuf_diagLog || ((s: string) => console.log(s));
      let _readN = 0, _readBytes = 0;
      _diag(`[LOADER] _fetchRange(${from}-${to}) response: status=${response.status} clen=${response.headers.get('content-length')} ctype=${response.headers.get('content-type')} enc=${response.headers.get('transfer-encoding')}`);

      while (true) {
        const { done, value } = await reader.read();
        if (this._requestAbort) {
          _diag(`[LOADER] _fetchRange(${from}) aborted after ${_readN} reads / ${_readBytes}B`);
          await reader.cancel().catch(() => {});
          return;
        }
        if (done) {
          _diag(`[LOADER] _fetchRange(${from}) reader DONE after ${_readN} reads / ${_readBytes}B (offset=${offset})`);
          break;
        }
        _readN++;
        _readBytes += (value?.byteLength ?? 0);
        if (_readN <= 8 || _readN % 20 === 0) {
          _diag(`[LOADER] read #${_readN}: +${value?.byteLength ?? 0}B total=${_readBytes}B offset=${offset}`);
        }

        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        // Hard-stop: if a fatal decode error occurred, stop feeding data to
        // the transmuxer immediately. Without this, _onDataArrival keeps
        // producing segments that try to appendBuffer, which keeps failing
        // and triggering our error handler in a loop.
        if ((window as any).__nobuf_mpegtsFatalAbort) {
          await reader.cancel().catch(() => {});
          return;
        }
        if (this._shadowCache) {
          this._shadowCache.put(offset, chunk);
        }
        try {
          this._onDataArrival(chunk, offset, chunk.byteLength);
        } catch (err: any) {
          this._status = mpegts.LoaderStatus.kError;
          try { this._onError(mpegts.LoaderErrors.EXCEPTION, { code: -1, msg: err.message }); } catch (_) {}
          await reader.cancel().catch(() => {});
          return;
        }
        offset += chunk.byteLength;
        this._currentByte = offset;
        this._isFirstChunk = false;
        this._isSeekStart = false;

        // Pipe backpressure: if the buffer is far ahead of the playhead, stop
        // reading here (fetch stays open) until it drains. Stalling the reader
        // fills the TCP window so ffmpeg self-throttles — no abort, no re-seek,
        // no second transcode. No-op for byte-seekable (/stream) players.
        await this._awaitBackpressure(gen);
        if (this._requestAbort || gen !== this._pumpGen || (window as any).__nobuf_mpegtsFatalAbort) {
          await reader.cancel().catch(() => {});
          return;
        }
      }

      // Validate we got the expected number of bytes when file length is known
      if (this._fileLength > 0 && offset !== to + 1) {
        console.warn(`[ChunkedFetchLoader] Range ${from}-${to} ended at ${offset}, expected ${to + 1}`);
      }
    }
  }

  return ChunkedFetchLoader;
}
