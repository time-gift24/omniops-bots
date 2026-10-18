use std::io::Write;

use async_trait::async_trait;
use omniops_bots_core::{
    Cluster, Control, Error as CoreError, Node, NodeContext, NodeInstance, Outcome, Scheduler,
};

use crate::Error;

use super::support::{FailureState, Seed, Unexpected, report, status};

struct Reject;

#[async_trait]
impl NodeInstance<FailureState> for Reject {
    type Input = String;
    type Payload = usize;

    async fn run(
        &self,
        _: String,
        _: NodeContext<'_, FailureState>,
    ) -> Result<Outcome<i32, usize>, CoreError> {
        Ok(Outcome {
            state_delta: Some(-1),
            control: Control::Goto {
                target: "sentinel".into(),
                input: 99,
            },
        })
    }
}

pub(super) async fn run(output: &mut impl Write) -> Result<(), Error> {
    let mut cluster = Cluster::new();
    cluster.add(Node::builder().id("reject".into()).body(Reject).build()?)?;
    cluster.add(
        Node::builder()
            .id("sentinel".into())
            .body(Unexpected)
            .build()?,
    )?;
    cluster.add(
        Node::builder()
            .id("seed".into())
            .body(Seed("reject"))
            .build()?,
    )?;
    let mut run = cluster
        .start()
        .state(FailureState::default())
        .entry("seed".into())
        .input(())
        .call()?;
    let result = Scheduler::new().drive(&mut run).await;
    report(
        output,
        format!(
            "status={} node={} value={}",
            status(&run),
            run.node_id().map_or("none", String::as_str),
            run.state().value
        ),
        result,
    )
}
