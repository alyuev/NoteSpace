//! Desktop storage for NoteSpace: the same files and operations as the dev server
//! (`server/dataPlugin.ts`), kept in the user's app data folder
//! (`%APPDATA%\com.notespace.app` on Windows):
//!
//!   index.json                 { activeId }
//!   spaces/<id>.json           one space per file
//!   backups/<id>/<stamp>--<reason>.json
//!   images/<name>              pictures for node styles (served through the asset protocol)

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

type Res<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn data_dir(app: &AppHandle) -> Res<PathBuf> {
    let dir = app.path().app_data_dir().map_err(err)?;
    fs::create_dir_all(dir.join("spaces")).map_err(err)?;
    Ok(dir)
}

/// Ids and file names come from the page: allow only safe characters (no paths).
fn safe_id(id: &str) -> Res<&str> {
    let ok = !id.is_empty() && id.len() <= 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok { Ok(id) } else { Err(format!("bad id: {id}")) }
}

fn safe_file(name: &str, exts: &[&str]) -> Res<String> {
    let (stem, ext) = name.rsplit_once('.').ok_or("bad file name")?;
    let ok = !stem.is_empty()
        && name.len() <= 160
        && stem.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
        && exts.contains(&ext.to_ascii_lowercase().as_str());
    if ok { Ok(name.to_string()) } else { Err(format!("bad file name: {name}")) }
}

/// File modification time in ms: lets the page tell its own writes apart.
fn rev(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn write_atomic(path: &Path, text: &str) -> Res<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(err)?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(err)?;
    fs::rename(&tmp, path).map_err(err)
}

fn space_file(app: &AppHandle, id: &str) -> Res<PathBuf> {
    Ok(data_dir(app)?.join("spaces").join(format!("{}.json", safe_id(id)?)))
}

/// Copies a space file into its backups; returns the backup's name (None if there is no file).
fn backup(app: &AppHandle, id: &str, reason: &str) -> Res<Option<String>> {
    let file = space_file(app, id)?;
    if !file.exists() {
        return Ok(None);
    }
    let dir = data_dir(app)?.join("backups").join(safe_id(id)?);
    fs::create_dir_all(&dir).map_err(err)?;
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).map_err(err)?.as_millis();
    let reason: String = reason.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).take(40).collect();
    let name = format!("{ms:013}--{}.json", if reason.is_empty() { "manual".into() } else { reason });
    fs::copy(&file, dir.join(&name)).map_err(err)?;
    Ok(Some(name))
}

#[derive(Serialize)]
struct Meta {
    id: String,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    en: Option<serde_json::Value>,
    rev: u64,
}

#[derive(Serialize)]
struct Loaded {
    /// The space as JSON text (parsed on the page).
    space: String,
    rev: u64,
}

#[derive(Serialize)]
struct BackupInfo {
    name: String,
    reason: String,
    time: u64,
}

#[tauri::command]
fn data_path(app: AppHandle) -> Res<String> {
    Ok(data_dir(&app)?.to_string_lossy().into_owned())
}

#[tauri::command]
fn list_spaces(app: AppHandle) -> Res<Vec<Meta>> {
    let dir = data_dir(&app)?.join("spaces");
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(err)? {
        let path = entry.map_err(err)?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        // Half-written or broken files are skipped.
        let Ok(text) = fs::read_to_string(&path) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        let (Some(id), Some(title)) = (v["id"].as_str(), v["title"].as_str()) else { continue };
        out.push(Meta { id: id.into(), title: title.into(), en: v.get("en").cloned(), rev: rev(&path) });
    }
    Ok(out)
}

#[tauri::command]
fn get_space(app: AppHandle, id: String) -> Res<Option<Loaded>> {
    let file = space_file(&app, &id)?;
    if !file.exists() {
        return Ok(None);
    }
    Ok(Some(Loaded { space: fs::read_to_string(&file).map_err(err)?, rev: rev(&file) }))
}

#[tauri::command]
fn put_space(app: AppHandle, id: String, json: String) -> Res<u64> {
    // The text must be a space with the same id.
    let v: serde_json::Value = serde_json::from_str(&json).map_err(err)?;
    if v["id"].as_str() != Some(id.as_str()) {
        return Err("id mismatch".into());
    }
    let file = space_file(&app, &id)?;
    write_atomic(&file, &json)?;
    Ok(rev(&file))
}

#[tauri::command]
fn delete_space(app: AppHandle, id: String) -> Res<()> {
    backup(&app, &id, "before-delete")?;
    let file = space_file(&app, &id)?;
    if file.exists() {
        fs::remove_file(file).map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
fn get_index(app: AppHandle) -> Res<String> {
    let file = data_dir(&app)?.join("index.json");
    Ok(fs::read_to_string(file).unwrap_or_else(|_| "{}".into()))
}

#[tauri::command]
fn put_index(app: AppHandle, json: String) -> Res<()> {
    serde_json::from_str::<serde_json::Value>(&json).map_err(err)?;
    write_atomic(&data_dir(&app)?.join("index.json"), &json)
}

#[tauri::command]
fn list_backups(app: AppHandle, id: String) -> Res<Vec<BackupInfo>> {
    let dir = data_dir(&app)?.join("backups").join(safe_id(&id)?);
    let Ok(entries) = fs::read_dir(&dir) else { return Ok(Vec::new()) };
    let mut out: Vec<BackupInfo> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let reason = name.split_once("--")?.1.trim_end_matches(".json").to_string();
            Some(BackupInfo { time: rev(&e.path()), name, reason })
        })
        .collect();
    out.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(out)
}

#[tauri::command]
fn backup_space(app: AppHandle, id: String, reason: String) -> Res<Option<String>> {
    backup(&app, &id, &reason)
}

#[tauri::command]
fn restore_backup(app: AppHandle, id: String, name: String) -> Res<Loaded> {
    let src = data_dir(&app)?.join("backups").join(safe_id(&id)?).join(safe_file(&name, &["json"])?);
    if !src.exists() {
        return Err("backup not found".into());
    }
    backup(&app, &id, "before-restore")?;
    let text = fs::read_to_string(&src).map_err(err)?;
    let file = space_file(&app, &id)?;
    write_atomic(&file, &text)?;
    Ok(Loaded { space: text, rev: rev(&file) })
}

#[tauri::command]
fn save_image(app: AppHandle, name: String, data: Vec<u8>) -> Res<()> {
    if data.is_empty() || data.len() > 8 * 1024 * 1024 {
        return Err("empty or too large".into());
    }
    let name = safe_file(&name, &["png", "jpg", "jpeg", "gif", "webp", "svg"])?;
    let dir = data_dir(&app)?.join("images");
    fs::create_dir_all(&dir).map_err(err)?;
    fs::write(dir.join(name), data).map_err(err)
}

/// Names of the pictures saved in the data folder.
#[tauri::command]
fn list_images(app: AppHandle) -> Res<Vec<String>> {
    let Ok(entries) = fs::read_dir(data_dir(&app)?.join("images")) else { return Ok(Vec::new()) };
    Ok(entries.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            data_path,
            list_spaces,
            get_space,
            put_space,
            delete_space,
            get_index,
            put_index,
            list_backups,
            backup_space,
            restore_backup,
            save_image,
            list_images
        ])
        .run(tauri::generate_context!())
        .expect("error while running NoteSpace");
}
