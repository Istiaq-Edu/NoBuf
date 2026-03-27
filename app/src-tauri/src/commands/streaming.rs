use tauri::State;

/// Holds the per-session streaming token
pub struct StreamToken(pub String);

/// Returns the streaming server's session token to the frontend
#[tauri::command]
pub fn cmd_get_stream_token(token_state: State<'_, StreamToken>) -> String {
    token_state.0.clone()
}
