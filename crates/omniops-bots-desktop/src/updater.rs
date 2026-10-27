use super::{
    Runtime,
    error::{Error, IpcError},
};
use serde::Serialize;
use serde_json::Value;
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

const MAX_MANIFEST: u64 = 2 * 1024 * 1024;
const MAX_PACKAGE: u64 = 1024 * 1024 * 1024;
const ENDPOINT: Option<&str> = option_env!("OMNIOPS_BOTS_UPDATE_URL");
const PUBLIC_KEY: Option<&str> = option_env!("OMNIOPS_BOTS_UPDATE_PUBLIC_KEY");

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Snapshot {
    phase: &'static str,
    current_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    notes: Option<String>,
    downloaded_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<IpcError>,
}
pub(super) struct Updater {
    snapshot: Mutex<Snapshot>,
    operation: tokio::sync::Mutex<()>,
    selected: Mutex<Option<Update>>,
    bytes: Mutex<Option<Vec<u8>>>,
}
impl Updater {
    pub(super) fn new(version: String, diagnostics_only: bool) -> Self {
        let configured = !diagnostics_only
            && ENDPOINT.is_some_and(|value| !value.trim().is_empty())
            && PUBLIC_KEY.is_some_and(|value| !value.trim().is_empty());
        Self {
            snapshot: Mutex::new(Snapshot {
                phase: if configured { "idle" } else { "disabled" },
                current_version: version,
                version: None,
                notes: None,
                downloaded_bytes: 0,
                total_bytes: None,
                error: None,
            }),
            operation: tokio::sync::Mutex::new(()),
            selected: Mutex::new(None),
            bytes: Mutex::new(None),
        }
    }
    fn status(&self) -> Snapshot {
        self.snapshot.lock().unwrap().clone()
    }
    fn update(&self, app: &tauri::AppHandle, change: impl FnOnce(&mut Snapshot)) -> Snapshot {
        let snapshot = {
            let mut value = self.snapshot.lock().unwrap();
            change(&mut value);
            value.clone()
        };
        let _ = app.emit_to("main", "updater-state", snapshot.clone());
        snapshot
    }
    fn failed(&self, app: &tauri::AppHandle, error: Error) -> IpcError {
        let safe = IpcError::from(error);
        self.update(app, |value| {
            value.phase = "failed";
            value.error = Some(safe.clone());
        });
        safe
    }
}
fn secure_url(value: &str) -> Result<url::Url, Error> {
    let url = url::Url::parse(value).map_err(|_| Error::InvalidInput("更新地址无效。"))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::InvalidInput("更新仅接受不含凭据的 HTTPS 地址。"));
    }
    Ok(url)
}
async fn download_bytes(
    url: url::Url,
    max: u64,
    timeout: Duration,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<Vec<u8>, Error> {
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .build()?;
    let mut response = client.get(url).send().await?.error_for_status()?;
    if !response.status().is_success() {
        return Err(Error::Unavailable("更新站点未返回成功响应。"));
    }
    let total = response.content_length();
    if total.is_some_and(|bytes| bytes > max) {
        return Err(Error::InvalidInput("更新文件超过允许大小。"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if (bytes.len() as u64).saturating_add(chunk.len() as u64) > max {
            return Err(Error::InvalidInput("更新文件超过允许大小。"));
        }
        bytes.extend_from_slice(&chunk);
        progress(bytes.len() as u64, total);
    }
    if total.is_some_and(|total| total != bytes.len() as u64) {
        return Err(Error::InvalidInput("更新下载不完整。"));
    }
    Ok(bytes)
}

#[tauri::command]
pub(super) fn updater_status(updater: State<'_, Updater>) -> Snapshot {
    updater.status()
}

#[tauri::command]
pub(super) async fn updater_check(
    app: tauri::AppHandle,
    updater: State<'_, Updater>,
) -> Result<Snapshot, IpcError> {
    let _operation = updater
        .operation
        .try_lock()
        .map_err(|_| IpcError::from(Error::Unavailable("更新操作仍在进行。")))?;
    if matches!(updater.status().phase, "disabled" | "ready") {
        return Ok(updater.status());
    }
    updater.update(&app, |value| {
        value.phase = "checking";
        value.error = None;
    });
    let result = async {
        let endpoint = secure_url(ENDPOINT.ok_or(Error::Unavailable("尚未配置更新服务。"))?)?;
        let bytes = download_bytes(
            endpoint.clone(),
            MAX_MANIFEST,
            Duration::from_secs(15),
            |_, _| {},
        )
        .await?;
        let raw: Value = serde_json::from_slice(&bytes)?;
        let standard = app
            .updater_builder()
            .endpoints(vec![endpoint])?
            .pubkey(PUBLIC_KEY.ok_or(Error::Unavailable("更新公钥未配置。"))?)
            .configure_client(|builder| {
                builder
                    .https_only(true)
                    .redirect(reqwest::redirect::Policy::none())
            })
            .build()?;
        let selected = standard.restore_update(raw)?;
        if let Some(update) = &selected {
            secure_url(update.download_url.as_str())?;
        }
        let snapshot = updater.update(&app, |value| {
            value.phase = if selected.is_some() {
                "available"
            } else {
                "idle"
            };
            value.version = selected.as_ref().map(|update| update.version.clone());
            value.notes = selected.as_ref().and_then(|update| update.body.clone());
            value.downloaded_bytes = 0;
            value.total_bytes = None;
        });
        *updater.selected.lock().unwrap() = selected;
        *updater.bytes.lock().unwrap() = None;
        Ok(snapshot)
    }
    .await;
    result.map_err(|error| updater.failed(&app, error))
}

#[tauri::command]
pub(super) async fn updater_download(
    app: tauri::AppHandle,
    updater: State<'_, Updater>,
) -> Result<Snapshot, IpcError> {
    let _operation = updater
        .operation
        .try_lock()
        .map_err(|_| IpcError::from(Error::Unavailable("更新操作仍在进行。")))?;
    if updater.status().phase == "ready" {
        return Ok(updater.status());
    }
    let selected = updater
        .selected
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| IpcError::from(Error::Unavailable("请先检查可用更新。")))?;
    updater.update(&app, |value| {
        value.phase = "downloading";
        value.error = None;
        value.downloaded_bytes = 0;
    });
    let result = async {
        let mut last_progress = Instant::now();
        let bytes = download_bytes(
            secure_url(selected.download_url.as_str())?,
            MAX_PACKAGE,
            Duration::from_secs(600),
            |downloaded, total| {
                if last_progress.elapsed() >= Duration::from_millis(100)
                    || total == Some(downloaded)
                {
                    updater.update(&app, |value| {
                        value.downloaded_bytes = downloaded;
                        value.total_bytes = total;
                    });
                    last_progress = Instant::now();
                } else {
                    let mut value = updater.snapshot.lock().unwrap();
                    value.downloaded_bytes = downloaded;
                    value.total_bytes = total;
                }
            },
        )
        .await?;
        selected.verify(&bytes)?;
        *updater.bytes.lock().unwrap() = Some(bytes);
        Ok(updater.update(&app, |value| value.phase = "ready"))
    }
    .await;
    result.map_err(|error| updater.failed(&app, error))
}

#[tauri::command]
pub(super) async fn updater_install(
    app: tauri::AppHandle,
    updater: State<'_, Updater>,
    runtime: State<'_, Arc<Runtime>>,
) -> Result<Snapshot, IpcError> {
    let _operation = updater
        .operation
        .try_lock()
        .map_err(|_| IpcError::from(Error::Unavailable("更新操作仍在进行。")))?;
    if updater.status().phase != "ready" {
        return Err(Error::Unavailable("尚无已验证的待安装更新。").into());
    }
    if !super::host_confirm(
        app.clone(),
        "确认安装更新并重启？只有全部任务结束后才能安装。".into(),
    )
    .await?
    {
        return Ok(updater.status());
    }
    runtime
        .request("maintenance_begin", Value::Null, Duration::from_secs(2))
        .await
        .map_err(IpcError::from)?;
    match runtime.begin_shutdown() {
        Ok(true) => {}
        Ok(false) => {
            return Err(Error::Unavailable("客户端正在退出，请重新启动后再确认更新。").into());
        }
        Err(error) => {
            let _ = runtime
                .request("maintenance_end", Value::Null, Duration::from_secs(2))
                .await;
            return Err(error.into());
        }
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    updater.update(&app, |value| {
        value.phase = "installing";
        value.error = None;
    });
    let cleanup = async {
        runtime.shutdown_for_update(deadline).await?;
        #[cfg(all(
            feature = "native-browser",
            any(target_os = "macos", target_os = "windows")
        ))]
        super::close_native_browser_for_update(&app, deadline).await?;
        Ok::<(), Error>(())
    }
    .await;
    if let Err(error) = cleanup {
        runtime.fail(IpcError::from(Error::Unavailable(
            "更新准备失败，执行服务可能已停止；请退出并重新启动。",
        )));
        runtime.inner.lock().unwrap().shutting_down = false;
        return Err(updater.failed(&app, error));
    }
    let selected = updater
        .selected
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| IpcError::from(Error::Unavailable("更新状态已失效。")))?;
    let bytes = updater
        .bytes
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| IpcError::from(Error::Unavailable("更新包已失效。")))?;
    let installed = tauri::async_runtime::spawn_blocking(move || selected.install(bytes)).await;
    match installed {
        Ok(Ok(())) => {
            runtime.inner.lock().unwrap().exit_allowed = true;
            app.restart();
        }
        Ok(Err(error)) => {
            runtime.inner.lock().unwrap().shutting_down = false;
            Err(updater.failed(&app, Error::UpdateInstall(error)))
        }
        Err(_) => {
            runtime.inner.lock().unwrap().shutting_down = false;
            Err(updater.failed(
                &app,
                Error::Unavailable("安装器操作中断；执行服务已停止，请手动重新启动。"),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn update_addresses_never_downgrade_or_carry_credentials() {
        for value in [
            "http://example.com/update",
            "https://user:secret@example.com/update",
            "https://example.com/update#fragment",
            "file:///tmp/update",
        ] {
            assert!(secure_url(value).is_err());
        }
        assert!(secure_url("https://updates.example.com/stable/latest.json").is_ok());
    }
    #[test]
    fn absent_public_configuration_disables_updater_without_network() {
        let disabled = Updater::new("0.1.0".into(), true).status();
        assert_eq!(disabled.phase, "disabled");
        assert_eq!(disabled.downloaded_bytes, 0);
        let value = serde_json::to_value(disabled).unwrap();
        assert_eq!(value["currentVersion"], "0.1.0");
        assert!(value.get("error").is_none());
    }
}
