use grammers_client::types::Peer;
use tauri::{State, AppHandle, Manager};
use sqlite::{Connection, Value};
use crate::commands::TelegramState;
use crate::commands::utils::map_error;
use crate::models::{ChatInfo, PickableChat, EnrichedChat};

// ─── SQLite helpers ──────────────────────────────────────────────
// Same DB file as groups/public_channels/adopted (house pattern: one
// nobuf_groups.db, lazily-created tables per module).

fn db_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("nobuf_groups.db"))
}

pub fn get_connection(app: &AppHandle) -> Result<Connection, String> {
    let path = db_path(app)?;
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.execute("CREATE TABLE IF NOT EXISTS normal_chats (
        chat_id     INTEGER PRIMARY KEY,
        peer_kind   TEXT NOT NULL,
        access_hash INTEGER,
        title       TEXT NOT NULL,
        added_at    INTEGER NOT NULL,
        group_id    INTEGER,
        is_bot      INTEGER NOT NULL DEFAULT 0
    )").map_err(|e| e.to_string())?;
    // m6 (F-C8): dev DBs created before is_bot — best-effort backfill.
    let _ = conn.execute("ALTER TABLE normal_chats ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0");
    // cmd_get_enriched_chats LEFT JOINs `groups` (owned by folder_groups.rs).
    // Create it here too so the JOIN can't fail on a profile that never ran
    // a groups command (review: cross-module table dependency).
    conn.execute("CREATE TABLE IF NOT EXISTS groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color_hex TEXT DEFAULT '#22c55e', display_order INTEGER NOT NULL DEFAULT 0)").map_err(|e| e.to_string())?;
    Ok(conn)
}

fn vi(v: &Value) -> i64 {
    match v { Value::Integer(i) => *i, _ => 0 }
}

fn voi(v: &Value) -> Option<i64> {
    match v { Value::Integer(i) => Some(*i), _ => None }
}

fn vs(v: &Value) -> String {
    match v { Value::String(s) => s.clone(), _ => String::new() }
}

fn row_to_chat_info(row: &[Value]) -> ChatInfo {
    ChatInfo {
        chat_id: vi(&row[0]),
        peer_kind: vs(&row[1]),
        access_hash: voi(&row[2]),
        title: vs(&row[3]),
        added_at: vi(&row[4]),
        group_id: voi(&row[5]),
        // is_bot (m6): absent in pre-migration dev rows → default false.
        is_bot: !row.is_empty() && row.len() > 6 && matches!(row[6], Value::Integer(1)),
    }
}

/// Load all stored chats (used by cmd_list_chats and the startup cache seed).
pub fn load_normal_chats(app: &AppHandle) -> Result<Vec<ChatInfo>, String> {
    let conn = get_connection(app)?;
    let mut stmt = conn.prepare(
        "SELECT chat_id, peer_kind, access_hash, title, added_at, group_id, is_bot FROM normal_chats ORDER BY rowid"
    ).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    while stmt.next().map_err(|e| e.to_string())? == sqlite::State::Row {
        let row: Vec<Value> = (0..7).map(|i| stmt.read(i).unwrap_or(Value::Null)).collect();
        out.push(row_to_chat_info(&row));
    }
    Ok(out)
}

// ─── Picker eligibility (pure logic, unit-tested) ────────────────

/// Classify a dialog peer for the chat picker.
/// Returns Some((peer_kind, access_hash, title)) for eligible chats,
/// None for everything the picker excludes.
///
/// peer_kind: 'user' (DM with a person/bot), 'basic_group' (small group),
/// 'group' (supergroup/megagroup — channel-shaped, needs access_hash).
pub fn classify_dialog_peer(
    peer: &Peer,
    self_id: i64,
    adopted_ids: &std::collections::HashSet<i64>,
    added_ids: &std::collections::HashSet<i64>,
) -> Option<(String, Option<i64>, String, bool)> {
    use grammers_tl_types::enums::Chat;
    match peer {
        // DMs: any non-self user (bots included — D2).
        Peer::User(u) => {
            let id = u.raw.id();
            if id == self_id {
                return None; // Saved Messages has its own entry (D14)
            }
            match &u.raw {
                grammers_tl_types::enums::User::User(raw) => {
                    let name = u.full_name();
                    let title = if name.is_empty() {
                        raw.first_name.clone().unwrap_or_else(|| "Unknown".to_string())
                    } else {
                        name
                    };
                    Some((
                        "user".to_string(),
                        raw.access_hash,
                        title,
                        added_ids.contains(&id),
                    ))
                }
                _ => None, // User::Empty — deleted account stub
            }
        }
        // Groups: basic groups and megagroups both arrive as Peer::Group.
        Peer::Group(g) => match &g.raw {
            // Megagroup (supergroup): channel-shaped, carries an access_hash.
            Chat::Channel(c) => {
                if adopted_ids.contains(&c.id) {
                    return None; // already a folder — one entity, one sidebar entry
                }
                if crate::commands::adopted_folders::title_matches_nb_folder(&c.title) {
                    return None; // [NB]/[NB-PUB] folder titles stay folders
                }
                Some((
                    "group".to_string(),
                    c.access_hash,
                    c.title.clone(),
                    added_ids.contains(&c.id),
                ))
            }
            // Basic group with real data. [NB]-titled basic groups stay out
            // (plan §1.1 #2 covers 'Group chats' broadly; cosmetic-only since
            // scan_folders never matches Peer::Group as folders).
            Chat::Chat(c) => {
                if crate::commands::adopted_folders::title_matches_nb_folder(&c.title) {
                    return None;
                }
                Some((
                    "basic_group".to_string(),
                    None, // basic chats have no access_hash in TL
                    c.title.clone(),
                    added_ids.contains(&c.id),
                ))
            }
            // Dead/stub dialogs: chats you left or were kicked from, or
            // placeholder objects. Instant-CHAT_GONE rows — never offer them.
            Chat::Forbidden(_) | Chat::Empty(_) => None,
            _ => None,
        },
        // Broadcast channels have their own flows (public add / adoption).
        Peer::Channel(_) => None,
    }
}

// ─── Commands ────────────────────────────────────────────────────

#[tauri::command]
pub fn cmd_list_chats(app: AppHandle) -> Result<Vec<ChatInfo>, String> {
    load_normal_chats(&app)
}

/// List dialogs eligible for the Chats section picker: non-broadcast peers
/// (DMs incl. bots, basic groups, supergroups), excluding self, adopted
/// megagroups, [NB]-titled groups, and dead (Forbidden/Empty) dialogs.
/// Already-added chats are INCLUDED with already_added=true (the modal
/// renders them disabled). Search is client-side (AddChannelModal pattern).
#[tauri::command]
pub async fn cmd_pick_chats(
    app: AppHandle,
    state: State<'_, TelegramState>,
) -> Result<Vec<PickableChat>, String> {
    let client_opt = { state.client.lock().await.clone() };
    let client = client_opt.ok_or("Not connected to Telegram")?;

    let added_ids: std::collections::HashSet<i64> = load_normal_chats(&app)?
        .into_iter()
        .map(|c| c.chat_id)
        .collect();

    let adopted_ids: std::collections::HashSet<i64> =
        crate::commands::adopted_folders::load_adopted_folders(&app)
            .unwrap_or_default()
            .into_iter()
            .map(|r| r.channel_id)
            .collect();

    let me = client.get_me().await.map_err(map_error)?;
    let self_id = me.raw.id();

    let mut out = Vec::new();
    let mut dialogs = client.iter_dialogs();
    while let Some(dialog) = dialogs.next().await.map_err(map_error)? {
        if let Some((peer_kind, access_hash, title, already_added)) =
            classify_dialog_peer(&dialog.peer, self_id, &adopted_ids, &added_ids)
        {
            let id = dialog_id(&dialog.peer);
            let kind_label = pickable_kind_label(&dialog.peer);
            let is_bot = matches!(&dialog.peer, Peer::User(u) if matches!(&u.raw, grammers_tl_types::enums::User::User(raw) if raw.bot));
            out.push(PickableChat {
                chat_id: id,
                peer_kind,
                access_hash,
                title,
                already_added,
                kind_label,
                is_bot,
            });
        }
    }

    Ok(out)
}

fn dialog_id(peer: &Peer) -> i64 {
    use grammers_tl_types::enums::Chat;
    match peer {
        Peer::User(u) => u.raw.id(),
        Peer::Group(g) => match &g.raw {
            // Megagroups are keyed by their channel id.
            Chat::Channel(c) => c.id,
            // Basic groups: raw chat id from the Chat enum (NOT Group::id(),
            // which returns a packed PeerId — grammers group.rs:61-71).
            Chat::Chat(c) => c.id as i64,
            Chat::Forbidden(c) => c.id as i64,
            Chat::Empty(c) => c.id as i64,
            _ => 0,
        },
        Peer::Channel(c) => c.raw.id,
    }
}

fn pickable_kind_label(peer: &Peer) -> String {
    use grammers_tl_types::enums::Chat;
    match peer {
        Peer::User(u) => match &u.raw {
            grammers_tl_types::enums::User::User(raw) if raw.bot => "Bot".to_string(),
            _ => "Direct message".to_string(),
        },
        Peer::Group(g) => match &g.raw {
            Chat::Channel(_) => "Supergroup".to_string(),
            _ => "Group".to_string(),
        },
        Peer::Channel(_) => "Channel".to_string(),
    }
}

/// Add a chat to the Chats section. INSERT OR IGNORE + re-SELECT so a
/// double-click on the picker row is idempotent; also seeds the peer cache
/// immediately so the chat is usable before any dialog scan runs.
#[tauri::command]
pub async fn cmd_add_chat(
    chat_id: i64,
    peer_kind: String,
    access_hash: Option<i64>,
    title: String,
    is_bot: Option<bool>,
    app: AppHandle,
    state: State<'_, TelegramState>,
) -> Result<ChatInfo, String> {
    if !matches!(peer_kind.as_str(), "user" | "basic_group" | "group") {
        return Err(format!("Invalid peer_kind: {}", peer_kind));
    }
    if peer_kind != "basic_group" && access_hash.is_none() {
        return Err(format!("access_hash required for peer_kind {}", peer_kind));
    }
    // Range guard: PeerId::user/chat/channel PANIC on out-of-range ids
    // (grammers-session peer.rs:160-176). Real Telegram ids are always in
    // range; reject fabricated ones before they poison the peer cache.
    if chat_id <= 0 || chat_id > (1 << 55) {
        return Err(format!("chat_id out of valid range: {}", chat_id));
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    {
        let conn = get_connection(&app)?;
        let mut stmt = conn.prepare(
            "INSERT OR IGNORE INTO normal_chats (chat_id, peer_kind, access_hash, title, added_at, group_id, is_bot) VALUES (?, ?, ?, ?, ?, NULL, ?)"
        ).map_err(|e| e.to_string())?;
        stmt.bind((1, chat_id)).map_err(|e| e.to_string())?;
        stmt.bind((2, peer_kind.as_str())).map_err(|e| e.to_string())?;
        match access_hash {
            Some(h) => stmt.bind((3, h)).map_err(|e| e.to_string())?,
            None => stmt.bind((3, Value::Null)).map_err(|e| e.to_string())?,
        }
        stmt.bind((4, title.as_str())).map_err(|e| e.to_string())?;
        stmt.bind((5, now)).map_err(|e| e.to_string())?;
        stmt.bind((6, if is_bot.unwrap_or(false) { 1 } else { 0 })).map_err(|e| e.to_string())?;
        stmt.next().map_err(|e| e.to_string())?;
    }

    // Seed the peer cache so uploads/downloads work even if the chat is
    // archived (invisible to the dialog scan). Unconditional: the stored row
    // is the authority for this dialog (plan §1.1, review2 V2-16).
    seed_chat_cache_entry(&state, chat_id, &peer_kind, access_hash, &title).await;

    load_normal_chats(&app)?
        .into_iter()
        .find(|c| c.chat_id == chat_id)
        .ok_or_else(|| "Chat insert failed".to_string())
}

/// Unlist a chat from the Chats section. No Telegram-side action (D11) —
/// the chat and its history stay fully intact. Prunes any vault entry so
/// the id can't linger hidden forever (review M5).
#[tauri::command]
pub async fn cmd_remove_chat(
    chat_id: i64,
    app: AppHandle,
    state: State<'_, TelegramState>,
) -> Result<bool, String> {
    {
        let conn = get_connection(&app)?;
        let mut stmt = conn.prepare("DELETE FROM normal_chats WHERE chat_id = ?")
            .map_err(|e| e.to_string())?;
        stmt.bind((1, chat_id)).map_err(|e| e.to_string())?;
        stmt.next().map_err(|e| e.to_string())?;
    }
    state.peer_cache.write().await.remove(&chat_id);
    // Best-effort vault prune (same discipline as the frontend's
    // public-channel diff pruning): a hidden-then-removed chat must not
    // leave an invisible, un-unhideable vault id behind.
    {
        let mut store = crate::commands::vault::load_store(&app);
        if store.vaulted_chat_ids.contains(&chat_id) {
            store = crate::commands::vault::prune_chat_ids(store, &[chat_id]);
            let _ = crate::commands::vault::save_store(&app, &mut store);
        }
    }
    Ok(true)
}

// ─── Resolution + file listing (R2) ──────────────────────────────

/// Errors that mean "this chat is gone for good" (dead-chat path D13).
pub fn is_chat_gone_error(err: &str) -> bool {
    err.contains("CHAT_GONE")
        || err.contains("USER_IS_BLOCKED")
        || err.contains("USER_ID_INVALID")
        || err.contains("PEER_ID_INVALID")
        || err.contains("USER_NOT_PARTICIPANT")
        || err.contains("CHAT_ID_INVALID")
        || err.contains("CHANNEL_PRIVATE")
}

/// Errors that mean the stored access_hash is stale (retry after refresh).
fn is_stale_hash_error(err: &str) -> bool {
    err.contains("PEER_ID_INVALID")
        || err.contains("USER_ID_INVALID")
        || err.contains("CHANNEL_INVALID")
        || err.contains("CHANNEL_ID_INVALID")
}

/// Build a kind-checked InputPeer from a stored chat row.
/// 'user' → InputPeerUser (hash required); 'basic_group' → InputPeerChat
/// (hash-free); 'group' (supergroup) → InputPeerChannel (hash required).
/// Also used by cmd_forward_to_folder's chat-source fallback.
pub fn resolve_chat_peer_pub(chat: &ChatInfo) -> Result<grammers_tl_types::enums::InputPeer, String> {
    resolve_chat_peer(chat)
}

fn resolve_chat_peer(chat: &ChatInfo) -> Result<grammers_tl_types::enums::InputPeer, String> {
    use grammers_tl_types::enums::InputPeer;
    use grammers_tl_types::types;
    match chat.peer_kind.as_str() {
        "user" => Ok(InputPeer::User(types::InputPeerUser {
            user_id: chat.chat_id,
            access_hash: chat
                .access_hash
                .ok_or_else(|| "Missing access_hash for user chat".to_string())?,
        })),
        "basic_group" => Ok(InputPeer::Chat(types::InputPeerChat {
            chat_id: chat.chat_id,
        })),
        "group" => Ok(InputPeer::Channel(types::InputPeerChannel {
            channel_id: chat.chat_id,
            access_hash: chat
                .access_hash
                .ok_or_else(|| "Missing access_hash for supergroup".to_string())?,
        })),
        other => Err(format!("Unknown peer_kind: {}", other)),
    }
}

/// Load a stored chat row or fail with CHAT_GONE (removed while in use).
fn load_chat_row(app: &AppHandle, chat_id: i64) -> Result<ChatInfo, String> {
    load_normal_chats(app)?
        .into_iter()
        .find(|c| c.chat_id == chat_id)
        .ok_or_else(|| "CHAT_GONE: Chat is no longer in NoBuf".to_string())
}

/// Stale-hash recovery (scoped to cmd_get_chat_files — plan §1.1): re-scan
/// dialogs (+ archive), update the stored hash + cache, retry once.
async fn refresh_chat_peer(
    client: &grammers_client::Client,
    app: &AppHandle,
    state: &TelegramState,
    chat: &mut ChatInfo,
) -> Result<(), String> {
    // Main dialog list scan: collect a fresh (kind, hash) for this chat id.
    let mut fresh: Option<ChatInfo> = None;
    {
        let mut dialogs = client.iter_dialogs();
        while let Some(dialog) = dialogs.next().await.map_err(map_error)? {
            if dialog_id(&dialog.peer) == chat.chat_id {
                if let Some((peer_kind, access_hash, title, _)) =
                    classify_dialog_peer(&dialog.peer, i64::MAX, &Default::default(), &Default::default())
                {
                    fresh = Some(ChatInfo {
                        chat_id: chat.chat_id,
                        peer_kind,
                        access_hash,
                        title,
                        added_at: chat.added_at,
                        group_id: chat.group_id,
                        // Identity refresh: preserve stored botness.
                        is_bot: chat.is_bot,
                    });
                }
                break;
            }
        }
    }
    // Archive scan (folder_id=1, raw pagination — adopted_folders.rs:383-425
    // pattern). Best-effort: only used when the main scan missed.
    if fresh.is_none() {
        if let Some(f) = scan_archive_for_chat(client, chat.chat_id).await {
            // Preserve added_at/group_id — the archive row only carries
            // identity (kind/hash/title), not local metadata.
            fresh = Some(ChatInfo {
                chat_id: f.chat_id,
                peer_kind: f.peer_kind,
                access_hash: f.access_hash,
                title: f.title,
                added_at: chat.added_at,
                group_id: chat.group_id,
                is_bot: f.is_bot,
            });
        }
    }
    let f = fresh.ok_or_else(|| "CHAT_GONE: Chat not found in dialogs".to_string())?;
    // Persist the refreshed hash + title.
    {
        let conn = get_connection(app)?;
        let mut stmt = conn.prepare(
            "UPDATE normal_chats SET access_hash = ?, title = ?, peer_kind = ? WHERE chat_id = ?",
        ).map_err(|e| e.to_string())?;
        match f.access_hash {
            Some(h) => stmt.bind((1, h)).map_err(|e| e.to_string())?,
            None => stmt.bind((1, Value::Null)).map_err(|e| e.to_string())?,
        }
        stmt.bind((2, f.title.as_str())).map_err(|e| e.to_string())?;
        stmt.bind((3, f.peer_kind.as_str())).map_err(|e| e.to_string())?;
        stmt.bind((4, chat.chat_id)).map_err(|e| e.to_string())?;
        stmt.next().map_err(|e| e.to_string())?;
    }
    // Re-seed the cache with the fresh peer.
    seed_chat_cache_entry(state, f.chat_id, &f.peer_kind, f.access_hash, &f.title).await;
    *chat = f;
    Ok(())
}

/// Archive-folder scan via raw GetDialogs{folder_id: Some(1)} pagination.
/// Scans BOTH `chats` (groups/megagroups) and `users` (DMs) — archived DMs
/// never appear in `chats`. Pagination follows the adopted_folders.rs:436-448
/// pattern: offset_id = last dialog's top_message, offset_date = 0,
/// offset_peer advanced to the last dialog's peer.
async fn scan_archive_for_chat(
    client: &grammers_client::Client,
    chat_id: i64,
) -> Option<ChatInfo> {
    use grammers_tl_types::enums;
    let mut offset_date: i32 = 0;
    let mut offset_id: i32 = 0;
    let mut offset_peer = enums::InputPeer::Empty;
    loop {
        let resp = client
            .invoke(&grammers_tl_types::functions::messages::GetDialogs {
                exclude_pinned: true,
                folder_id: Some(1),
                offset_date,
                offset_id,
                offset_peer: offset_peer.clone(),
                limit: 100,
                hash: 0,
            })
            .await;
        let (dialogs, chats, users) = match resp {
            Ok(enums::messages::Dialogs::Dialogs(d)) => (d.dialogs, d.chats, d.users),
            Ok(enums::messages::Dialogs::Slice(d)) => (d.dialogs, d.chats, d.users),
            Ok(_) => break,
            Err(e) => {
                // Best-effort: archive scan failures degrade to "not found".
                log::warn!("[CHATS] archive scan failed: {}", e);
                break;
            }
        };
        // Archived DMs live in `users`.
        for u in &users {
            let peer = Peer::User(grammers_client::types::User { raw: u.clone() });
            if dialog_id(&peer) == chat_id {
                let is_bot = matches!(u, grammers_tl_types::enums::User::User(raw) if raw.bot);
                if let Some((peer_kind, access_hash, title, _)) =
                    classify_dialog_peer(&peer, i64::MAX, &Default::default(), &Default::default())
                {
                    return Some(ChatInfo {
                        chat_id,
                        peer_kind,
                        access_hash,
                        title,
                        added_at: 0,
                        group_id: None,
                        is_bot,
                    });
                }
            }
        }
        // Groups and megagroups live in `chats`.
        for c in &chats {
            let peer = match c {
                enums::Chat::Channel(_) | enums::Chat::Chat(_) | enums::Chat::Forbidden(_) | enums::Chat::Empty(_) => {
                    Peer::Group(grammers_client::types::Group { raw: c.clone() })
                }
                _ => continue,
            };
            if dialog_id(&peer) == chat_id {
                if let Some((peer_kind, access_hash, title, _)) =
                    classify_dialog_peer(&peer, i64::MAX, &Default::default(), &Default::default())
                {
                    return Some(ChatInfo {
                        chat_id,
                        peer_kind,
                        access_hash,
                        title,
                        is_bot: false,
                        added_at: 0,
                        group_id: None,
                    });
                }
            }
        }
        let count = dialogs.len();
        if count < 100 {
            break;
        }
        // Advance pagination per adopted_folders.rs:436-448: offset_id anchors
        // to the last dialog's top_message; offset_date stays 0; offset_peer
        // moves to the last dialog's peer.
        let mut advanced = false;
        for d in dialogs.iter().rev() {
            if let enums::Dialog::Dialog(dd) = d {
                offset_id = dd.top_message;
                offset_date = 0;
                offset_peer = match &dd.peer {
                    enums::Peer::Channel(pc) => enums::InputPeer::Channel(
                        grammers_tl_types::types::InputPeerChannel {
                            channel_id: pc.channel_id,
                            access_hash: 0,
                        },
                    ),
                    enums::Peer::User(pu) => enums::InputPeer::User(
                        grammers_tl_types::types::InputPeerUser {
                            user_id: pu.user_id,
                            access_hash: 0,
                        },
                    ),
                    enums::Peer::Chat(pc) => enums::InputPeer::Chat(
                        grammers_tl_types::types::InputPeerChat {
                            chat_id: pc.chat_id,
                        },
                    ),
                };
                advanced = true;
                break;
            }
        }
        if !advanced {
            break;
        }
    }
    None
}

/// List a chat's media history with offset pagination — mirrors
/// cmd_get_public_channel_files (public_channels.rs:642-746): GetHistory
/// limit 100, client-side filter to documents/photos, 50-file cap,
/// has_more = fetched >= 100. CHAT_GONE mapping for dead chats (D13).
#[tauri::command]
pub async fn cmd_get_chat_files(
    chat_id: i64,
    offset_id: Option<i32>,
    app: AppHandle,
    state: State<'_, TelegramState>,
) -> Result<(Vec<crate::models::FileMetadata>, bool), String> {
    let client_opt = { state.client.lock().await.clone() };
    let client = client_opt.ok_or("Not connected to Telegram")?;

    let mut chat = load_chat_row(&app, chat_id)?;

    let fetch = |input_peer: grammers_tl_types::enums::InputPeer| {
        let client = client.clone();
        async move {
            client
                .invoke(&grammers_tl_types::functions::messages::GetHistory {
                    peer: input_peer,
                    offset_id: offset_id.unwrap_or(0),
                    offset_date: 0,
                    add_offset: 0,
                    limit: 100,
                    max_id: 0,
                    min_id: 0,
                    hash: 0,
                })
                .await
        }
    };

    let mut input_peer = resolve_chat_peer(&chat)?;
    let result = fetch(input_peer.clone()).await;
    let result = match result {
        Ok(r) => r,
        Err(e) => {
            let err = e.to_string();
            if is_stale_hash_error(&err) {
                // Refresh (dialog + archive re-scan → update stored hash) and
                // retry once. Failure to refresh maps to CHAT_GONE below.
                refresh_chat_peer(&client, &app, &state, &mut chat).await?;
                input_peer = resolve_chat_peer(&chat)?;
                fetch(input_peer).await.map_err(|e2| {
                    let msg = e2.to_string();
                    if is_chat_gone_error(&msg) {
                        format!("CHAT_GONE: {}", msg)
                    } else {
                        map_error(e2)
                    }
                })?
            } else if is_chat_gone_error(&err) {
                return Err(format!("CHAT_GONE: {}", err));
            } else {
                return Err(map_error(e));
            }
        }
    };

    let messages = crate::commands::utils::messages_from_history(&result);
    log::info!(
        "[Chats] GetHistory returned {} messages for chat {}",
        messages.len(),
        chat_id
    );

    let mut files = Vec::new();
    let limit = 50;
    let mut count = 0;
    let has_more = messages.len() >= 100;

    for msg in messages {
        if count >= limit {
            break;
        }
        if let grammers_tl_types::enums::Message::Message(m) = msg {
            if let Some(media) = &m.media {
                let (name, size, mime, ext, duration) = match media {
                    grammers_tl_types::enums::MessageMedia::Document(d) => {
                        if let Some(grammers_tl_types::enums::Document::Document(doc)) = &d.document {
                            let n = doc
                                .attributes
                                .iter()
                                .find_map(|a| match a {
                                    grammers_tl_types::enums::DocumentAttribute::Filename(f) => {
                                        Some(f.file_name.clone())
                                    }
                                    _ => None,
                                })
                                .unwrap_or_else(|| "Unknown".to_string());
                            let s = doc.size as u64;
                            let mi = doc.mime_type.clone();
                            let e = std::path::Path::new(&n)
                                .extension()
                                .map(|os| os.to_str().unwrap_or("").to_string());
                            let dur = crate::commands::public_channels::extract_duration_from_doc(
                                &grammers_tl_types::enums::Document::Document(doc.clone()),
                            );
                            (n, s, Some(mi), e, dur)
                        } else {
                            continue;
                        }
                    }
                    grammers_tl_types::enums::MessageMedia::Photo(_) => (
                        "Photo.jpg".to_string(),
                        0,
                        Some("image/jpeg".to_string()),
                        Some("jpg".to_string()),
                        None,
                    ),
                    _ => continue,
                };
                files.push(crate::models::FileMetadata {
                    id: m.id as i64,
                    folder_id: Some(chat_id),
                    name,
                    size,
                    mime_type: mime,
                    file_ext: ext,
                    created_at: m.date.to_string(),
                    icon_type: "file".to_string(),
                    duration,
                });
                count += 1;
            }
        }
    }

    log::info!(
        "[Chats] Extracted {} files (has_more={}) for chat {}",
        files.len(),
        has_more,
        chat_id
    );

    Ok((files, has_more))
}

// ─── Chat group assignment (D9) ──────────────────────────────────

/// Assign a chat to a colored group (null = unassign). Mirrors
/// cmd_assign_folder_to_group (folder_groups.rs) against the
/// normal_chats.group_id column.
#[tauri::command]
pub fn cmd_assign_chat_to_group(
    chat_id: i64,
    group_id: Option<i64>,
    app: AppHandle,
) -> Result<bool, String> {
    let conn = get_connection(&app)?;
    let mut stmt = conn.prepare("UPDATE normal_chats SET group_id = ? WHERE chat_id = ?")
        .map_err(|e| e.to_string())?;
    match group_id {
        Some(g) => stmt.bind((1, g)).map_err(|e| e.to_string())?,
        None => stmt.bind((1, Value::Null)).map_err(|e| e.to_string())?,
    }
    stmt.bind((2, chat_id)).map_err(|e| e.to_string())?;
    stmt.next().map_err(|e| e.to_string())?;
    Ok(true)
}

/// Chat id → group (id, color) map for the sidebar's group-chip filtering.
/// Mirrors cmd_get_enriched_folders (folder_groups.rs:141-154 pattern).
#[tauri::command]
pub fn cmd_get_enriched_chats(app: AppHandle) -> Result<Vec<EnrichedChat>, String> {
    let conn = get_connection(&app)?;
    let mut stmt = conn.prepare(
        "SELECT n.chat_id, n.group_id, g.color_hex FROM normal_chats n LEFT JOIN groups g ON n.group_id = g.id",
    ).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    while stmt.next().map_err(|e| e.to_string())? == sqlite::State::Row {
        let row: Vec<Value> = (0..3).map(|i| stmt.read(i).unwrap_or(Value::Null)).collect();
        out.push(EnrichedChat {
            chat_id: vi(&row[0]),
            group_id: voi(&row[1]),
            group_color: match &row[2] { Value::String(s) => Some(s.clone()), _ => None },
        });
    }
    Ok(out)
}

// ─── Peer cache seeding (R2 will call this at startup too) ───────
/// Insert a synthetic peer for a stored chat row so seam ops (upload/
/// download/stream via resolve_peer) work even when the dialog is archived
/// or the scan hasn't run yet.
pub async fn seed_chat_cache_entry(
    state: &TelegramState,
    chat_id: i64,
    peer_kind: &str,
    access_hash: Option<i64>,
    title: &str,
) {
    use grammers_tl_types::types as tl_types;
    let peer = match peer_kind {
        "user" => {
            let hash = access_hash.unwrap_or(0);
            let raw_user = tl_types::User {
                is_self: false,
                contact: false,
                mutual_contact: false,
                deleted: false,
                bot: false,
                bot_chat_history: false,
                bot_nochats: false,
                verified: false,
                restricted: false,
                min: false,
                bot_inline_geo: false,
                support: false,
                scam: false,
                apply_min_photo: false,
                fake: false,
                bot_attach_menu: false,
                premium: false,
                attach_menu_enabled: false,
                bot_can_edit: false,
                close_friend: false,
                stories_hidden: false,
                stories_unavailable: false,
                contact_require_premium: false,
                bot_business: false,
                bot_has_main_app: false,
                bot_forum_view: false,
                // Only id/access_hash/name matter downstream.
                id: chat_id,
                access_hash: Some(hash),
                first_name: Some(title.to_string()),
                last_name: None,
                username: None,
                phone: None,
                photo: None,
                status: None,
                bot_info_version: None,
                restriction_reason: None,
                bot_inline_placeholder: None,
                lang_code: None,
                emoji_status: None,
                usernames: None,
                stories_max_id: None,
                color: None,
                profile_color: None,
                bot_active_users: None,
                bot_verification_icon: None,
                send_paid_messages_stars: None,
            };
            Peer::User(grammers_client::types::User { raw: grammers_tl_types::enums::User::User(raw_user) })
        }
        "basic_group" => {
            let raw_chat = tl_types::Chat {
                creator: false,
                left: false,
                deactivated: false,
                call_active: false,
                call_not_empty: false,
                noforwards: false,
                id: chat_id,
                title: title.to_string(),
                photo: grammers_tl_types::enums::ChatPhoto::Empty,
                participants_count: 0,
                date: 0,
                version: 0,
                migrated_to: None,
                admin_rights: None,
                default_banned_rights: None,
            };
            Peer::Group(grammers_client::types::Group { raw: grammers_tl_types::enums::Chat::Chat(raw_chat) })
        }
        "group" => {
            let hash = access_hash.unwrap_or(0);
            let raw_channel = tl_types::Channel {
                creator: false,
                left: false,
                broadcast: false,
                verified: false,
                megagroup: true,
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
                id: chat_id,
                access_hash: Some(hash),
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
            Peer::Group(grammers_client::types::Group { raw: grammers_tl_types::enums::Chat::Channel(raw_channel) })
        }
        _ => return,
    };
    state.peer_cache.write().await.insert(chat_id, peer);
}

/// Seed the cache from every stored chat row (startup / post-login).
/// Unconditional overwrite per plan §1.1 (V2-16): the stored row is the
/// authority; richer dialog-scan entries get refreshed on the next scan.
pub async fn seed_chat_peer_cache(state: &TelegramState, app: &AppHandle) {
    let rows = match load_normal_chats(app) {
        Ok(r) => r,
        Err(e) => {
            log::warn!("[CHATS] cache seeding skipped: {}", e);
            return;
        }
    };
    let count = rows.len();
    for c in rows {
        seed_chat_cache_entry(state, c.chat_id, &c.peer_kind, c.access_hash, &c.title).await;
    }
    log::info!("[CHATS] seeded {} chat peers into cache", count);
}

// ─── Tests ───────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// Build a minimal raw Chat::Chat (basic group).
    fn basic_chat(id: i64, title: &str) -> grammers_tl_types::enums::Chat {
        grammers_tl_types::enums::Chat::Chat(grammers_tl_types::types::Chat {
            creator: false,
            left: false,
            deactivated: false,
            call_active: false,
            call_not_empty: false,
            noforwards: false,
            id,
            title: title.to_string(),
            photo: grammers_tl_types::enums::ChatPhoto::Empty,
            participants_count: 10,
            date: 0,
            version: 0,
            migrated_to: None,
            admin_rights: None,
            default_banned_rights: None,
        })
    }

    fn forbidden_chat(id: i64) -> grammers_tl_types::enums::Chat {
        grammers_tl_types::enums::Chat::Forbidden(grammers_tl_types::types::ChatForbidden {
            id,
            title: "Gone".to_string(),
        })
    }

    fn megagroup(id: i64, title: &str, hash: i64) -> Peer {
        Peer::Group(grammers_client::types::Group {
            raw: grammers_tl_types::enums::Chat::Channel(grammers_tl_types::types::Channel {
                creator: false,
                left: false,
                broadcast: false,
                verified: false,
                megagroup: true,
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
                id,
                access_hash: Some(hash),
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
            }),
        })
    }

    fn user(id: i64, first: &str, bot: bool) -> Peer {
        let mut raw = minimal_user(id, first);
        raw.bot = bot;
        Peer::User(grammers_client::types::User {
            raw: grammers_tl_types::enums::User::User(raw),
        })
    }

    /// Full-field tl User with sane defaults (the struct has 46 fields).
    fn minimal_user(id: i64, first: &str) -> grammers_tl_types::types::User {
        grammers_tl_types::types::User {
            is_self: false,
            contact: false,
            mutual_contact: false,
            deleted: false,
            bot: false,
            bot_chat_history: false,
            bot_nochats: false,
            verified: false,
            restricted: false,
            min: false,
            bot_inline_geo: false,
            support: false,
            scam: false,
            apply_min_photo: false,
            fake: false,
            bot_attach_menu: false,
            premium: false,
            attach_menu_enabled: false,
            bot_can_edit: false,
            close_friend: false,
            stories_hidden: false,
            stories_unavailable: false,
            contact_require_premium: false,
            bot_business: false,
            bot_has_main_app: false,
            bot_forum_view: false,
            id,
            access_hash: Some(777),
            first_name: Some(first.to_string()),
            last_name: None,
            username: None,
            phone: None,
            photo: None,
            status: None,
            bot_info_version: None,
            restriction_reason: None,
            bot_inline_placeholder: None,
            lang_code: None,
            emoji_status: None,
            usernames: None,
            stories_max_id: None,
            color: None,
            profile_color: None,
            bot_active_users: None,
            bot_verification_icon: None,
            send_paid_messages_stars: None,
        }
    }

    fn empty_sets() -> (HashSet<i64>, HashSet<i64>) {
        (HashSet::new(), HashSet::new())
    }

    #[test]
    fn self_is_excluded() {
        let (adopted, added) = empty_sets();
        assert!(classify_dialog_peer(&user(42, "Me", false), 42, &adopted, &added).is_none());
    }

    #[test]
    fn broadcast_channel_is_excluded() {
        let (adopted, added) = empty_sets();
        let peer = Peer::Channel(grammers_client::types::Channel {
            raw: grammers_tl_types::types::Channel {
                creator: false, left: false, broadcast: true, verified: false, megagroup: false,
                restricted: false, signatures: false, min: false, scam: false, has_link: false,
                has_geo: false, slowmode_enabled: false, call_active: false, call_not_empty: false,
                fake: false, gigagroup: false, noforwards: false, join_to_send: false,
                join_request: false, forum: false, stories_hidden: false, stories_hidden_min: false,
                stories_unavailable: false, signature_profiles: false, autotranslation: false,
                broadcast_messages_allowed: false, monoforum: false, forum_tabs: false,
                id: 100, access_hash: Some(1), title: "News".into(), username: None,
                photo: grammers_tl_types::enums::ChatPhoto::Empty, date: 0, restriction_reason: None,
                admin_rights: None, banned_rights: None, default_banned_rights: None,
                participants_count: None, usernames: None, stories_max_id: None, color: None,
                profile_color: None, emoji_status: None, level: None, subscription_until_date: None,
                bot_verification_icon: None, send_paid_messages_stars: None, linked_monoforum_id: None,
            },
        });
        assert!(classify_dialog_peer(&peer, 1, &adopted, &added).is_none());
    }

    #[test]
    fn forbidden_and_empty_groups_are_excluded() {
        let (adopted, added) = empty_sets();
        let forbidden = Peer::Group(grammers_client::types::Group { raw: forbidden_chat(5) });
        assert!(classify_dialog_peer(&forbidden, 1, &adopted, &added).is_none());
        let empty = Peer::Group(grammers_client::types::Group {
            raw: grammers_tl_types::enums::Chat::Empty(grammers_tl_types::types::ChatEmpty { id: 6 }),
        });
        assert!(classify_dialog_peer(&empty, 1, &adopted, &added).is_none());
    }

    #[test]
    fn adopted_megagroup_is_excluded() {
        let mut adopted = HashSet::new();
        adopted.insert(900);
        let (_, added) = empty_sets();
        let peer = megagroup(900, "My Group", 42);
        assert!(classify_dialog_peer(&peer, 1, &adopted, &added).is_none());
    }

    #[test]
    fn nb_titled_megagroup_is_excluded() {
        let (adopted, added) = empty_sets();
        let peer = megagroup(901, "Stuff [NB]", 42);
        assert!(classify_dialog_peer(&peer, 1, &adopted, &added).is_none());
    }

    #[test]
    fn plain_megagroup_is_included_with_hash() {
        let (adopted, added) = empty_sets();
        let peer = megagroup(902, "Friends", 42);
        let (kind, hash, title, already) = classify_dialog_peer(&peer, 1, &adopted, &added).unwrap();
        assert_eq!(kind, "group");
        assert_eq!(hash, Some(42));
        assert_eq!(title, "Friends");
        assert!(!already);
    }

    #[test]
    fn basic_group_is_included_hashless() {
        let (adopted, added) = empty_sets();
        let peer = Peer::Group(grammers_client::types::Group { raw: basic_chat(7, "Old Gang") });
        let (kind, hash, title, already) = classify_dialog_peer(&peer, 1, &adopted, &added).unwrap();
        assert_eq!(kind, "basic_group");
        assert_eq!(hash, None);
        assert_eq!(title, "Old Gang");
        assert!(!already);
    }

    #[test]
    fn user_dm_is_included_and_flagged_when_added() {
        let (adopted, mut added) = empty_sets();
        added.insert(50);
        let (kind, hash, _title, already) =
            classify_dialog_peer(&user(50, "Alice", false), 1, &adopted, &added).unwrap();
        assert_eq!(kind, "user");
        assert_eq!(hash, Some(777));
        assert!(already);

        let (kind2, _, _, already2) =
            classify_dialog_peer(&user(51, "Bob", false), 1, &adopted, &added).unwrap();
        assert_eq!(kind2, "user");
        assert!(!already2);
    }

    #[test]
    fn bots_are_included() {
        let (adopted, added) = empty_sets();
        let (kind, _, _, _) =
            classify_dialog_peer(&user(60, "HelperBot", true), 1, &adopted, &added).unwrap();
        assert_eq!(kind, "user");
    }

    #[test]
    fn dialog_id_uses_raw_chat_id_not_packed() {
        // Group::id() would return a packed PeerId; dialog_id must return the
        // raw chat id so the picker's chat_id matches what cmd_add_chat stores
        // and what resolve_peer caches.
        let peer = Peer::Group(grammers_client::types::Group { raw: basic_chat(1234, "X") });
        assert_eq!(dialog_id(&peer), 1234);

        let mg = megagroup(5678, "Y", 1);
        assert_eq!(dialog_id(&mg), 5678);

        let u = user(99, "Z", false);
        assert_eq!(dialog_id(&u), 99);
    }

    // ── R2: resolve_chat_peer construction ──────────────────────

    fn chat_row(kind: &str, id: i64, hash: Option<i64>) -> ChatInfo {
        ChatInfo {
            chat_id: id,
            peer_kind: kind.to_string(),
            access_hash: hash,
            title: "T".into(),
            added_at: 0,
            group_id: None,
            is_bot: false,
        }
    }

    #[test]
    fn resolve_chat_peer_user_builds_input_peer_user_with_hash() {
        let p = resolve_chat_peer(&chat_row("user", 42, Some(777))).unwrap();
        match p {
            grammers_tl_types::enums::InputPeer::User(u) => {
                assert_eq!(u.user_id, 42);
                assert_eq!(u.access_hash, 777);
            }
            other => panic!("expected InputPeerUser, got {:?}", other),
        }
    }

    #[test]
    fn resolve_chat_peer_basic_group_builds_input_peer_chat_hashless() {
        let p = resolve_chat_peer(&chat_row("basic_group", 7, None)).unwrap();
        match p {
            grammers_tl_types::enums::InputPeer::Chat(c) => assert_eq!(c.chat_id, 7),
            other => panic!("expected InputPeerChat, got {:?}", other),
        }
    }

    #[test]
    fn resolve_chat_peer_supergroup_builds_input_peer_channel_with_hash() {
        let p = resolve_chat_peer(&chat_row("group", 900, Some(123))).unwrap();
        match p {
            grammers_tl_types::enums::InputPeer::Channel(c) => {
                assert_eq!(c.channel_id, 900);
                assert_eq!(c.access_hash, 123);
            }
            other => panic!("expected InputPeerChannel, got {:?}", other),
        }
    }

    #[test]
    fn resolve_chat_peer_missing_hash_errors_for_user_and_supergroup() {
        assert!(resolve_chat_peer(&chat_row("user", 1, None)).is_err());
        assert!(resolve_chat_peer(&chat_row("group", 2, None)).is_err());
        // basic_group legitimately has no hash
        assert!(resolve_chat_peer(&chat_row("basic_group", 3, None)).is_ok());
        // unknown kind rejected
        assert!(resolve_chat_peer(&chat_row("channel", 4, Some(5))).is_err());
    }

    // ── R2: CHAT_GONE error mapping ──────────────────────────────

    #[test]
    fn chat_gone_error_mapping() {
        assert!(is_chat_gone_error("CHAT_GONE: x"));
        assert!(is_chat_gone_error("USER_IS_BLOCKED"));
        assert!(is_chat_gone_error("USER_ID_INVALID"));
        assert!(is_chat_gone_error("PEER_ID_INVALID"));
        assert!(is_chat_gone_error("USER_NOT_PARTICIPANT"));
        assert!(is_chat_gone_error("CHAT_ID_INVALID"));
        assert!(is_chat_gone_error("CHANNEL_PRIVATE"));
        // Transient errors must NOT map to CHAT_GONE (D13 false-positive guard)
        assert!(!is_chat_gone_error("FLOOD_WAIT_30"));
        assert!(!is_chat_gone_error("timeout"));
        assert!(!is_chat_gone_error("network error"));
    }

    #[test]
    fn nb_titled_basic_group_is_excluded() {
        let (adopted, added) = empty_sets();
        let peer = Peer::Group(grammers_client::types::Group { raw: basic_chat(8, "Stuff [NB]") });
        assert!(classify_dialog_peer(&peer, 1, &adopted, &added).is_none());
    }

    #[test]
    fn user_empty_stub_is_excluded() {
        let (adopted, added) = empty_sets();
        let peer = Peer::User(grammers_client::types::User {
            raw: grammers_tl_types::enums::User::Empty(grammers_tl_types::types::UserEmpty { id: 77 }),
        });
        assert!(classify_dialog_peer(&peer, 1, &adopted, &added).is_none());
    }

    #[test]
    fn stale_hash_error_mapping() {
        assert!(is_stale_hash_error("PEER_ID_INVALID"));
        assert!(is_stale_hash_error("USER_ID_INVALID"));
        assert!(is_stale_hash_error("CHANNEL_INVALID"));
        assert!(is_stale_hash_error("CHANNEL_ID_INVALID"));
        assert!(!is_stale_hash_error("FLOOD_WAIT_30"));
        assert!(!is_stale_hash_error("USER_IS_BLOCKED"));
    }

    // ── Review fixes: source-scan guards (house pattern) ────────

    #[test]
    fn archive_scan_advances_offset_peer_between_pages() {
        // Regression guard for the fixed pagination bug (review MAJOR, three
        // reviewers converged): scan_archive_for_chat must advance offset_peer
        // from the last dialog's peer and keep offset_date = 0 — the old code
        // wrote top_message (a MESSAGE ID) into offset_date and never moved
        // offset_peer, truncating the archive to page 1.
        let src = include_str!("normal_chats.rs");
        let start = src.find("async fn scan_archive_for_chat").expect("fn exists");
        let end = src[start..].find("/// List a chat's media history").map(|i| start + i).expect("next fn");
        let body = &src[start..end];
        // offset_date is reset to 0 (never assigned top_message)...
        assert!(body.contains("offset_date = 0;"), "must reset offset_date per adopted pattern");
        assert!(!body.contains("offset_date = d_date"), "offset_date must not receive top_message");
        // ...offset_peer is reassigned (not a frozen Empty)...
        assert!(body.contains("offset_peer = match &dd.peer"), "must advance offset_peer from last dialog");
        // ...and the users array is scanned (archived DMs live there).
        assert!(body.contains("for u in &users"), "must scan users for archived DMs");
    }
}
