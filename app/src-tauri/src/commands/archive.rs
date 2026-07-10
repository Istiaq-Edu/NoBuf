use serde::Serialize;
use std::io::Cursor;

#[derive(Debug, Serialize, Clone)]
pub struct ArchiveEntry {
    pub filename: String,
    pub size: u64,
    pub is_dir: bool,
}

#[derive(Debug, Serialize)]
pub struct ExtractedFile {
    pub temp_path: String,
    pub filename: String,
    pub size: u64,
}

enum ArchiveType {
    Zip,
    Rar,
    SevenZ,
}

fn detect_archive_type(filename: &str) -> Option<ArchiveType> {
    let lower = filename.to_lowercase();
    if lower.ends_with(".zip") {
        Some(ArchiveType::Zip)
    } else if lower.ends_with(".rar") {
        Some(ArchiveType::Rar)
    } else if lower.ends_with(".7z") {
        Some(ArchiveType::SevenZ)
    } else {
        None
    }
}

/// Sanitize archive entry names to prevent directory traversal.
/// Extracts only the file_name component, stripping any path prefixes.
fn sanitise_entry_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

/// List the contents of an archive (ZIP, RAR, or 7Z).
/// ZIP: parsed in-memory. RAR/7Z: downloaded to temp file, extracted.
#[tauri::command]
pub async fn cmd_list_archive_contents(
    message_id: i32,
    folder_id: Option<i64>,
    state: tauri::State<'_, crate::commands::TelegramState>,
) -> Result<Vec<ArchiveEntry>, String> {
    let client_opt = { state.client.lock().await.clone() };
    if client_opt.is_none() {
        return Ok(Vec::new());
    }
    let client = client_opt.unwrap();

    let peer = crate::commands::utils::resolve_peer(&client, folder_id, &state.peer_cache).await?;

    let messages = client.get_messages_by_id(&peer, &[message_id]).await.map_err(|e| e.to_string())?;
    let msg = messages.into_iter().flatten().next().ok_or("Message not found")?;
    let media = msg.media().ok_or("No media in message")?;

    let (filename, _size) = match &media {
        grammers_client::types::Media::Document(d) => (d.name().to_string(), d.size()),
        _ => return Err("Not a document".to_string()),
    };

    let archive_type = detect_archive_type(&filename).ok_or("Not a supported archive format")?;

    match archive_type {
        ArchiveType::Zip => {
            // Download to memory — use semaphore + rate limiter to prevent FLOOD_PREMIUM_WAIT
            let mut data = Vec::new();
            let mut iter = client.iter_download(&media).chunk_size(512 * 1024);
            loop {
                let chunk_result = {
                    let _permit = state.download_semaphore.acquire().await.unwrap();
                    iter.next().await
                };
                let chunk = match chunk_result {
                    Ok(Some(c)) => c,
                    Ok(None) => break,
                    Err(e) => return Err(format!("Download error: {}", e)),
                };
                data.extend_from_slice(&chunk);
                tokio::task::yield_now().await;
            }

            let cursor = Cursor::new(data);
            let mut archive = zip::ZipArchive::new(cursor).map_err(|e| format!("ZIP open error: {}", e))?;

            let mut entries = Vec::new();
            for i in 0..archive.len() {
                let entry = archive.by_index(i).map_err(|e| format!("ZIP entry error: {}", e))?;
                entries.push(ArchiveEntry {
                    filename: sanitise_entry_name(entry.name()),
                    size: entry.size(),
                    is_dir: entry.is_dir(),
                });
            }
            Ok(entries)
        }
        ArchiveType::Rar => {
            // RAR: download to temp file, extract with rar crate
            let temp_dir = std::env::temp_dir().join("nobuf_archive_rar");
            std::fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
            let extract_dir = temp_dir.join(format!("extract_{}", message_id));
            std::fs::create_dir_all(&extract_dir).map_err(|e| e.to_string())?;
            let temp_path = temp_dir.join(format!("archive_{}.rar", message_id));

            let mut file = std::fs::File::create(&temp_path).map_err(|e| e.to_string())?;
            let mut iter = client.iter_download(&media).chunk_size(512 * 1024);
            loop {
                let chunk_result = {
                    let _permit = state.download_semaphore.acquire().await.unwrap();
                    iter.next().await
                };
                let chunk = match chunk_result {
                    Ok(Some(c)) => c,
                    Ok(None) => break,
                    Err(e) => return Err(format!("Download error: {}", e)),
                };
                std::io::Write::write_all(&mut file, &chunk).map_err(|e| e.to_string())?;
                tokio::task::yield_now().await;
            }
            drop(file);

            // Extract all — password is empty string for non-encrypted archives
            let archive = rar::Archive::extract_all(
                temp_path.to_str().unwrap(),
                extract_dir.to_str().unwrap(),
                "",
            ).map_err(|e| format!("RAR extract error: {}", e))?;

            // Security: Verify no files were written outside the extract directory (path traversal check)
            let extract_canonical = extract_dir.canonicalize().map_err(|e| e.to_string())?;
            for f in &archive.files {
                let extracted_path = extract_dir.join(&f.name);
                if let Ok(canonical) = extracted_path.canonicalize() {
                    if !canonical.starts_with(&extract_canonical) {
                        // Path traversal detected — clean up and reject
                        let _ = std::fs::remove_dir_all(&extract_dir);
                        let _ = std::fs::remove_file(&temp_path);
                        return Err(format!("Archive contains path traversal entry: '{}'", f.name));
                    }
                }
            }

            // Build entries from the archive's file list
            let mut entries = Vec::new();
            for f in &archive.files {
                entries.push(ArchiveEntry {
                    filename: sanitise_entry_name(&f.name),
                    size: f.unpacked_size as u64,
                    is_dir: false, // rar crate doesn't expose is_dir directly
                });
            }

            // Cleanup
            let _ = std::fs::remove_file(&temp_path);
            let _ = std::fs::remove_dir_all(&extract_dir);

            Ok(entries)
        }
        ArchiveType::SevenZ => {
            // 7z: download to temp file, list with sevenz-rust2
            let temp_dir = std::env::temp_dir().join("nobuf_archive_7z");
            std::fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
            let temp_path = temp_dir.join(format!("archive_{}.7z", message_id));

            let mut file = std::fs::File::create(&temp_path).map_err(|e| e.to_string())?;
            let mut iter = client.iter_download(&media).chunk_size(512 * 1024);
            loop {
                let chunk_result = {
                    let _permit = state.download_semaphore.acquire().await.unwrap();
                    iter.next().await
                };
                let chunk = match chunk_result {
                    Ok(Some(c)) => c,
                    Ok(None) => break,
                    Err(e) => return Err(format!("Download error: {}", e)),
                };
                std::io::Write::write_all(&mut file, &chunk).map_err(|e| e.to_string())?;
                tokio::task::yield_now().await;
            }
            drop(file);

            // Open archive and read entries
            let archive = sevenz_rust2::Archive::open(&temp_path)
                .map_err(|e| format!("7z open error: {}", e))?;

            let mut entries = Vec::new();
            for entry in &archive.files {
                entries.push(ArchiveEntry {
                    filename: sanitise_entry_name(entry.name()),
                    size: entry.size(),
                    is_dir: entry.is_directory(),
                });
            }

            // Cleanup
            let _ = std::fs::remove_file(&temp_path);

            Ok(entries)
        }
    }
}

/// Extract a specific entry from a ZIP archive to a temp file.
#[tauri::command]
pub async fn cmd_extract_archive_entry(
    message_id: i32,
    folder_id: Option<i64>,
    entry_index: usize,
    state: tauri::State<'_, crate::commands::TelegramState>,
) -> Result<ExtractedFile, String> {
    let client_opt = { state.client.lock().await.clone() };
    if client_opt.is_none() {
        return Err("Not connected".to_string());
    }
    let client = client_opt.unwrap();

    let peer = crate::commands::utils::resolve_peer(&client, folder_id, &state.peer_cache).await?;

    let messages = client.get_messages_by_id(&peer, &[message_id]).await.map_err(|e| e.to_string())?;
    let msg = messages.into_iter().flatten().next().ok_or("Message not found")?;
    let media = msg.media().ok_or("No media in message")?;

    let (filename, _size) = match &media {
        grammers_client::types::Media::Document(d) => (d.name().to_string(), d.size()),
        _ => return Err("Not a document".to_string()),
    };

    if !filename.to_lowercase().ends_with(".zip") {
        return Err("Individual entry extraction only supported for ZIP".to_string());
    }

    // Download to memory
    let mut data = Vec::new();
    let mut iter = client.iter_download(&media).chunk_size(512 * 1024);
    loop {
        let chunk_result = {
            let _permit = state.download_semaphore.acquire().await.unwrap();
            iter.next().await
        };
        let chunk = match chunk_result {
            Ok(Some(c)) => c,
            Ok(None) => break,
            Err(e) => return Err(format!("Download error: {}", e)),
        };
        data.extend_from_slice(&chunk);
        tokio::task::yield_now().await;
    }

    let cursor = Cursor::new(data);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| format!("ZIP open error: {}", e))?;

    let mut entry = archive.by_index(entry_index).map_err(|e| format!("ZIP entry error: {}", e))?;
    let entry_name = sanitise_entry_name(entry.name());
    let entry_size = entry.size();

    let temp_dir = std::env::temp_dir().join("nobuf_extract");
    std::fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
    let temp_path = temp_dir.join(&entry_name);

    let mut file = std::fs::File::create(&temp_path).map_err(|e| e.to_string())?;
    std::io::copy(&mut entry, &mut file).map_err(|e| format!("Extract write error: {}", e))?;

    Ok(ExtractedFile {
        temp_path: temp_path.to_string_lossy().to_string(),
        filename: entry_name,
        size: entry_size,
    })
}

/// Compress a folder to a ZIP file and return the path.
/// Used for folder upload feature — the ZIP is uploaded to Telegram.
#[tauri::command]
pub async fn cmd_zip_folder(
    folder_path: String,
    state: tauri::State<'_, crate::commands::TelegramState>,
) -> Result<String, String> {
    let source = std::path::Path::new(&folder_path);
    if !source.exists() {
        return Err(format!("Source folder does not exist: {}", folder_path));
    }
    if !source.is_dir() {
        return Err(format!("Path is not a directory: {}", folder_path));
    }

    // Create temp ZIP file
    let temp_dir = std::env::temp_dir().join("nobuf_zip");
    std::fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
    let folder_name = source.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or("folder".to_string());
    let zip_path = temp_dir.join(format!("{}.zip", folder_name));

    let zip_file = std::fs::File::create(&zip_path).map_err(|e| e.to_string())?;
    let mut zip_writer = zip::ZipWriter::new(zip_file);
    let zip_options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    // Walk the directory tree — DO NOT follow symlinks (security: prevents including files outside the folder)
    for entry in walkdir::WalkDir::new(&folder_path).follow_links(false) {
        let entry = entry.map_err(|e| format!("Walk error: {}", e))?;
        let path = entry.path();
        let relative = path.strip_prefix(source).map_err(|e| e.to_string())?;

        // Skip symlinks entirely
        if entry.file_type().is_symlink() {
            log::warn!("[ZIP] Skipping symlink: {}", path.display());
            continue;
        }

        if path.is_dir() {
            if relative.as_os_str().is_empty() {
                continue;
            }
            zip_writer.add_directory(relative.to_string_lossy(), zip_options)
                .map_err(|e| format!("ZIP add dir error: {}", e))?;
        } else {
            zip_writer.start_file(relative.to_string_lossy(), zip_options)
                .map_err(|e| format!("ZIP start file error: {}", e))?;
            let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
            std::io::copy(&mut file, &mut zip_writer).map_err(|e| format!("ZIP copy error: {}", e))?;
        }
    }

    zip_writer.finish().map_err(|e| format!("ZIP finish error: {}", e))?;

    // Check upload size limit (Premium-aware — 4 GB Premium, 2 GB free)
    let zip_size = std::fs::metadata(&zip_path).map(|m| m.len()).unwrap_or(0);
    let limit = {
        let client_opt = { state.client.lock().await.clone() };
        match client_opt {
            Some(client) => crate::commands::utils::upload_limit_bytes(&client).await.unwrap_or(2_000_000_000),
            None => 2_000_000_000,
        }
    };
    if zip_size > limit {
        let _ = std::fs::remove_file(&zip_path);
        return Err(format!("Compressed folder exceeds the {} GB upload limit ({} bytes)", limit / 1_000_000_000, zip_size));
    }

    log::info!("Folder zipped: {} → {} ({} bytes)", folder_path, zip_path.display(), zip_size);
    Ok(zip_path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_archive_type_zip() {
        assert!(matches!(detect_archive_type("file.zip"), Some(ArchiveType::Zip)));
        assert!(matches!(detect_archive_type("FILE.ZIP"), Some(ArchiveType::Zip)));
    }

    #[test]
    fn test_detect_archive_type_rar() {
        assert!(matches!(detect_archive_type("file.rar"), Some(ArchiveType::Rar)));
    }

    #[test]
    fn test_detect_archive_type_7z() {
        assert!(matches!(detect_archive_type("file.7z"), Some(ArchiveType::SevenZ)));
    }

    #[test]
    fn test_detect_archive_type_invalid() {
        assert!(detect_archive_type("file.txt").is_none());
        assert!(detect_archive_type("file.mp4").is_none());
    }

    #[test]
    fn test_sanitise_entry_name_strips_path() {
        assert_eq!(sanitise_entry_name("../../../etc/passwd"), "passwd");
        assert_eq!(sanitise_entry_name("folder/subfolder/file.txt"), "file.txt");
        assert_eq!(sanitise_entry_name("file.txt"), "file.txt");
    }
}


