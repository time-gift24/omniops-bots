import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { Execution } from '../execution/index.ts';

/** Compile-only contract: graph schemas, rather than chat messages, drive inference. */
export async function graphContract(execution: Execution) {
  const input = Annotation.Root({ question: Annotation<string>() });
  const output = Annotation.Root({ answer: Annotation<string>() });
  const state = Annotation.Root({ question: Annotation<string>(), answer: Annotation<string>(), privateValue: Annotation<number>() });
  const definition = new StateGraph({ input, output, stateSchema: state })
    .addNode('respond', value => ({ answer: value.question, privateValue: 42 }))
    .addEdge(START, 'respond').addEdge('respond', END);
  const outcome = await execution.execute({
    threadId: 'typed', runId: 'typed', timeoutMs: 1_000,
    async prepare(scope) {
      await Promise.resolve();
      return { graph: definition.compile({ checkpointer: scope.checkpointer }), input: { question: 'proof' } };
    },
  });
  if (outcome.ok) {
    const answer: string = outcome.output.answer;
    // @ts-expect-error Private state is not part of the graph output.
    outcome.output.privateValue;
    void answer;
  }
  await execution.execute({
    threadId: 'typed', runId: 'invalid', timeoutMs: 1_000,
    // @ts-expect-error prepare input must satisfy the graph's input schema.
    prepare(scope) { return { graph: definition.compile({ checkpointer: scope.checkpointer }), input: { question: 42 } }; },
  });
}
