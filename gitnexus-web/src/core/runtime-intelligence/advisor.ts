import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { RuntimeAdvisorDecision, RuntimeIntelligenceProfile } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../graph/types';
import { createChatModel } from '../llm/agent';
import { getActiveProviderConfig } from '../llm/settings-service';

const stripFence = (text: string): string =>
  text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

const messageText = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  return content
    .map((part) =>
      typeof part === 'string'
        ? part
        : part && typeof part === 'object' && 'text' in part && typeof part.text === 'string'
          ? part.text
          : '',
    )
    .join('');
};

const compactGraphContext = (graph: KnowledgeGraph | null): unknown => {
  if (!graph) return { graphLoaded: false };
  const interesting = new Set(['Route', 'Tool', 'Process', 'File', 'Function', 'Method', 'Class']);
  return {
    graphLoaded: true,
    nodeCount: graph.nodeCount,
    relationshipCount: graph.relationshipCount,
    sample: graph.nodes
      .filter((node) => interesting.has(node.label))
      .slice(0, 180)
      .map((node) => ({
        id: node.id,
        label: node.label,
        name: node.properties?.name,
        filePath: node.properties?.filePath,
        startLine: node.properties?.startLine,
        endLine: node.properties?.endLine,
      })),
  };
};

const SYSTEM = `You are the Runtime Intelligence planner inside GitNexus.
Use deterministic repository reconnaissance and the compact graph sample to improve how GitNexus traces and visualizes this application.

Return JSON only, without markdown fences. Never invent a launch command without evidence. Prefer tracer mechanisms already present in the base profile. Use stable rule IDs. Regex fields must be valid JavaScript regex source strings. Make meaningful behavior visible instead of assigning unique animations to low-value helpers.

The response may contain summary, componentUpdates, visualizationRules, hypotheses, and confidence. Component updates must reference an existing componentId. Do not return repository identity, schema, generation, or observations.`;

/** Run through the existing browser-side provider so credentials never enter the server. */
export async function runRuntimeAdvisor(
  profile: RuntimeIntelligenceProfile,
  graph: KnowledgeGraph | null,
): Promise<RuntimeAdvisorDecision> {
  const provider = getActiveProviderConfig();
  if (!provider) throw new Error('No Nexus AI provider is configured');
  const response = await createChatModel(provider).invoke([
    new SystemMessage(SYSTEM),
    new HumanMessage(
      JSON.stringify({
        profile,
        graph: compactGraphContext(graph),
        request: [
          'Validate app components, entry points, and launch commands.',
          'Choose supported tracing strategies.',
          'Create semantic rules for UI, routes, rendering, network, storage, queues, errors, and important domain actions.',
          'Add hypotheses that future runtime observations can confirm or reject.',
        ],
      }),
    ),
  ]);
  const parsed: unknown = JSON.parse(stripFence(messageText(response.content)));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Runtime advisor returned invalid JSON');
  }
  return parsed as RuntimeAdvisorDecision;
}
