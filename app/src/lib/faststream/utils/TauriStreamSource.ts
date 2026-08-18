import { CustomSource } from 'mediabunny';

export interface TauriStreamSourceConfig {
  url: string;
  fileSize: number;
  headers?: Record<string, string>;
  maxCacheSize?: number;
  prefetchProfile?: 'none' | 'fileSystem' | 'network';
  seedData?: ArrayBuffer;
  sourceId?: string;
}

const MAX_503_RETRIES = 8;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 15000;
const MAX_EMPTY_RETRIES = 60;
const EMPTY_RETRY_DELAY_MS = 500;
const PARTIAL_RETRY_DELAY_MS = 100;

export function createTauriStreamSource(config: TauriStreamSourceConfig): CustomSource {
  const {
    url,
    fileSize,
    headers = {},
    maxCacheSize,
    prefetchProfile = 'network',
    seedData,
    sourceId,
  } = config;
  const seedBytes = seedData ? new Uint8Array(seedData) : null;
  const seedLength = seedBytes?.byteLength ?? 0;
  const tailStart = fileSize > 32 * 1024 * 1024 ? fileSize - 32 * 1024 * 1024 : fileSize;
  let disposed = false;
  let superseded = false;
  let clusterByteOfLastSeek = -1;
  let captureNextReadStart = false;
  const inFlightAborts = new Set<AbortController>();

  const buildUrl = (id?: string) => {
    if (!id) return url;
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}source_id=${encodeURIComponent(id)}`;
  };
  const bodyUrl = buildUrl(sourceId);
  const tailUrl = buildUrl(sourceId ? `${sourceId}-tail` : undefined);
  const urlForPosition = (position: number) => sourceId && position >= tailStart ? tailUrl : bodyUrl;
  const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

  const streamNetworkRange = async (
    start: number,
    endExclusive: number,
    controller: ReadableStreamDefaultController<Uint8Array>,
    localAborts: Set<AbortController>,
    cancelled: () => boolean,
  ) => {
    let position = start;
    let emptyRetries = 0;

    while (position < endExclusive) {
      if (disposed || superseded || cancelled()) {
        throw new Error('[TauriStreamSource] read aborted (superseded by seek)');
      }
      const requestedEnd = Math.min(endExclusive - 1, fileSize - 1);
      let progressed = false;

      for (let attempt = 0; attempt <= MAX_503_RETRIES && !progressed; attempt++) {
        if (disposed || superseded || cancelled()) {
          throw new Error('[TauriStreamSource] read aborted (superseded by seek)');
        }
        const abort = new AbortController();
        inFlightAborts.add(abort);
        localAborts.add(abort);
        try {
          let response: Response;
          try {
            response = await fetch(urlForPosition(position), {
              headers: { ...headers, Range: `bytes=${position}-${requestedEnd}` },
              signal: abort.signal,
            });
          } catch (error: any) {
            if (error?.name === 'AbortError') {
              throw new Error('[TauriStreamSource] read aborted (superseded by seek)');
            }
            throw error;
          }

          if (response.status === 503) {
            const reason = response.headers.get('X-Reason') ?? '';
            if (reason === 'cached-only-miss') {
              throw new Error(`[TauriStreamSource] Range ${position}-${requestedEnd} not cached (cached_only=503)`);
            }
            if (attempt < MAX_503_RETRIES) {
              const retryAfter = Number.parseInt(response.headers.get('Retry-After') ?? '30', 10);
              await wait(Math.min(
                retryAfter * 1000,
                RETRY_BASE_DELAY_MS * 2 ** attempt,
                RETRY_MAX_DELAY_MS,
              ));
              continue;
            }
          }

          if (!response.ok && response.status !== 206) {
            throw new Error(`[TauriStreamSource] HTTP ${response.status} for range ${position}-${requestedEnd}`);
          }

          if (!response.body) {
            const data = new Uint8Array(await response.arrayBuffer());
            const take = Math.min(data.byteLength, requestedEnd - position + 1);
            if (take > 0) {
              controller.enqueue(data.subarray(0, take));
              position += take;
              progressed = true;
            }
          } else {
            const reader = response.body.getReader();
            try {
              while (position <= requestedEnd) {
                if (disposed || superseded || cancelled()) {
                  throw new Error('[TauriStreamSource] read aborted (superseded by seek)');
                }
                const { done, value } = await reader.read();
                if (done) break;
                if (!value?.byteLength) continue;
                const take = Math.min(value.byteLength, requestedEnd - position + 1);
                if (take > 0) {
                  controller.enqueue(value.subarray(0, take));
                  position += take;
                  progressed = true;
                }
                if (take < value.byteLength || position > requestedEnd) {
                  await reader.cancel();
                  break;
                }
              }
            } finally {
              reader.releaseLock();
            }
          }
        } finally {
          inFlightAborts.delete(abort);
          localAborts.delete(abort);
        }
      }

      if (!progressed) {
        emptyRetries++;
        if (emptyRetries >= MAX_EMPTY_RETRIES) {
          throw new Error(`[TauriStreamSource] No data available after ${MAX_EMPTY_RETRIES} retries for range ${start}-${endExclusive - 1}`);
        }
        await wait(EMPTY_RETRY_DELAY_MS);
      } else {
        emptyRetries = 0;
        if (position < endExclusive) await wait(PARTIAL_RETRY_DELAY_MS);
      }
    }
  };

  const source = new CustomSource({
    getSize: async () => fileSize,
    read: (start: number, end: number) => {
      const localAborts = new Set<AbortController>();
      let cancelled = false;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          let position = start;
          if (captureNextReadStart) {
            clusterByteOfLastSeek = start;
            captureNextReadStart = false;
          }

          void (async () => {
            try {
              if (seedBytes && position < seedLength) {
                const seedEnd = Math.min(end, seedLength);
                controller.enqueue(seedBytes.subarray(position, seedEnd));
                position = seedEnd;
              }
              if (position < end) {
                await streamNetworkRange(position, end, controller, localAborts, () => cancelled);
              }
              if (!cancelled) controller.close();
            } catch (error) {
              if (!cancelled) controller.error(error);
            }
          })();
        },
        cancel() {
          cancelled = true;
          for (const abort of localAborts) abort.abort();
          localAborts.clear();
        },
      });
    },
    dispose: () => {
      disposed = true;
      for (const abort of inFlightAborts) abort.abort();
      inFlightAborts.clear();
    },
    maxCacheSize,
    prefetchProfile,
  });

  (source as any).abortInFlight = () => {
    superseded = true;
    for (const abort of inFlightAborts) abort.abort();
    inFlightAborts.clear();
  };
  (source as any).resetSupersession = () => {
    superseded = false;
  };
  (source as any).markSeekResolved = () => {
    captureNextReadStart = true;
  };
  (source as any).clearSeekState = () => {
    captureNextReadStart = false;
  };
  (source as any).getClusterByteOfLastSeek = () => clusterByteOfLastSeek;
  return source;
}
