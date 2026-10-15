//! Runtime provider configuration, authentication, and streaming LLM adapters.
//!
//! Supply a shared [`reqwest::Client`] with automatic redirects and retries
//! disabled, then use [`build_models`] or assemble [`HttpAccess`] directly.
//! Protocol calls return [`cognacta_core::Error`]; configuration and HTTP access
//! return this crate's [`Error`].

mod auth;
mod config;
mod error;
mod http;
mod openai;
mod runtime;

pub use auth::{HeaderAuth, RequestAuth};
pub use config::{ApiKeyConfig, AuthConfig, ModelConfig, ProviderConfig, ProvidersConfig};
pub use error::Error;
pub use http::HttpAccess;
pub use openai::OpenAiChatCompletions;
pub use runtime::build_models;
