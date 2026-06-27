use serde::{Deserialize, Serialize};
use sqlite::{Connection, Value};
use tauri::{AppHandle, Manager};
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FolderGroup {
    pub id: i64,
    pub name: String,
    pub color_hex: String,
    pub display_order: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EnrichedFolder {
    pub id: i64,
    pub name: String,
    pub group_id: Option<i64>,
    pub group_name: Option<String>,
    pub group_color: Option<String>,
    pub display_order: i64,
    pub is_public: bool,
}

fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("nobuf_groups.db"))
}

fn get_connection(app: &AppHandle) -> Result<Connection, String> {
    let path = db_path(app)?;
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.execute("CREATE TABLE IF NOT EXISTS groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color_hex TEXT DEFAULT '#22c55e', display_order INTEGER NOT NULL DEFAULT 0)").map_err(|e| e.to_string())?;
    conn.execute("CREATE TABLE IF NOT EXISTS folder_metadata (channel_id INTEGER PRIMARY KEY, name TEXT NOT NULL, display_order INTEGER NOT NULL DEFAULT 0, group_id INTEGER, FOREIGN KEY(group_id) REFERENCES groups(id) ON DELETE SET NULL)").map_err(|e| e.to_string())?;
    Ok(conn)
}

fn vi(v: &Value) -> i64 {
    match v { Value::Integer(i) => *i, _ => 0 }
}

fn vs(v: &Value) -> String {
    match v { Value::String(s) => s.clone(), _ => String::new() }
}

fn voi(v: &Value) -> Option<i64> {
    match v { Value::Integer(i) => Some(*i), _ => None }
}

fn vos(v: &Value) -> Option<String> {
    match v { Value::String(s) => Some(s.clone()), _ => None }
}

#[tauri::command]
pub fn cmd_get_groups(app: AppHandle) -> Result<Vec<FolderGroup>, String> {
    let conn = get_connection(&app)?;
    let mut groups = Vec::new();
    let mut stmt = conn.prepare("SELECT id, name, color_hex, display_order FROM groups ORDER BY display_order").map_err(|e| e.to_string())?;
    let mut cursor = stmt.iter();
    while let Some(Ok(row)) = cursor.next() {
        groups.push(FolderGroup { id: vi(&row[0]), name: vs(&row[1]), color_hex: vs(&row[2]), display_order: vi(&row[3]) });
    }
    Ok(groups)
}

#[tauri::command]
pub fn cmd_create_group(name: String, color_hex: String, app: AppHandle) -> Result<i64, String> {
    let conn = get_connection(&app)?;
    let max_order: i64 = {
        let mut stmt = conn.prepare("SELECT COALESCE(MAX(display_order), -1) FROM groups").map_err(|e| e.to_string())?;
        let mut c = stmt.iter();
        if let Some(Ok(row)) = c.next() { vi(&row[0]) } else { -1 }
    };
    let mut stmt = conn.prepare("INSERT INTO groups (name, color_hex, display_order) VALUES (?, ?, ?)").map_err(|e| e.to_string())?;
    stmt.bind((1, name.as_str())).map_err(|e| e.to_string())?;
    stmt.bind((2, color_hex.as_str())).map_err(|e| e.to_string())?;
    stmt.bind((3, max_order + 1)).map_err(|e| e.to_string())?;
    stmt.iter().next();
    let mut stmt = conn.prepare("SELECT last_insert_rowid()").map_err(|e| e.to_string())?;
    let mut c = stmt.iter();
    if let Some(Ok(row)) = c.next() { Ok(vi(&row[0])) } else { Err("Failed to get inserted ID".to_string()) }
}

#[tauri::command]
pub fn cmd_update_group(id: i64, name: String, color_hex: String, app: AppHandle) -> Result<bool, String> {
    let conn = get_connection(&app)?;
    let mut stmt = conn.prepare("UPDATE groups SET name = ?, color_hex = ? WHERE id = ?").map_err(|e| e.to_string())?;
    stmt.bind((1, name.as_str())).map_err(|e| e.to_string())?;
    stmt.bind((2, color_hex.as_str())).map_err(|e| e.to_string())?;
    stmt.bind((3, id)).map_err(|e| e.to_string())?;
    stmt.iter().next();
    Ok(true)
}

#[tauri::command]
pub fn cmd_delete_group(id: i64, app: AppHandle) -> Result<bool, String> {
    let conn = get_connection(&app)?;
    let mut stmt = conn.prepare("DELETE FROM groups WHERE id = ?").map_err(|e| e.to_string())?;
    stmt.bind((1, id)).map_err(|e| e.to_string())?;
    stmt.iter().next();
    let mut stmt = conn.prepare("UPDATE folder_metadata SET group_id = NULL WHERE group_id = ?").map_err(|e| e.to_string())?;
    stmt.bind((1, id)).map_err(|e| e.to_string())?;
    stmt.iter().next();
    Ok(true)
}

#[tauri::command]
pub fn cmd_assign_folder_to_group(channel_id: i64, group_id: Option<i64>, app: AppHandle) -> Result<bool, String> {
    let conn = get_connection(&app)?;
    match group_id {
        Some(gid) => {
            let mut stmt = conn.prepare("INSERT INTO folder_metadata (channel_id, name, display_order, group_id) VALUES (?, '', 0, ?) ON CONFLICT(channel_id) DO UPDATE SET group_id = ?").map_err(|e| e.to_string())?;
            stmt.bind((1, channel_id)).map_err(|e| e.to_string())?;
            stmt.bind((2, gid)).map_err(|e| e.to_string())?;
            stmt.bind((3, gid)).map_err(|e| e.to_string())?;
            stmt.iter().next();
        }
        None => {
            let mut stmt = conn.prepare("INSERT INTO folder_metadata (channel_id, name, display_order, group_id) VALUES (?, '', 0, NULL) ON CONFLICT(channel_id) DO UPDATE SET group_id = NULL").map_err(|e| e.to_string())?;
            stmt.bind((1, channel_id)).map_err(|e| e.to_string())?;
            stmt.iter().next();
        }
    }
    Ok(true)
}

#[tauri::command]
pub fn cmd_update_group_order(group_orders: Vec<(i64, i64)>, app: AppHandle) -> Result<bool, String> {
    let conn = get_connection(&app)?;
    for (id, order) in group_orders {
        let mut stmt = conn.prepare("UPDATE groups SET display_order = ? WHERE id = ?").map_err(|e| e.to_string())?;
        stmt.bind((1, order)).map_err(|e| e.to_string())?;
        stmt.bind((2, id)).map_err(|e| e.to_string())?;
        stmt.iter().next();
    }
    Ok(true)
}

#[tauri::command]
pub fn cmd_get_enriched_folders(app: AppHandle) -> Result<Vec<EnrichedFolder>, String> {
    let conn = get_connection(&app)?;
    let mut folders = Vec::new();
    let mut stmt = conn.prepare("SELECT fm.channel_id, fm.name, fm.group_id, g.name, g.color_hex, fm.display_order FROM folder_metadata fm LEFT JOIN groups g ON fm.group_id = g.id ORDER BY g.display_order, fm.display_order").map_err(|e| e.to_string())?;
    let mut cursor = stmt.iter();
    while let Some(Ok(row)) = cursor.next() {
        folders.push(EnrichedFolder {
            id: vi(&row[0]), name: vs(&row[1]), group_id: voi(&row[2]),
            group_name: vos(&row[3]), group_color: vos(&row[4]), display_order: vi(&row[5]),
            is_public: false,
        });
    }
    Ok(folders)
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_folder_group_struct() {
        let g = super::FolderGroup { id: 1, name: "Test".to_string(), color_hex: "#22c55e".to_string(), display_order: 0 };
        assert_eq!(g.id, 1);
        assert_eq!(g.name, "Test");
    }
}
