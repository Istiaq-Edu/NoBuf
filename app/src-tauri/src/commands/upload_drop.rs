//! Stream-direct upload endpoint for external file drops.
//!
//! WebView2 hands the webview a browser File handle with NO filesystem path, which
//! is why dropped files were previously staged (fully copied) to %TEMP% before
//! cmd_upload_file could read them. The actix streaming server (127.0.0.1:14201)
//! lets the webview POST the raw bytes instead — this handler pumps them straight
//! into grammers' upload_stream with no temp file and no preparing phase.

use std::sync::Arc;
use std::time::Instant;
use actix_web::{web, HttpRequest, HttpResponse, Responder};
use futures::StreamExt;
use tauri::Emitter;

use crate::bandwidth::BandwidthManager;
use crate::commands::TelegramState;
use crate::server::StreamTokenData;

/// Process-global dependencies for the drop-upload handler.
///
/// WHY GLOBALS: the route used to be registered conditionally on actix
/// web::Data availability, and in one user session the route silently never
/// appeared (healthy server, alive=true, 404 on the path — cause never
/// isolated). Conditional registration was the only moving part left, so it
/// is GONE: /upload-drop now registers UNCONDITIONALLY and its deps live in a
/// OnceLock set by lib.rs before the server thread starts. A drop arriving
/// before set_deps() runs can only happen pre-connect; the handler answers 503.
#[derive(Clone)]
pub struct UploadDeps {
    pub app_handle: Option<tauri::AppHandle>,
    pub bw: Option<Arc<BandwidthManager>>,
}

static UPLOAD_DEPS: std::sync::OnceLock<UploadDeps> = std::sync::OnceLock::new();

pub fn set_upload_deps(deps: UploadDeps) {
    let _ = UPLOAD_DEPS.set(deps);
}

pub(crate) fn upload_deps() -> UploadDeps {
    UPLOAD_DEPS.get().cloned().unwrap_or(UploadDeps { app_handle: None, bw: None })
}

pub(crate) const MAX_DROP_BYTES: u64 = 4_294_967_295; // Telegram hard ceiling (u32 part math)

#[derive(Clone, serde::Serialize)]
struct DropProgressPayload {
    id: String,
    percent: u8,
    uploaded_bytes: u64,
    total_bytes: u64,
    speed_bytes_per_sec: u64,
}

/// Adapter turning an actix payload stream into the AsyncRead that
/// grammers' PartStream consumes. Pull-based: PartStream reads exactly
/// MAX_CHUNK_SIZE bytes per part; our poll_read forwards whatever the
/// HTTP body currently has buffered, so no whole-file buffering occurs.
struct BodyReader {
    stream: Box<dyn futures::Stream<Item = Result<web::Bytes, actix_web::Error>> + Unpin>,
    current: web::Bytes,
    /// Bytes actually forwarded into the uploader (for progress + accounting).
    consumed: Arc<std::sync::atomic::AtomicU64>,
}

impl tokio::io::AsyncRead for BodyReader {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        // Refill from the HTTP body when the previous chunk is drained.
        while self.current.is_empty() {
            match std::task::ready!(self.stream.poll_next_unpin(cx)) {
                Some(Ok(bytes)) if !bytes.is_empty() => self.current = bytes,
                Some(Ok(_)) => continue, // empty frame; keep polling
                Some(Err(e)) => {
                    return std::task::Poll::Ready(Err(std::io::Error::new(
                        std::io::ErrorKind::ConnectionAborted,
                        format!("client disconnected mid-upload: {e}"),
                    )))
                }
                None => break, // body exhausted; short read signals EOF to PartStream
            }
        }
        let n = std::cmp::min(self.current.len(), buf.remaining());
        buf.put_slice(&self.current.split_to(n));
        self.consumed.fetch_add(n as u64, std::sync::atomic::Ordering::Relaxed);
        std::task::Poll::Ready(Ok(()))
    }
}

pub(crate) fn query_param(req: &HttpRequest, key: &str) -> Option<String> {
    use actix_web::web::Query;
    let q = Query::<std::collections::HashMap<String, String>>::from_query(req.query_string()).ok()?;
    q.get(key).cloned()
}

/// Stream-direct drop upload handler.
///
/// Registered method-agnostically (server.rs uses `web::to`) because actix-web
/// matches HEAD only against GET routes — a POST-only resource answers HEAD
/// with 404, which made every availability probe a false negative while the
/// route was live. The handler itself enforces POST before touching anything.
pub(crate) async fn upload_drop_handler(
    req: HttpRequest,
    payload: web::Payload,
    tg_state: web::Data<Arc<TelegramState>>,
    token_data: web::Data<StreamTokenData>,
) -> impl Responder {
    // --- Method gate ------------------------------------------------------------
    // The route is registered method-agnostically (web::to) because actix-web
    // matches HEAD only against GET routes — a POST-only resource 404s on HEAD,
    // which made every availability probe report a false negative. Presence is
    // now provable with ANY verb; real uploads must still be POST.
    if req.method() != actix_web::http::Method::POST {
        return HttpResponse::MethodNotAllowed().body("use POST");
    }
    // --- Auth: session token required (loopback is shared with every local
    //     process/browser tab; CORS cannot stop them SENDING, only reading) ------
    match query_param(&req, "token") {
        Some(t) if t == token_data.token => {}
        _ => {
            log::warn!("[drop] rejected unauthenticated /upload-drop attempt from {}", req.peer_addr().map(|a| a.to_string()).unwrap_or_else(|| "unknown".into()));
            return HttpResponse::Unauthorized().body("invalid or missing token");
        }
    }
    // --- Parameter validation -------------------------------------------------
    let name = match query_param(&req, "name") {
        Some(n) if !n.trim().is_empty() => n,
        _ => return HttpResponse::BadRequest().body("missing or empty 'name'"),
    };
    let size: u64 = match query_param(&req, "size").and_then(|s| s.parse().ok()) {
        Some(s) => s,
        None => return HttpResponse::BadRequest().body("missing or invalid 'size'"),
    };
    if size == 0 || size > MAX_DROP_BYTES {
        return HttpResponse::BadRequest().body("invalid 'size'");
    }
    let display_name = query_param(&req, "display_name");
    let folder_id: Option<i64> = query_param(&req, "folder_id").and_then(|s| s.parse().ok());
    let tid = query_param(&req, "tid").unwrap_or_default();

    // --- Bandwidth gate (same daily cap as every other transfer) ---------------
    let bw_state = upload_deps().bw.expect("upload deps missing bandwidth");
    if bw_state.can_transfer(size).is_err() {
        log::warn!("[drop] {name} ({size}B) rejected: daily bandwidth cap");
        return HttpResponse::BadRequest().body("Daily bandwidth limit exceeded");
    }

    // --- Client -----------------------------------------------------------------
    let client_opt = { tg_state.client.lock().await.clone() };
    let Some(client) = client_opt else {
        log::warn!("[drop] {name} rejected: not connected to Telegram");
        return HttpResponse::ServiceUnavailable().body("Not connected to Telegram");
    };
    log::info!("[drop] streaming '{name}' ({size}B -> folder {folder_id:?}) tid={tid}");

    // --- Progress reporter (250ms cadence, mirrors cmd_upload_file) -------------
    let consumed = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let progress_task = if !tid.is_empty() {
        let counter = consumed.clone();
        let handle = upload_deps().app_handle.expect("upload deps missing app_handle");
        let cancelled = tg_state.cancelled_transfers.clone();
        let tid_p = tid.clone();
        let total = size;
        Some(actix_web::rt::spawn(async move {
            let mut last_bytes = 0u64;
            let mut last_time = Instant::now();
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                let current = counter.load(std::sync::atomic::Ordering::Relaxed);
                let now = Instant::now();
                let dt = now.duration_since(last_time).as_secs_f64();
                let speed = if dt > 0.0 { ((current - last_bytes) as f64 / dt) as u64 } else { 0 };
                let percent = if total > 0 { ((current * 100) / total).min(100) as u8 } else { 0 };
                let _ = handle.emit("upload-progress", DropProgressPayload {
                    id: tid_p.clone(),
                    percent,
                    uploaded_bytes: current,
                    total_bytes: total,
                    speed_bytes_per_sec: speed,
                });
                last_bytes = current;
                last_time = now;
                if current >= total { break; }
                if cancelled.read().await.contains(&tid_p) { break; }
            }
        }))
    } else {
        None
    };
    if !tid.is_empty() {
        let _ = upload_deps().app_handle.as_ref().map(|h| h.emit("upload-progress", DropProgressPayload {
            id: tid.clone(), percent: 0, uploaded_bytes: 0, total_bytes: size, speed_bytes_per_sec: 0,
        }));
    }

    // --- Cancellation pre-check (mirrors cmd_upload_file ordering) --------------
    if tg_state.cancelled_transfers.read().await.contains(&tid) {
        tg_state.cancelled_transfers.write().await.remove(&tid);
        if let Some(t) = progress_task { t.abort(); }
        return HttpResponse::BadRequest().body("Transfer cancelled");
    }

    // --- Stream the request body directly into Telegram -------------------------
    let reader = BodyReader {
        stream: Box::new(
            payload.map(|r| r.map_err(|e| actix_web::Error::from(e)))
        ),
        current: web::Bytes::new(),
        consumed: consumed.clone(),
    };
    let doc_name = crate::commands::fs::effective_document_name(&display_name, &name);

    let mut buffered = tokio::io::BufReader::with_capacity(512 * 1024, reader);
    let upload_res = client.upload_stream(&mut buffered, size as usize, doc_name).await;

    if let Some(t) = progress_task { t.abort(); }

    // Bandwidth accounting on EVERY terminal path: bytes actually consumed count
    // toward the daily cap whether the transfer succeeded, was cancelled, or died
    // mid-stream (the old code only counted full successes).
    let consumed_bytes = consumed.load(std::sync::atomic::Ordering::Relaxed);
    bw_state.add_up(consumed_bytes);

    // Post-upload cancellation check (mirrors cmd_upload_file)
    let was_cancelled = tg_state.cancelled_transfers.read().await.contains(&tid);
    if was_cancelled {
        tg_state.cancelled_transfers.write().await.remove(&tid);
    }

    match upload_res {
        Ok(_) if was_cancelled => {
            log::info!("[drop] tid={tid} cancelled after {consumed_bytes}B (user abort)");
            HttpResponse::BadRequest().body("Transfer cancelled")
        }
        Ok(uploaded) => {
            // Integrity gate: grammers tolerates a short FINAL part, so a body
            // that drained before `size` bytes would silently upload a truncated
            // document. Refuse to send anything incomplete.
            if consumed_bytes != size {
                return HttpResponse::InternalServerError().body(format!(
                    "Incomplete transfer: sent {} of {} bytes", consumed_bytes, size
                ));
            }
            let peer = crate::commands::utils::resolve_peer(
                &client, folder_id, &tg_state.peer_cache,
            ).await;
            match peer {
                Ok(peer) => {
                    let msg = grammers_client::types::InputMessage::new().text("").document(uploaded);
                    match client.send_message(&peer, msg).await {
                        Ok(m) => {
                            log::info!("[drop] tid={tid} SUCCESS: '{name}' ({size}B) sent, message_id={}", m.id());
                            // documents-changed (parts-first plan §A): the drop
                            // pipeline has its own send path — emit here too so
                            // the folder listing refreshes without a restart.
                            if let Some(h) = upload_deps().app_handle {
                                let _ = h.emit(
                                    "documents-changed",
                                    serde_json::json!({ "folder_id": folder_id }),
                                );
                            }
                            HttpResponse::Ok().json(serde_json::json!({ "message_id": m.id() }))
                        }
                        // Distinct marker body: bytes are ALREADY STORED in
                        // Telegram's servers. Retrying would re-upload and
                        // duplicate the document. Frontend treats this as
                        // terminal 'sent-unconfirmed', not retryable error.
                        Err(e) => {
                            log::warn!("[drop] tid={tid} stored but send failed (document orphaned in TG): {e}");
                            HttpResponse::UnprocessableEntity()
                                .body(format!("ALREADY_STORED: {e}"))
                        }
                    }
                }
                Err(e) => {
                    log::warn!("[drop] tid={tid} stored but resolve failed (document orphaned in TG): {e}");
                    HttpResponse::UnprocessableEntity()
                        .body(format!("ALREADY_STORED: {e}"))
                }
            }
        }
        Err(e) => {
            log::warn!("[drop] tid={tid} upload failed after {consumed_bytes}B: {e}");
            HttpResponse::InternalServerError().body(format!("Upload failed: {e}"))
        }
    }
}

#[cfg(test)]
mod body_reader_tests {
    use super::*;
    use futures::stream::{self, Stream};
    use std::pin::Pin;
    use tokio::io::AsyncReadExt as _;

    /// Drain the whole stream through the adapter; returns byte count.
    async fn drain(
        stream: Pin<Box<dyn Stream<Item = Result<web::Bytes, actix_web::Error>> + Unpin>>,
        consumed: Arc<std::sync::atomic::AtomicU64>,
    ) -> std::io::Result<usize> {
        let mut reader = BodyReader {
            stream: Box::new(stream),
            current: web::Bytes::new(),
            consumed,
        };
        let mut out = Vec::new();
        reader.read_to_end(&mut out).await?;
        Ok(out.len())
    }

    #[test]
    fn partial_frames_forward_and_count_consumed() {
        let s: Pin<Box<dyn Stream<Item = Result<web::Bytes, actix_web::Error>> + Unpin>> =
            Box::pin(stream::iter(vec![
                Ok(web::Bytes::from_static(b"hello")),
                Ok(web::Bytes::from_static(b" world")),
            ]));
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let consumed = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let n = rt.block_on(drain(s, consumed.clone())).unwrap();
        assert_eq!(n, 11);
        assert_eq!(consumed.load(std::sync::atomic::Ordering::Relaxed), 11);
    }

    #[test]
    fn body_draining_early_yields_clean_eof_short_read() {
        // Declared size 100 but only 3 bytes arrive: PartStream's contract needs a
        // SHORT READ at EOF (not an error, not a hang) so its UnexpectedEof arm
        // decides. The adapter must end cleanly after the last frame.
        let s: Pin<Box<dyn Stream<Item = Result<web::Bytes, actix_web::Error>> + Unpin>> =
            Box::pin(stream::iter(vec![Ok(web::Bytes::from_static(b"abc"))]));
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let consumed = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let n = rt.block_on(drain(s, consumed.clone())).unwrap();
        assert_eq!(n, 3);
        assert_eq!(consumed.load(std::sync::atomic::Ordering::Relaxed), 3,
            "EOF must surface as a clean short read of exactly the delivered bytes");
    }

    #[test]
    fn payload_error_maps_to_connection_aborted() {
        let s: Pin<Box<dyn Stream<Item = Result<web::Bytes, actix_web::Error>> + Unpin>> =
            Box::pin(stream::iter(vec![Err(actix_web::Error::from(
                std::io::Error::new(std::io::ErrorKind::Other, "boom"),
            ))]));
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let res = rt.block_on(async {
            let mut reader = BodyReader {
                stream: Box::new(Box::pin(s)),
                current: web::Bytes::new(),
                consumed: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            };
            let mut buf = [0u8; 16];
            reader.read(&mut buf).await
        });
        let err = res.expect_err("payload error must become an io error");
        assert_eq!(err.kind(), std::io::ErrorKind::ConnectionAborted);
    }
}
