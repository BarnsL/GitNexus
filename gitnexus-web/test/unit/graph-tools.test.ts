import { describe, expect, it, vi } from 'vitest';
import { createGraphControlTools, GRAPH_CONTROL_TOOL_NAMES } from '../../src/core/llm/graph-tools';
import type { NexusGraphController } from '../../src/core/llm/graph-controller';

const stubController = () =>
  ({
    focusNode: vi.fn(async () => 'focused'),
    frameNodes: vi.fn(async () => 'framed'),
    setHighlight: vi.fn(async () => 'highlighted'),
    animate: vi.fn(async () => 'animated'),
    setViewMode: vi.fn(async () => 'switched'),
    setFilters: vi.fn(async () => 'filtered'),
    openCode: vi.fn(async () => 'opened'),
    neighbors: vi.fn(async () => 'neighbors'),
    snapshot: vi.fn(async () => ({ viewMode: 'force', totalNodeCount: 7 })),
    clearVisuals: vi.fn(async () => 'cleared'),
  }) as unknown as NexusGraphController & Record<string, ReturnType<typeof vi.fn>>;

const toolNamed = (ui: NexusGraphController, name: string) => {
  const found = createGraphControlTools(ui).find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not registered`);
  return found;
};

describe('graph control tool registration', () => {
  it('registers exactly the nine declared names', () => {
    const tools = createGraphControlTools(stubController());
    expect(tools).toHaveLength(9);
    expect(tools.map((t) => t.name).sort()).toEqual([...GRAPH_CONTROL_TOOL_NAMES].sort());
  });

  it('gives every tool a description, since the model picks tools by description', () => {
    for (const t of createGraphControlTools(stubController())) {
      expect(t.description).toBeTruthy();
    }
  });
});

describe('focus_node', () => {
  it('forwards the target and options', async () => {
    const ui = stubController();
    await toolNamed(ui, 'focus_node').invoke({ target: 'envBaseFor', zoom: 0.2 });
    expect(ui.focusNode).toHaveBeenCalledWith('envBaseFor', { zoom: 0.2, openCode: undefined });
  });

  it('returns a controller failure as text instead of throwing', async () => {
    const ui = stubController();
    ui.focusNode = vi.fn(async () => {
      throw new Error('canvas gone');
    });
    const output = await toolNamed(ui, 'focus_node').invoke({ target: 'x' });
    expect(String(output)).toContain('canvas gone');
  });
});

describe('show_neighbors', () => {
  it('clamps depth into the supported range', async () => {
    const ui = stubController();
    await toolNamed(ui, 'show_neighbors').invoke({ target: 'x', depth: 9 });
    expect(ui.neighbors).toHaveBeenCalledWith('x', expect.objectContaining({ depth: 3 }));

    await toolNamed(ui, 'show_neighbors').invoke({ target: 'x', depth: 0 });
    expect(ui.neighbors).toHaveBeenLastCalledWith('x', expect.objectContaining({ depth: 1 }));
  });

  it('defaults to a single hop', async () => {
    const ui = stubController();
    await toolNamed(ui, 'show_neighbors').invoke({ target: 'x' });
    expect(ui.neighbors).toHaveBeenCalledWith('x', expect.objectContaining({ depth: 1 }));
  });
});

describe('highlight_nodes', () => {
  it('maps the style name onto the internal highlight channel', async () => {
    const ui = stubController();
    await toolNamed(ui, 'highlight_nodes').invoke({ targets: ['a'], style: 'impact' });
    expect(ui.setHighlight).toHaveBeenCalledWith(['a'], 'blast-radius');
  });

  it('defaults to the cyan relevance channel', async () => {
    const ui = stubController();
    await toolNamed(ui, 'highlight_nodes').invoke({ targets: ['a'] });
    expect(ui.setHighlight).toHaveBeenCalledWith(['a'], 'ai-tool');
  });

  it('plays the matching animation only when asked', async () => {
    const ui = stubController();
    await toolNamed(ui, 'highlight_nodes').invoke({ targets: ['a'], style: 'impact' });
    expect(ui.animate).not.toHaveBeenCalled();

    await toolNamed(ui, 'highlight_nodes').invoke({
      targets: ['a'],
      style: 'impact',
      animate: true,
    });
    expect(ui.animate).toHaveBeenCalledWith(['a'], 'ripple');
  });
});

describe('graph_snapshot', () => {
  it('serializes the snapshot object to text for the model', async () => {
    const ui = stubController();
    const output = await toolNamed(ui, 'graph_snapshot').invoke({});
    expect(String(output)).toContain('force');
    expect(String(output)).toContain('7');
  });
});

describe('open_code', () => {
  it('passes line numbers through as 1-based', async () => {
    const ui = stubController();
    await toolNamed(ui, 'open_code').invoke({
      filePath: 'src/a.ts',
      startLine: 30,
      endLine: 55,
    });
    expect(ui.openCode).toHaveBeenCalledWith({
      filePath: 'src/a.ts',
      startLine: 30,
      endLine: 55,
    });
  });
});
