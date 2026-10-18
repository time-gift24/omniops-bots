use std::io::Write;

use async_trait::async_trait;
use omniops_bots_core::{
    Control, Error as CoreError, ErrorKind, NodeContext, NodeInstance, Outcome, Run, RunStatus,
    State,
};

use crate::Error;

pub(super) fn status<S: State>(run: &Run<'_, S>) -> &'static str {
    match run.status() {
        RunStatus::Ready => "ready",
        RunStatus::Running => "running",
        RunStatus::Completed => "completed",
        RunStatus::Failed => "failed",
    }
}

pub(super) fn report(
    output: &mut impl Write,
    summary: String,
    result: Result<(), CoreError>,
) -> Result<(), Error> {
    writeln!(output, "{summary}")?;
    output.flush()?;
    result.map_err(Error::Core)
}

#[derive(Default)]
pub(super) struct FailureState {
    pub(super) value: i32,
}

impl State for FailureState {
    type Delta = i32;

    fn apply_delta(&mut self, delta: i32) -> Result<(), CoreError> {
        if delta < 0 {
            return Err(CoreError::new(
                ErrorKind::InvalidRequest,
                "SECRET_DELTA_REJECTED",
            ));
        }
        self.value = delta;
        Ok(())
    }
}

pub(super) struct Seed(pub(super) &'static str);

#[async_trait]
impl NodeInstance<FailureState> for Seed {
    type Input = ();
    type Payload = String;

    async fn run(
        &self,
        _: (),
        _: NodeContext<'_, FailureState>,
    ) -> Result<Outcome<i32, String>, CoreError> {
        Ok(Outcome {
            state_delta: Some(1),
            control: Control::Goto {
                target: self.0.into(),
                input: "seeded".into(),
            },
        })
    }
}

pub(super) struct Unexpected;

#[async_trait]
impl NodeInstance<FailureState> for Unexpected {
    type Input = usize;
    type Payload = ();

    async fn run(
        &self,
        _: usize,
        _: NodeContext<'_, FailureState>,
    ) -> Result<Outcome<i32, ()>, CoreError> {
        // Executing this body would visibly violate the failed-run summary.
        Ok(Outcome {
            state_delta: Some(99),
            control: Control::Finish,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejected_delta_leaves_state_unchanged() {
        let mut state = FailureState { value: 1 };
        assert!(state.apply_delta(-1).is_err());
        assert_eq!(state.value, 1);
    }
}
