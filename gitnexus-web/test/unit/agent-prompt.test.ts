import { describe, expect, it } from 'vitest';
import { BASE_SYSTEM_PROMPT } from '../../src/core/llm/agent';
import { buildDynamicSystemPrompt, type CodebaseContext } from '../../src/core/llm/context-builder';
import {
  createGraphRAGTools,
  GRAPH_RAG_TOOL_NAMES,
  type GraphRAGBackend,
} from '../../src/core/llm/tools';
import { NODE_REF_REGEX } from '../../src/lib/grounding-patterns';
import { createNoopGraphController } from '../../src/core/llm/graph-controller';

const MINIMAL_CONTEXT: CodebaseContext = {
  stats: {
    projectName: 'proj',
    fileCount: 0,
    functionCount: 0,
    classCount: 0,
    interfaceCount: 0,
    methodCount: 0,
  },
  hotspots: [],
  folderTree: '',
};

const RUNTIME_CONTEXT: CodebaseContext = {
  ...MINIMAL_CONTEXT,
  runtime: {
    profileGeneration: 7,
    actions: [
      {
        id: 'runtime-aaaaaaaaaaaaaaaa',
        componentId: 'web',
        kind: 'trace-app',
        title: 'Start Web app with tracing',
        description: 'Starts the detected app and streams function activity into the dock.',
        commandPreview: 'npm run dev',
        workingDirectory: '.',
        tracers: ['node-v8-coverage'],
        enabled: true,
      },
    ],
    runs: [],
  },
};

/** Legacy or phantom tool names that must not appear in the system prompt. */
const FORBIDDEN_TOOL_NAMES = [
  'hybrid_search',
  'semantic_search',
  'semantic_search_with_context',
  'execute_cypher',
  'execute_vector_cypher',
  'grep_code',
  'read_file',
  'get_graph_schema',
  'get_code_content',
  'get_codebase_stats',
] as const;

/**
 * No-op backend. createGraphRAGTools only captures these methods inside each tool's
 * async execute closure — it never invokes them at construction time — so empty
 * implementations are enough to build the tools and read their registered names.
 */
const stubBackend: GraphRAGBackend = {
  executeQuery: async () => [],
  search: async () => [],
  grep: async () => [],
  readFile: async () => '',
};

describe('BASE_SYSTEM_PROMPT tool parity', () => {
  it('documents every registered Graph RAG tool by exact name', () => {
    for (const name of GRAPH_RAG_TOOL_NAMES) {
      expect(BASE_SYSTEM_PROMPT).toContain(`\`${name}\``);
    }
  });

  it('keeps GRAPH_RAG_TOOL_NAMES in sync with the tools createGraphRAGTools registers', () => {
    // Graph control tools only register when a UI controller is supplied, so
    // the parity check must pass one. The constant lists every registerable
    // tool, which is what BASE_SYSTEM_PROMPT is checked against.
    const registered = createGraphRAGTools(stubBackend, createNoopGraphController()).map(
      (t) => t.name,
    );
    expect(registered.sort()).toEqual([...GRAPH_RAG_TOOL_NAMES].sort());
  });

  it('omits graph control tools when no UI controller is available (chat-only)', () => {
    const registered = createGraphRAGTools(stubBackend).map((t) => t.name);
    expect(registered).not.toContain('focus_node');
    expect(registered).toContain('search');
  });

  it('does not reference legacy or non-existent tool names', () => {
    for (const name of FORBIDDEN_TOOL_NAMES) {
      // Word-boundary match catches both backticked and bare-prose mentions.
      expect(BASE_SYSTEM_PROMPT).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
  });

  it('uses explicit file citation format expected by the UI parser', () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/\[\[src\/[^\]]+:\d+-\d+\]\]/);
    expect(BASE_SYSTEM_PROMPT).not.toContain('[[file:line]]');
  });

  it('documents a parser-recognized symbol citation format', () => {
    // Use the UI parser's own allowlist (NODE_REF_REGEX) so this tracks the parser
    // instead of forking its label list. NODE_REF_REGEX is /g; use a non-global copy
    // so the match is stateless.
    expect(BASE_SYSTEM_PROMPT).toMatch(new RegExp(NODE_REF_REGEX.source));
  });

  it('documents typed node labels, not polymorphic CodeNode', () => {
    expect(BASE_SYSTEM_PROMPT).toContain('MATCH (f:Function)');
    expect(BASE_SYSTEM_PROMPT).not.toContain('CodeNode');
    expect(BASE_SYSTEM_PROMPT).not.toContain('INHERITS');
  });

  it('never names highlight_in_graph, which has never been a real tool', () => {
    // The prompt used to carry a disclaimer about this invented name. Real
    // highlight tools now exist (highlight_nodes), so the disclaimer is gone —
    // but the registry-level guarantee still holds and the prompt must never
    // instruct the model to call the invented name.
    expect(GRAPH_RAG_TOOL_NAMES).not.toContain('highlight_in_graph');
    expect(BASE_SYSTEM_PROMPT).not.toMatch(/\b(?:use|call|invoke)\s+`?highlight_in_graph/i);
  });
});

describe('buildDynamicSystemPrompt chat-only mode (#2178)', () => {
  it('appends a chat-only note that overrides VISUAL GROUNDING when chatOnly', () => {
    const prompt = buildDynamicSystemPrompt(BASE_SYSTEM_PROMPT, MINIMAL_CONTEXT, true);
    expect(prompt).toContain('CHAT-ONLY MODE');
    expect(prompt).toMatch(/node citations will NOT highlight/i);
    expect(prompt).toContain('[[path:START-END]]');
  });

  it('leaves the prompt unchanged when chatOnly is false/omitted', () => {
    const full = buildDynamicSystemPrompt(BASE_SYSTEM_PROMPT, MINIMAL_CONTEXT);
    const explicitFalse = buildDynamicSystemPrompt(BASE_SYSTEM_PROMPT, MINIMAL_CONTEXT, false);
    expect(full).toBe(explicitFalse);
    expect(full).not.toContain('CHAT-ONLY MODE');
  });
});

describe('Nexus runtime guidance', () => {
  it('teaches a layperson through the GUI and requires a safe confirmation card', () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/plain language/i);
    expect(BASE_SYSTEM_PROMPT).toMatch(/why (?:it|this) matters/i);
    expect(BASE_SYSTEM_PROMPT).toMatch(/before you start/i);
    expect(BASE_SYSTEM_PROMPT).toMatch(/success looks like/i);
    expect(BASE_SYSTEM_PROMPT).toMatch(/next safe action/i);
    expect(BASE_SYSTEM_PROMPT).toMatch(/Runtime Intelligence/i);
    expect(BASE_SYSTEM_PROMPT).toMatch(/bottom dock/i);
    expect(BASE_SYSTEM_PROMPT).toMatch(/never invent/i);
    expect(BASE_SYSTEM_PROMPT).toContain('[[runtime-action:runtime-');
  });

  it('injects only the server-advertised action IDs and current managed state', () => {
    const prompt = buildDynamicSystemPrompt(BASE_SYSTEM_PROMPT, RUNTIME_CONTEXT);
    expect(prompt).toContain('runtime-aaaaaaaaaaaaaaaa');
    expect(prompt).toContain('Start Web app with tracing');
    expect(prompt).toContain('npm run dev');
    expect(prompt).toMatch(/No managed runs are active/i);
  });
});

describe('graph control prompt', () => {
  it('documents every registered tool name', () => {
    for (const name of GRAPH_RAG_TOOL_NAMES) {
      expect(BASE_SYSTEM_PROMPT).toContain(name);
    }
  });

  it('no longer claims the agent cannot move the viewport or switch view mode', () => {
    expect(BASE_SYSTEM_PROMPT).not.toContain('You cannot programmatically zoom');
    expect(BASE_SYSTEM_PROMPT).not.toContain('You cannot switch the view mode');
    expect(BASE_SYSTEM_PROMPT).not.toContain('There is NO `highlight_in_graph` tool');
  });

  it('bounds camera movement to one destination per reply', () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/at most ONE time per reply/i);
  });

  it('forbids reporting a hidden relationship as nonexistent', () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/NEVER claim a relationship does not exist/i);
  });

  it('requires narrating what the navigation did', () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/narrate what you just did/i);
  });
});
