use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    env, fs,
    io::{Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream},
    path::PathBuf,
    sync::Mutex,
    time::Duration,
};
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

const KEYRING_SERVICE: &str = "com.githubdiscover.usagecompanion";
const DATA_FILE: &str = "app-data.json";
const LAB_HOST: &str = "127.0.0.1";
const LAB_PORT: u16 = 17_840;

#[derive(Default)]
struct AppState {
    io_lock: Mutex<()>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Settings {
    warning_threshold: u8,
    critical_threshold: u8,
    notifications_enabled: bool,
    refresh_interval_minutes: u16,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            warning_threshold: 70,
            critical_threshold: 90,
            notifications_enabled: true,
            refresh_interval_minutes: 15,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Connection {
    id: String,
    label: String,
    provider: String,
    account_hint: String,
    secret_saved: bool,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct UsageSnapshot {
    used: f64,
    limit: f64,
    unit: String,
    source: String,
    updated_at: String,
    resets_at: Option<String>,
}

impl Default for UsageSnapshot {
    fn default() -> Self {
        Self {
            used: 0.0,
            limit: 100.0,
            unit: "美元".to_string(),
            source: "手动录入".to_string(),
            updated_at: Utc::now().to_rfc3339(),
            resets_at: None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct AppData {
    settings: Settings,
    connections: Vec<Connection>,
    usage: UsageSnapshot,
}

#[derive(Debug, Clone, Serialize)]
struct PlatformInfo {
    os: String,
    arch: String,
    credential_store_available: bool,
    cursor_detected: bool,
    cursor_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct AppSnapshot {
    settings: Settings,
    connections: Vec<Connection>,
    usage: UsageSnapshot,
    platform: PlatformInfo,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
enum LabOperation {
    Health,
    ListAccounts,
    CreateAccounts,
    CreateDevice,
    RotateDevice,
    IssueSession,
    RevokeSession,
    Consume,
    SwitchNext,
    ResetCycle,
    Audit,
}

#[derive(Debug, Clone, Serialize)]
struct LabHttpResponse {
    status: u16,
    body: Value,
}

#[derive(Debug, Deserialize)]
struct ConnectionInput {
    id: Option<String>,
    label: String,
    provider: String,
    account_hint: String,
    secret: String,
}

fn data_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法确定应用数据目录：{error}"))?;
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建应用数据目录：{error}"))?;
    Ok(directory.join(DATA_FILE))
}

fn load_data(app: &AppHandle) -> Result<AppData, String> {
    let path = data_path(app)?;
    if !path.exists() {
        return Ok(AppData::default());
    }
    let content = fs::read_to_string(path).map_err(|error| format!("无法读取应用数据：{error}"))?;
    serde_json::from_str(&content).map_err(|error| format!("应用数据格式损坏：{error}"))
}

fn save_data(app: &AppHandle, data: &AppData) -> Result<(), String> {
    let path = data_path(app)?;
    let content = serde_json::to_string_pretty(data)
        .map_err(|error| format!("无法序列化应用数据：{error}"))?;
    fs::write(path, content).map_err(|error| format!("无法保存应用数据：{error}"))
}

fn cursor_candidates() -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let mut paths = vec![PathBuf::from("/Applications/Cursor.app")];
        if let Some(home) = env::var_os("HOME") {
            paths.push(PathBuf::from(home).join("Applications/Cursor.app"));
        }
        paths
    }

    #[cfg(target_os = "windows")]
    {
        let mut paths = Vec::new();
        if let Some(local) = env::var_os("LOCALAPPDATA") {
            paths.push(PathBuf::from(&local).join("Programs/cursor/Cursor.exe"));
            paths.push(PathBuf::from(local).join("Programs/Cursor/Cursor.exe"));
        }
        if let Some(program_files) = env::var_os("ProgramFiles") {
            paths.push(PathBuf::from(program_files).join("Cursor/Cursor.exe"));
        }
        paths
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Vec::new()
    }
}

fn find_cursor() -> Option<PathBuf> {
    cursor_candidates().into_iter().find(|path| path.exists())
}

fn platform_info() -> PlatformInfo {
    let cursor = find_cursor();
    let os = match env::consts::OS {
        "macos" => "macOS",
        "windows" => "Windows",
        other => other,
    };
    PlatformInfo {
        os: os.to_string(),
        arch: env::consts::ARCH.to_string(),
        credential_store_available: keyring::Entry::store_status().is_ok(),
        cursor_detected: cursor.is_some(),
        cursor_path: cursor.map(|path| path.to_string_lossy().into_owned()),
    }
}

fn make_snapshot(app: &AppHandle) -> Result<AppSnapshot, String> {
    let data = load_data(app)?;
    Ok(AppSnapshot {
        settings: data.settings,
        connections: data.connections,
        usage: data.usage,
        platform: platform_info(),
    })
}

fn lab_route(operation: &LabOperation) -> (&'static str, &'static str) {
    match operation {
        LabOperation::Health => ("GET", "/health"),
        LabOperation::ListAccounts => ("GET", "/api/lab/accounts"),
        LabOperation::CreateAccounts => ("POST", "/api/lab/accounts/batch"),
        LabOperation::CreateDevice => ("POST", "/api/lab/devices"),
        LabOperation::RotateDevice => ("POST", "/api/lab/devices/rotate"),
        LabOperation::IssueSession => ("POST", "/api/lab/sessions/issue"),
        LabOperation::RevokeSession => ("POST", "/api/lab/sessions/revoke"),
        LabOperation::Consume => ("POST", "/api/lab/usage/consume"),
        LabOperation::SwitchNext => ("POST", "/api/lab/switch/next"),
        LabOperation::ResetCycle => ("POST", "/api/lab/cycle/reset"),
        LabOperation::Audit => ("GET", "/api/lab/audit?limit=100"),
    }
}

fn lab_key_candidates(app: &AppHandle) -> Result<Vec<PathBuf>, String> {
    let mut candidates = Vec::new();
    if let Some(directory) = env::var_os("USAGE_COMPANION_LAB_DIR") {
        candidates.push(PathBuf::from(directory).join("lab-key.txt"));
    }
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法确定应用数据目录：{error}"))?;
    candidates.push(app_data.join("research-lab/lab-key.txt"));
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../research-lab/.lab-data/lab-key.txt"),
    );
    Ok(candidates)
}

fn load_lab_key(app: &AppHandle) -> Result<String, String> {
    for path in lab_key_candidates(app)? {
        if !path.exists() {
            continue;
        }
        let key = fs::read_to_string(&path)
            .map_err(|error| format!("无法读取本地研究沙盒密钥：{error}"))?
            .trim()
            .to_string();
        if key.starts_with("lab_admin_")
            && key.len() >= 32
            && key
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '_')
        {
            return Ok(key);
        }
        return Err("本地研究沙盒密钥格式无效".to_string());
    }
    Err("未找到本地研究沙盒密钥，请先启动 research-lab 服务".to_string())
}

fn parse_lab_http_response(raw: &[u8]) -> Result<LabHttpResponse, String> {
    let marker = b"\r\n\r\n";
    let split = raw
        .windows(marker.len())
        .position(|window| window == marker)
        .ok_or_else(|| "本地研究服务返回了无效 HTTP 响应".to_string())?;
    let headers = std::str::from_utf8(&raw[..split])
        .map_err(|_| "本地研究服务响应头不是有效文本".to_string())?;
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| "无法读取本地研究服务状态码".to_string())?;
    let body = serde_json::from_slice(&raw[split + marker.len()..])
        .map_err(|error| format!("本地研究服务返回了无效 JSON：{error}"))?;
    Ok(LabHttpResponse { status, body })
}

fn request_lab(
    method: &str,
    path: &str,
    key: Option<&str>,
    token: Option<&str>,
    payload: Option<&Value>,
) -> Result<LabHttpResponse, String> {
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), LAB_PORT);
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))
        .map_err(|_| "无法连接本地研究沙盒，请确认服务已启动".to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|error| format!("无法设置研究服务读取超时：{error}"))?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|error| format!("无法设置研究服务写入超时：{error}"))?;

    let body = if method == "POST" {
        match payload {
            Some(value) => serde_json::to_string(value)
                .map_err(|error| format!("无法序列化研究请求：{error}"))?,
            None => "{}".to_string(),
        }
    } else {
        String::new()
    };
    let mut request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {LAB_HOST}:{LAB_PORT}\r\nAccept: application/json\r\nConnection: close\r\n"
    );
    if let Some(key) = key {
        request.push_str(&format!("X-Lab-Key: {key}\r\n"));
    }
    if let Some(token) = token {
        if !token.starts_with("lab_tok_")
            || token.len() > 96
            || !token
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '_')
        {
            return Err("本地实验令牌格式无效".to_string());
        }
        request.push_str(&format!("Authorization: Bearer {token}\r\n"));
    }
    if method == "POST" {
        request.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            body.len()
        ));
    }
    request.push_str("\r\n");
    request.push_str(&body);
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("无法发送本地研究请求：{error}"))?;
    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .map_err(|error| format!("无法读取本地研究响应：{error}"))?;
    parse_lab_http_response(&response)
}

fn validate_settings(settings: &Settings) -> Result<(), String> {
    if settings.warning_threshold == 0 || settings.warning_threshold >= settings.critical_threshold
    {
        return Err("普通提醒阈值必须大于 0 且低于严重提醒阈值".to_string());
    }
    if settings.critical_threshold > 100 {
        return Err("严重提醒阈值不能超过 100%".to_string());
    }
    if ![5, 15, 30, 60].contains(&settings.refresh_interval_minutes) {
        return Err("检查间隔不受支持".to_string());
    }
    Ok(())
}

fn validate_usage(usage: &UsageSnapshot) -> Result<(), String> {
    if !usage.used.is_finite() || !usage.limit.is_finite() || usage.used < 0.0 || usage.limit <= 0.0
    {
        return Err("用量必须是有效的非负数，总额度必须大于 0".to_string());
    }
    let unit = usage.unit.trim();
    if unit.is_empty() || unit.chars().count() > 16 {
        return Err("请填写 1 到 16 个字符的用量单位".to_string());
    }
    Ok(())
}

fn validate_connection(input: &ConnectionInput) -> Result<(), String> {
    let allowed = ["openai", "anthropic", "google", "cursor-byok", "other"];
    if input.label.trim().is_empty() || input.label.chars().count() > 48 {
        return Err("连接名称应为 1 到 48 个字符".to_string());
    }
    if !allowed.contains(&input.provider.as_str()) {
        return Err("不支持的服务商".to_string());
    }
    if input.account_hint.chars().count() > 80 {
        return Err("账号备注不能超过 80 个字符".to_string());
    }
    if input.secret.chars().count() < 8 {
        return Err("凭证长度至少为 8 个字符".to_string());
    }
    Ok(())
}

#[tauri::command]
fn bootstrap(app: AppHandle, state: State<'_, AppState>) -> Result<AppSnapshot, String> {
    let _guard = state
        .io_lock
        .lock()
        .map_err(|_| "本地数据锁不可用".to_string())?;
    make_snapshot(&app)
}

#[tauri::command]
fn save_connection(
    app: AppHandle,
    state: State<'_, AppState>,
    input: ConnectionInput,
) -> Result<AppSnapshot, String> {
    validate_connection(&input)?;
    let _guard = state
        .io_lock
        .lock()
        .map_err(|_| "本地数据锁不可用".to_string())?;
    let mut data = load_data(&app)?;
    let id = input
        .id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let entry = keyring::Entry::new(KEYRING_SERVICE, &id)
        .map_err(|error| format!("无法连接系统凭证库：{error}"))?;
    entry
        .set_password(&input.secret)
        .map_err(|error| format!("无法写入系统凭证库：{error}"))?;

    let now = Utc::now().to_rfc3339();
    if let Some(existing) = data
        .connections
        .iter_mut()
        .find(|connection| connection.id == id)
    {
        existing.label = input.label.trim().to_string();
        existing.provider = input.provider;
        existing.account_hint = input.account_hint.trim().to_string();
        existing.secret_saved = true;
        existing.updated_at = now;
    } else {
        data.connections.push(Connection {
            id,
            label: input.label.trim().to_string(),
            provider: input.provider,
            account_hint: input.account_hint.trim().to_string(),
            secret_saved: true,
            created_at: now.clone(),
            updated_at: now,
        });
    }
    save_data(&app, &data)?;
    make_snapshot(&app)
}

#[tauri::command]
fn delete_connection(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<AppSnapshot, String> {
    let _guard = state
        .io_lock
        .lock()
        .map_err(|_| "本地数据锁不可用".to_string())?;
    let mut data = load_data(&app)?;
    if !data
        .connections
        .iter()
        .any(|connection| connection.id == id)
    {
        return Err("连接不存在".to_string());
    }
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, &id) {
        let _ = entry.delete_credential();
    }
    data.connections.retain(|connection| connection.id != id);
    save_data(&app, &data)?;
    make_snapshot(&app)
}

#[tauri::command]
fn save_usage(
    app: AppHandle,
    state: State<'_, AppState>,
    mut usage: UsageSnapshot,
) -> Result<AppSnapshot, String> {
    validate_usage(&usage)?;
    let _guard = state
        .io_lock
        .lock()
        .map_err(|_| "本地数据锁不可用".to_string())?;
    let mut data = load_data(&app)?;
    usage.unit = usage.unit.trim().to_string();
    usage.source = "手动录入".to_string();
    usage.updated_at = Utc::now().to_rfc3339();
    data.usage = usage;
    save_data(&app, &data)?;
    make_snapshot(&app)
}

#[tauri::command]
fn save_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: Settings,
) -> Result<AppSnapshot, String> {
    validate_settings(&settings)?;
    let _guard = state
        .io_lock
        .lock()
        .map_err(|_| "本地数据锁不可用".to_string())?;
    let mut data = load_data(&app)?;
    data.settings = settings;
    save_data(&app, &data)?;
    make_snapshot(&app)
}

#[tauri::command]
fn lab_request(
    app: AppHandle,
    operation: LabOperation,
    payload: Option<Value>,
    token: Option<String>,
) -> Result<LabHttpResponse, String> {
    let (method, path) = lab_route(&operation);
    let key = if matches!(operation, LabOperation::Health) {
        None
    } else {
        Some(load_lab_key(&app)?)
    };
    request_lab(
        method,
        path,
        key.as_deref(),
        token.as_deref(),
        payload.as_ref(),
    )
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            save_connection,
            delete_connection,
            save_usage,
            save_settings,
            lab_request
        ])
        .run(tauri::generate_context!())
        .expect("failed to run usage companion");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_inverted_thresholds() {
        let settings = Settings {
            warning_threshold: 90,
            critical_threshold: 80,
            ..Settings::default()
        };
        assert!(validate_settings(&settings).is_err());
    }

    #[test]
    fn accepts_supported_thresholds() {
        assert!(validate_settings(&Settings::default()).is_ok());
    }

    #[test]
    fn rejects_invalid_usage() {
        let usage = UsageSnapshot {
            limit: 0.0,
            ..UsageSnapshot::default()
        };
        assert!(validate_usage(&usage).is_err());
    }

    #[test]
    fn accepts_owned_credential_metadata() {
        let input = ConnectionInput {
            id: None,
            label: "工作密钥".to_string(),
            provider: "openai".to_string(),
            account_hint: "dev@example.com".to_string(),
            secret: "sk-example-secret".to_string(),
        };
        assert!(validate_connection(&input).is_ok());
    }

    #[test]
    fn cursor_candidates_are_platform_scoped() {
        let candidates = cursor_candidates();
        assert!(candidates.iter().all(|path| !path.as_os_str().is_empty()));
    }

    #[test]
    fn data_file_name_is_not_secret_bearing() {
        assert_eq!(
            std::path::Path::new(DATA_FILE)
                .extension()
                .and_then(|ext| ext.to_str()),
            Some("json")
        );
    }

    #[test]
    fn lab_routes_are_fixed_to_local_api_paths() {
        let operations = [
            LabOperation::Health,
            LabOperation::ListAccounts,
            LabOperation::CreateAccounts,
            LabOperation::CreateDevice,
            LabOperation::RotateDevice,
            LabOperation::IssueSession,
            LabOperation::RevokeSession,
            LabOperation::Consume,
            LabOperation::SwitchNext,
            LabOperation::ResetCycle,
            LabOperation::Audit,
        ];
        for operation in operations {
            let (_, path) = lab_route(&operation);
            assert!(path.starts_with('/'));
            assert!(!path.starts_with("//"));
            assert!(!path.contains("http://"));
            assert!(!path.contains("https://"));
        }
    }

    #[test]
    fn parses_lab_http_response() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"status\":\"ok\"}";
        let response = parse_lab_http_response(raw).expect("response should parse");
        assert_eq!(response.status, 200);
        assert_eq!(response.body["status"], "ok");
    }

    #[test]
    #[ignore = "requires the local research-lab service on 127.0.0.1:17840"]
    fn live_lab_bridge_smoke_test() {
        let key_path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../research-lab/.lab-data/lab-key.txt");
        let key = fs::read_to_string(key_path)
            .expect("lab key should exist")
            .trim()
            .to_string();
        let health =
            request_lab("GET", "/health", None, None, None).expect("health request should succeed");
        assert_eq!(health.status, 200);
        assert_eq!(health.body["external_network_enabled"], false);
        let accounts = request_lab("GET", "/api/lab/accounts", Some(&key), None, None)
            .expect("account request should succeed");
        assert_eq!(accounts.status, 200);
        assert_eq!(accounts.body["environment"], "local-research-lab");

        let create_payload = serde_json::json!({ "count": 2, "quota_limit": 10 });
        let created = request_lab(
            "POST",
            "/api/lab/accounts/batch",
            Some(&key),
            None,
            Some(&create_payload),
        )
        .expect("synthetic accounts should be created");
        assert_eq!(created.status, 201);
        let first_account = created.body["data"][0]["id"]
            .as_str()
            .expect("first account id")
            .to_string();

        let device_payload = serde_json::json!({ "label": "Rust bridge smoke device" });
        let device = request_lab(
            "POST",
            "/api/lab/devices",
            Some(&key),
            None,
            Some(&device_payload),
        )
        .expect("virtual device should be created");
        let device_id = device.body["data"]["id"]
            .as_str()
            .expect("virtual device id")
            .to_string();

        let issue_payload = serde_json::json!({
            "account_id": first_account,
            "virtual_device_id": device_id,
        });
        let grant = request_lab(
            "POST",
            "/api/lab/sessions/issue",
            Some(&key),
            None,
            Some(&issue_payload),
        )
        .expect("local token should be issued");
        let token = grant.body["data"]["access_token"]
            .as_str()
            .expect("local token")
            .to_string();
        assert!(token.starts_with("lab_tok_"));

        let consume_payload = serde_json::json!({ "units": 10 });
        let consumed = request_lab(
            "POST",
            "/api/lab/usage/consume",
            Some(&key),
            Some(&token),
            Some(&consume_payload),
        )
        .expect("quota should be consumed");
        assert_eq!(consumed.status, 200);
        assert_eq!(consumed.body["data"]["quota_used"], 10);

        let over_payload = serde_json::json!({ "units": 1 });
        let exhausted = request_lab(
            "POST",
            "/api/lab/usage/consume",
            Some(&key),
            Some(&token),
            Some(&over_payload),
        )
        .expect("quota rejection should return a response");
        assert_eq!(exhausted.status, 429);
        assert_eq!(exhausted.body["error"]["should_switch"], true);

        let switch_payload = serde_json::json!({
            "current_account_id": first_account,
            "virtual_device_id": device_id,
        });
        let switched = request_lab(
            "POST",
            "/api/lab/switch/next",
            Some(&key),
            None,
            Some(&switch_payload),
        )
        .expect("another synthetic account should be selected");
        assert_eq!(switched.status, 200);
        assert_ne!(switched.body["data"]["account_id"], first_account);
        let switched_token = switched.body["data"]["access_token"]
            .as_str()
            .expect("switched local token")
            .to_string();

        let revoked = request_lab(
            "POST",
            "/api/lab/sessions/revoke",
            Some(&key),
            Some(&switched_token),
            None,
        )
        .expect("switched token should be revoked");
        assert_eq!(revoked.status, 200);

        let reset_payload = serde_json::json!({ "account_id": null });
        let reset = request_lab(
            "POST",
            "/api/lab/cycle/reset",
            Some(&key),
            None,
            Some(&reset_payload),
        )
        .expect("synthetic quotas should reset");
        assert_eq!(reset.status, 200);
    }
}
