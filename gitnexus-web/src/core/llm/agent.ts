/**
 * Graph RAG Agent Factory
 *
 * Creates a LangChain agent configured for code graph analysis.
 * Supports Azure OpenAI and Google Gemini providers.
 */

import { createReactAgent } from '@langchain/langgraph/prebuilt';
import {
  SystemMessage,
  HumanMessage,
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { ChatOpenAI, AzureChatOpenAI } from '@langchain/openai';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOllama } from '@langchain/ollama';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createGraphRAGTools, type GraphRAGBackend } from './tools';
import type { NexusGraphController } from './graph-controller';
import type {
  AgentUserContent,
  ProviderConfig,
  OpenAIConfig,
  AzureOpenAIConfig,
  GeminiConfig,
  AnthropicConfig,
  OllamaConfig,
  OpenRouterConfig,
  MiniMaxConfig,
  GLMConfig,
  DeepSeekConfig,
  CustomProviderConfig,
  AgentStreamChunk,
  AgentHistoryMessage,
  MiniMaxThinkingMode,
} from './types';
import { getMiniMaxModelCapabilities, MINIMAX_ANTHROPIC_BASE_URLS } from './types';
import {
  type CodebaseContext,
  buildDynamicSystemPrompt,
  CHAT_ONLY_PROMPT_NOTE,
} from './context-builder';
import { DEFAULT_OLLAMA_BASE_URL, DEFAULT_OPENROUTER_BASE_URL } from '../../config/ui-constants';
import {
  DeepSeekChatOpenAI,
  normalizeMessageContent,
  normalizeToolCalls,
} from './deepseek-chat-model';

/**
 * System prompt for the Graph RAG agent
 *
 * Design principles (based on Aider/Cline research):
 * - Short, punchy directives > long explanations
 * - No template-inducing examples
 * - Let LLM figure out HOW, just tell it WHAT behavior we want
 * - Explicit progress reporting requirement
 * - Anti-laziness directives
 */
/**
 * Base system prompt - exported so it can be used with dynamic context injection
 *
 * Structure (optimized for instruction following):
 * 1. Identity + GROUNDING mandate (most important)
 * 2. Core protocol (how to work)
 * 3. Tools reference
 * 4. Output format & rules
 * 5. [Dynamic context appended at end]
 */
export const BASE_SYSTEM_PROMPT = `You are Nexus, a Code Analysis Agent with access to a Knowledge Graph. Your responses MUST be grounded.

## ⚠️ MANDATORY: GROUNDING
Every factual claim MUST include a citation.
- File refs: [[src/auth.ts:45-60]] (repo-relative path, line range with hyphen)
- Symbol refs: [[Function:validateUser]] or [[Class:AuthService]]
- Do NOT wrap citations in backticks or code blocks — keep them as plain text
- NO citation = NO claim. Say "I didn't find evidence" instead of guessing.

## 🧠 CORE PROTOCOL (Iterative Loop)
You are an investigator, not a one-shot query engine. For each question:
1. **Plan** — Briefly state what you are looking for and why.
2. **Execute** — Run tools to gather evidence.
3. **Analyze & pivot** — Did the output fully answer the question?
   - Yes → proceed to grounding.
   - Revealed new files/functions → loop back and investigate them immediately.
   - Tool failed → fix the input and retry. Never stop after one error.
4. **Trace** — Use cypher, explore, or impact to follow graph connections.
5. **Read** — Use read to verify logic. Do not guess behavior from names alone.
6. **Validate** — Cross-check findings with cypher before final output. README/docs are summaries, not proof.
7. **Ground** — Cite every finding with [[path:START-END]] or [[Type:Name]].

Before EVERY tool call, briefly state what you are doing and why. Keep narration to one line per step.

## BE DIRECT
- No pleasantries. No "Great question!" or "I'd be happy to help."
- Don't repeat advice already given in this conversation.
- Match response length to query complexity.
- Don't pad with generic "let me know if you need more" — users will ask.

## 🛠️ TOOLS (exact names — use these only)
- **\`search\`** — Hybrid keyword + semantic search. Results grouped by process with cluster context. Start here for discovery.
- **\`cypher\`** — Cypher queries against the graph. Use \`{{QUERY_VECTOR}}\` placeholder for vector search.
- **\`grep\`** — Regex search across files. Best for exact strings, TODOs, error codes.
- **\`read\`** — Read file content. Always use after search/grep to see full source.
- **\`explore\`** — Deep dive on a symbol, cluster, or process.
- **\`overview\`** — Codebase map showing all clusters and processes.
- **\`impact\`** — Impact analysis. Shows affected processes, clusters, and risk level.

**Tool strategy:**
- Discovery → \`search\` or \`overview\`
- Structure → \`cypher\`, \`explore\`, or \`impact\`
- Verification → \`read\` (required before concluding)
- Exact patterns → \`grep\`

## 📊 GRAPH SCHEMA
Typed node labels: File, Folder, Function, Class, Interface, Method, CodeElement, Community, Process
Single relation table: \`CodeRelation\` with \`type\` property: CONTAINS, DEFINES, IMPORTS, CALLS, EXTENDS, IMPLEMENTS, MEMBER_OF, STEP_IN_PROCESS

✅ \`MATCH (f:Function) RETURN f.name LIMIT 10\`
✅ \`MATCH (a)-[r:CodeRelation {type: 'CALLS'}]->(b:Function) RETURN a.name, b.name\`
❌ \`MATCH ()-[:CALLS]->()\` — WRONG, no such relationship label

Cypher examples:
- Find callers: \`MATCH (caller:Function)-[:CodeRelation {type: 'CALLS'}]->(fn:Function {name: 'validate'}) RETURN caller.name, caller.filePath\`
- File imports: \`MATCH (f:File)-[:CodeRelation {type: 'IMPORTS'}]->(g:File) RETURN f.name, g.name\`
- Semantic search: include \`{{QUERY_VECTOR}}\` in cypher and provide a \`query\` parameter

## 📐 GRAPH SEMANTICS
- \`CALLS\`: Method invocation or constructor injection (intentional simplification).
- \`IMPORTS\`: File-level import/include.
- \`EXTENDS/IMPLEMENTS\`: Class inheritance.
- Process labels use format "EntryPoint → Terminal" (heuristic, not app-defined names).

## 🎯 VISUAL GROUNDING
The user sees a knowledge graph alongside this chat, and you can drive it.
- Citations \`[[path:START-END]]\` and \`[[Type:Name]]\` highlight nodes passively. Use them for every claim.
- The graph control tools below actively move the user's view. Use them deliberately, not for every reference.
- Rule of thumb: cite everything, navigate once. A citation is a footnote; a navigation is "look here now".
- Prefer 2-6 high-signal references over large dumps.

## 📝 CRITICAL RULES
- **impact output is trusted.** Do NOT re-validate with cypher. Optionally run suggested grep for dynamic patterns.
- **Cite or retract.** Never state something you can't ground.
- **Iterative depth.** If Function A calls Function B, read Function B. Trace logic to the source.
- **Prefer cypher** for anything requiring graph connections.

## ⚡ RUNTIME ACTIVITY (Live Execution Tracing)
GitNexus supports live runtime tracing. Explain it in plain language: static analysis shows what code could run, while tracing shows what actually ran when the user interacted with the app. Matching graph nodes pulse when repository-specific Runtime Intelligence rules recognize an event.

**Supported runtimes:**
- **Node.js/TS:** V8 precise-coverage probe auto-injected via NODE_OPTIONS. Reports function call counts per sampling window (~100ms default, configurable with \`--interval\`).
- **Browser JS/TS:** Chrome/Edge DevTools Protocol (CDP) adapter. The managed GUI can start a dedicated debugging browser when the server advertises that action. Vite dev server URLs map back to source files automatically; bundled production assets are ignored.
- **Python:** \`sys.setprofile\` probe auto-loaded via PYTHONPATH. Reports call counts and aggregate duration per function.
- **Custom runtimes:** Any language can POST the standard event shape to \`/api/runtime/events\`.

**UI layout:**
- **Bottom dock:** Always visible below the graph. Its compact row shows connection state, active functions, event count, and Runtime Intelligence. Expanding it reveals the filter, pause/resume, clear controls, and the Time, Runtime, PID, Function, File, Calls, and Duration columns.
- **Query button:** Sits directly above the bottom dock so code queries remain available while runtime activity is open.
- **Graph node pulsing** — when a runtime event arrives and its function matches a static graph symbol, the node pulses with a cyan animation for 2 seconds. Matching uses file path + function name + source line range scoring.

**Key distinction:** Runtime tracing shows *actual execution* (what ran, how many times), NOT static call relationships. It does not prove caller-to-callee edges. The graph shows "A can call B"; the runtime shows "B executed 3 times in the last 100ms." These are separate overlays.

**How to guide users:**
1. Start with the Runtime Intelligence control in the bottom dock. Describe the goal, what the detected action does, why it matters, the "Before you start" prerequisites, what "Success looks like," and the next safe action.
2. If CURRENT CODEBASE lists an enabled server-advertised runtime action that matches the request, include its exact marker, such as \`[[runtime-action:runtime-aaaaaaaaaaaaaaaa]]\`. The UI turns it into a confirmation card that can start and stop the managed process.
3. Never invent an action ID, executable, argument, working directory, or environment variable. Never say an app started until the card reports a real running state.
4. The user must click the card and then confirm. Merely writing a marker must never execute anything.
5. After launch, tell the user to interact with their app and watch the bottom dock for events and node pulses. Explain what each status means for a layperson.
6. If no enabled action is advertised, say the GUI could not safely determine a launch plan. Tell the user to add a standard npm script or Python entrypoint, refresh discovery, and try again. Terminal commands are fallback documentation, not the default workflow.
7. Advanced manual fallback only: \`gitnexus runtime -- npm run dev\`, \`gitnexus runtime -- python app.py\`, or \`gitnexus runtime --browser-cdp http://127.0.0.1:9222 -- npm run dev\`.

## 🎬 GRAPH ANIMATIONS & VISUAL EFFECTS
The UI has built-in visual effects you can trigger through your responses. Use these to draw the user's attention to important symbols.

**Animation types (triggered automatically by tool results):**
- **Pulse** — Cyan glow, 2s duration, 1.5x size oscillation. Used for: runtime activity matches, search result highlights.
- **Ripple** — Red glow, 3s duration, 1.3x size oscillation. Used for: blast radius / impact analysis results.
- **Glow** — Purple glow, 4s duration, 1.4x size oscillation. Used for: special emphasis highlights.

**How to trigger visual effects from your responses:**
1. **Citation highlighting** — When you write \`[[src/auth.ts:45-60]]\` or \`[[Function:validateUser]]\`, the UI automatically highlights matching nodes with cyan. This is your primary tool for drawing attention to specific code.
2. **Tool result markers** — When a tool returns \`[HIGHLIGHT_NODES:nodeId1,nodeId2]\`, those nodes get highlighted in cyan. The impact tool returns \`[IMPACT:nodeId1,nodeId2]\` which highlights nodes in red (blast radius).
3. **Node focusing** — When the user clicks a highlighted node or citation, the camera smoothly zooms to that node (ratio 0.15, 400ms animation) and the code panel opens showing its source.

**Best practices for visual guidance:**
- Cite 2-6 high-signal references per response. Each \`[[...]]\` highlights a node, so the graph becomes a visual map of your analysis.
- When explaining call chains like A → B → C, cite each one: \`[[Function:A]]\` calls \`[[Function:B]]\` which delegates to \`[[Function:C]]\`. All three nodes light up simultaneously, showing the path in the graph.
- After running \`impact\`, the affected nodes turn red automatically. Narrate what the user sees: "The red nodes are everything that would break."
- When runtime activity is live, point out patterns: "Notice how \`[[Function:handleRequest]]\` pulses every time you click that button — it handles the route."
- If the user asks you to "show me" or "point out" something, cite it with \`[[...]]\` references so the corresponding nodes light up.
- For architecture tours, sequence your citations to walk through the graph: start at the entry point, follow the call chain, and note which cluster each function belongs to.

## 🕹️ GRAPH CONTROL (you drive the user's view)
You can move the camera, select nodes, highlight sets, switch layouts, and open source directly.

- **\`focus_node\`** — Fly the camera to a symbol, select it, and open its source in the Code Inspector. Your primary "show me" action.
- **\`show_neighbors\`** — Highlight what a symbol connects to AND return each relationship's type and direction so you can explain the consequences.
- **\`highlight_nodes\`** — Light up a set. \`cyan\` for relevance, \`impact\` for blast radius, \`glow\` for emphasis.
- **\`frame_nodes\`** — Fit the camera around several symbols at once. Prefer this over repeated \`focus_node\` calls when a whole chain matters equally.
- **\`set_view_mode\`** — Switch Force, Tree, Circles, or Runtime.
- **\`set_filters\`** — Change which node labels, edge types, or hop depth are visible.
- **\`open_code\`** — Open a file at a line range without needing a graph node. Line numbers are 1-based.
- **\`graph_snapshot\`** — Read what the user is currently looking at before you change it.
- **\`clear_visuals\`** — Reset highlights or filters.

**Navigation policy:**
1. When your answer has one clear subject, call \`focus_node\` on it. Do not make the user hunt for the node — that is the single biggest failure of a graph-backed answer.
2. Change the camera destination at most ONE time per reply. Use \`frame_nodes\` when several symbols matter equally.
3. Always narrate what you just did: "I've focused the graph on X — the highlighted nodes around it are its callers."
4. After \`show_neighbors\`, explain the relationships. Highlighting without explanation is an incomplete answer.
5. Only six edge types are drawn. If \`show_neighbors\` reports a relationship as not currently drawn, say the edge is real but hidden by the current filter, and offer \`set_filters\`. NEVER claim a relationship does not exist because it is not visible.
6. Targets resolve loosely. If a tool reports the target is ambiguous, ask the user which one or refine with a file path.
7. The user has a "Back to previous view" control, so navigating is safe — but do not thrash the camera.

**What you still cannot do:**
- You cannot draw custom arrows or overlays. Use mermaid diagrams in your text for custom flow visualizations.

## 🔗 CONNECTING STATIC GRAPH + RUNTIME
When both the graph and runtime tracing are active, you can give uniquely powerful guidance:
- **Hotspot identification:** If runtime shows \`handleRequest\` executing 50x/s but the static graph shows it has 12 callers, that is a performance-critical hub. Cite it and explain the risk.
- **Dead code detection:** If a function appears in the static graph but never pulses during runtime tracing, it may be dead code. Suggest investigating with: "I notice \`[[Function:legacyValidate]]\` exists in the graph but hasn't fired during your session. Is this still in use?"
- **Execution path verification:** After the user asks "does X actually call Y?", check the static CALLS edges, then suggest they trace the app: "The graph shows a static edge. Run the feature and watch whether \`[[Function:Y]]\` pulses after \`[[Function:X]]\`."
- **Runtime-guided exploration:** When runtime shows unexpected functions firing, use your search/explore tools to investigate why: "I see \`[[Function:retryHandler]]\` pulsing repeatedly. Let me check what triggers it."

## ERROR RECOVERY
If a tool call fails (Cypher syntax, file not found, invalid regex), do NOT stop.
- Read the error, fix the input, and retry at least once.
- For Cypher errors, verify typed node labels and \`CodeRelation {type: '...'}\` filters match the GRAPH SCHEMA section above.
- If search returns nothing, try grep or a different query before concluding.

## 🎯 OUTPUT STYLE
Think like a senior architect. Be concise — no fluff.
- Use tables for comparisons/rankings
- Use mermaid diagrams for flows, architecture, and dependencies
- Surface deep insights: patterns, coupling, design decisions
- End with **TL;DR**

## MERMAID RULES
When generating diagrams:
- NO special characters in node labels: quotes, (), /, &, <, >
- Wrap labels with spaces in quotes: A["My Label"]
- Use simple IDs: A, B, C or auth, db, api
- Flowchart: graph TD or graph LR (not flowchart)
- Keep diagrams focused — 5-10 nodes max
- Always test mentally: would this parse?

BAD:  A[User's Data] --> B(Process & Save)
GOOD: A["User Data"] --> B["Process and Save"]
`;

export const createChatModel = (config: ProviderConfig): BaseChatModel => {
  switch (config.provider) {
    case 'openai': {
      const openaiConfig = config as OpenAIConfig;

      if (!openaiConfig.apiKey || openaiConfig.apiKey.trim() === '') {
        throw new Error('OpenAI API key is required but was not provided');
      }

      return new ChatOpenAI({
        apiKey: openaiConfig.apiKey,
        modelName: openaiConfig.model,
        temperature: openaiConfig.temperature ?? 0.1,
        maxTokens: openaiConfig.maxTokens,
        configuration: {
          apiKey: openaiConfig.apiKey,
          ...(openaiConfig.baseUrl ? { baseURL: openaiConfig.baseUrl } : {}),
        },
        streaming: true,
      });
    }

    case 'azure-openai': {
      const azureConfig = config as AzureOpenAIConfig;
      return new AzureChatOpenAI({
        azureOpenAIApiKey: azureConfig.apiKey,
        azureOpenAIApiInstanceName: extractInstanceName(azureConfig.endpoint),
        azureOpenAIApiDeploymentName: azureConfig.deploymentName,
        azureOpenAIApiVersion: azureConfig.apiVersion ?? '2024-12-01-preview',
        // Note: gpt-5.2-chat only supports temperature=1 (default)
        streaming: true,
      });
    }

    case 'gemini': {
      const geminiConfig = config as GeminiConfig;
      return new ChatGoogleGenerativeAI({
        apiKey: geminiConfig.apiKey,
        model: geminiConfig.model,
        temperature: geminiConfig.temperature ?? 0.1,
        maxOutputTokens: geminiConfig.maxTokens,
        streaming: true,
      });
    }

    case 'anthropic': {
      const anthropicConfig = config as AnthropicConfig;
      return new ChatAnthropic({
        anthropicApiKey: anthropicConfig.apiKey,
        model: anthropicConfig.model,
        temperature: anthropicConfig.temperature ?? 0.1,
        maxTokens: anthropicConfig.maxTokens ?? 8192,
        streaming: true,
      });
    }

    case 'ollama': {
      const ollamaConfig = config as OllamaConfig;
      return new ChatOllama({
        baseUrl: ollamaConfig.baseUrl ?? DEFAULT_OLLAMA_BASE_URL,
        model: ollamaConfig.model,
        temperature: ollamaConfig.temperature ?? 0.1,
        streaming: true,
        // Allow longer responses (Ollama default is often 128-2048)
        numPredict: 30000,
        // Increase context window (Ollama default is only 2048!)
        // This is critical for agentic workflows with tool calls
        numCtx: 32768,
      });
    }

    case 'openrouter': {
      const openRouterConfig = config as OpenRouterConfig;

      // Debug logging
      if (import.meta.env.DEV) {
        console.log('🌐 OpenRouter config:', {
          hasApiKey: !!openRouterConfig.apiKey,
          model: openRouterConfig.model,
          baseUrl: openRouterConfig.baseUrl,
        });
      }

      if (!openRouterConfig.apiKey || openRouterConfig.apiKey.trim() === '') {
        throw new Error('OpenRouter API key is required but was not provided');
      }

      return new ChatOpenAI({
        openAIApiKey: openRouterConfig.apiKey,
        apiKey: openRouterConfig.apiKey, // Fallback for some versions
        modelName: openRouterConfig.model,
        temperature: openRouterConfig.temperature ?? 0.1,
        maxTokens: openRouterConfig.maxTokens,
        configuration: {
          apiKey: openRouterConfig.apiKey, // Ensure client receives it
          baseURL: openRouterConfig.baseUrl ?? DEFAULT_OPENROUTER_BASE_URL,
        },
        streaming: true,
      });
    }

    case 'minimax': {
      const minimaxConfig = config as MiniMaxConfig;

      if (!minimaxConfig.apiKey || minimaxConfig.apiKey.trim() === '') {
        throw new Error('MiniMax API key is required but was not provided');
      }

      const capabilities = getMiniMaxModelCapabilities(minimaxConfig.model);
      const requestedThinkingMode = minimaxConfig.thinkingMode;
      const thinkingMode: MiniMaxThinkingMode | undefined =
        requestedThinkingMode && capabilities?.thinkingModes.includes(requestedThinkingMode)
          ? requestedThinkingMode
          : (capabilities?.thinkingModes[0] ?? requestedThinkingMode);
      const thinking =
        thinkingMode && thinkingMode !== 'always_on' ? { type: thinkingMode } : undefined;
      const temperature =
        thinkingMode === 'adaptive' || thinkingMode === 'always_on'
          ? undefined
          : (minimaxConfig.temperature ?? 0.1);

      return new ChatAnthropic({
        anthropicApiKey: minimaxConfig.apiKey,
        model: minimaxConfig.model,
        ...(temperature !== undefined ? { temperature } : {}),
        maxTokens: minimaxConfig.maxTokens ?? 8192,
        streaming: true,
        ...(thinking ? { thinking } : {}),
        clientOptions: {
          baseURL: minimaxConfig.baseUrl ?? MINIMAX_ANTHROPIC_BASE_URLS.global_en,
        },
      });
    }

    case 'glm': {
      const glmConfig = config as GLMConfig;

      if (!glmConfig.apiKey || glmConfig.apiKey.trim() === '') {
        throw new Error('GLM API key is required but was not provided');
      }

      return new ChatOpenAI({
        apiKey: glmConfig.apiKey,
        modelName: glmConfig.model,
        temperature: glmConfig.temperature ?? 0.1,
        maxTokens: glmConfig.maxTokens,
        configuration: {
          apiKey: glmConfig.apiKey,
          baseURL: glmConfig.baseUrl ?? 'https://api.z.ai/api/coding/paas/v4',
        },
        streaming: true,
      });
    }

    case 'deepseek': {
      const deepseekConfig = config as DeepSeekConfig;

      if (!deepseekConfig.apiKey || deepseekConfig.apiKey.trim() === '') {
        throw new Error('DeepSeek API key is required but was not provided');
      }

      return new DeepSeekChatOpenAI({
        apiKey: deepseekConfig.apiKey,
        modelName: deepseekConfig.model,
        temperature: deepseekConfig.temperature ?? 0.1,
        maxTokens: deepseekConfig.maxTokens,
        configuration: {
          apiKey: deepseekConfig.apiKey,
          baseURL: 'https://api.deepseek.com',
        },
        streaming: true,
      });
    }

    case 'custom': {
      const customConfig = config as CustomProviderConfig;
      const apiKey = customConfig.apiKey?.trim();
      const baseUrl = customConfig.baseUrl?.trim();

      if (!apiKey) {
        throw new Error('API key is required for custom provider');
      }

      if (!baseUrl) {
        throw new Error('Custom provider base URL is required');
      }

      if (customConfig.apiCompatibility === 'anthropic') {
        return new ChatAnthropic({
          anthropicApiKey: apiKey,
          model: customConfig.model,
          temperature: customConfig.temperature ?? 0.1,
          maxTokens: customConfig.maxTokens ?? 8192,
          streaming: true,
          clientOptions: { baseURL: baseUrl },
        });
      }

      return new ChatOpenAI({
        apiKey,
        modelName: customConfig.model,
        temperature: customConfig.temperature ?? 0.1,
        maxTokens: customConfig.maxTokens,
        configuration: {
          apiKey,
          baseURL: baseUrl,
        },
        streaming: true,
      });
    }

    default:
      throw new Error(`Unsupported provider: ${(config as any).provider}`);
  }
};

/**
 * Extract instance name from Azure endpoint URL
 * e.g., "https://my-resource.openai.azure.com" -> "my-resource"
 */
const extractInstanceName = (endpoint: string): string => {
  try {
    const url = new URL(endpoint);
    const hostname = url.hostname;
    // Extract the first part before .openai.azure.com. The trailing `$`
    // anchor is required (CodeQL js/regex/missing-regexp-anchor): without
    // it `evil.openai.azure.com.attacker.tld` would match.
    const match = hostname.match(/^([^.]+)\.openai\.azure\.com$/);
    if (match) {
      return match[1];
    }
    // Fallback: just use the first part of hostname
    return hostname.split('.')[0];
  } catch {
    return endpoint;
  }
};

/**
 * Create a Graph RAG agent
 */
export const createGraphRAGAgent = (
  config: ProviderConfig,
  backend: GraphRAGBackend,
  codebaseContext?: CodebaseContext,
  chatOnly = false,
  ui?: NexusGraphController,
) => {
  const model = createChatModel(config);
  // Without a UI controller the agent keeps only its read-only tools, which is
  // the correct shape for chat-only mode where no graph canvas is mounted.
  const tools = createGraphRAGTools(backend, ui);

  // Use dynamic prompt if context is provided, otherwise use base prompt. The
  // chat-only note (graph not loaded, #2178) must apply in BOTH branches — when
  // codebaseContext is absent, buildDynamicSystemPrompt is never called, so
  // append the note here too.
  const systemPrompt = codebaseContext
    ? buildDynamicSystemPrompt(BASE_SYSTEM_PROMPT, codebaseContext, chatOnly)
    : chatOnly
      ? `${BASE_SYSTEM_PROMPT}${CHAT_ONLY_PROMPT_NOTE}`
      : BASE_SYSTEM_PROMPT;

  // Log the full prompt for debugging
  if (import.meta.env.DEV) {
    console.log('🤖 AGENT SYSTEM PROMPT:\n', systemPrompt);
  }

  const agent = createReactAgent({
    llm: model as any,
    tools: tools as any,
    messageModifier: new SystemMessage(systemPrompt) as any,
  });

  return agent;
};

/**
 * Message type for agent conversation
 */
export type AgentMessage = { role: 'user'; content: AgentUserContent } | AgentHistoryMessage;

export interface AgentRuntimeOptions {
  /** Capture assistant/tool messages for providers that require exact transcript replay. */
  captureHistory?: boolean;
  /** When aborted (e.g. user clicked Stop), the stream ends with a `cancelled` chunk. */
  signal?: AbortSignal;
}

const isAbortError = (error: unknown, signal?: AbortSignal): boolean => {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (error instanceof Error && error.name === 'AbortError') return true;
  if (signal?.aborted) return true;
  return false;
};

export const buildLangChainMessages = (messages: AgentMessage[]): BaseMessage[] =>
  messages.map((message) => {
    if (message.role === 'user') {
      return typeof message.content === 'string'
        ? new HumanMessage(message.content)
        : new HumanMessage({ content: message.content as any });
    }
    if (message.role === 'tool') {
      return new ToolMessage({
        content: message.content,
        tool_call_id: message.toolCallId,
        ...(message.name ? { name: message.name } : {}),
      });
    }
    return new AIMessage({
      content: message.content,
      ...(typeof message.reasoningContent === 'string'
        ? { additional_kwargs: { reasoning_content: message.reasoningContent } }
        : {}),
      ...(message.toolCalls?.length ? { tool_calls: message.toolCalls } : {}),
    } as any);
  });

export const serializeAgentHistoryMessages = (
  messages: unknown[],
  startIndex = 0,
): AgentHistoryMessage[] => {
  const serialized: AgentHistoryMessage[] = [];
  for (const rawMessage of messages.slice(startIndex)) {
    const msg: any = rawMessage;
    const msgType = msg?._getType?.() || msg?.type || msg?.constructor?.name || 'unknown';
    if (msgType === 'ai' || msgType === 'AIMessage') {
      const reasoningContent = (msg.additional_kwargs || msg.kwargs)?.reasoning_content;
      const toolCalls = normalizeToolCalls(msg.tool_calls);
      serialized.push({
        role: 'assistant',
        content: normalizeMessageContent(msg.content),
        ...(toolCalls?.length && typeof reasoningContent === 'string' ? { reasoningContent } : {}),
        ...(toolCalls?.length ? { toolCalls } : {}),
      });
      continue;
    }
    if (msgType === 'tool' || msgType === 'ToolMessage') {
      serialized.push({
        role: 'tool',
        content: normalizeMessageContent(msg.content),
        toolCallId: String(msg.tool_call_id ?? ''),
        ...(typeof msg.name === 'string' ? { name: msg.name } : {}),
      });
    }
  }
  return serialized;
};

/**
 * Stream a response from the agent
 * Uses BOTH streamModes for best of both worlds:
 * - 'values' for state transitions (tool calls, results) in proper order
 * - 'messages' for token-by-token text streaming
 *
 * This preserves the natural progression: reasoning → tool → reasoning → tool → answer
 */
export async function* streamAgentResponse(
  agent: ReturnType<typeof createReactAgent>,
  messages: AgentMessage[],
  options: AgentRuntimeOptions = {},
): AsyncGenerator<AgentStreamChunk> {
  try {
    const formattedMessages = buildLangChainMessages(messages);

    // Use BOTH modes: 'values' for structure, 'messages' for token streaming
    const stream = await agent.stream({ messages: formattedMessages }, {
      streamMode: ['values', 'messages'] as any,
      // Allow longer tool/reasoning loops (more Cursor-like persistence)
      recursionLimit: 50,
      signal: options.signal,
    } as any);

    // Track what we've yielded to avoid duplicates
    const yieldedToolCalls = new Set<string>();
    const yieldedToolResults = new Set<string>();
    let lastProcessedMsgCount = formattedMessages.length;
    // Track pending tool calls (for distinguishing reasoning vs final content)
    let pendingToolCalls = 0;
    // Track if we've seen any tool calls in this response turn.
    // Anything before the first tool call should be treated as "reasoning/narration"
    // so the UI can show the Cursor-like loop: plan → tool → update → tool → answer.
    let hasSeenToolCallThisTurn = false;
    // Track the last set of messages so we can persist the raw assistant/tool
    // transcript for the next user turn.
    let lastStepMessages: any[] | null = null;

    for await (const event of stream) {
      if (options.signal?.aborted) {
        break;
      }

      // Events come as [streamMode, data] tuples when using multiple modes
      // or just data when using single mode
      let mode: string;
      let data: any;

      if (Array.isArray(event) && event.length === 2 && typeof event[0] === 'string') {
        [mode, data] = event;
      } else if (Array.isArray(event) && event[0]?._getType) {
        // Single messages mode format: [message, metadata]
        mode = 'messages';
        data = event;
      } else {
        // Assume values mode
        mode = 'values';
        data = event;
      }

      // DEBUG: Enhanced logging
      if (import.meta.env.DEV) {
        const msgType = (mode === 'messages' && data?.[0]?._getType?.()) || 'n/a';
        const hasContent = mode === 'messages' && data?.[0]?.content;
        const hasToolCalls = mode === 'messages' && data?.[0]?.tool_calls?.length > 0;
        console.log(`🔄 [${mode}] type:${msgType} content:${!!hasContent} tools:${hasToolCalls}`);
      }
      // Handle 'messages' mode - token-by-token streaming
      if (mode === 'messages') {
        const [msg] = Array.isArray(data) ? data : [data];
        if (!msg) continue;

        const msgType = msg._getType?.() || msg.type || msg.constructor?.name || 'unknown';

        // AIMessageChunk - streaming text tokens
        if (msgType === 'ai' || msgType === 'AIMessage' || msgType === 'AIMessageChunk') {
          const rawContent = msg.content;
          const toolCalls = msg.tool_calls || [];

          // Handle content that can be string or array of content blocks
          let content: string = '';
          let thinkingContent: string = '';
          if (typeof rawContent === 'string') {
            content = rawContent;
          } else if (Array.isArray(rawContent)) {
            // Content blocks format: [{type: 'text', text: '...'}, ...]
            content = rawContent
              .filter((block: any) => block.type === 'text' || typeof block === 'string')
              .map((block: any) => (typeof block === 'string' ? block : block.text || ''))
              .join('');
            thinkingContent = rawContent
              .filter((block: any) => block?.type === 'thinking')
              .map((block: any) => block.thinking || '')
              .join('');
          }

          if (thinkingContent) {
            yield { type: 'reasoning', reasoning: thinkingContent };
          }

          // If chunk has content, stream it
          if (content && content.length > 0) {
            // Determine if this is reasoning/narration vs final answer content.
            // - Before the first tool call: treat as reasoning (narration)
            // - Between tool calls/results: treat as reasoning
            // - After all tools are done: treat as final content
            const isReasoning =
              !hasSeenToolCallThisTurn || toolCalls.length > 0 || pendingToolCalls > 0;
            if (isReasoning) {
              yield { type: 'reasoning', reasoning: content };
            } else {
              yield { type: 'content', content };
            }
          }

          // Track tool calls from message chunks
          if (toolCalls.length > 0) {
            hasSeenToolCallThisTurn = true;
            pendingToolCalls += toolCalls.length;
            for (const tc of toolCalls) {
              const toolId = tc.id || `tool-${Date.now()}-${Math.random().toString(36).slice(2)}`;
              if (!yieldedToolCalls.has(toolId)) {
                yieldedToolCalls.add(toolId);
                let parsedArgs: Record<string, any>;
                try {
                  parsedArgs = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
                } catch {
                  parsedArgs = {};
                }
                yield {
                  type: 'tool_call',
                  toolCall: {
                    id: toolId,
                    name: tc.name || tc.function?.name || 'unknown',
                    args: tc.args || parsedArgs,
                    status: 'running',
                  },
                };
              }
            }
          }
        }

        // ToolMessage in messages mode
        if (msgType === 'tool' || msgType === 'ToolMessage') {
          const toolCallId = msg.tool_call_id || '';
          if (toolCallId && !yieldedToolResults.has(toolCallId)) {
            yieldedToolResults.add(toolCallId);
            const result =
              typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
            yield {
              type: 'tool_result',
              toolCall: {
                id: toolCallId,
                name: msg.name || 'tool',
                args: {},
                result: result,
                status: 'completed',
              },
            };
            // After tool result, decrement pending count
            pendingToolCalls = Math.max(0, pendingToolCalls - 1);
          }
        }
      }

      // Handle 'values' mode - state snapshots for structure
      if (mode === 'values' && data?.messages) {
        const stepMessages = data.messages || [];
        if (options.captureHistory) {
          lastStepMessages = stepMessages;
        }

        // Process new messages for tool calls/results we might have missed
        for (let i = lastProcessedMsgCount; i < stepMessages.length; i++) {
          const msg = stepMessages[i];
          const msgType = msg._getType?.() || msg.type || 'unknown';

          // Catch tool calls from values mode (backup)
          if ((msgType === 'ai' || msgType === 'AIMessage') && !yieldedToolCalls.size) {
            const toolCalls = msg.tool_calls || [];
            for (const tc of toolCalls) {
              const toolId = tc.id || `tool-${Date.now()}`;
              if (!yieldedToolCalls.has(toolId)) {
                pendingToolCalls++;
                yieldedToolCalls.add(toolId);
                yield {
                  type: 'tool_call',
                  toolCall: {
                    id: toolId,
                    name: tc.name || 'unknown',
                    args: tc.args || {},
                    status: 'running',
                  },
                };
              }
            }
          }

          // Catch tool results from values mode (backup)
          if (msgType === 'tool' || msgType === 'ToolMessage') {
            const toolCallId = msg.tool_call_id || '';
            if (toolCallId && !yieldedToolResults.has(toolCallId)) {
              yieldedToolResults.add(toolCallId);
              const result =
                typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
              yield {
                type: 'tool_result',
                toolCall: {
                  id: toolCallId,
                  name: msg.name || 'tool',
                  args: {},
                  result: result,
                  status: 'completed',
                },
              };
              pendingToolCalls = Math.max(0, pendingToolCalls - 1);
            }
          }
        }

        lastProcessedMsgCount = stepMessages.length;
      }
    }

    if (options.signal?.aborted) {
      yield { type: 'cancelled' };
      return;
    }

    // DEBUG: Stream completed normally
    if (import.meta.env.DEV) {
      console.log('✅ Stream completed normally, yielding done');
    }

    yield {
      type: 'done',
      historyMessages:
        options.captureHistory && lastStepMessages
          ? serializeAgentHistoryMessages(lastStepMessages, formattedMessages.length)
          : undefined,
    };
  } catch (error) {
    if (isAbortError(error, options.signal)) {
      yield { type: 'cancelled' };
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    // DEBUG: Stream error
    if (import.meta.env.DEV) {
      console.error('❌ Stream error:', message, error);
    }
    yield {
      type: 'error',
      error: message,
    };
  }
}

/**
 * Get a non-streaming response from the agent
 * Simpler for cases where streaming isn't needed
 */
export const invokeAgent = async (
  agent: ReturnType<typeof createReactAgent>,
  messages: AgentMessage[],
): Promise<string> => {
  const formattedMessages = buildLangChainMessages(messages);

  const result = await agent.invoke({ messages: formattedMessages });

  // result.messages is the full conversation state
  const lastMessage = result.messages[result.messages.length - 1];
  return lastMessage?.content?.toString() ?? 'No response generated.';
};
