//! Shared LLM request, response, and runtime protocol boundaries.

/// Returns the crate version of `cognacta-core`.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

pub fn add(left: u64, right: u64) -> u64 {
    left + right
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_works() {
        let result = add(2, 2);
        assert_eq!(result, 4);
    }
}
mod error;
mod generation;
mod model;
mod observation;

pub use error::{Error, ErrorKind, PartialGeneration, PartialPart};
pub use generation::{
    AssistantMessage, Finish, FinishReason, GenerationEvent, GenerationMetadata, GenerationOptions,
    GenerationRequest, GenerationResponse, InputPart, Message, OutputPart, PartDelta, PartId,
    PartKind, Usage,
};
pub use model::{EventStream, Model, Protocol, Provider};
