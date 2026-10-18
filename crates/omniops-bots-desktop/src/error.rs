use serde::Serialize;

/// Errors stay typed inside the host; only this safe summary crosses IPC.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("native browser: {0}")]
    Native(String),
    #[error("native operation failed: {operation}")]
    #[cfg(windows)]
    NativeIo {
        operation: &'static str,
        #[source]
        source: std::io::Error,
    },
    #[error("desktop I/O failed")]
    Io(#[from] std::io::Error),
    #[error("desktop operation failed")]
    Tauri(#[from] tauri::Error),
    #[error("native string is invalid")]
    NativeString(#[from] std::ffi::NulError),
    #[error("runtime process operation failed")]
    Shell(#[from] tauri_plugin_shell::Error),
    #[error("runtime protocol is invalid")]
    Protocol(#[from] serde_json::Error),
    #[error("{0}")]
    Unavailable(&'static str),
    #[error("{0}")]
    InvalidInput(&'static str),
    #[error("runtime request timed out")]
    Timeout,
    #[error("runtime rejected the request")]
    Remote(IpcError),
    #[error("system dialog failed")]
    Dialog(#[from] tauri_plugin_dialog::Error),
    #[error("clipboard operation failed")]
    Clipboard(#[from] tauri_plugin_clipboard_manager::Error),
    #[error("external link could not be opened")]
    Opener(#[from] tauri_plugin_opener::Error),
}

impl Error {
    /// A closed vocabulary for diagnostics; never derive labels from remote errors.
    pub(super) fn diagnostic_kind(&self) -> &'static str {
        match self {
            Self::Native(_) | Self::NativeString(_) => "native-browser",
            #[cfg(windows)]
            Self::NativeIo { .. } => "native-browser",
            Self::Io(_) => "io",
            Self::Tauri(_) => "host",
            Self::Shell(_) => "transport",
            Self::Protocol(_) => "protocol",
            Self::Unavailable(_) => "unavailable",
            Self::InvalidInput(_) => "invalid-input",
            Self::Timeout => "timeout",
            Self::Remote(_) => "runtime",
            Self::Dialog(_) => "dialog",
            Self::Clipboard(_) => "clipboard",
            Self::Opener(_) => "opener",
        }
    }
}

impl From<String> for Error {
    fn from(message: String) -> Self {
        Self::Native(message)
    }
}

impl From<&str> for Error {
    fn from(message: &str) -> Self {
        Self::Native(message.to_owned())
    }
}

#[derive(Clone, Debug, Serialize, serde::Deserialize)]
pub struct IpcError {
    pub kind: String,
    pub message: String,
}

impl From<Error> for IpcError {
    fn from(error: Error) -> Self {
        if let Error::Remote(remote) = error {
            return remote;
        }
        let kind = match error {
            Error::InvalidInput(_) => "invalid-input",
            Error::Timeout => "timeout",
            Error::Unavailable(_) => "unavailable",
            Error::Native(_) | Error::NativeString(_) => "native-browser",
            #[cfg(windows)]
            Error::NativeIo { .. } => "native-browser",
            Error::Protocol(_) => "protocol",
            _ => "host",
        };
        Self {
            kind: kind.to_owned(),
            message: error.to_string(),
        }
    }
}
