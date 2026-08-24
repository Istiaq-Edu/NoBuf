//! Vault cross-device sync via Saved Messages (spec §7, added post-v1).
//!
//! State travels as a plain text message to the user's own peer with a
//! marker prefix. Pull happens once per launch (after auto-sync); push is
//! fired after every mutating vault command. Conflicts resolve as a union
//! of hidden-ID lists (concealment-safe); credentials adopt the remote only
//! when local has none or the remote message is newer than the local file.

use serde::{Deserialize, Serialize};

use crate::commands::vault::{self, VaultLock};
use crate::commands::utils::resolve_peer;
use grammers_client::InputMessage;
use tauri::{AppHandle, Manager};
/// Marker identifying NoBuf vault-sync messages in Saved Messages.
pub const SYNC_MARKER: &str = "[NoBuf-Vault-v1]";

/// The synced payload. Field order/versioned via `v`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VaultSyncBlob {
    pub v: u32,
    /// Telegram user id of the vault owner. Pull skips blobs whose owner
    /// differs from the logged-in account (cross-account safety).
    pub owner_id: i64,
    #[serde(default)]
    pub folder_ids: Vec<i64>,
    #[serde(default)]
    pub public_ids: Vec<i64>,
    /// Hex-encoded PBKDF2 salt (empty = no passcode).
    #[serde(default)]
    pub salt_hex: String,
    /// Hex-encoded passcode hash (empty = no passcode).
    #[serde(default)]
    pub hash_hex: String,
    #[serde(default)]
    pub iterations: u32,
    #[serde(default = "default_true")]
    pub entry_visible: bool,
}

fn default_true() -> bool {
    true
}

/// Extract and parse the sync blob from a message body, if it is one.
pub fn parse_sync_message(body: &str) -> Option<VaultSyncBlob> {
    let rest = body.strip_prefix(SYNC_MARKER)?.trim();
    serde_json::from_str(rest).ok()
}

/// Serialize state into a sendable message body.
pub fn encode_sync_message(blob: &VaultSyncBlob) -> Result<String, String> {
    let json = serde_json::to_string(blob).map_err(|e| e.to_string())?;
    // Telegram text-message hard limit is 4096 chars; keep headroom.
    if SYNC_MARKER.len() + json.len() > 4000 {
        return Err("vault sync payload too large".to_string());
    }
    Ok(format!("{} {}", SYNC_MARKER, json))
}

/// Union-merge a pulled remote blob into the local store fields.
///
/// - IDs: union (hidden on either device stays hidden).
/// - Credentials: adopted from remote ONLY if local has none, or
///   `remote_newer` (caller compares message date vs local file mtime).
/// - entry_visible: remote wins when `remote_newer`, else local stands.
pub struct LocalVaultFields<'a> {
    pub folder_ids: &'a mut Vec<i64>,
    pub public_ids: &'a mut Vec<i64>,
    pub salt_hex: &'a mut String,
    pub hash_hex: &'a mut String,
    pub iterations: &'a mut u32,
    pub entry_visible: &'a mut bool,
}

pub fn merge_remote_into_local(
    local: LocalVaultFields<'_>,
    remote: &VaultSyncBlob,
    remote_newer: bool,
) {
    for id in &remote.folder_ids {
        if !local.folder_ids.contains(id) {
            local.folder_ids.push(*id);
        }
    }
    for id in &remote.public_ids {
        if !local.public_ids.contains(id) {
            local.public_ids.push(*id);
        }
    }

    let local_has_creds = !local.hash_hex.is_empty();
    let remote_has_creds = !remote.hash_hex.is_empty();

    if remote_has_creds && (!local_has_creds || remote_newer) {
        *local.salt_hex = remote.salt_hex.clone();
        *local.hash_hex = remote.hash_hex.clone();
        *local.iterations = if remote.iterations == 0 { 600_000 } else { remote.iterations };
    }

    if remote_newer {
        *local.entry_visible = remote.entry_visible;
    }
}

// ---------------------------------------------------------------------------
// Telegram transport (Saved Messages)
// ---------------------------------------------------------------------------

/// Build the current local state into a sync blob.
pub fn blob_from_store(store: &vault::VaultStore, owner_id: i64) -> VaultSyncBlob {
    VaultSyncBlob {
        v: 1,
        owner_id,
        folder_ids: store.vaulted_folder_ids.clone(),
        public_ids: store.vaulted_public_channel_ids.clone(),
        salt_hex: hex_of(store.salt.as_ref()),
        hash_hex: hex_of(store.passcode_hash.as_ref()),
        iterations: store.iterations,
        entry_visible: store.entry_visible,
    }
}

/// Apply a pulled remote blob into vault.json (merge + save) and return
/// the refreshed state response. Caller must hold VaultLock.
pub fn apply_remote_blob(
    app: &AppHandle,
    remote: &VaultSyncBlob,
    remote_newer: bool,
) -> Result<(), String> {
    let mut store = vault::load_store(app);
    {
        let mut salt_hex = hex_of(store.salt.as_ref());
        let mut hash_hex = hex_of(store.passcode_hash.as_ref());
        merge_remote_into_local(
            crate::commands::vault_sync::LocalVaultFields {
                folder_ids: &mut store.vaulted_folder_ids,
                public_ids: &mut store.vaulted_public_channel_ids,
                salt_hex: &mut salt_hex,
                hash_hex: &mut hash_hex,
                iterations: &mut store.iterations,
                entry_visible: &mut store.entry_visible,
            },
            remote,
            remote_newer,
        );
        // Write back whatever the merge left in the owned hex copies.
        store.salt = if salt_hex.is_empty() {
            None
        } else {
            Some(salt_hex)
        };
        store.passcode_hash = if hash_hex.is_empty() {
            None
        } else {
            Some(hash_hex)
        };
    }
    vault::save_store(app, &store)?;
    Ok(())
}

fn hex_of(bytes: Option<&String>) -> String {
    match bytes {
        Some(s) => s.clone(),
        None => String::new(),
    }
}

#[allow(dead_code)]
fn hex_to_bytes(hex: &str) -> Result<Vec<u8>, String> {
    if hex.len() % 2 != 0 {
        return Err("odd-length hex".into());
    }
    (0..hex.len() / 2)
        .map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).map_err(|e| e.to_string()))
        .collect()
}

/// PUSH: send current vault state to Saved Messages.
/// Fired after every mutating vault command; failures are non-fatal by design
/// (offline / not connected — next successful command re-pushes).
pub async fn push_state(app: &AppHandle) -> Result<(), String> {
    let client_opt = {
        let state = app.state::<crate::TelegramState>();
        let guard = state.client.lock().await;
        guard.clone()
    };
    let Some(client) = client_opt else {
        return Err("not_connected".into());
    };
    let peer_cache = {
        let state = app.state::<crate::TelegramState>();
        state.peer_cache.clone()
    };
    let peer = resolve_peer(&client, None, &peer_cache).await?;

    // Owner id + one-message discipline (review S1/S2): the sync state lives
    // in a SINGLE Saved Messages message that we EDIT in place. No
    // accumulation, no plaintext history of hidden IDs.
    let me = client.get_me().await.map_err(|e| e.to_string())?;
    let owner_id = me.raw.id();
    let store = vault::load_store(app);
    let body = encode_sync_message(&blob_from_store(&store, owner_id))?;

    match store.sync_message_id {
        Some(msg_id) => {
            // Try edit first; if the message was deleted remotely, fall back
            // to sending a fresh one.
            match client
                .edit_message(&peer, msg_id, InputMessage::new().text(body.clone()))
                .await
            {
                Ok(()) => Ok(()),
                Err(_) => {
                    let sent = client
                        .send_message(&peer, InputMessage::new().text(body))
                        .await
                        .map_err(|e| e.to_string())?;
                    persist_sync_message_id(app, sent.id())?;
                    Ok(())
                }
            }
        }
        None => {
            let sent = client
                .send_message(&peer, InputMessage::new().text(body))
                .await
                .map_err(|e| e.to_string())?;
            persist_sync_message_id(app, sent.id())?;
            Ok(())
        }
    }
}

/// Remember which Saved Messages message carries the vault blob.
fn persist_sync_message_id(app: &AppHandle, msg_id: i32) -> Result<(), String> {
    let lock = app.state::<VaultLock>();
    let _guard = lock.0.lock().map_err(|e| e.to_string())?;
    let mut store = vault::load_store(app);
    store.sync_message_id = Some(msg_id);
    vault::save_store(app, &store)
}

/// PULL: find the newest sync message in Saved Messages and merge it in.
/// Returns true when a remote blob was found and merged.
pub async fn pull_and_merge(app: &AppHandle) -> Result<bool, String> {
    let client_opt = {
        let state = app.state::<crate::TelegramState>();
        let guard = state.client.lock().await;
        guard.clone()
    };
    let Some(client) = client_opt else {
        return Err("not_connected".into());
    };
    let peer_cache = {
        let state = app.state::<crate::TelegramState>();
        state.peer_cache.clone()
    };
    let peer = resolve_peer(&client, None, &peer_cache).await?;

    // Scan the newest ~50 messages of Saved Messages for our marker.
    let mut msgs = client.iter_messages(&peer).limit(50);
    let mut newest: Option<(i64, VaultSyncBlob)> = None;
    while let Some(msg) = msgs.next().await.map_err(|e| e.to_string())? {
        let body_raw = msg.text();
        if let Some(blob) = parse_sync_message(body_raw) {
            newest = Some((msg.date().timestamp(), blob));
            break; // iter_messages yields newest-first
        }
    }
    let Some((msg_secs, remote)) = newest else {
        return Ok(false);
    };

    // Cross-account safety (review S1): a blob owned by a different Telegram
    // account must never merge into this machine's vault.
    let me = client.get_me().await.map_err(|e| e.to_string())?;
    if remote.owner_id != 0 && remote.owner_id != me.raw.id() {
        log::info!(
            "[vault-sync] skipping blob from owner {} (logged in as {})",
            remote.owner_id,
            me.raw.id()
        );
        return Ok(false);
    }

    // Remote-newer test: sync message date vs vault.json mtime.
    let local_mtime = vault_path_mtime(app)?;
    let remote_newer = match local_mtime {
        Some(m) => msg_secs > m,
        None => true,
    };

    let lock = app.state::<VaultLock>();
    let _guard = lock.0.lock().map_err(|e| e.to_string())?;
    apply_remote_blob(app, &remote, remote_newer)?;
    Ok(true)
}

fn vault_path_mtime(app: &AppHandle) -> Result<Option<i64>, String> {
    use std::time::UNIX_EPOCH;
    // Read mtime of app_data/vault.json (same path resolution as vault.rs).
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let p = dir.join("vault.json");
    match std::fs::metadata(&p) {
        Ok(meta) => Ok(meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)),
        Err(_) => Ok(None),
    }
}

/// Tauri command wrapper: manual "Sync now" + used at startup after connect.
#[tauri::command]
pub async fn cmd_vault_pull_sync(app: AppHandle) -> Result<serde_json::Value, String> {
    // Always end with a push. Two cases:
    // - No usable blob in Saved Messages (first sync ever): our push SEEDS
    //   the cloud from local state.
    // - Blob existed and was merged (union): RE-PUSH the union so the other
    //   side converges. Without this, a PC whose vault predates sync never
    //   uploads — it pulls, merges, stays silent, and its richer local state
    //   never leaves the machine (the exact bug seen on cross-PC install).
    let had_remote = match pull_and_merge(&app).await {
        Ok(found) => found,
        Err(e) => return Err(e),
    };
    push_state(&app).await?;
    // Dual-blob note (review R2): two PCs cold-launching simultaneously can
    // each create their own marker message; union merge keeps contents
    // convergent, so at most a stray duplicate message — acceptable.
    let store = vault::load_store(&app);
    let resp = vault::state_response_public(&app, &store);
    Ok(serde_json::json!({ "merged": !had_remote, "state": resp }))
}

/// Tauri command wrapper: fire-and-forget push (called post-mutation).
#[tauri::command]
pub async fn cmd_vault_push_sync(app: AppHandle) -> Result<(), String> {
    push_state(&app).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blob(folder_ids: &[i64], public_ids: &[i64], hash_hex: &str) -> VaultSyncBlob {
        VaultSyncBlob {
            v: 1,
            owner_id: 42,
            folder_ids: folder_ids.to_vec(),
            public_ids: public_ids.to_vec(),
            salt_hex: if hash_hex.is_empty() { String::new() } else { "aabb".into() },
            hash_hex: hash_hex.into(),
            iterations: 600_000,
            entry_visible: true,
        }
    }

    #[test]
    fn roundtrip_encode_parse() {
        let b = blob(&[1, 2], &[3], "deadbeef");
        let msg = encode_sync_message(&b).unwrap();
        assert!(msg.starts_with(SYNC_MARKER));
        let parsed = parse_sync_message(&msg).unwrap();
        assert_eq!(parsed, b);
    }

    #[test]
    fn non_sync_message_parses_to_none() {
        assert!(parse_sync_message("hello world").is_none());
        assert!(parse_sync_message("[NoBuf-Vault-v1] not-json").is_none());
    }

    #[test]
    fn oversized_payload_rejected() {
        let mut b = blob(&[], &[], "");
        b.folder_ids = vec![i64::MAX; 500]; // ~5KB of digits
        assert!(encode_sync_message(&b).is_err());
    }

    #[test]
    fn merge_unions_id_lists_order_stable() {
        let mut f = vec![10, 20];
        let mut p = vec![30];
        let mut salt = String::new();
        let mut hash = String::new();
        let mut iters = 600_000;
        let mut vis = true;
        merge_remote_into_local(
            LocalVaultFields {
                folder_ids: &mut f, public_ids: &mut p,
                salt_hex: &mut salt, hash_hex: &mut hash,
                iterations: &mut iters, entry_visible: &mut vis,
            },
            &blob(&[20, 40], &[50], ""),
            false,
        );
        assert_eq!(f, vec![10, 20, 40]);
        assert_eq!(p, vec![30, 50]);
    }

    #[test]
    fn creds_adopted_only_when_local_empty_or_remote_newer() {
        let mut f = vec![]; let mut p = vec![];
        let mut salt = "local_salt".into();
        let mut hash = "local_hash".into();
        let mut iters = 600_000u32;
        let mut vis = true;

        // Remote older/equal + local has creds → keep local.
        merge_remote_into_local(
            LocalVaultFields {
                folder_ids: &mut f, public_ids: &mut p,
                salt_hex: &mut salt, hash_hex: &mut hash,
                iterations: &mut iters, entry_visible: &mut vis,
            },
            &blob(&[], &[], "remote_hash"),
            false,
        );
        assert_eq!(hash, "local_hash");

        // Remote strictly newer → adopt.
        merge_remote_into_local(
            LocalVaultFields {
                folder_ids: &mut f, public_ids: &mut p,
                salt_hex: &mut salt, hash_hex: &mut hash,
                iterations: &mut iters, entry_visible: &mut vis,
            },
            &blob(&[], &[], "remote_hash"),
            true,
        );
        assert_eq!(hash, "remote_hash");
        assert_eq!(salt, "aabb");
    }

    #[test]
    fn empty_local_adopts_remote_creds_even_if_not_newer() {
        let mut f = vec![]; let mut p = vec![];
        let mut salt = String::new();
        let mut hash = String::new();
        let mut iters = 600_000u32;
        let mut vis = true;
        merge_remote_into_local(
            LocalVaultFields {
                folder_ids: &mut f, public_ids: &mut p,
                salt_hex: &mut salt, hash_hex: &mut hash,
                iterations: &mut iters, entry_visible: &mut vis,
            },
            &blob(&[7], &[], "ff00"),
            false,
        );
        assert_eq!(hash, "ff00");
        assert!(f.contains(&7));
    }

    #[test]
    fn merge_is_idempotent() {
        let mut f = vec![1];
        let mut p = vec![];
        let mut salt = String::new();
        let mut hash = String::new();
        let mut iters = 600_000u32;
        let mut vis = true;
        let remote = blob(&[1, 2], &[], "");
        {
            merge_remote_into_local(
                LocalVaultFields {
                    folder_ids: &mut f,
                    public_ids: &mut p,
                    salt_hex: &mut salt,
                    hash_hex: &mut hash,
                    iterations: &mut iters,
                    entry_visible: &mut vis,
                },
                &remote,
                false,
            );
        }
        {
            merge_remote_into_local(
                LocalVaultFields {
                    folder_ids: &mut f,
                    public_ids: &mut p,
                    salt_hex: &mut salt,
                    hash_hex: &mut hash,
                    iterations: &mut iters,
                    entry_visible: &mut vis,
                },
                &remote,
                false,
            );
        }
        assert_eq!(f, vec![1, 2]);
    }
}
