use std::io::Write;

use async_trait::async_trait;
use cognacta_core::{
    Cluster, Control, Error as CoreError, ErrorKind, Node, NodeContext, NodeInstance, Outcome,
    Scheduler, State,
};

use crate::Error;

use super::support::{report, status};

#[derive(Default)]
struct ChainState {
    length: usize,
    output: String,
}

enum ChainDelta {
    Length(usize),
    Output(String),
}

impl State for ChainState {
    type Delta = ChainDelta;

    fn apply_delta(&mut self, delta: ChainDelta) -> Result<(), CoreError> {
        match delta {
            ChainDelta::Length(length) => self.length = length,
            ChainDelta::Output(output) => self.output = output,
        }
        Ok(())
    }
}

struct Count;

#[async_trait]
impl NodeInstance<ChainState> for Count {
    type Input = String;
    type Payload = usize;

    async fn run(
        &self,
        input: String,
        _: NodeContext<'_, ChainState>,
    ) -> Result<Outcome<ChainDelta, usize>, CoreError> {
        let length = input.chars().count();
        Ok(Outcome {
            state_delta: Some(ChainDelta::Length(length)),
            control: Control::Goto {
                target: "render".into(),
                input: length,
            },
        })
    }
}

struct Render;

#[async_trait]
impl NodeInstance<ChainState> for Render {
    type Input = usize;
    type Payload = ();

    async fn run(
        &self,
        input: usize,
        ctx: NodeContext<'_, ChainState>,
    ) -> Result<Outcome<ChainDelta, ()>, CoreError> {
        if input != ctx.state.length {
            return Err(CoreError::new(
                ErrorKind::InvalidRequest,
                "length not committed",
            ));
        }
        Ok(Outcome {
            state_delta: Some(ChainDelta::Output(format!("len={input}"))),
            control: Control::Finish,
        })
    }
}

pub(super) async fn run(output: &mut impl Write) -> Result<(), Error> {
    let mut cluster = Cluster::new();
    cluster.add(Node::builder().id("count".into()).body(Count).build()?)?;
    cluster.add(Node::builder().id("render".into()).body(Render).build()?)?;
    let mut run = cluster
        .start()
        .state(ChainState::default())
        .entry("count".into())
        .input("hello".to_owned())
        .call()?;
    let result = Scheduler::new().drive(&mut run).await;
    report(
        output,
        format!(
            "status={} length={} output={}",
            status(&run),
            run.state().length,
            run.state().output
        ),
        result,
    )
}
