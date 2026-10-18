use std::io::Write;

use async_trait::async_trait;
use omniops_bots_core::{
    Cluster, Control, Error as CoreError, ErrorKind, Node, NodeContext, NodeInstance, Outcome,
    Scheduler, State,
};

use crate::Error;

use super::support::{report, status};

#[derive(Default)]
struct BranchState {
    selected: &'static str,
}

impl State for BranchState {
    type Delta = &'static str;

    fn apply_delta(&mut self, delta: Self::Delta) -> Result<(), CoreError> {
        if !self.selected.is_empty() {
            return Err(CoreError::new(
                ErrorKind::InvalidRequest,
                "branch already selected",
            ));
        }
        self.selected = delta;
        Ok(())
    }
}

struct Route;

#[async_trait]
impl NodeInstance<BranchState> for Route {
    type Input = i64;
    type Payload = i64;

    async fn run(
        &self,
        input: i64,
        _: NodeContext<'_, BranchState>,
    ) -> Result<Outcome<&'static str, i64>, CoreError> {
        Ok(Outcome {
            state_delta: None,
            control: Control::Goto {
                target: if input % 2 == 0 { "even" } else { "odd" }.into(),
                input,
            },
        })
    }
}

struct SelectBranch(&'static str);

#[async_trait]
impl NodeInstance<BranchState> for SelectBranch {
    type Input = i64;
    type Payload = ();

    async fn run(
        &self,
        input: i64,
        ctx: NodeContext<'_, BranchState>,
    ) -> Result<Outcome<&'static str, ()>, CoreError> {
        let expected = if input % 2 == 0 { "even" } else { "odd" };
        if self.0 != expected || !ctx.state.selected.is_empty() {
            return Err(CoreError::new(
                ErrorKind::InvalidRequest,
                "incorrect branch",
            ));
        }
        Ok(Outcome {
            state_delta: Some(self.0),
            control: Control::Finish,
        })
    }
}

pub(super) async fn run(input: i64, output: &mut impl Write) -> Result<(), Error> {
    let mut cluster = Cluster::new();
    cluster.add(Node::builder().id("route".into()).body(Route).build()?)?;
    for name in ["even", "odd"] {
        cluster.add(
            Node::builder()
                .id(name.into())
                .body(SelectBranch(name))
                .build()?,
        )?;
    }
    let mut run = cluster
        .start()
        .state(BranchState::default())
        .entry("route".into())
        .input(input)
        .call()?;
    let result = Scheduler::new().drive(&mut run).await;
    report(
        output,
        format!("status={} branch={}", status(&run), run.state().selected),
        result,
    )
}

#[cfg(test)]
mod tests {
    use omniops_bots_core::State;

    use super::BranchState;

    #[test]
    fn rejected_delta_leaves_state_unchanged() {
        let mut branch = BranchState { selected: "even" };
        assert!(branch.apply_delta("odd").is_err());
        assert_eq!(branch.selected, "even");
    }
}
