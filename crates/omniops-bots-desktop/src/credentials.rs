use super::error::Error;
use serde::Deserialize;
use serde_json::Value;

const SERVICE: &str = "com.omniops.bots.provider";
const MAX_REQUEST_ID: u64 = 9_007_199_254_740_991;

#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Operation {
    Get,
    Set,
    Delete,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Request {
    event: String,
    #[serde(rename = "requestId")]
    pub(super) request_id: u64,
    operation: Operation,
    reference: String,
    secret: Option<String>,
}

pub(super) fn request_id(message: &Value) -> Option<u64> {
    message["requestId"]
        .as_u64()
        .filter(|id| *id > 0 && *id <= MAX_REQUEST_ID)
}

impl Request {
    pub(super) fn parse(message: Value) -> Result<Self, Error> {
        let has_secret = message.get("secret").is_some();
        let request: Self = serde_json::from_value(message)
            .map_err(|_| Error::CredentialBoundary("凭据请求格式无效。"))?;
        let reference = uuid::Uuid::parse_str(&request.reference)
            .map_err(|_| Error::CredentialBoundary("凭据引用无效。"))?;
        if request.event != "credential_request"
            || request.request_id == 0
            || request.request_id > MAX_REQUEST_ID
            || reference.is_nil()
            || reference.to_string() != request.reference
        {
            return Err(Error::CredentialBoundary("凭据请求格式无效。"));
        }
        match (&request.operation, request.secret.as_deref()) {
            (Operation::Set, Some(secret))
                if !secret.is_empty()
                    && secret.len() <= 2560
                    && !secret.chars().any(|ch| ch.is_ascii_control()) => {}
            (Operation::Get | Operation::Delete, None) if !has_secret => {}
            _ => {
                return Err(Error::CredentialBoundary(
                    "API Key 格式无效或超过 2560 字节。",
                ));
            }
        }
        Ok(request)
    }

    pub(super) fn execute(self) -> Result<Option<String>, Error> {
        let entry = entry(&self.reference)?;
        match self.operation {
            Operation::Get => match entry.get_password() {
                Ok(secret)
                    if !secret.is_empty()
                        && secret.len() <= 2560
                        && !secret.chars().any(|ch| ch.is_ascii_control()) =>
                {
                    Ok(Some(secret))
                }
                Ok(_) => Err(Error::CredentialBoundary(
                    "系统凭据内容无效，请重新配置 API Key。",
                )),
                Err(keyring_core::Error::NoEntry) => Ok(None),
                Err(error) => Err(Error::Credentials(error)),
            },
            Operation::Set => entry
                .set_password(self.secret.as_deref().unwrap_or_default())
                .map(|()| None)
                .map_err(Error::Credentials),
            Operation::Delete => match entry.delete_credential() {
                Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(None),
                Err(error) => Err(Error::Credentials(error)),
            },
        }
    }
}

fn entry(reference: &str) -> Result<keyring_core::Entry, Error> {
    #[cfg(target_os = "macos")]
    {
        use keyring_core::api::CredentialStoreApi;
        apple_native_keyring_store::keychain::Store::new()
            .and_then(|store| store.build(SERVICE, reference, None))
            .map_err(Error::Credentials)
    }
    #[cfg(target_os = "windows")]
    {
        use keyring_core::api::CredentialStoreApi;
        let modifiers = std::collections::HashMap::from([("persistence", "Local")]);
        windows_native_keyring_store::Store::new()
            .and_then(|store| store.build(SERVICE, reference, Some(&modifiers)))
            .map_err(Error::Credentials)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (reference, SERVICE);
        Err(Error::CredentialBoundary("此平台暂不支持系统凭据库。"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn message(operation: &str) -> Value {
        json!({"event":"credential_request","requestId":1,"operation":operation,"reference":"b44da25d-0d6f-4a93-89e4-e2b0fb29974a"})
    }

    #[test]
    fn credential_requests_validate_before_os_access() {
        assert!(Request::parse(message("get")).is_ok());
        assert!(Request::parse(message("delete")).is_ok());
        assert!(Request::parse(message("set")).is_err());
        let mut value = message("set");
        value["secret"] = json!("local-fixture-secret");
        assert!(Request::parse(value.clone()).is_ok());
        for secret in ["", "line\nbreak", &"a".repeat(2561)] {
            value["secret"] = json!(secret);
            assert!(Request::parse(value.clone()).is_err());
        }
        for (key, invalid) in [
            ("reference", json!("../../other-app")),
            ("reference", json!("00000000-0000-0000-0000-000000000000")),
            ("requestId", json!(0)),
            ("requestId", json!(MAX_REQUEST_ID + 1)),
            ("operation", json!("search")),
            ("service", json!("other-app")),
            ("secret", Value::Null),
        ] {
            let mut value = message("get");
            value[key] = invalid;
            assert!(Request::parse(value).is_err(), "{key} must be rejected");
        }
    }

    #[test]
    fn credential_errors_keep_sources_out_of_ipc() {
        let error =
            Error::Credentials(keyring_core::Error::BadEncoding(b"FIXTURE_SECRET".to_vec()));
        let reply = super::super::error::IpcError::from(error);
        assert_eq!(reply.kind, "credentials");
        assert!(!reply.message.contains("FIXTURE_SECRET"));
    }

    #[test]
    #[ignore = "writes an isolated OS credential; run explicitly with --ignored"]
    fn system_credentials_roundtrip_and_cleanup() -> Result<(), Error> {
        struct Cleanup(String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                if let Ok(entry) = entry(&self.0) {
                    let _ = entry.delete_credential();
                }
            }
        }
        let reference = uuid::Uuid::new_v4().to_string();
        let _cleanup = Cleanup(reference.clone());
        let execute = |operation: &str, secret: Option<&str>| {
            let mut value = message(operation);
            value["reference"] = json!(reference);
            if let Some(secret) = secret {
                value["secret"] = json!(secret);
            }
            Request::parse(value)?.execute()
        };
        assert!(execute("get", None)?.is_none());
        execute("set", Some("isolated-fixture-one"))?;
        assert!(execute("get", None)?.as_deref() == Some("isolated-fixture-one"));
        execute("set", Some("isolated-fixture-two"))?;
        assert!(execute("get", None)?.as_deref() == Some("isolated-fixture-two"));
        execute("delete", None)?;
        assert!(execute("get", None)?.is_none());
        execute("delete", None)?;
        Ok(())
    }
}
