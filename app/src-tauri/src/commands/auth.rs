use tauri::State;
use tauri::Manager;
use grammers_client::Client;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use grammers_mtsender::SenderPool;
use grammers_session::storages::SqliteSession;
use tokio::sync::oneshot;
use tokio::time::Duration;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use grammers_tl_types as tl;

use crate::TelegramState;
use crate::models::{AuthResult};
use crate::commands::utils::map_error;
use crate::download_pool::DownloadPool;
use grammers_client::SignInError;

/// Ensures the Telegram client is initialized.
/// 
/// IMPORTANT: This function properly manages runner lifecycle to prevent stack overflow.
/// Before spawning a new runner, it signals the old runner to shutdown.
pub async fn ensure_client_initialized(
    app_handle: &tauri::AppHandle,
    state: &State<'_, TelegramState>,
    api_id: i32,
) -> Result<Client, String> {
    let mut client_guard = state.client.lock().await;

    if let Some(client) = client_guard.as_ref() {
        return Ok(client.clone());
    }

    // CRITICAL: Shutdown existing runner before creating a new one
    // This prevents runner task accumulation which causes stack overflow
    let did_shutdown_old_runner = {
        let mut guard = state.runner_shutdown.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(shutdown_tx) = guard.take() {
            log::info!("Signaling old runner to shutdown...");
            let _ = shutdown_tx.send(());
            true
        } else {
            false
        }
    }; // MutexGuard dropped here — before the await
    if did_shutdown_old_runner {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    let runner_num = state.runner_count.fetch_add(1, Ordering::SeqCst) + 1;
    log::info!("Initializing Telegram Client #{}", runner_num);
    
    // Resolve session path safely
    let app_data_dir = app_handle.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
        
    if !app_data_dir.exists() {
        std::fs::create_dir_all(&app_data_dir)
            .map_err(|e| format!("Failed to create app data dir: {}", e))?;
    }
    
    let session_path = app_data_dir.join("telegram.session");
    let session_path_str = session_path.to_string_lossy().to_string();
    log::info!("Opening session in app data directory");
    
    // Security: Restrict session file permissions to current user only (Unix)
    #[cfg(unix)]
    {
        // The session file may not exist yet — SqliteSession::open creates it.
        // We set permissions after opening to ensure the file exists.
    }
    
    // Grammers initialization with corruption recovery
    let session = match SqliteSession::open(&session_path_str).map_err(|e| e.to_string()) {
        Ok(s) => s,
        Err(_) => {
            log::warn!("Session file corrupted or invalid. Recreating...");
            let _ = std::fs::remove_file(&session_path);
            let _ = std::fs::remove_file(format!("{}-wal", session_path_str));
            let _ = std::fs::remove_file(format!("{}-shm", session_path_str));
            
            SqliteSession::open(&session_path_str)
                .map_err(|e| format!("Failed to open session after recreation: {}", e))?
        }
    };
    
    // Security: Restrict session file permissions to current user only (Unix)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&session_path, std::fs::Permissions::from_mode(0o600));
        let _ = std::fs::set_permissions(format!("{}-wal", session_path_str), std::fs::Permissions::from_mode(0o600));
        let _ = std::fs::set_permissions(format!("{}-shm", session_path_str), std::fs::Permissions::from_mode(0o600));
    }
    
    let session = Arc::new(session);
    let pool = SenderPool::new(session, api_id);
    let client = Client::new(&pool);
    
    // Create shutdown channel for this runner
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    *state.runner_shutdown.lock().unwrap_or_else(|e| e.into_inner()) = Some(shutdown_tx);
    
    // Spawn the network runner with shutdown support
    let SenderPool { runner, .. } = pool;
    tauri::async_runtime::spawn(async move {
        tokio::select! {
            // Normal runner operation
            _ = runner.run() => {
                log::info!("Runner #{} exited normally", runner_num);
            }
            // Shutdown requested
            _ = shutdown_rx => {
                log::info!("Runner #{} shutdown requested, exiting", runner_num);
            }
        }
    });
    
    *client_guard = Some(client.clone());

    // Initialize the download pool for parallel file transfers.
    // Each worker creates its own TCP connection to the Telegram media DC,
    // following Telegram's official recommendation for parallel downloads.
    // We use separate session file copies (grammers requires separate sessions per pool).
    let session_path_str_for_pool = session_path_str.clone();
    let pool_api_id = api_id;
    let mut pool_guard = state.download_pool.lock().await;
    if pool_guard.is_none() {
        match DownloadPool::new(&session_path_str_for_pool, pool_api_id) {
            Ok(pool) => {
                log::info!("DownloadPool initialized with {} workers", 3);
                *pool_guard = Some(pool);
            }
            Err(e) => {
                log::warn!("Failed to initialize DownloadPool (will use single-connection fallback): {}", e);
                // Not critical - single-connection downloads still work
            }
        }
    }

    Ok(client)
}

#[tauri::command]
pub async fn cmd_connect(
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
    api_id: i32,
) -> Result<bool, String> {
    // Store API ID for auto-reconnect
    *state.api_id.lock().await = Some(api_id);
    ensure_client_initialized(&app_handle, &state, api_id).await?;
    Ok(true)
}

#[tauri::command]
pub async fn cmd_check_connection(
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
) -> Result<bool, String> {
    // 1. Check if client exists and is responsive
    let client_msg_opt = {
        let guard = state.client.lock().await;
        guard.as_ref().cloned()
    };

    if let Some(client) = client_msg_opt {
        // Ping (e.g., get_me)
        if client.get_me().await.is_ok() {
            return Ok(true);
        }
        log::warn!("Connection check failed (get_me). Attempting reconnect...");
    } else {
         log::warn!("Connection check: No client found. Checking for saved API ID...");
    }

    // 2. Reconnect Logic
    let api_id_opt = *state.api_id.lock().await;
    if let Some(api_id) = api_id_opt {
        // Force re-init: Clear old client first to ensure fresh pool
        *state.client.lock().await = None;
        
        match ensure_client_initialized(&app_handle, &state, api_id).await {
            Ok(c) => {
                // Double check
                if c.get_me().await.is_ok() {
                    log::info!("Auto-reconnect successful.");
                    return Ok(true);
                } else {
                    return Err("Reconnect succeeded but ping failed.".to_string());
                }
            },
            Err(e) => return Err(format!("Auto-reconnect failed: {}", e))
        }
    }

    Ok(false) // Not connected and no credentials to reconnect
}

#[tauri::command]
pub async fn cmd_logout(
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
) -> Result<bool, String> {
    log::info!("Logging out...");
    
    // 1. Shutdown the network runner FIRST to prevent any operations
    {
        let mut shutdown_guard = state.runner_shutdown.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(shutdown_tx) = shutdown_guard.take() {
            log::info!("Signaling runner shutdown for logout...");
            let _ = shutdown_tx.send(());
        }
    }
    
    // 2. Try to sign out from Telegram (if connected)
    let client_opt = { state.client.lock().await.clone() };
    if let Some(client) = client_opt {
        // We don't strictly care if this fails (e.g. network down), we just want to clear local state.
        let _ = client.sign_out().await; 
    }

    // 3. Clear State
        *state.client.lock().await = None;
        *state.login_token.lock().await = None;
        *state.password_token.lock().await = None;
        *state.api_id.lock().await = None;
        *state.qr_token.lock().await = None;
        *state.stored_api_hash.lock().await = None;
        state.stored_api_id.store(0, std::sync::atomic::Ordering::SeqCst);
        state.qr_finalized.store(false, std::sync::atomic::Ordering::SeqCst);
    state.last_qr_export_ts.store(0, std::sync::atomic::Ordering::SeqCst);
        crate::commands::utils::clear_peer_cache(&state.peer_cache).await;
    state.cancelled_transfers.write().await.clear();

    // 3b. Clean up DownloadPool worker session files
    {
        let mut pool_guard = state.download_pool.lock().await;
        if let Some(pool) = pool_guard.take() {
            let app_data_dir = app_handle.path().app_data_dir().unwrap();
            let main_session_path = app_data_dir.join("telegram.session").to_string_lossy().to_string();
            pool.cleanup_session_files(&main_session_path);
            log::info!("DownloadPool worker session files cleaned up");
        }
    }

    // 4. Remove Session File
    let app_data_dir = app_handle.path().app_data_dir().unwrap();
    let session_path = app_data_dir.join("telegram.session");
    let _ = std::fs::remove_file(session_path);
    let _ = std::fs::remove_file(app_data_dir.join("telegram.session-wal"));
    let _ = std::fs::remove_file(app_data_dir.join("telegram.session-shm"));

    log::info!("Logout complete. Runner count: {}", state.runner_count.load(Ordering::SeqCst));
    Ok(true)
}

#[tauri::command]
pub async fn cmd_auth_request_code(
    app_handle: tauri::AppHandle,
    phone: String,
    api_id: i32,
    api_hash: String,
    state: State<'_, TelegramState>,
) -> Result<String, String> {
    
    if api_hash.trim().is_empty() {
        return Err("API Hash cannot be empty.".to_string());
    }

    // Store API ID
    *state.api_id.lock().await = Some(api_id);

    let client_handle = ensure_client_initialized(&app_handle, &state, api_id).await?;
    
    log::info!("Requesting login code");
    
    let mut last_error = String::new();
    
    // Retry up to 2 times for AUTH_RESTART or 500
    for i in 1..=2 {
        match client_handle.request_login_code(&phone, &api_hash).await {
            Ok(token) => {
                let mut token_guard = state.login_token.lock().await;
                *token_guard = Some(token);
                return Ok("code_sent".to_string());
            },
            Err(e) => {
                let err_msg = e.to_string();
                log::warn!("Error requesting code (Attempt {}): {}", i, err_msg);
                
                if err_msg.contains("AUTH_RESTART") || err_msg.contains("500") {
                    log::info!("AUTH_RESTART error detected. Retrying...");
                    last_error = err_msg;
                    // Prepare for retry
                    continue;
                }
                
                // Other errors, fail immediately
                return Err(map_error(e));
            }
        }
    }

    Err(format!("Telegram Error after retry: {}", last_error))
}

#[tauri::command]
pub async fn cmd_auth_sign_in(
    code: String,
    state: State<'_, TelegramState>,
) -> Result<AuthResult, String> {
    log::info!("Signing in with code...");
    
    let client = {
        let guard = state.client.lock().await;
        guard.as_ref().ok_or("Client not initialized")?.clone()
    };

    let token_guard = state.login_token.lock().await;
    let login_token = token_guard.as_ref().ok_or("No login session found (restart flow)")?;

    match client.sign_in(login_token, &code).await {
        Ok(_user) => {
             log::info!("Successfully logged in.");
             Ok(AuthResult {
                success: true,
                next_step: Some("dashboard".to_string()),
                error: None,
            })
        }
        Err(SignInError::PasswordRequired(token)) => {
            let mut pw_guard = state.password_token.lock().await;
            *pw_guard = Some(token);

            Ok(AuthResult {
                success: false,
                next_step: Some("password".to_string()),
                error: None,
            })
        }
        Err(e) => {
           log::error!("Sign in error: {}", e);
           Err(format!("Sign in failed: {}", e))
        }
    }
}

#[tauri::command]
pub async fn cmd_auth_check_password(
    password: String,
    state: State<'_, TelegramState>,
) -> Result<AuthResult, String> {
    let client = {
        let guard = state.client.lock().await;
        guard.as_ref().ok_or("Client not initialized")?.clone()
    };
    
    let mut pw_guard = state.password_token.lock().await;
    let pw_token = pw_guard.take().ok_or("No password session found")?;

    match client.check_password(pw_token, password.as_str()).await {
        Ok(_user) => {
             log::info!("2FA Success.");
             Ok(AuthResult {
                success: true,
                next_step: Some("dashboard".to_string()),
                error: None,
            })
        }
        Err(e) => Err(format!("2FA Failed: {}", e))
    }
}

/// Encodes a raw login token into the `tg://login?token=...` URL that the
/// frontend renders as a QR code. Shared by cmd_auth_qr_login and
/// cmd_auth_qr_current so both produce identical URLs for the same token.
fn qr_login_url(token: &[u8]) -> String {
    format!("tg://login?token={}", URL_SAFE_NO_PAD.encode(token))
}

/// QR Login -- Step 1: Export a login token and return the `tg://login?token=...` URL.
/// The frontend renders this as a QR code for the user to scan with their phone.
#[tauri::command]
pub async fn cmd_auth_qr_login(
    app_handle: tauri::AppHandle,
    api_id: i32,
    api_hash: String,
    state: State<'_, TelegramState>,
) -> Result<String, String> {
    if api_hash.trim().is_empty() {
        return Err("API Hash cannot be empty.".to_string());
    }

    // Store API ID
    *state.api_id.lock().await = Some(api_id);

    let client = ensure_client_initialized(&app_handle, &state, api_id).await?;

    // Store API credentials for QR poll finalization
        *state.stored_api_hash.lock().await = Some(api_hash.clone());
        state.stored_api_id.store(api_id, std::sync::atomic::Ordering::SeqCst);
        state.qr_finalized.store(false, std::sync::atomic::Ordering::SeqCst);
    state.last_qr_export_ts.store(0, std::sync::atomic::Ordering::SeqCst);

        // Clear any previous QR token
        *state.qr_token.lock().await = None;

    log::info!("Requesting QR login token...");

    let result = client.invoke(&tl::functions::auth::ExportLoginToken {
        api_id,
        api_hash: api_hash.clone(),
        except_ids: vec![],
    }).await.map_err(|e| format!("ExportLoginToken failed: {}", e))?;

    match result {
        tl::enums::auth::LoginToken::Token(t) => {
            log::info!("QR login URL generated, expires at {}", t.expires);
            // Store the token so cmd_auth_qr_poll can call importLoginToken with it
            *state.qr_token.lock().await = Some(t.token.clone());
            Ok(qr_login_url(&t.token))
        }
        tl::enums::auth::LoginToken::Success(_s) => {
            // Already authorized (e.g. from a previous session)
            log::info!("QR login: already authorized");
            Ok("__authorized__".to_string())
        }
        tl::enums::auth::LoginToken::MigrateTo(m) => {
            log::info!("QR login: need to migrate to DC {}", m.dc_id);
            // MigrateTo means: reconnect to DC m.dc_id and call auth.importLoginToken
            // with m.token to get the REAL login token for the QR code.
            // The migration token itself is NOT a valid QR code token.
            let import_result = client.invoke_in_dc(
                m.dc_id,
                &tl::functions::auth::ImportLoginToken {
                    token: m.token.clone(),
                },
            ).await;

            match import_result {
                Ok(tl::enums::auth::LoginToken::Token(t)) => {
                    log::info!("QR login URL generated after DC migration, expires at {}", t.expires);
                    *state.qr_token.lock().await = Some(t.token.clone());
                    Ok(qr_login_url(&t.token))
                }
                Ok(tl::enums::auth::LoginToken::Success(_s)) => {
                    log::info!("QR login: already authorized after DC migration");
                    Ok("__authorized__".to_string())
                }
                Ok(tl::enums::auth::LoginToken::MigrateTo(_m2)) => {
                    // Shouldn't happen, but handle gracefully
                    log::error!("QR login: double migration requested, not supported");
                    Err("QR login failed: unexpected double DC migration".to_string())
                }
                Err(e) => {
                    log::error!("QR login: importLoginToken after migration failed: {}", e);
                    Err(format!("QR login DC migration failed: {}", e))
                }
            }
        }
    }
}

/// QR Login -- Step 2: Poll for scan completion.
///
/// Per the official QR login docs (core.telegram.org/api/qr-login):
/// After the phone app calls auth.acceptLoginToken, the desktop client
/// receives an updateLoginToken update, which should trigger a second
/// call to auth.exportLoginToken. This second call returns
/// loginTokenSuccess if the user accepted.
///
/// Strategy: Use is_authorized() as the trigger. When it returns true,
/// call exportLoginToken ONCE (guarded by qr_finalized flag) to complete
/// the handshake. This avoids the flood-wait from calling exportLoginToken
/// on every poll while still finalizing the login.
#[tauri::command]
pub async fn cmd_auth_qr_poll(
    state: State<'_, TelegramState>,
) -> Result<AuthResult, String> {
    let client = {
        let guard = state.client.lock().await;
        guard.as_ref().ok_or("Client not initialized")?.clone()
    };

    // Check if already finalized
    if state.qr_finalized.load(std::sync::atomic::Ordering::SeqCst) {
        return Ok(AuthResult {
            success: true,
            next_step: Some("dashboard".to_string()),
            error: None,
        });
    }

    // Check if session is authorized (phone accepted the QR)
    match client.is_authorized().await {
        Ok(true) => {
            // Phone accepted! Now finalize by calling exportLoginToken once.
            // Guard with qr_finalized to ensure we only call it once.
            if state.qr_finalized.compare_exchange(
                false, true,
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
            ).is_ok() {
                log::info!("QR login: is_authorized=true, finalizing with exportLoginToken");

                let api_id = state.stored_api_id.load(std::sync::atomic::Ordering::SeqCst);
                let api_hash = state.stored_api_hash.lock().await.clone().unwrap_or_default();

                let result = client.invoke(&tl::functions::auth::ExportLoginToken {
                    api_id,
                    api_hash,
                    except_ids: vec![],
                }).await;

                match result {
                    Ok(tl::enums::auth::LoginToken::Success(_)) => {
                        log::info!("QR login: finalized successfully!");
                        *state.qr_token.lock().await = None;
                        return Ok(AuthResult {
                            success: true,
                            next_step: Some("dashboard".to_string()),
                            error: None,
                        });
                    }
                    Ok(tl::enums::auth::LoginToken::MigrateTo(m)) => {
                        log::info!("QR login: DC migration to DC {} during finalization", m.dc_id);
                        match client.invoke_in_dc(
                            m.dc_id,
                            &tl::functions::auth::ImportLoginToken {
                                token: m.token.clone(),
                            },
                        ).await {
                            Ok(tl::enums::auth::LoginToken::Success(_)) => {
                                log::info!("QR login: finalized after DC migration!");
                                *state.qr_token.lock().await = None;
                                return Ok(AuthResult {
                                    success: true,
                                    next_step: Some("dashboard".to_string()),
                                    error: None,
                                });
                            }
                            Ok(_) => {
                                // Still waiting after migration
                                state.qr_finalized.store(false, std::sync::atomic::Ordering::SeqCst);
    state.last_qr_export_ts.store(0, std::sync::atomic::Ordering::SeqCst);
                                return Ok(AuthResult {
                                    success: false,
                                    next_step: Some("waiting".to_string()),
                                    error: None,
                                });
                            }
                            Err(e) => {
                                let err_msg = e.to_string();
                                if err_msg.contains("SESSION_PASSWORD_NEEDED") {
                                    return handle_2fa(&client, &state).await;
                                }
                                log::warn!("QR finalization migration error: {}", e);
                                state.qr_finalized.store(false, std::sync::atomic::Ordering::SeqCst);
    state.last_qr_export_ts.store(0, std::sync::atomic::Ordering::SeqCst);
                                return Ok(AuthResult {
                                    success: false,
                                    next_step: Some("waiting".to_string()),
                                    error: None,
                                });
                            }
                        }
                    }
                    Ok(tl::enums::auth::LoginToken::Token(_)) => {
                        // Got a token instead of success — phone hasn't fully accepted yet
                        // Reset qr_finalized so we can try again on next poll
                        state.qr_finalized.store(false, std::sync::atomic::Ordering::SeqCst);
    state.last_qr_export_ts.store(0, std::sync::atomic::Ordering::SeqCst);
                        return Ok(AuthResult {
                            success: false,
                            next_step: Some("waiting".to_string()),
                            error: None,
                        });
                    }
                    Err(e) => {
                        let err_msg = e.to_string();
                        if err_msg.contains("SESSION_PASSWORD_NEEDED") {
                            return handle_2fa(&client, &state).await;
                        }
                        // Reset and keep waiting
                        state.qr_finalized.store(false, std::sync::atomic::Ordering::SeqCst);
    state.last_qr_export_ts.store(0, std::sync::atomic::Ordering::SeqCst);
                        log::warn!("QR finalization error (will retry): {}", e);
                        return Ok(AuthResult {
                            success: false,
                            next_step: Some("waiting".to_string()),
                            error: None,
                        });
                    }
                }
            } else {
                // Another poll already finalizing
                return Ok(AuthResult {
                    success: false,
                    next_step: Some("waiting".to_string()),
                    error: None,
                });
            }
        }
        Ok(false) => {
                    // Not yet authorized. Periodically probe with exportLoginToken
                    // (every ~15 seconds) to detect: phone accepted (Success),
                    // 2FA needed (SESSION_PASSWORD_NEEDED error), or still waiting (Token).
                    // Throttle to avoid flood waits.
                    let now = chrono::Utc::now().timestamp_millis();
                    let last = state.last_qr_export_ts.load(std::sync::atomic::Ordering::SeqCst);
                    if now - last < 15000 {
                        // Too soon since last probe — just wait
                        return Ok(AuthResult {
                            success: false,
                            next_step: Some("waiting".to_string()),
                            error: None,
                        });
                    }
                    state.last_qr_export_ts.store(now, std::sync::atomic::Ordering::SeqCst);

                    let api_id = state.stored_api_id.load(std::sync::atomic::Ordering::SeqCst);
                    let api_hash = state.stored_api_hash.lock().await.clone().unwrap_or_default();

                    log::info!("QR poll: probing with exportLoginToken (is_authorized=false)");
                    let result = client.invoke(&tl::functions::auth::ExportLoginToken {
                        api_id,
                        api_hash,
                        except_ids: vec![],
                    }).await;

                    match result {
                        Ok(tl::enums::auth::LoginToken::Success(_)) => {
                            log::info!("QR login: finalized via probe!");
                            state.qr_finalized.store(true, std::sync::atomic::Ordering::SeqCst);
                            *state.qr_token.lock().await = None;
                            return Ok(AuthResult {
                                success: true,
                                next_step: Some("dashboard".to_string()),
                                error: None,
                            });
                        }
                        Ok(tl::enums::auth::LoginToken::Token(t)) => {
                            // Same or refreshed token — still waiting
                            let rotated = {
                                let mut qr_guard = state.qr_token.lock().await;
                                let same = qr_guard.as_ref() == Some(&t.token);
                                *qr_guard = Some(t.token.clone());
                                !same
                            };
                            log::info!("QR poll probe: token received (rotated={}, len={})", rotated, t.token.len());
                            return Ok(AuthResult {
                                success: false,
                                next_step: Some("waiting".to_string()),
                                error: None,
                            });
                        }
                        Ok(tl::enums::auth::LoginToken::MigrateTo(m)) => {
                            log::info!("QR poll: DC migration to DC {}", m.dc_id);
                            match client.invoke_in_dc(
                                m.dc_id,
                                &tl::functions::auth::ImportLoginToken { token: m.token.clone() },
                            ).await {
                                Ok(tl::enums::auth::LoginToken::Success(_)) => {
                                    log::info!("QR login: finalized after DC migration!");
                                    state.qr_finalized.store(true, std::sync::atomic::Ordering::SeqCst);
                                    *state.qr_token.lock().await = None;
                                    return Ok(AuthResult {
                                        success: true,
                                        next_step: Some("dashboard".to_string()),
                                        error: None,
                                    });
                                }
                                Ok(_) => {
                                    return Ok(AuthResult {
                                        success: false,
                                        next_step: Some("waiting".to_string()),
                                        error: None,
                                    });
                                }
                                Err(e) => {
                                    let err_msg = e.to_string();
                                    if err_msg.contains("SESSION_PASSWORD_NEEDED") {
                                        return handle_2fa(&client, &state).await;
                                    }
                                    log::warn!("QR poll migration error: {}", e);
                                    return Ok(AuthResult {
                                        success: false,
                                        next_step: Some("waiting".to_string()),
                                        error: None,
                                    });
                                }
                            }
                        }
                        Err(e) => {
                            let err_msg = e.to_string();
                            if err_msg.contains("SESSION_PASSWORD_NEEDED") {
                                return handle_2fa(&client, &state).await;
                            }
                            if err_msg.contains("TOKEN_EXPIRED") || err_msg.contains("token expired") {
                                log::warn!("QR login: token expired");
                                *state.qr_token.lock().await = None;
                                return Ok(AuthResult {
                                    success: false,
                                    next_step: Some("expired".to_string()),
                                    error: Some("QR code expired. Please refresh.".to_string()),
                                });
                            }
                            if err_msg.contains("FLOOD_WAIT_") {
                                log::warn!("QR login: flood wait: {}", err_msg);
                                return Ok(AuthResult {
                                    success: false,
                                    next_step: Some("waiting".to_string()),
                                    error: Some(err_msg),
                                });
                            }
                            log::warn!("QR poll probe error (waiting): {}", e);
                            return Ok(AuthResult {
                                success: false,
                                next_step: Some("waiting".to_string()),
                                error: None,
                            });
                        }
                    }
                }
        Err(e) => {
            let err_msg = e.to_string();
            if err_msg.contains("SESSION_PASSWORD_NEEDED") {
                return handle_2fa(&client, &state).await;
            }
            if err_msg.contains("TOKEN_EXPIRED") || err_msg.contains("token expired") {
                log::warn!("QR login: token expired");
                *state.qr_token.lock().await = None;
                return Ok(AuthResult {
                    success: false,
                    next_step: Some("expired".to_string()),
                    error: Some("QR code expired. Please refresh.".to_string()),
                });
            }
            if err_msg.contains("FLOOD_WAIT_") {
                log::warn!("QR login: flood wait: {}", err_msg);
                return Ok(AuthResult {
                    success: false,
                    next_step: Some("waiting".to_string()),
                    error: Some(err_msg),
                });
            }
            log::warn!("QR poll: is_authorized error (waiting): {}", e);
            return Ok(AuthResult {
                success: false,
                next_step: Some("waiting".to_string()),
                error: None,
            });
        }
    }
}

/// QR Login -- Step 3: Return the CURRENT login-token URL without exporting
/// a new one.
///
/// The QR token Telegram issues expires in ~30 seconds, and per the qr-login
/// spec (core.telegram.org/api/qr-login) the polling client must re-call
/// exportLoginToken and re-render a fresh QR automatically. cmd_auth_qr_poll
/// performs exactly that rotation while waiting (it stores every refreshed
/// token in state.qr_token), but the rotated URL never reached the UI: the
/// displayed QR kept showing the ORIGINAL token, so scanning it long after
/// expiry could never complete and the panel stayed on "Waiting for scan..."
/// forever. This command exposes the current token so the poll handler can
/// keep the rendered QR in sync with what the backend is actually probing.
#[tauri::command]
pub async fn cmd_auth_qr_current(
    state: State<'_, TelegramState>,
) -> Result<Option<String>, String> {
    let guard = state.qr_token.lock().await;
    Ok(guard.as_ref().map(|t| qr_login_url(t)))
}

/// Handle 2FA password requirement after QR scan
async fn handle_2fa(
    client: &Client,
    state: &State<'_, TelegramState>,
) -> Result<AuthResult, String> {
    log::info!("QR login: 2FA password required");
    let password: tl::types::account::Password = match client.invoke(&tl::functions::account::GetPassword {}).await {
        Ok(p) => p.into(),
        Err(pe) => return Err(format!("2FA required but failed to get password info: {}", pe)),
    };
    *state.password_token.lock().await = Some(grammers_client::types::PasswordToken::new(password));
    Ok(AuthResult {
        success: false,
        next_step: Some("password".to_string()),
        error: None,
    })
}

/// Opens my.telegram.org/apps in a Tauri webview window.
/// Periodically injects JS to check for api_id + api_hash on the page.
/// When found, sends them to the frontend via the `telegram-credentials` event.
///
/// Uses periodic polling (every 2s) instead of relying on page load events,
/// because the login flow uses AJAX (phone → code → redirect) and the
/// credentials may appear after dynamic content loads.
#[tauri::command]
pub async fn cmd_open_telegram_auth(
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    use tauri::webview::WebviewWindowBuilder;
    use tauri::webview::PageLoadEvent;
    use tauri::Emitter;
    use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};

    let url = url::Url::parse("https://my.telegram.org/auth?to=apps")
        .map_err(|e| format!("Invalid URL: {}", e))?;

    // Check if window already exists
    if app_handle.get_webview_window("telegram_auth").is_some() {
        if let Some(win) = app_handle.get_webview_window("telegram_auth") {
            let _ = win.set_focus();
        }
        return Ok(());
    }

    // Aggressive extraction JS with debug logging.
    // Returns a JSON object with either credentials or diagnostic info
    // so we can see exactly what's on the page and why extraction fails.
    let extract_js = r#"
        (function() {
            try {
                var pageText = document.body ? document.body.innerText : '';
                var url = window.location.href;
                var path = window.location.pathname;

                // Strategy 1: Regex on page text
                var idMatch = pageText.match(/api_id[^0-9]*([0-9]{5,})/i);
                var hashMatch = pageText.match(/api_hash[^a-f0-9]*([a-f0-9]{32})/i);

                // Strategy 2: Element-by-element scan
                if (!idMatch) {
                    var allEls = document.querySelectorAll('span, div, strong, code, .form-control, .uneditable-input, input[readonly]');
                    for (var i = 0; i < allEls.length; i++) {
                        var t = (allEls[i].textContent || allEls[i].value || '').trim();
                        if (/^[0-9]{5,}$/.test(t)) {
                            var parent = allEls[i].parentElement;
                            if (parent && /api_id/i.test(parent.textContent)) {
                                idMatch = [null, t];
                                break;
                            }
                        }
                    }
                }

                if (!hashMatch) {
                    var allEls2 = document.querySelectorAll('span, div, strong, code, .form-control, .uneditable-input, input[readonly]');
                    for (var j = 0; j < allEls2.length; j++) {
                        var t2 = (allEls2[j].textContent || allEls2[j].value || '').trim();
                        if (/^[a-f0-9]{32}$/i.test(t2)) {
                            var parent2 = allEls2[j].parentElement;
                            if (parent2 && /api_hash/i.test(parent2.textContent)) {
                                hashMatch = [null, t2];
                                break;
                            }
                        }
                    }
                }

                // Strategy 3: Broad regex
                if (!hashMatch) {
                    var broadHash = pageText.match(/([a-f0-9]{32})/i);
                    if (broadHash) hashMatch = broadHash;
                }
                if (!idMatch) {
                    var broadId = pageText.match(/(?:App|api)[^0-9]*([0-9]{5,8})/i);
                    if (broadId) idMatch = broadId;
                }

                // If credentials found, return them
                if (idMatch && hashMatch) {
                    return JSON.stringify({
                        status: 'found',
                        api_id: idMatch[1],
                        api_hash: hashMatch[1],
                        url: url
                    });
                }

                // Not found — return diagnostic info for debugging
                // Collect: URL, page text snippet, form info, link info
                var forms = document.querySelectorAll('form');
                var formInfo = [];
                for (var f = 0; f < forms.length; f++) {
                    var inputs = forms[f].querySelectorAll('input, textarea, select');
                    var inputNames = [];
                    for (var ii = 0; ii < inputs.length; ii++) {
                        inputNames.push(inputs[ii].name || inputs[ii].id || inputs[ii].type || 'unknown');
                    }
                    formInfo.push({
                        action: forms[f].action || '',
                        method: forms[f].method || '',
                        inputs: inputNames
                    });
                }

                var links = document.querySelectorAll('a, button');
                var linkTexts = [];
                for (var l = 0; l < links.length; l++) {
                    var lt = (links[l].textContent || '').trim().substring(0, 50);
                    if (lt) linkTexts.push(lt);
                }

                // Get first 500 chars of page text for debugging
                var textSnippet = pageText.substring(0, 500).replace(/\n/g, ' ').replace(/\s+/g, ' ');

                // Check for "API development tools" link
                var hasApiToolsLink = false;
                for (var lk = 0; lk < links.length; lk++) {
                    if ((links[lk].textContent || '').indexOf('API development tools') !== -1) {
                        hasApiToolsLink = true;
                        break;
                    }
                }

                // Auto-click "API development tools" if on /apps page
                if (hasApiToolsLink && (path === '/apps' || path.indexOf('/apps') !== -1)) {
                    for (var lk2 = 0; lk2 < links.length; lk2++) {
                        if ((links[lk2].textContent || '').indexOf('API development tools') !== -1) {
                            links[lk2].click();
                            return JSON.stringify({ status: 'clicked_api_tools', url: url });
                        }
                    }
                }

                // Auto-fill create form if found
                var form = document.querySelector('form');
                if (form) {
                    var titleInput = form.querySelector('input[name*="title"], input#app_title');
                    var shortNameInput = form.querySelector('input[name*="shortname"], input[name*="short_name"], input#app_shortname');
                    if (titleInput && shortNameInput) {
                        titleInput.value = 'NoBuf';
                        titleInput.dispatchEvent(new Event('input', {bubbles: true}));
                        shortNameInput.value = 'nobuf';
                        shortNameInput.dispatchEvent(new Event('input', {bubbles: true}));
                        var descInput = form.querySelector('textarea[name*="desc"], input[name*="desc"]');
                        if (descInput) {
                            descInput.value = 'NoBuf Telegram Cloud Drive';
                            descInput.dispatchEvent(new Event('input', {bubbles: true}));
                        }
                        var platformSelect = form.querySelector('select');
                        if (platformSelect) {
                            for (var p = 0; p < platformSelect.options.length; p++) {
                                var optText = platformSelect.options[p].text.toLowerCase();
                                if (optText.indexOf('other') !== -1 || optText.indexOf('desktop') !== -1) {
                                    platformSelect.selectedIndex = p;
                                    platformSelect.dispatchEvent(new Event('change', {bubbles: true}));
                                    break;
                                }
                            }
                        }
                        setTimeout(function() {
                            var submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
                            if (submitBtn) submitBtn.click();
                            else form.submit();
                        }, 500);
                        return JSON.stringify({ status: 'submitted_form', url: url });
                    }
                }

                return JSON.stringify({
                    status: 'not_found',
                    url: url,
                    path: path,
                    textSnippet: textSnippet,
                    forms: formInfo,
                    linkTexts: linkTexts.slice(0, 10),
                    hasApiToolsLink: hasApiToolsLink,
                    idFound: !!idMatch,
                    hashFound: !!hashMatch
                });
            } catch(e) {
                return JSON.stringify({ status: 'error', error: e.message });
            }
        })()
    "#;

    // Build the window with on_page_load handler that starts periodic polling
    let app_for_poll = app_handle.clone();
    let polling_active = Arc::new(AtomicBool::new(true));
    let polling_active_clone = polling_active.clone();

    let window = WebviewWindowBuilder::new(&app_handle, "telegram_auth", tauri::WebviewUrl::External(url))
        .title("Login to Telegram")
        .inner_size(500.0, 700.0)
        .min_inner_size(400.0, 500.0)
        .on_page_load(move |webview_window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let page_url = payload.url();
                let host = page_url.host_str().unwrap_or("");
                log::info!("[telegram-auth] Page loaded: {}", page_url);

                if host == "my.telegram.org" {
                    // Do a single immediate extraction attempt on page load
                    let app = app_for_poll.clone();
                    let js = extract_js;
                    let _ = webview_window.eval_with_callback(js, move |result: String| {
                                            log::info!("[telegram-auth] Page-load extraction result: {}", &result[..result.len().min(200)]);
                                            if result.is_empty() || result == "null" {
                                                return;
                                            }
                                            match serde_json::from_str::<serde_json::Value>(&result) {
                                                Ok(parsed) => {
                                                    // Unwrap double-encoding: Tauri's eval_with_callback
                                                    // wraps the JS return value in a JSON string. If JS
                                                    // returns JSON.stringify(...), the result is a
                                                    // double-encoded string that needs a second parse.
                                                    let parsed = if let Some(s) = parsed.as_str() {
                                                        serde_json::from_str::<serde_json::Value>(s).unwrap_or(parsed)
                                                    } else {
                                                        parsed
                                                    };
                                                    let status = parsed.get("status").and_then(|v| v.as_str()).unwrap_or("");
                                                    log::info!("[telegram-auth] Parsed OK, status='{}'", status);
                                                    if status == "found" {
                                                        let api_id = parsed.get("api_id").and_then(|v| v.as_str()).unwrap_or("");
                                                        let api_hash = parsed.get("api_hash").and_then(|v| v.as_str()).unwrap_or("");
                                                        if !api_id.is_empty() && !api_hash.is_empty() {
                                                            log::info!("[telegram-auth] Emitting credentials: api_id={}", api_id);
                                                            let _ = app.emit("telegram-credentials", serde_json::json!({
                                                                "api_id": api_id,
                                                                "api_hash": api_hash,
                                                            }));
                                                            if let Some(auth_win) = app.get_webview_window("telegram_auth") {
                                                                let _ = auth_win.close();
                                                            }
                                                        }
                                                    }
                                                }
                                                Err(e) => {
                                                    log::error!("[telegram-auth] JSON parse error: {}", e);
                                                }
                                            }
                                        });
                }
            }
        })
        .build()
        .map_err(|e| format!("Failed to create auth window: {}", e))?;

    // Start a periodic poll: every 2 seconds, inject the extraction JS.
    // This handles AJAX-based login flows where the page doesn't fully reload.
    // Stops after 5 minutes (150 polls) or when credentials are found.
    let app_for_timer = app_handle.clone();
    let js_for_timer = extract_js.to_string();

    tauri::async_runtime::spawn(async move {
        let mut poll_count = 0u32;
        let max_polls = 150u32; // 5 minutes at 2s intervals

        while polling_active_clone.load(AtomicOrdering::SeqCst) && poll_count < max_polls {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            poll_count += 1;

            // Check if window still exists
            let current_win = match app_for_timer.get_webview_window("telegram_auth") {
                Some(w) => w,
                None => {
                    log::info!("[telegram-auth] Window closed, stopping poll");
                    break;
                }
            };

            // Check current URL — only poll on my.telegram.org
            let current_url = match current_win.url() {
                Ok(u) => u,
                Err(_) => continue,
            };

            if current_url.host_str() != Some("my.telegram.org") {
                continue;
            }

            let app_inner = app_for_timer.clone();
            let js_inner = js_for_timer.clone();

            let _ = current_win.eval_with_callback(js_inner.as_str(), move |result: String| {
                            if poll_count % 5 == 0 {
                                log::info!("[telegram-auth] Poll #{} result: {}", poll_count, &result[..result.len().min(200)]);
                            }
                            if !result.is_empty() && result != "null" {
                                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&result) {
                                    // Unwrap double-encoding (same as page-load callback)
                                    let parsed = if let Some(s) = parsed.as_str() {
                                        serde_json::from_str::<serde_json::Value>(s).unwrap_or(parsed)
                                    } else {
                                        parsed
                                    };
                                    let status = parsed.get("status").and_then(|v| v.as_str()).unwrap_or("");
                                    if status == "found" {
                                        let api_id = parsed.get("api_id").and_then(|v| v.as_str()).unwrap_or("");
                                        let api_hash = parsed.get("api_hash").and_then(|v| v.as_str()).unwrap_or("");
                                        if !api_id.is_empty() && !api_hash.is_empty() {
                                            log::info!("[telegram-auth] Credentials found via poll #{}: api_id={}", poll_count, api_id);
                                            let _ = app_inner.emit("telegram-credentials", serde_json::json!({
                                                "api_id": api_id,
                                                "api_hash": api_hash,
                                            }));
                                            if let Some(auth_win) = app_inner.get_webview_window("telegram_auth") {
                                                let _ = auth_win.close();
                                            }
                                        }
                                    }
                                }
                            }
                        });
        }

        if poll_count >= max_polls {
            log::warn!("[telegram-auth] Polling timed out after 5 minutes");
            // Emit a timeout event so the frontend can reset its loading state
            let _ = app_for_timer.emit("telegram-credentials", serde_json::json!({
                "timeout": true
            }));
        }

        polling_active_clone.store(false, AtomicOrdering::SeqCst);
    });

    // When the window is closed, stop polling
    let app_for_close = app_handle.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Destroyed = event {
            polling_active.store(false, AtomicOrdering::SeqCst);
            // Emit a cancel event in case the user closed the window without logging in
            let _ = app_for_close.emit("telegram-credentials", serde_json::json!({
                "cancelled": true
            }));
        }
    });

    Ok(())
}

#[cfg(test)]
mod qr_login_url_tests {
    use super::*;

    /// Regression guard for the "stuck on Waiting for scan" bug: the QR token
    /// Telegram issues expires in ~30s and cmd_auth_qr_poll rotates it, but the
    /// rotated URL never reached the UI. cmd_auth_qr_current + the frontend poll
    /// handler now re-render the live token; this pins the shared encoder so the
    /// exported and re-served URLs stay byte-identical for the same token.
    #[test]
    fn encodes_token_as_url_safe_base64_without_padding() {
        // 0xFB 0xFF -> "+/" in standard base64, "-" "_" in URL_SAFE
        let url = qr_login_url(&[0x04, 0x08, 0x10, 0x20, 0xFB, 0xFF]);
        assert!(url.starts_with("tg://login?token="));
        let encoded = &url["tg://login?token=".len()..];
        assert_eq!(encoded, "BAgQIPv_"); // URL-safe alphabet, no '=' padding
        assert!(!encoded.contains('+'));
        assert!(!encoded.contains('/'));
        assert!(!encoded.contains('='));
    }

    #[test]
    fn matches_the_url_cmd_auth_qr_login_builds() {
        // The exact expression cmd_auth_qr_login used before the helper was
        // extracted; both paths must stay identical.
        let token: Vec<u8> = (0u8..=64).collect();
        let expected = format!("tg://login?token={}", URL_SAFE_NO_PAD.encode(&token));
        assert_eq!(qr_login_url(&token), expected);
    }

    #[test]
    fn empty_token_yields_empty_credentials_segment() {
        assert_eq!(qr_login_url(&[]), "tg://login?token=");
    }

    /// Structural guard binding cmd_auth_qr_poll to cmd_auth_qr_current: the
    /// waiting-probe MUST persist every refreshed token into state.qr_token,
    /// because cmd_auth_qr_current serves THAT stored token back to the UI.
    /// Deleting the store line compiles clean and passes every behavioral test
    /// (the poll loop needs a live Telegram client) while re-serving a stale
    /// QR forever — the original "stuck on Waiting for scan" bug. This
    /// source-level assert is the only gate that sees that seam.
    #[test]
    fn poll_probe_stores_rotated_token_for_cmd_auth_qr_current() {
        let src = include_str!("auth.rs");
        let start = src
            .find("// Same or refreshed token")
            .expect("probe Token arm comment missing from auth.rs");
        let body = &src[start..start + 400];
        // The probe persists each refreshed token through the qr_guard lock so
        // cmd_auth_qr_current can serve the live URL back to the UI. Deleting
        // the store compiles clean and passes every behavioral test while
        // re-serving a stale QR forever — this source-level assert is the
        // only gate that sees that seam.
        assert!(
            body.contains("*qr_guard = Some(t.token.clone());"),
            "poll probe no longer stores the rotated QR token; the UI would re-render a stale code forever"
        );
    }
}