mod branch;
mod chain;
mod delta_error;
mod input_error;
mod node_error;
mod react_loop;
mod support;

use std::io::Write;

use crate::Error;

#[derive(Debug, clap::Args)]
pub(crate) struct DemoArgs {
    #[arg(value_enum)]
    scenario: Scenario,
}

#[derive(Clone, Copy, Debug, clap::ValueEnum)]
enum Scenario {
    Chain,
    BranchEven,
    BranchOdd,
    ReactLoop,
    NodeError,
    DeltaError,
    InputError,
}

pub(crate) async fn run(args: DemoArgs) -> Result<(), Error> {
    run_scenario(args.scenario, &mut std::io::stdout().lock()).await
}

async fn run_scenario(scenario: Scenario, output: &mut impl Write) -> Result<(), Error> {
    match scenario {
        Scenario::Chain => chain::run(output).await,
        Scenario::BranchEven => branch::run(2, output).await,
        Scenario::BranchOdd => branch::run(3, output).await,
        Scenario::ReactLoop => react_loop::run(output).await,
        Scenario::NodeError => node_error::run(output).await,
        Scenario::DeltaError => delta_error::run(output).await,
        Scenario::InputError => input_error::run(output).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn summary_write_failure_is_returned_without_retry() {
        struct BrokenOutput(usize);
        impl Write for BrokenOutput {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                self.0 += 1;
                Err(std::io::ErrorKind::BrokenPipe.into())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut output = BrokenOutput(0);
        let error = run_scenario(Scenario::ReactLoop, &mut output)
            .await
            .unwrap_err();
        assert!(
            matches!(error, Error::Io(error) if error.kind() == std::io::ErrorKind::BrokenPipe)
        );
        assert_eq!(output.0, 1);
    }
}
