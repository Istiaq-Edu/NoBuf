pub mod models;

pub mod commands;
pub mod stream_cache;
pub mod bandwidth;

use tauri::Manager;
use tauri::webview::WebviewWindowBuilder;
use tauri::WebviewUrl;
use url::Url;
use tokio::sync::Mutex;
use std::sync::Arc;
use std::collections::{HashMap, HashSet};
use commands::TelegramState;
use commands::streaming::StreamConfig;
use rand::Rng;

/// Port for the localhost plugin that serves frontend assets in production.
/// This makes the document origin http://localhost:LOCALHOST_PORT, which
/// passes WebView2's URL safety check for media loading from
/// http://localhost:14201 (the Actix streaming server).
/// Without this, WebView2 blocks <video> src URLs on localhost when
/// the page is served from a different origin (tauri://localhost).
const LOCALHOST_PORT: u16 = 9527;

/// Frontend URL: Vite dev server in debug builds, localhost plugin in release.
#[cfg(debug_assertions)]
const FRONTEND_URL: &str = "http://localhost:1420";

#[cfg(not(debug_assertions))]
const FRONTEND_URL: &str = "http://localhost:9527";

pub mod server;
pub mod api_routes;
pub mod hls;
pub mod download_pool;

/// Single source of truth for the Actix streaming server port.
/// Referenced in lib.rs (server startup) and exposed to the frontend
/// via cmd_get_stream_info so no component ever hardcodes the port.
pub const STREAM_PORT: u16 = 14201;

/// Generate a random 32-character hex token for streaming server auth
fn generate_stream_token() -> String {
    let mut rng = rand::thread_rng();
    let bytes: Vec<u8> = (0..16).map(|_| rng.gen()).collect();
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Holds the Actix-web server stop handle so we can shut it down
/// from the RunEvent::Exit handler for graceful Ctrl+C termination.
pub struct ActixServerHandle(pub Arc<std::sync::Mutex<Option<actix_web::dev::ServerHandle>>>);

/// Tracks whether the API server is currently running (for the frontend status dot)
pub struct ApiServerRunning(pub Arc<std::sync::atomic::AtomicBool>);

/// Holds the API server stop handle separately so we can restart it independently
pub struct ApiServerHandle(pub Arc<std::sync::Mutex<Option<actix_web::dev::ServerHandle>>>);

/// Restart (or stop) the API server based on current settings.
/// Called from Tauri commands when the user changes API settings.
pub fn restart_api_server(app: &tauri::AppHandle) {
    // Stop existing API server if running
    let api_handle_arc = app.state::<ApiServerHandle>().0.clone();
    let old_handle = api_handle_arc.lock().ok().and_then(|mut g| g.take());
    if let Some(handle) = old_handle {
        log::info!("Stopping existing API server...");
        drop(handle.stop(true));
        // Give it a moment to release the port
        std::thread::sleep(std::time::Duration::from_millis(200));
    }

    let settings = commands::api_settings::load_settings(app);
    let running_flag = app.state::<ApiServerRunning>().0.clone();

    if !settings.enabled {
        running_flag.store(false, std::sync::atomic::Ordering::Relaxed);
        log::info!("API server disabled");
        return;
    }

    // Need TelegramState to share with the API server
    let tg_state = Arc::new(app.state::<TelegramState>().inner().clone());
    let api_port = settings.port;
    let key_hash = settings.key_hash.clone();
    let handle_for_thread = api_handle_arc.clone();

    std::thread::spawn(move || {
        let sys = actix_rt::System::new();
        sys.block_on(async move {
            let api_state_data = actix_web::web::Data::new(tg_state);
            let api_state = actix_web::web::Data::new(api_routes::ApiState {
                key_hash,
            });

            log::info!("Starting REST API server on port {}", api_port);

            match actix_web::HttpServer::new(move || {
                let cors = actix_cors::Cors::default()
                    .allow_any_origin()
                    .allow_any_method()
                    .allow_any_header();

                actix_web::App::new()
                    .wrap(cors)
                    .app_data(api_state_data.clone())
                    .app_data(api_state.clone())
                    .configure(api_routes::configure_api)
            })
            .bind(("127.0.0.1", api_port)) {
                Ok(bound) => {
                    let server = bound.run();
                    *handle_for_thread.lock().unwrap() = Some(server.handle());
                    running_flag.store(true, std::sync::atomic::Ordering::Relaxed);
                    log::info!("REST API server started on http://127.0.0.1:{}", api_port);
                    server.await.ok();
                }
                Err(e) => {
                    running_flag.store(false, std::sync::atomic::Ordering::Relaxed);
                    log::error!("Failed to start API server on port {}: {}", api_port, e);
                }
            }
        });
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let stream_token = generate_stream_token();

    // Shared handle for stopping the Actix streaming server during shutdown
    let server_handle: Arc<std::sync::Mutex<Option<actix_web::dev::ServerHandle>>> =
        Arc::new(std::sync::Mutex::new(None));
    let server_handle_for_setup = server_handle.clone();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_localhost::Builder::new(LOCALHOST_PORT).build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(move |app| {
            // Create main window programmatically with localhost URL.
            // This is required for WebView2's URL safety check to allow
            // media loading from http://localhost:14201 (Actix streaming).
            // In dev: Vite dev server (http://localhost:1420).
            // In prod: localhost plugin (http://localhost:9527).
            let frontend_url = WebviewUrl::External(Url::parse(FRONTEND_URL).unwrap());
            WebviewWindowBuilder::new(app, "main", frontend_url)
                .title("NoBuf")
                .inner_size(1200.0, 800.0)
                .min_inner_size(1000.0, 700.0)
                .disable_drag_drop_handler()
                .build()?;

            app.manage(TelegramState {
                client: Arc::new(Mutex::new(None)),
                login_token: Arc::new(Mutex::new(None)),
                password_token: Arc::new(Mutex::new(None)),
                api_id: Arc::new(Mutex::new(None)),
                runner_shutdown: Arc::new(std::sync::Mutex::new(None)),
                runner_count: Arc::new(std::sync::atomic::AtomicU32::new(0)),
                peer_cache: Arc::new(tokio::sync::RwLock::new(HashMap::new())),
                cancelled_transfers: Arc::new(tokio::sync::RwLock::new(HashSet::new())),
                partial_downloads: Arc::new(tokio::sync::Mutex::new(Vec::new())),
                download_semaphore: Arc::new(tokio::sync::Semaphore::new(4)),
                prebuffer_speed_limit_kb: Arc::new(std::sync::atomic::AtomicU64::new(0)),
                download_speed_limit_kb: Arc::new(std::sync::atomic::AtomicU64::new(0)),
                download_pool: Arc::new(tokio::sync::Mutex::new(None)),
            });
            app.manage(bandwidth::BandwidthManager::new(app.handle()));
            app.manage(StreamConfig { token: stream_token.clone(), port: STREAM_PORT });
            app.manage(ActixServerHandle(server_handle_for_setup.clone()));
            app.manage(ApiServerHandle(Arc::new(std::sync::Mutex::new(None))));
            app.manage(ApiServerRunning(Arc::new(std::sync::atomic::AtomicBool::new(false))));

            // Initialize stream cache manager
            // Use app_data_dir instead of temp_dir: on Windows, %TEMP% is
            // subject to automatic cleanup by Storage Sense, Disk Cleanup,
            // and antivirus — which can delete .dat and .meta files mid-stream
            // causing catastrophic cached-range loss.
            let cache_dir = app.path().app_data_dir()
                .map_err(|e| format!("app_data_dir: {}", e))
                .unwrap_or_else(|_| std::env::temp_dir().join("nobuf-cache"))
                .join("stream-cache");
            let cache_mgr = match stream_cache::StreamCacheManager::new(cache_dir) {
                Ok(cache_mgr) => {
                    app.manage(cache_mgr.clone());
                    log::info!("Stream cache initialized at {:?}", cache_mgr.cache_dir());
                    Some(cache_mgr)
                }
                Err(e) => {
                    log::error!("Failed to initialize stream cache: {}", e);
                    None
                }
            };

            // Start Streaming Server on dedicated thread
            let state = Arc::new(app.state::<TelegramState>().inner().clone());
            let token_for_server = stream_token.clone();
            let handle_for_thread = server_handle_for_setup.clone();
            std::thread::spawn(move || {
                let sys = actix_rt::System::new();
                sys.block_on(async move {
                    match server::start_server(state, STREAM_PORT, token_for_server, cache_mgr, 0).await {
                        Ok(streaming_server) => {
                            // Store the handle so RunEvent::Exit can stop it
                            *handle_for_thread.lock().unwrap() = Some(streaming_server.handle());
                            // Now await the server — blocks until stopped
                            streaming_server.await.ok();
                        }
                        Err(e) => log::error!("Streaming server failed: {}", e),
                    }
                });
            });

            // Start API server if enabled in settings
            restart_api_server(app.handle());
            
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::cmd_auth_request_code,
            commands::cmd_auth_sign_in,
            commands::cmd_auth_check_password,
            commands::cmd_get_files,
            commands::cmd_upload_file,
            commands::cmd_connect,
            commands::cmd_log,
            commands::cmd_delete_file,
            commands::cmd_download_file,
            commands::cmd_move_files,
            commands::cmd_create_folder,
            commands::cmd_delete_folder,
            commands::cmd_get_bandwidth,
            commands::cmd_get_preview,
            commands::cmd_logout,
            commands::cmd_scan_folders,
            commands::cmd_search_global,
            commands::cmd_check_connection,
            commands::cmd_is_network_available,
            commands::cmd_clean_cache,
            commands::cmd_get_thumbnail,
            commands::cmd_get_stream_info,
            commands::cmd_cancel_transfer,
            commands::cmd_auth_qr_login,
            commands::cmd_auth_qr_poll,
            commands::cmd_get_api_settings,
            commands::cmd_update_api_settings,
            commands::cmd_regenerate_api_key,
            commands::cmd_generate_sprite_sheet,
            commands::cmd_get_cache_status,
            commands::cmd_delete_cache,
            commands::cmd_start_background_cache,
            commands::cmd_stop_background_cache,
            commands::cmd_set_speed_limits,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            log::info!("Application exiting — shutting down background services...");

            // 1. Shutdown the grammers network runner
            let shutdown_arc = app_handle.state::<TelegramState>().runner_shutdown.clone();
            let runner_tx = shutdown_arc.lock().ok().and_then(|mut g| g.take());
            if let Some(tx) = runner_tx {
                log::info!("Signaling network runner shutdown...");
                let _ = tx.send(());
            }

            // 2. Stop the Actix streaming server (graceful)
            let server_arc = app_handle.state::<ActixServerHandle>().0.clone();
            let server_handle = server_arc.lock().ok().and_then(|mut g| g.take());
            if let Some(handle) = server_handle {
                log::info!("Stopping Actix streaming server...");
                drop(handle.stop(true));
                // Give the server time to finish in-flight streaming requests
                // before we clear the cache — prevents concurrent writes during
                // cache deletion which can cause meta corruption on Windows.
                std::thread::sleep(std::time::Duration::from_millis(500));
            }

            // 3. Stop the API server (graceful)
            let api_arc = app_handle.state::<ApiServerHandle>().0.clone();
            let api_handle = api_arc.lock().ok().and_then(|mut g| g.take());
            if let Some(handle) = api_handle {
                log::info!("Stopping API server...");
                drop(handle.stop(true));
            }

            // 4. Clear stream cache
            if let Some(cache_mgr) = app_handle.try_state::<stream_cache::StreamCacheManager>() {
                log::info!("Clearing stream cache...");
                if let Err(e) = cache_mgr.clear_all() {
                    log::error!("Failed to clear stream cache: {}", e);
                }
            }
            // 5. Clean up partial download files
            let state = app_handle.state::<TelegramState>();
            let partials = state.partial_downloads.clone();
            if let Ok(mut paths) = partials.try_lock() {
                for path in paths.drain(..) {
                    if let Err(e) = std::fs::remove_file(&path) {
                        if e.kind() != std::io::ErrorKind::NotFound {
                            log::warn!("Failed to clean up partial download {}: {}", path, e);
                        }
                    } else {
                        log::info!("Cleaned up partial download: {}", path);
                    }
                }
            };
        }
    });
}
