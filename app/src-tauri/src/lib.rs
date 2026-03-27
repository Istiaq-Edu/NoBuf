pub mod models;

pub mod commands;
pub mod bandwidth;

use tauri::Manager;
use tokio::sync::Mutex;
use std::sync::Arc;
use commands::TelegramState;
use commands::streaming::StreamToken;
use rand::Rng;

pub mod server;

/// Generate a random 32-character hex token for streaming server auth
fn generate_stream_token() -> String {
    let mut rng = rand::thread_rng();
    let bytes: Vec<u8> = (0..16).map(|_| rng.gen()).collect();
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    let stream_token = generate_stream_token();
    
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(move |app| {
            app.manage(TelegramState {
                client: Arc::new(Mutex::new(None)),
                login_token: Arc::new(Mutex::new(None)),
                password_token: Arc::new(Mutex::new(None)),
                api_id: Arc::new(Mutex::new(None)),
                runner_shutdown: Arc::new(Mutex::new(None)),
                runner_count: Arc::new(std::sync::atomic::AtomicU32::new(0)),
            });
            app.manage(bandwidth::BandwidthManager::new(app.handle()));
            app.manage(StreamToken(stream_token.clone()));
            
            // Start Streaming Server on dedicated thread (Actix needs its own runtime)
            let state = Arc::new(app.state::<TelegramState>().inner().clone());
            let token_for_server = stream_token.clone();
            std::thread::spawn(move || {
                let sys = actix_rt::System::new();
                sys.block_on(async move {
                    if let Err(e) = server::start_server(state, 14200, token_for_server).await {
                        log::error!("Streaming server failed: {}", e);
                    }
                });
            });
            
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
            commands::cmd_get_stream_token,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
