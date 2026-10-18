use std::io::Write;

use omniops_bots_core::{Cluster, Node, Scheduler};

use crate::Error;

use super::support::{FailureState, Seed, Unexpected, report, status};

pub(super) async fn run(output: &mut impl Write) -> Result<(), Error> {
    let mut cluster = Cluster::new();
    cluster.add(
        Node::builder()
            .id("typed_target".into())
            .body(Unexpected)
            .build()?,
    )?;
    cluster.add(
        Node::builder()
            .id("seed".into())
            .body(Seed("typed_target"))
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
