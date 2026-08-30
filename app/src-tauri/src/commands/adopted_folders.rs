use grammers_client::Client;
use grammers_client::types::Peer;
use tauri::{State, AppHandle, Manager};
use sqlite::{Connection, Value};
use crate::commands::TelegramState;
use crate::commands::utils::map_error;
use crate::models::{AdoptedFolder, FolderMetadata};

// ─── SQLite helpers ──────────────────────────────────────────────

pub fn adopted_db_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("nobuf_groups.db"))
}

pub fn adopted_get_connection(app: &AppHandle) -> Result<Connection, String> {
    let path = adopted_db_path(app)?;
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.execute("CREATE TABLE IF NOT EXISTS adopted_folders (
        channel_id   INTEGER PRIMARY KEY,
        access_hash  INTEGER NOT NULL,
        title        TEXT NOT NULL,
        adopted_at   INTEGER NOT NULL
    )").map_err(|e| e.to_string())?;
    Ok(conn)
}

pub fn load_adopted_folders(app: &AppHandle) -> Result<Vec<AdoptedFolder>, String> {
    let conn = adopted_get_connection(app)?;
    let mut stmt = conn.prepare(
        "SELECT channel_id, access_hash, title, adopted_at FROM adopted_folders ORDER BY adopted_at"
    ).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    while stmt.next().map_err(|e| e.to_string())? == sqlite::State::Row {
        let row: Vec<Value> = (0..4).map(|i| stmt.read(i).unwrap_or(Value::Null)).collect();
        out.push(AdoptedFolder {
            channel_id: match &row[0] { Value::Integer(i) => *i, _ => 0 },
            access_hash: match &row[1] { Value::Integer(i) => *i, _ => 0 },
            title: match &row[2] { Value::String(s) => s.clone(), _ => String::new() },
            adopted_at: match &row[3] { Value::Integer(i) => *i, _ => 0 },
        });
    }
    Ok(out)
}

pub fn delete_adopted_row(conn: &Connection, channel_id: i64) -> Result<(), String> {
    let mut stmt = conn.prepare("DELETE FROM adopted_folders WHERE channel_id = ?")
        .map_err(|e| e.to_string())?;
    stmt.bind((1, channel_id)).map_err(|e| e.to_string())?;
    stmt.next().map_err(|e| e.to_string())?;
    Ok(())
}

// ─── Rights helpers ──────────────────────────────────────────────

/// Eligibility predicate: creator OR admin with post_messages.
/// Reads raw TL flags (the enum wrapper is `ChatAdminRights::Rights(struct)`).
pub fn can_adopt_flags(creator: bool, admin_rights: &Option<grammers_tl_types::enums::ChatAdminRights>) -> bool {
    if creator {
        return true;
    }
    matches!(admin_rights, Some(grammers_tl_types::enums::ChatAdminRights::Rights(r)) if r.post_messages)
}

/// Extract (id, access_hash, title, creator, admin_rights, broadcast) from a raw Chat enum.
/// Returns None for non-Channel chats (basic groups, forbidden, empty).
pub fn channel_info_from_chat(chat: &grammers_tl_types::enums::Chat) -> Option<(i64, i64, String, bool, Option<grammers_tl_types::enums::ChatAdminRights>, bool)> {
    match chat {
        grammers_tl_types::enums::Chat::Channel(c) => Some((
            c.id,
            c.access_hash.unwrap_or(0),
            c.title.clone(),
            c.creator,
            c.admin_rights.clone(),
            c.broadcast,
        )),
        _ => None,
    }
}

/// Re-fetch a channel by id + access_hash to verify current rights.
/// Returns None when the channel is gone/stale (CHANNEL_PRIVATE & friends) —
/// the caller treats that as auto-unadopt.
pub async fn fetch_channel_fresh(
    client: &Client,
    channel_id: i64,
    access_hash: i64,
) -> Option<(i64, String, bool, Option<grammers_tl_types::enums::ChatAdminRights>)> {
    let result = client.invoke(&grammers_tl_types::functions::channels::GetChannels {
        id: vec![grammers_tl_types::enums::InputChannel::Channel(grammers_tl_types::types::InputChannel { channel_id, access_hash })],
    }).await;
    match result {
        Ok(res) => {
            let chats = match res {
                grammers_tl_types::enums::messages::Chats::Chats(c) => c.chats,
                grammers_tl_types::enums::messages::Chats::Slice(c) => c.chats,
            };
            chats.first().and_then(|chat| match chat {
                grammers_tl_types::enums::Chat::Channel(c) => Some((
                    // Trust the caller's stored hash when the fetch returns a
                    // min channel with the hash stripped (in-repo precedent:
                    // public_channels.rs resolve_channel_by_hash).
                    c.access_hash.filter(|h| *h != 0).unwrap_or(access_hash),
                    c.title.clone(),
                    c.creator,
                    c.admin_rights.clone(),
                )),
                _ => None,
            })
        }
        Err(_) => None,
    }
}

/// Seed the peer cache from an adoption record so uploads/downloads/moves work
/// even when the channel is archived (invisible to the dialog scan in resolve_peer).
/// The seeded Peer carries the STORED access_hash (min/stripped objects can't be trusted).
pub async fn seed_peer_cache(
    state: &TelegramState,
    channel_id: i64,
    access_hash: i64,
    title: &str,
    broadcast: bool,
) {
    use grammers_tl_types::types as tl_types;
    // Construct the raw Channel with the stored hash. Flags mirror what dialog
    // results carry; only id/access_hash/title/broadcast matter downstream.
    let raw_channel = tl_types::Channel {
        creator: false,
        left: false,
        broadcast,
        verified: false,
        megagroup: !broadcast,
        restricted: false,
        signatures: false,
        min: false,
        scam: false,
        has_link: false,
        has_geo: false,
        slowmode_enabled: false,
        call_active: false,
        call_not_empty: false,
        fake: false,
        gigagroup: false,
        noforwards: false,
        join_to_send: false,
        join_request: false,
        forum: false,
        stories_hidden: false,
        stories_hidden_min: false,
        stories_unavailable: false,
        signature_profiles: false,
        autotranslation: false,
        broadcast_messages_allowed: false,
        monoforum: false,
        forum_tabs: false,
        id: channel_id,
        access_hash: Some(access_hash),
        title: title.to_string(),
        username: None,
        photo: grammers_tl_types::enums::ChatPhoto::Empty,
        date: 0,
        restriction_reason: None,
        admin_rights: None,
        banned_rights: None,
        default_banned_rights: None,
        participants_count: None,
        usernames: None,
        stories_max_id: None,
        color: None,
        profile_color: None,
        emoji_status: None,
        level: None,
        subscription_until_date: None,
        bot_verification_icon: None,
        send_paid_messages_stars: None,
        linked_monoforum_id: None,
    };
    let peer = if broadcast {
        Peer::Channel(grammers_client::types::Channel { raw: raw_channel })
    } else {
        Peer::Group(grammers_client::types::Group { raw: grammers_tl_types::enums::Chat::Channel(raw_channel) })
    };
    state.peer_cache.write().await.insert(channel_id, peer);
}

// ─── Commands ────────────────────────────────────────────────────

/// Adopt an owned/administered channel as a full NoBuf folder.
/// Verifies rights first (creator OR post_messages admin); removes the channel
/// from public_channels if present (one channel, one sidebar entry).
/// Returns the FolderMetadata so the frontend can push it into folder state
/// directly (the handleCreateFolder pattern) — no restart/sync needed.
#[tauri::command]
pub async fn cmd_adopt_channel(
    channel_id: i64,
    access_hash: i64,
    app: AppHandle,
    state: State<'_, TelegramState>,
) -> Result<FolderMetadata, String> {
    // Dedup: already adopted?
    {
        let conn = adopted_get_connection(&app)?;
        let mut stmt = conn.prepare("SELECT channel_id FROM adopted_folders WHERE channel_id = ?")
            .map_err(|e| e.to_string())?;
        stmt.bind((1, channel_id)).map_err(|e| e.to_string())?;
        if stmt.next().map_err(|e| e.to_string())? == sqlite::State::Row {
            return Err("ALREADY_ADOPTED: This channel is already a NoBuf folder".to_string());
        }
    }

    let client_opt = { state.client.lock().await.clone() };
    let client = client_opt.ok_or("Not connected to Telegram")?;

    // Rights re-verification (mock mode skips this — DB-only, per plan)
    let (fresh_hash, title, _creator, _rights) = match fetch_channel_fresh(&client, channel_id, access_hash).await {
        Some(v) => v,
        None => return Err("Channel not found or access expired. It may have been deleted or you may have lost access.".to_string()),
    };

    // Eligibility: creator OR admin with post_messages
    let fetch = fetch_channel_fresh(&client, channel_id, access_hash).await;
    let eligible = match &fetch {
        Some((_, _, creator, rights)) => can_adopt_flags(*creator, rights),
        None => false,
    };
    if !eligible {
        return Err("NOT_ELIGIBLE: Only channels you created or administer (with post permission) can be adopted.".to_string());
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    // Insert adoption record (parameterized, house rule)
    {
        let conn = adopted_get_connection(&app)?;
        let mut stmt = conn.prepare(
            "INSERT INTO adopted_folders (channel_id, access_hash, title, adopted_at) VALUES (?, ?, ?, ?)"
        ).map_err(|e| e.to_string())?;
        stmt.bind((1, channel_id)).map_err(|e| e.to_string())?;
        stmt.bind((2, fresh_hash)).map_err(|e| e.to_string())?;
        stmt.bind((3, title.as_str())).map_err(|e| e.to_string())?;
        stmt.bind((4, now)).map_err(|e| e.to_string())?;
        stmt.next().map_err(|e| e.to_string())?;
    }

    // One channel, one sidebar entry: drop it from public_channels if present.
    // Best-effort — a failure here must not fail the adoption.
    {
        if let Ok(conn) = crate::commands::public_channels::pub_get_connection(&app) {
            let mut stmt = match conn.prepare("DELETE FROM public_channels WHERE channel_id = ?") {
                Ok(s) => s,
                Err(_) => return Ok(FolderMetadata { id: channel_id, name: title.clone(), parent_id: None, is_adopted: true }),
            };
            if stmt.bind((1, channel_id)).is_ok() {
                let _ = stmt.next();
            }
        }
    }

    // Seed the peer cache so upload/download/move work immediately (archived-safe)
    seed_peer_cache(&state, channel_id, fresh_hash, &title, true).await;

    Ok(FolderMetadata { id: channel_id, name: title, parent_id: None, is_adopted: true })
}

/// Unadopt: remove the adoption record. The Telegram channel and its
/// subscribers are untouched. (cmd_delete_channel_permanently handles real deletion.)
#[tauri::command]
pub async fn cmd_unadopt_channel(
    channel_id: i64,
    app: AppHandle,
) -> Result<bool, String> {
    let conn = adopted_get_connection(&app)?;
    delete_adopted_row(&conn, channel_id)?;
    Ok(true)
}

/// List adoption records (debug/frontend completeness).
#[tauri::command]
pub fn cmd_get_adopted_folders(app: AppHandle) -> Result<Vec<AdoptedFolder>, String> {
    load_adopted_folders(&app)
}

/// List channels eligible for adoption: broadcast channels AND megagroups the
/// logged-in account created or administers (post_messages). Covers the main
/// dialog list AND the archive folder (folder_id=1) — your own channels are
/// frequently archived and invisible to iter_dialogs.
/// Excludes: [NB]-tagged channels (regular folders), [NB-PUB], already-adopted.
#[tauri::command]
pub async fn cmd_list_owned_channels(
    app: AppHandle,
    state: State<'_, TelegramState>,
) -> Result<Vec<crate::models::JoinedChannel>, String> {
    let client_opt = { state.client.lock().await.clone() };
    if client_opt.is_none() {
        return Ok(Vec::new());
    }
    let client = client_opt.unwrap();

    // Exclusion sets
    let adopted_ids: std::collections::HashSet<i64> = load_adopted_folders(&app)
        .unwrap_or_default()
        .into_iter()
        .map(|r| r.channel_id)
        .collect();

    let mut results: Vec<crate::models::JoinedChannel> = Vec::new();
    let mut seen: std::collections::HashSet<i64> = std::collections::HashSet::new();

    // Main dialog list (broadcast channels — existing pattern)
    {
        let mut dialogs = client.iter_dialogs();
        while let Some(dialog) = dialogs.next().await.map_err(map_error)? {
            if let Peer::Channel(c) = &dialog.peer {
                if let Some(jc) = evaluate_for_adoption(
                    &c.raw.title, c.raw.id, c.raw.access_hash.unwrap_or(0),
                    c.raw.creator, &c.raw.admin_rights, c.raw.broadcast,
                    &adopted_ids, &mut seen,
                ) {
                    results.push(jc);
                }
            }
        }
    }

    // Archive folder scan (folder_id=1) — raw invoke; grammers' iterator
    // hardcodes folder_id: None. Manual pagination like DialogIter::next.
    // Megagroups arrive here as Peer::Group via the raw Chat enum, so we
    // evaluate the raw Chat::Channel directly (broadcast OR megagroup).
    {
        let mut offset_date: i32 = 0;
        let mut offset_id: i32 = 0;
        let mut offset_peer = grammers_tl_types::enums::InputPeer::Empty;
        loop {
            let resp = client.invoke(&grammers_tl_types::functions::messages::GetDialogs {
                exclude_pinned: true,
                folder_id: Some(1),
                offset_date,
                offset_id,
                offset_peer: offset_peer.clone(),
                limit: 100,
                hash: 0,
            }).await;
            let (dialogs, chats) = match resp {
                Ok(grammers_tl_types::enums::messages::Dialogs::Dialogs(d)) => {
                    (d.dialogs, d.chats)
                }
                Ok(grammers_tl_types::enums::messages::Dialogs::Slice(d)) => {
                    (d.dialogs, d.chats)
                }
                Ok(_) => break,
                Err(e) => {
                    // Archive scan is best-effort: FOLDER_ID_INVALID or
                    // CHANNEL_TOO_LARGE degrade to the main list only.
                    log::warn!("[ADOPT] archive dialog scan failed: {}", e);
                    break;
                }
            };
            let count = dialogs.len();
            // Evaluate every channel-shaped chat in this page (dialog entries
            // may reference them; we don't need the pairing).
            for chat in &chats {
                if let Some((id, hash, title, creator, rights, broadcast)) = channel_info_from_chat(chat) {
                    if let Some(jc) = evaluate_for_adoption(
                        &title, id, hash, creator, &rights, broadcast,
                        &adopted_ids, &mut seen,
                    ) {
                        results.push(jc);
                    }
                }
            }
            if count < 100 {
                break;
            }
            // Advance pagination offsets from the last dialog entry.
            // Dialog::Folder entries carry no message; Dialog::Dialog does.
            let mut advanced = false;
            for d in dialogs.iter().rev() {
                if let grammers_tl_types::enums::Dialog::Dialog(dd) = d {
                    offset_id = dd.top_message;
                    offset_date = 0; // top_message-anchored paging suffices here
                    offset_peer = match &dd.peer {
                        grammers_tl_types::enums::Peer::Channel(pc) =>
                            grammers_tl_types::enums::InputPeer::Channel(grammers_tl_types::types::InputPeerChannel {
                                channel_id: pc.channel_id,
                                access_hash: 0,
                            }),
                        _ => grammers_tl_types::enums::InputPeer::Empty,
                    };
                    advanced = true;
                    break;
                }
            }
            if !advanced {
                break;
            }
        }
    }

    results.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(results)
}

/// Shared eligibility evaluation for a raw channel. Returns None when the
/// channel is excluded ([NB]-tagged, [NB-PUB], already adopted, not eligible).
#[allow(clippy::too_many_arguments)]
fn evaluate_for_adoption(
    title: &str,
    id: i64,
    access_hash: i64,
    creator: bool,
    admin_rights: &Option<grammers_tl_types::enums::ChatAdminRights>,
    _broadcast: bool,
    adopted_ids: &std::collections::HashSet<i64>,
    seen: &mut std::collections::HashSet<i64>,
) -> Option<crate::models::JoinedChannel> {
    if !seen.insert(id) {
        return None;
    }
    let title_lower = title.to_lowercase();
    // Regular [NB] folders are NOT adoptable (never duplicate). [NB-PUB] needs
    // its own check: "[nb-pub]" does NOT contain the substring "[nb]" (the
    // dash breaks it), so it would slip through the tag check alone.
    if title_lower.contains("[nb-pub]") {
        return None;
    }
    if title_lower.contains("[nb]") {
        return None;
    }
    if adopted_ids.contains(&id) {
        return None;
    }
    let is_admin_post = can_adopt_flags(creator, admin_rights);
    if !is_admin_post {
        return None;
    }
    Some(crate::models::JoinedChannel {
        channel_id: id,
        name: title.to_string(),
        username: None,
        access_hash,
        already_added: false,
        is_nb_folder: false,
        is_creator: creator,
        is_admin_post,
    })
}


/// Really delete the channel from Telegram. Only for adopted folders — the
/// frontend gates this behind a separate, stronger danger dialog. Errors
/// (e.g. CHANNEL_TOO_LARGE for >1000 members) surface to the toast honestly.
#[tauri::command]
pub async fn cmd_delete_channel_permanently(
    channel_id: i64,
    access_hash: i64,
    app: AppHandle,
    state: State<'_, TelegramState>,
) -> Result<bool, String> {
    let client_opt = { state.client.lock().await.clone() };
    let client = client_opt.ok_or("Not connected to Telegram")?;

    client.invoke(&grammers_tl_types::functions::channels::DeleteChannel {
        channel: grammers_tl_types::enums::InputChannel::Channel(grammers_tl_types::types::InputChannel {
            channel_id,
            access_hash,
        }),
    }).await.map_err(map_error)?;

    // Drop the adoption record + peer cache entry
    {
        let conn = adopted_get_connection(&app)?;
        delete_adopted_row(&conn, channel_id)?;
    }
    state.peer_cache.write().await.remove(&channel_id);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rights(post: bool) -> Option<grammers_tl_types::enums::ChatAdminRights> {
        Some(grammers_tl_types::enums::ChatAdminRights::Rights(grammers_tl_types::types::ChatAdminRights {
            change_info: false,
            post_messages: post,
            edit_messages: false,
            delete_messages: false,
            ban_users: false,
            invite_users: false,
            pin_messages: false,
            add_admins: false,
            anonymous: false,
            manage_call: false,
            other: false,
            manage_topics: false,
            post_stories: false,
            edit_stories: false,
            delete_stories: false,
            manage_direct_messages: false,
        }))
    }

    #[test]
    fn eligibility_creator_passes_without_rights() {
        assert!(can_adopt_flags(true, &None));
    }

    #[test]
    fn eligibility_post_admin_passes() {
        assert!(can_adopt_flags(false, &rights(true)));
    }

    #[test]
    fn eligibility_comment_only_admin_fails() {
        assert!(!can_adopt_flags(false, &rights(false)));
    }

    #[test]
    fn eligibility_plain_member_fails() {
        assert!(!can_adopt_flags(false, &None));
    }

    #[test]
    fn evaluation_excludes_nb_tagged_and_adopted() {
        let mut seen = std::collections::HashSet::new();
        let adopted = std::collections::HashSet::new();
        // [NB]-tagged → excluded even when creator
        assert!(evaluate_for_adoption("My Folder [NB]", 1, 1, true, &None, true, &adopted, &mut seen).is_none());
        // [NB-PUB] → excluded (title contains [nb])
        assert!(evaluate_for_adoption("[NB-PUB]", 2, 1, true, &None, true, &adopted, &mut seen).is_none());
        // already adopted → excluded
        let mut adopted2 = std::collections::HashSet::new();
        adopted2.insert(3);
        assert!(evaluate_for_adoption("Mine", 3, 1, true, &None, true, &adopted2, &mut seen).is_none());
        // creator, plain title → included with flags
        let jc = evaluate_for_adoption("My Channel", 4, 7, true, &None, true, &adopted, &mut seen).unwrap();
        assert_eq!(jc.channel_id, 4);
        assert!(jc.is_creator);
        assert!(jc.is_admin_post);
        assert!(!jc.is_nb_folder);
        // duplicate id → seen-guard blocks
        assert!(evaluate_for_adoption("My Channel", 4, 7, true, &None, true, &adopted, &mut seen).is_none());
        // non-eligible (plain member) → excluded
        assert!(evaluate_for_adoption("Not Mine", 5, 1, false, &None, true, &adopted, &mut seen).is_none());
    }
}
