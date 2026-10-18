use std::io::Write;

use async_trait::async_trait;
use omniops_bots_core::{
    Cluster, Control, Error as CoreError, ErrorKind, Node, NodeContext, NodeInstance, Outcome,
    Scheduler, State,
};

use crate::Error;

use super::support::{report, status};

#[derive(Default)]
struct LoopState {
    model_calls: usize,
    tool_calls: usize,
    answer: Option<i64>,
}

enum LoopDelta {
    Model(Option<i64>),
    Tool,
}

impl State for LoopState {
    type Delta = LoopDelta;

    fn apply_delta(&mut self, delta: LoopDelta) -> Result<(), CoreError> {
        match delta {
            LoopDelta::Model(answer) => {
                self.model_calls += 1;
                self.answer = answer;
            }
            LoopDelta::Tool => self.tool_calls += 1,
        }
        Ok(())
    }
}

enum ModelInput {
    Start,
    ToolResult(i64),
}

struct DemoToolCall {
    left: i64,
    right: i64,
}

struct Model;

#[async_trait]
impl NodeInstance<LoopState> for Model {
    type Input = ModelInput;
    type Payload = DemoToolCall;

    async fn run(
        &self,
        input: ModelInput,
        ctx: NodeContext<'_, LoopState>,
    ) -> Result<Outcome<LoopDelta, DemoToolCall>, CoreError> {
        match input {
            ModelInput::Start => Ok(Outcome {
                state_delta: Some(LoopDelta::Model(None)),
                control: Control::Goto {
                    target: "tool".into(),
                    input: DemoToolCall { left: 2, right: 3 },
                },
            }),
            ModelInput::ToolResult(answer) => {
                if ctx.state.model_calls != 1 || ctx.state.tool_calls != 1 {
                    return Err(CoreError::new(
                        ErrorKind::InvalidRequest,
                        "tool update not committed",
                    ));
                }
                Ok(Outcome {
                    state_delta: Some(LoopDelta::Model(Some(answer))),
                    control: Control::Finish,
                })
            }
        }
    }
}

struct Tool;

#[async_trait]
impl NodeInstance<LoopState> for Tool {
    type Input = DemoToolCall;
    type Payload = ModelInput;

    async fn run(
        &self,
        input: DemoToolCall,
        _: NodeContext<'_, LoopState>,
    ) -> Result<Outcome<LoopDelta, ModelInput>, CoreError> {
        let answer = input
            .left
            .checked_add(input.right)
            .ok_or_else(|| CoreError::new(ErrorKind::InvalidRequest, "addition overflow"))?;
        Ok(Outcome {
            state_delta: Some(LoopDelta::Tool),
            control: Control::Goto {
                target: "model".into(),
                input: ModelInput::ToolResult(answer),
            },
        })
    }
}

pub(super) async fn run(output: &mut impl Write) -> Result<(), Error> {
    let mut cluster = Cluster::new();
    cluster.add(Node::builder().id("model".into()).body(Model).build()?)?;
    cluster.add(Node::builder().id("tool".into()).body(Tool).build()?)?;
    let mut run = cluster
        .start()
        .state(LoopState::default())
        .entry("model".into())
        .input(ModelInput::Start)
        .call()?;
    let result = Scheduler::new().drive(&mut run).await;
    report(
        output,
        format!(
            "status={} model_calls={} tool_calls={} answer={}",
            status(&run),
            run.state().model_calls,
            run.state().tool_calls,
            run.state()
                .answer
                .map_or_else(|| "none".into(), |answer| answer.to_string())
        ),
        result,
    )
}
