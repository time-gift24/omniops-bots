import { END, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import type { NativeGraph } from '../execution/index.ts';
import { createBrowserAgent } from '../graphs/browser-agent.ts';

declare const options: Parameters<typeof createBrowserAgent>[0];
const agent = createBrowserAgent(options);
new StateGraph(MessagesAnnotation).addNode('browser', agent.graph)
  .addEdge(START, 'browser').addEdge('browser', END).compile({ checkpointer: options.scope.checkpointer });
const executable: NativeGraph<typeof agent['~InputType'], typeof agent['~OutputType']> = agent;
void executable;
