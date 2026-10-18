use std::io::Write;

use async_trait::async_trait;
use omniops_bots_core::{
    Cluster, Error as CoreError, ErrorKind, Node, NodeContext, NodeInstance, Outcome, Scheduler,
};

use crate::Error;

use super::support::{FailureState, Seed, report, status};

struct Fail;

#[async_trait]
impl NodeInstance<FailureState> for Fail {
    type Input = String;
    type Payload = ();

    async fn run(
        &self,
        _: String,
        _: NodeContext<'_, FailureState>,
    ) -> Result<Outcome<i32, ()>, CoreError> {
        Err(
            CoreError::new(ErrorKind::Unavailable, "SECRET_NODE_FAILURE")
                .with_source(Box::new(std::io::Error::other("SECRET_NODE_SOURCE"))),
        )
    }
}

pub(super) async fn run(output: &mut impl Write) -> Result<(), Error> {
    let mut cluster = Cluster::new();
    cluster.add(Node::builder().id("fail".into()).body(Fail).build()?)?;
    cluster.add(
        Node::builder()
            .id("seed".into())
            .body(Seed("fail"))
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
