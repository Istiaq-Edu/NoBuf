//! Fast drop-staging endpoint: streams a dropped File straight to
//! %TEMP%\nobuf_dropped\<id>-<name> as raw binary — no base64 inflation, no
//! per-chunk IPC. The webview POSTs the File object as the request body.
//!
//! Auth mirrors /upload-drop: session token in the query string. Returns the
//! staged absolute path as JSON on completion. Progress rides the SAME
//! `upload-progress` event channel regular uploads use, so existing UI
//! (staging progress rows) works unchanged.

use std::sync::Arc;
use std::io::Write;
use actix_web::{web, HttpRequest, HttpResponse, Responder};
use futures::StreamExt;
use tauri::Emitter;

use crate::commands::upload_drop::{query_param, upload_deps};

/// Registered method-agnostically (web::to) so HEAD probes return 405 not 404.
pub(crate) async fn stage_drop_handler(
    req: HttpRequest,
    payload: web::Payload,
    token_data: web::Data<crate::server::StreamTokenData>,
) -> impl Responder {
    if req.method() != actix_web::http::Method::POST {
        return HttpResponse::MethodNotAllowed().body("use POST");
    }
    match query_param(&req, "token") {
        Some(t) if t == token_data.token => {}
        _ => {
            log::warn!("[stage-drop] rejected unauthenticated attempt");
            return HttpResponse::Unauthorized().body("invalid or missing token");
        }
    }

    let name = match query_param(&req, "name") {
        Some(n) if !n.trim().is_empty() => n,
        _ => return HttpResponse::BadRequest().body("missing or empty 'name'"),
    };
    let size: u64 = match query_param(&req, "size").and_then(|s| s.parse().ok()) {
        Some(s) if s > 0 => s,
        _ => return HttpResponse::BadRequest().body("missing or invalid 'size'"),
    };
    // Cap at Telegram's hard ceiling (shared with /upload-drop). Without this
    // any token-holder can stream unboundedly and fill %TEMP% to ENOSPC.
    if size > crate::commands::upload_drop::MAX_DROP_BYTES {
        return HttpResponse::BadRequest().body("file exceeds maximum supported size");
    }
    let id = query_param(&req, "id")
        .map(|i| {
            let safe: String = i.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
            if safe.is_empty() { "drop".to_string() } else { safe }
        })
        .unwrap_or_else(|| "drop".to_string());
    let tid = query_param(&req, "tid").unwrap_or_default();

    // Same naming rules as cmd_stage_dropped_file (single source of truth).
    let safe_name = crate::commands::fs::sanitize_staged_name(&name);

    let dir = std::env::temp_dir().join("nobuf_dropped");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        log::error!("[stage-drop] mkdir {} failed: {e}", dir.display());
        return HttpResponse::InternalServerError().body(format!("mkdir failed: {e}"));
    }
    let path = dir.join(format!("{}-{}", id, safe_name));

    let app_handle = upload_deps().app_handle;

    let mut file = match std::fs::File::create(&path) {
        Ok(f) => f,
        Err(e) => {
            log::error!("[stage-drop] create {} failed: {e}", path.display());
            return HttpResponse::InternalServerError().body(format!("create failed: {e}"));
        }
    };

    // Stream body → file. Progress events every 250ms while data flows
    // (same channel/cadence as uploads so the TransferPanel just works).
    let consumed = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let mut stream = Box::pin(payload.map(|r| r.map_err(actix_web::Error::from)));
    let mut last_emit = std::time::Instant::now();

    while let Some(item) = stream.next().await {
        match item {
            Ok(bytes) => {
                if file.write_all(&bytes).is_err() {
                    let _ = std::fs::remove_file(&path);
                    log::error!("[stage-drop] disk write failed for {}", path.display());
                    return HttpResponse::InternalServerError().body("disk write failed");
                }
                let n = consumed.fetch_add(bytes.len() as u64, std::sync::atomic::Ordering::Relaxed)
                    + bytes.len() as u64;
                if !tid.is_empty()
                    && last_emit.elapsed() >= std::time::Duration::from_millis(250)
                {
                    last_emit = std::time::Instant::now();
                    if let Some(h) = &app_handle {
                        let pct = ((n * 100) / size).min(100) as u8;
                        let _ = h.emit(
                            "upload-progress",
                            serde_json::json!({
                                "id": tid,
                                "percent": pct,
                                "uploadedBytes": n,
                                "totalBytes": size,
                                "speedBytesPerSec": 0,
                            }),
                        );
                    }
                }
            }
            Err(e) => {
                let _ = std::fs::remove_file(&path);
                log::warn!("[stage-drop] body read failed mid-stream: {e}");
                return HttpResponse::BadRequest().body("body read failed");
            }
        }
    }

    let written = consumed.load(std::sync::atomic::Ordering::Relaxed);
    if written != size {
        let _ = std::fs::remove_file(&path);
        return HttpResponse::BadRequest().body(format!(
            "size mismatch: declared {size}, got {written}"
        ));
    }

    log::info!("[stage-drop] staged '{name}' ({written}B) -> {}", path.display());
    HttpResponse::Ok().json(serde_json::json!({ "path": path.to_string_lossy() }))
}
