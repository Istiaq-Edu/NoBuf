//! Stream-direct upload endpoint for external file drops.
//!
//! WebView2 hands the webview a browser File handle with NO filesystem path, which
//! is why dropped files were previously staged (fully copied) to %TEMP% before
//! cmd_upload_file could read them. The actix server on localhost:14200 lets the
//! webview POST the raw bytes instead — this handler pumps them straight into
//! grammers' upload_stream with no temp file and no preparing phase.

use std::sync::Arc;
use std::time::Instant;

use actix_web::{post, web, HttpRequest, HttpResponse, Responder};
use futures::StreamExt;
use tauri::Emitter;

use crate::bandwidth::BandwidthManager;
use crate::commands::TelegramState;
use crate::server::StreamTokenData;

const MAX_DROP_BYTES: u64 = 4_294_967_295; // Telegram hard ceiling (u32 part math)

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

fn query_param(req: &HttpRequest, key: &str) -> Option<String> {
    use actix_web::web::Query;
    let q = Query::<std::collections::HashMap<String, String>>::from_query(req.query_string()).ok()?;
    q.get(key).cloned()
}

#[post("/upload-drop")]
async fn upload_drop(
    req: HttpRequest,
    mut payload: web::Payload,
    tg_state: web::Data<Arc<TelegramState>>,
    token_data: web::Data<StreamTokenData>,
    app_handle: web::Data<tauri::AppHandle>,
    bw_state: web::Data<Arc<BandwidthManager>>,
) -> impl Responder {
    // --- Auth: session token required (loopback is shared with every local
    //     process/browser tab; CORS cannot stop them SENDING, only reading) ------
    match query_param(&req, "token") {
        Some(t) if t == token_data.token => {}
        _ => return HttpResponse::Unauthorized().body("invalid or missing token"),
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
    if bw_state.can_transfer(size).is_err() {
        return HttpResponse::BadRequest().body("Daily bandwidth limit exceeded");
    }

    // --- Client -----------------------------------------------------------------
    let client_opt = { tg_state.client.lock().await.clone() };
    let Some(client) = client_opt else {
        return HttpResponse::ServiceUnavailable().body("Not connected to Telegram");
    };

    // --- Progress reporter (250ms cadence, mirrors cmd_upload_file) -------------
    let start = Instant::now();
    let consumed = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let progress_task = if !tid.is_empty() {
        let counter = consumed.clone();
        let handle = app_handle.get_ref().clone();
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
        let _ = app_handle.emit("upload-progress", DropProgressPayload {
            id: tid.clone(), percent: 0, uploaded_bytes: 0, total_bytes: size, speed_bytes_per_sec: 0,
        });
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

    // Post-upload cancellation check (mirrors cmd_upload_file)
    let was_cancelled = tg_state.cancelled_transfers.read().await.contains(&tid);
    if was_cancelled {
        tg_state.cancelled_transfers.write().await.remove(&tid);
    }

    match upload_res {
        Ok(_) if was_cancelled => HttpResponse::BadRequest().body("Transfer cancelled"),
        Ok(uploaded) => {
            bw_state.add_up(consumed.load(std::sync::atomic::Ordering::Relaxed));
            let peer = crate::commands::utils::resolve_peer(
                &client, folder_id, &tg_state.peer_cache,
            ).await;
            match peer {
                Ok(peer) => {
                    let msg = grammers_client::types::InputMessage::new().text("").document(uploaded);
                    match client.send_message(&peer, msg).await {
                        Ok(m) => HttpResponse::Ok().json(serde_json::json!({ "message_id": m.id() })),
                        Err(e) => HttpResponse::InternalServerError()
                            .body(format!("Upload succeeded but send failed: {e}")),
                    }
                }
                Err(e) => HttpResponse::InternalServerError()
                    .body(format!("Upload succeeded but resolve failed: {e}")),
            }
        }
        Err(e) => HttpResponse::InternalServerError().body(format!("Upload failed: {e}")),
    }
}
