use std::sync::Arc;
use grammers_client::Client;
use grammers_mtsender::SenderPool;
use grammers_session::storages::SqliteSession;
use tokio::sync::Semaphore;

/// Telegram download chunk size (same as server.rs/fs.rs).
/// Grammers-client enforces a hard cap of 512KB.
const TELEGRAM_CHUNK_SIZE: i32 = 512 * 1024;

/// Number of parallel download workers (TCP connections to the same DC).
/// Telegram's official docs recommend "several connections (optimally to have a pool)"
/// for file downloads. 3 workers gives ~3x bandwidth improvement.
const WORKER_COUNT: usize = 3;

/// A chunk of downloaded data with its byte offset in the original file.
#[derive(Clone)]
pub struct StreamChunk {
    pub offset: u64,
    pub data: Vec<u8>,
}

/// A pool of N independent Client instances for parallel file downloads.
///
/// Each worker creates its own SenderPool + TCP connection to the Telegram DC,
/// following Telegram's official recommendation:
/// "It makes sense to download files over several connections (optimally to have a pool)."
///
/// The main client handles API calls (auth, messages, updates).
/// The DownloadPool handles only file download operations.
#[derive(Clone)]
pub struct DownloadPool {
    workers: Vec<DownloadWorker>,
}

#[derive(Clone)]
struct DownloadWorker {
    /// Each worker has its own Client connected to its own SenderPool.
    client: Client,
}

impl DownloadPool {
    /// Create a new DownloadPool by copying the main session file N times
    /// and creating N SenderPool + Client instances.
    ///
    /// Each copy gets its own session file so it can independently manage
    /// auth keys for different DCs (grammers requires separate sessions per pool).
    pub fn new(main_session_path: &str, api_id: i32) -> Result<Self, String> {
        let mut workers = Vec::with_capacity(WORKER_COUNT);

        for i in 0..WORKER_COUNT {
            // Copy main session to worker-specific session file
            let worker_session_path = format!("{}-download-worker-{}", main_session_path, i);

            // Copy the main session files
            Self::copy_session_files(main_session_path, &worker_session_path)?;

            let session = SqliteSession::open(&worker_session_path)
                .map_err(|e| format!("Failed to open worker {} session: {}", i, e))?;
            let session = Arc::new(session);

            let pool = SenderPool::new(session, api_id);
            let client = Client::new(&pool);

            // Spawn the network runner for this worker
            let SenderPool { runner, .. } = pool;
            let worker_num = i;
            tokio::spawn(async move {
                runner.run().await;
                log::info!("DownloadPool worker {} runner exited", worker_num);
            });

            workers.push(DownloadWorker {
                client,
            });

            log::info!("DownloadPool worker {} initialized", i);
        }

        Ok(Self { workers })
    }

    /// Copy session file + WAL + SHM from main to worker path.
    fn copy_session_files(main_path: &str, worker_path: &str) -> Result<(), String> {
        std::fs::copy(main_path, worker_path)
            .map_err(|e| format!("Failed to copy session to {}: {}", worker_path, e))?;

        let wal_src = format!("{}-wal", main_path);
        let wal_dst = format!("{}-wal", worker_path);
        if std::path::Path::new(&wal_src).exists() {
            let _ = std::fs::copy(&wal_src, &wal_dst);
        }

        let shm_src = format!("{}-shm", main_path);
        let shm_dst = format!("{}-shm", worker_path);
        if std::path::Path::new(&shm_src).exists() {
            let _ = std::fs::copy(&shm_src, &shm_dst);
        }

        Ok(())
    }

    /// Download a byte range from a Telegram media file using parallel workers.
    ///
    /// Splits the range into WORKER_COUNT sub-ranges and dispatches across
    /// workers. Each worker independently fetches its sub-range via
    /// iter_download through its own TCP connection.
    ///
    /// Results are merged in byte-offset order and returned as a single Vec.
    pub async fn download_range(
        &self,
        media: &grammers_client::types::Media,
        start_byte: u64,
        end_byte: u64,
        _total_size: u64,
    ) -> Result<Vec<u8>, String> {
        let content_length = end_byte - start_byte + 1;

        // For small ranges, use a single worker to avoid overhead
        if content_length <= TELEGRAM_CHUNK_SIZE as u64 * 2 {
            return self.download_range_single(media, start_byte, end_byte).await;
        }

        // Split range across workers
        let sub_range_size = content_length / WORKER_COUNT as u64;
        let media_clone = media.clone();
        let mut tasks = Vec::with_capacity(WORKER_COUNT);

        for i in 0..WORKER_COUNT {
            let sub_start = start_byte + (i as u64) * sub_range_size;
            let sub_end = if i == WORKER_COUNT - 1 {
                end_byte // Last worker gets the remainder
            } else {
                start_byte + ((i as u64 + 1) * sub_range_size) - 1
            };

            if sub_start > sub_end {
                continue;
            }

            let worker = &self.workers[i];
            let client = worker.client.clone();
            let media_c = media_clone.clone();

            tasks.push(tokio::spawn(async move {
                download_sub_range_iter(client, &media_c, sub_start, sub_end).await
            }));
        }

        // Collect results in order
        let mut result = Vec::with_capacity(content_length as usize);
        for task in tasks {
            let task_result: Result<Result<Vec<u8>, String>, tokio::task::JoinError> = task.await;
            match task_result {
                Ok(Ok(data)) => result.extend_from_slice(&data),
                Ok(Err(e)) => return Err(e),
                Err(e) => return Err(format!("Worker task join error: {}", e)),
            }
        }

        Ok(result)
    }

    /// Download a byte range using a single worker (for small ranges).
    async fn download_range_single(
        &self,
        media: &grammers_client::types::Media,
        start_byte: u64,
        end_byte: u64,
    ) -> Result<Vec<u8>, String> {
        let worker = &self.workers[0];
        download_sub_range_iter(worker.client.clone(), media, start_byte, end_byte).await
    }

    /// Stream a byte range using all workers concurrently.
    /// Uses a coordinated approach: workers share a next-offset counter,
    /// each worker atomically claims the next chunk and fetches it.
    /// Chunks are yielded in byte-offset order to the HTTP response.
    pub fn stream_range(
        &self,
        media: &grammers_client::types::Media,
        start_byte: u64,
        end_byte: u64,
        total_size: u64,
        semaphore: Arc<Semaphore>,
    ) -> tokio::sync::mpsc::UnboundedReceiver<Result<StreamChunk, String>> {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let content_length = end_byte - start_byte + 1;
        let _ = total_size; // Available for future use

        // For small ranges, use single-worker sequential stream
        if content_length <= TELEGRAM_CHUNK_SIZE as u64 * 2 {
            let client = self.workers[0].client.clone();
            let sem_clone = semaphore.clone();
            let media_c = media.clone();
            tokio::spawn(async move {
                let chunks = sequential_stream(
                    client, &media_c, start_byte, end_byte, sem_clone,
                ).await;
                for chunk in chunks {
                    if tx.send(chunk).is_err() { break; }
                }
            });
            return rx;
        }

        // Parallel stream: each worker claims chunks from a shared offset
        // Workers send raw chunks to an internal channel; a reorder coordinator
        // buffers them and yields in strict byte-offset order to the output channel.
        let next_offset = Arc::new(tokio::sync::Mutex::new(start_byte));
        let mut tasks = Vec::with_capacity(WORKER_COUNT);
        let media_c = media.clone();

        // Internal channel for raw (out-of-order) chunks from workers
        let (raw_tx, mut raw_rx) = tokio::sync::mpsc::unbounded_channel::<Result<StreamChunk, String>>();

        for i in 0..WORKER_COUNT {
            let client = self.workers[i].client.clone();
            let sem_clone = semaphore.clone();
            let next_offset_clone = next_offset.clone();
            let raw_tx_clone = raw_tx.clone();
            let media_per_worker = media_c.clone();
            let stagger_ms = i as u64 * 150; // Stagger workers 150ms apart to avoid FLOOD_PREMIUM_WAIT

            let task = tokio::spawn(async move {
                if stagger_ms > 0 {
                    tokio::time::sleep(tokio::time::Duration::from_millis(stagger_ms)).await;
                }
                parallel_worker_stream(
                    client, &media_per_worker, start_byte, end_byte,
                    next_offset_clone, sem_clone, raw_tx_clone,
                ).await;
            });
            tasks.push(task);
        }

        drop(raw_tx); // Close raw channel so raw_rx returns None when all workers finish

        // Reorder coordinator: buffer chunks and yield in byte-offset order
        let tx_clone = tx.clone();
        tokio::spawn(async move {
            let mut buffer: std::collections::BTreeMap<u64, Vec<u8>> = std::collections::BTreeMap::new();
            let mut next_yield = start_byte;

            while let Some(msg) = raw_rx.recv().await {
                match msg {
                    Ok(StreamChunk { offset, data }) => {
                        buffer.insert(offset, data);
                        // Yield all consecutive chunks starting from next_yield
                        while let Some(data) = buffer.remove(&next_yield) {
                            let len = data.len() as u64;
                            if tx_clone.send(Ok(StreamChunk { offset: next_yield, data })).is_err() {
                                return; // Receiver dropped
                            }
                            next_yield += len;
                        }
                    }
                    Err(e) => {
                        if tx_clone.send(Err(e)).is_err() {
                            return;
                        }
                    }
                }
            }

            // Flush any remaining buffered chunks (shouldn't normally happen
            // if all data was received, but handles edge cases)
            while let Some(data) = buffer.remove(&next_yield) {
                let len = data.len() as u64;
                if tx_clone.send(Ok(StreamChunk { offset: next_yield, data })).is_err() {
                    return;
                }
                next_yield += len;
            }
        });

        drop(tx); // Close output channel so rx.recv() returns None when coordinator finishes

        // Cleanup: wait for all worker tasks
        tokio::spawn(async move {
            for task in tasks {
                let _ = task.await;
            }
        });

        rx
    }

    /// Clean up worker session files (called on logout).
    pub fn cleanup_session_files(&self, main_session_path: &str) {
        for i in 0..WORKER_COUNT {
            let worker_path = format!("{}-download-worker-{}", main_session_path, i);
            let _ = std::fs::remove_file(&worker_path);
            let _ = std::fs::remove_file(format!("{}-wal", worker_path));
            let _ = std::fs::remove_file(format!("{}-shm", worker_path));
        }
    }

    /// Get the number of workers in this pool.
    pub fn worker_count(&self) -> usize {
        self.workers.len()
    }
}

/// Download a sub-range using iter_download on a specific worker Client.
/// This uses the standard grammers iter_download API which handles
/// FILE_MIGRATE and auth key errors automatically.
async fn download_sub_range_iter(
    client: Client,
    media: &grammers_client::types::Media,
    start_byte: u64,
    end_byte: u64,
) -> Result<Vec<u8>, String> {
    let chunks_to_skip = (start_byte / TELEGRAM_CHUNK_SIZE as u64) as i32;
    let bytes_to_discard = start_byte % TELEGRAM_CHUNK_SIZE as u64;
    let content_length = end_byte - start_byte + 1;

    let mut iter = client.iter_download(media)
        .chunk_size(TELEGRAM_CHUNK_SIZE)
        .skip_chunks(chunks_to_skip);

    let mut result = Vec::with_capacity(content_length as usize);
    let mut first_chunk = bytes_to_discard > 0;
    let mut bytes_received: u64 = 0;

    while let Some(chunk) = iter.next().await.transpose() {
        let chunk = chunk.map_err(|e| format!("Sub-range download error: {}", e))?;

        if bytes_received >= content_length {
            break;
        }

        let remaining = content_length - bytes_received;
        let mut chunk_data: &[u8] = &chunk;

        // On first chunk, discard leading bytes for unaligned start
        if first_chunk && bytes_to_discard > 0 {
            let discard = (bytes_to_discard as usize).min(chunk.len());
            chunk_data = &chunk[discard..];
            first_chunk = false;
        }

        let to_take = chunk_data.len().min(remaining as usize);
        result.extend_from_slice(&chunk_data[..to_take]);
        bytes_received += to_take as u64;

        // End of file (Telegram returned less than a full chunk)
        if chunk.len() < TELEGRAM_CHUNK_SIZE as usize {
            break;
        }
    }

    Ok(result)
}

/// Sequential stream of chunks for small ranges (single worker).
async fn sequential_stream(
    client: Client,
    media: &grammers_client::types::Media,
    start_byte: u64,
    end_byte: u64,
    semaphore: Arc<Semaphore>,
) -> Vec<Result<StreamChunk, String>> {
    let chunks_to_skip = (start_byte / TELEGRAM_CHUNK_SIZE as u64) as i32;
    let bytes_to_discard = start_byte % TELEGRAM_CHUNK_SIZE as u64;
    let content_length = end_byte - start_byte + 1;

    let mut iter = client.iter_download(media)
        .chunk_size(TELEGRAM_CHUNK_SIZE)
        .skip_chunks(chunks_to_skip);

    let mut chunks = Vec::new();
    let mut first_chunk = bytes_to_discard > 0;
    let mut current_offset = start_byte;
    let mut bytes_sent: u64 = 0;

    while let Some(chunk_result) = {
        let _permit = semaphore.acquire().await.unwrap();
        iter.next().await.transpose()
    } {
        match chunk_result {
            Ok(chunk) => {
                let remaining = content_length - bytes_sent;
                if remaining == 0 { break; }

                let mut chunk_data = chunk;

                if first_chunk && bytes_to_discard > 0 {
                    let discard = (bytes_to_discard as usize).min(chunk_data.len());
                    chunk_data = chunk_data[discard..].to_vec();
                    first_chunk = false;
                }

                let is_last = chunk_data.len() as u64 > remaining;
                let final_data = if is_last {
                    chunk_data[..remaining as usize].to_vec()
                } else {
                    chunk_data
                };

                let bytes_in_chunk = final_data.len() as u64;
                chunks.push(Ok(StreamChunk {
                    offset: current_offset,
                    data: final_data,
                }));

                current_offset += bytes_in_chunk;
                bytes_sent += bytes_in_chunk;

                if is_last { break; }
            }
            Err(e) => {
                chunks.push(Err(format!("Stream chunk error: {}", e)));
                break;
            }
        }
    }

    chunks
}

/// Parallel worker stream: each worker claims chunks from a shared next-offset
/// counter and fetches them via iter_download through its own TCP connection.
async fn parallel_worker_stream(
    client: Client,
    media: &grammers_client::types::Media,
    start_byte: u64,
    end_byte: u64,
    next_offset: Arc<tokio::sync::Mutex<u64>>,
    semaphore: Arc<Semaphore>,
    tx: tokio::sync::mpsc::UnboundedSender<Result<StreamChunk, String>>,
) {
    // Each worker fetches chunks one at a time, claiming the next offset
    // from the shared counter. This ensures balanced load distribution.
    let _content_length = end_byte - start_byte + 1;
    let bytes_to_discard_first = start_byte % TELEGRAM_CHUNK_SIZE as u64;
    let first_chunk_boundary = (start_byte / TELEGRAM_CHUNK_SIZE as u64) * TELEGRAM_CHUNK_SIZE as u64;
    let mut handled_first = false;

    loop {
        // Acquire semaphore before claiming offset
        let _permit = semaphore.acquire().await.unwrap();

        // Claim next chunk boundary offset
        let chunk_offset = {
            let mut guard = next_offset.lock().await;
            let offset = *guard;
            *guard += TELEGRAM_CHUNK_SIZE as u64;
            offset
        };

        if chunk_offset > end_byte + TELEGRAM_CHUNK_SIZE as u64 {
            break; // All chunks claimed
        }

        // Determine the actual byte range for this chunk
        let actual_start = if !handled_first && chunk_offset == first_chunk_boundary && bytes_to_discard_first > 0 {
            start_byte // Unaligned first chunk: start from the actual request start
        } else {
            chunk_offset.max(start_byte)
        };

        let actual_end = (chunk_offset + TELEGRAM_CHUNK_SIZE as u64 - 1).min(end_byte);
        if actual_start > actual_end {
            continue; // Chunk boundary past end_byte, nothing to download
        }
        let sub_length = actual_end - actual_start + 1;

        if sub_length == 0 {
            continue;
        }

        // Download this sub-range via iter_download
        let chunks_to_skip = (actual_start / TELEGRAM_CHUNK_SIZE as u64) as i32;
        let sub_discard = actual_start % TELEGRAM_CHUNK_SIZE as u64;
        let mut first_sub = sub_discard > 0;

        let mut iter = client.iter_download(media)
            .chunk_size(TELEGRAM_CHUNK_SIZE)
            .skip_chunks(chunks_to_skip);

        let mut bytes_received: u64 = 0;

        while let Some(chunk_result) = iter.next().await.transpose() {
            match chunk_result {
                Ok(chunk) => {
                    let original_len = chunk.len();
                    let mut chunk_data = chunk;

                    if first_sub && sub_discard > 0 && chunk_offset == first_chunk_boundary {
                        let discard = (sub_discard as usize).min(chunk_data.len());
                        chunk_data = chunk_data[discard..].to_vec();
                        first_sub = false;
                        handled_first = true;
                    } else {
                        first_sub = false;
                    }

                    let remaining = sub_length - bytes_received;
                    let to_take = chunk_data.len().min(remaining as usize);
                    let final_data = chunk_data[..to_take].to_vec();

                    if tx.send(Ok(StreamChunk {
                        offset: actual_start + bytes_received,
                        data: final_data,
                    })).is_err() {
                        return; // Receiver dropped (client disconnected)
                    }

                    bytes_received += to_take as u64;

                    // End of file or sub-range complete
                    if original_len < TELEGRAM_CHUNK_SIZE as usize || bytes_received >= sub_length {
                        break;
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(format!("Parallel chunk error: {}", e)));
                    return;
                }
            }
        }

        // If this was the last chunk of the file, signal completion
        // by setting the offset past the end
        let guard = next_offset.lock().await;
        if *guard > end_byte + TELEGRAM_CHUNK_SIZE as u64 {
            break;
        }
    }
}
