use std::{io::Write, process::ExitCode};

use clap::Parser;

#[cfg(feature = "cognacta-test")]
mod chat;

#[derive(Debug, Parser)]
#[command(version, about = "Cognacta command line")]
struct Cli {
    #[cfg(feature = "cognacta-test")]
    #[command(subcommand)]
    command: Option<Command>,
}

#[cfg(feature = "cognacta-test")]
#[derive(Debug, clap::Subcommand)]
enum Command {
    /// Chat with a configured model using streaming text.
    Chat(chat::ChatArgs),
}

#[derive(Debug, thiserror::Error)]
enum Error {
    #[error("{0}")]
    Observability(#[from] cognacta_collector::Error),
    #[error("{0}")]
    Arguments(#[from] clap::Error),
    #[error("终端或运行时 I/O 失败: {0}")]
    Io(#[from] std::io::Error),
    #[cfg(feature = "cognacta-test")]
    #[error("{0}")]
    Provider(#[from] cognacta_provider::Error),
    #[cfg(feature = "cognacta-test")]
    #[error("{0}")]
    Generation(#[from] cognacta_core::Error),
    #[cfg(feature = "cognacta-test")]
    #[error("无法创建 HTTP 客户端")]
    HttpClient(#[source] reqwest::Error),
    #[cfg(feature = "cognacta-test")]
    #[error("无法配置 HTTP 客户端 TLS")]
    Tls(#[source] rustls::Error),
    #[cfg(feature = "cognacta-test")]
    #[error("未配置 Provider {provider} 下的模型 {model}")]
    UnknownModel { provider: String, model: String },
}

fn main() -> ExitCode {
    let collector = cognacta_collector::Collector::init_from_env("cognacta-cli");
    if let Err(error) = &collector {
        tracing::warn!(event = "collector.initialization_failed", diagnostic = %error, "telemetry unavailable");
    }
    let code = exit_code(run());
    if let Ok(collector) = collector
        && let Err(error) = collector.shutdown(std::time::Duration::from_secs(3))
    {
        let error = Error::Observability(error);
        tracing::warn!(event = "collector.shutdown_failed", diagnostic = %error, "telemetry shutdown incomplete");
    }
    code
}

fn exit_code(result: Result<(), Error>) -> ExitCode {
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(Error::Arguments(error)) => {
            let code = if error.use_stderr() {
                ExitCode::from(2)
            } else {
                ExitCode::SUCCESS
            };
            if error.print().is_err() {
                return ExitCode::FAILURE;
            }
            code
        }
        Err(error) => {
            let _ = writeln!(std::io::stderr().lock(), "错误: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), Error> {
    let cli = Cli::try_parse()?;
    #[cfg(feature = "cognacta-test")]
    if let Some(Command::Chat(args)) = cli.command {
        return tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?
            .block_on(chat::run(args));
    }
    #[cfg(not(feature = "cognacta-test"))]
    let _ = cli;
    writeln!(
        std::io::stdout().lock(),
        "cognacta {}",
        cognacta_core::version()
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_help_and_feature_gate() {
        assert!(Cli::try_parse_from(["cognacta-cli"]).is_ok());
        for (flag, kind) in [
            ("--help", clap::error::ErrorKind::DisplayHelp),
            ("--version", clap::error::ErrorKind::DisplayVersion),
        ] {
            assert_eq!(
                Cli::try_parse_from(["cognacta-cli", flag])
                    .unwrap_err()
                    .kind(),
                kind
            );
        }
        let help = Cli::try_parse_from(["cognacta-cli", "--help"])
            .unwrap_err()
            .to_string();
        assert_eq!(help.contains("chat"), cfg!(feature = "cognacta-test"));
        let parsed = Cli::try_parse_from([
            "cognacta-cli",
            "chat",
            "--config",
            "test.toml",
            "--provider",
            "gateway",
            "--model",
            "model",
        ]);
        assert_eq!(parsed.is_ok(), cfg!(feature = "cognacta-test"));
        assert!(Cli::try_parse_from(["cognacta-cli", "chat"]).is_err());
    }
}
