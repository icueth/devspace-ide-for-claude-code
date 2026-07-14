import type { FlowEdge, FlowGraph, FlowNode } from '@shared/flowTypes';

/**
 * Starting graphs for the templates rail. Each one is a complete, runnable
 * flow — the point is that a user clicks "Pipeline" and immediately has
 * something the lead can start from chat, not a skeleton to fill in.
 *
 * All templates must satisfy validateGraph (main): acyclic over non-fail edges,
 * headless is claude-only, gates carry a condition, fail edges only leave a
 * gate and only land on an agent.
 */

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

interface NodeSpec extends Omit<FlowNode, 'x' | 'y'> {
  x: number;
  y: number;
}

function graph(name: string, description: string, nodes: NodeSpec[], edges: FlowEdge[]): FlowGraph {
  const now = Date.now();
  return {
    id: uid('flow'),
    name,
    description,
    nodes,
    edges,
    createdAt: now,
    updatedAt: now,
  };
}

const agent = (
  id: string,
  role: string,
  rolePrompt: string,
  x: number,
  y: number,
  mode: FlowNode['mode'] = 'headless',
): NodeSpec => ({
  id,
  kind: 'agent',
  role,
  rolePrompt,
  cliId: 'claude',
  mode,
  x,
  y,
});

// Row pitch: an agent card is 208 wide, so 280 leaves a comfortable wire run.
const ROW = 180;
const COL = (i: number): number => 80 + i * 280;

/** The mockup's flow: 5 agents, a gate on the tests, and a bounded retry loop. */
function pipelineWithGate(): FlowGraph {
  return graph(
    'feature-pipeline',
    'Multi-step feature work that must ship with passing tests — research, design, implement, test, review. The gate re-queues the coder when tests fail.',
    [
      agent('researcher', 'researcher', 'Read the codebase and summarize exactly what the task touches — files, call sites, existing patterns.', COL(0), ROW),
      agent('architect', 'architect', "Design the change from the researcher's findings. Produce a concrete file-by-file plan.", COL(1), ROW),
      agent('coder', 'coder', 'Implement the plan. Keep the diff tight and match the surrounding style.', COL(2), ROW, 'interactive'),
      agent('tester', 'tester', 'Run the project test suite against the change and report failures verbatim.', COL(3), ROW),
      {
        id: 'gate',
        kind: 'gate',
        role: 'tests pass?',
        rolePrompt: '',
        cliId: 'claude',
        mode: 'headless',
        condition: "The tester's output shows the suite passing with 0 failures.",
        maxRetries: 3,
        x: COL(4),
        y: ROW - 5,
      },
      agent('reviewer', 'reviewer', 'Review the final diff for correctness, security and style. Summarize what changed.', COL(4) + 240, ROW),
      {
        id: 'note',
        kind: 'note',
        role: 'note',
        rolePrompt: '',
        cliId: 'claude',
        mode: 'headless',
        noteText: 'Tests failing sends the work back to the coder — up to 3 times, then the run fails.',
        x: COL(2),
        y: ROW + 210,
      },
    ],
    [
      { from: 'researcher', to: 'architect', label: 'findings' },
      { from: 'architect', to: 'coder', label: 'plan' },
      { from: 'coder', to: 'tester', label: 'diff' },
      { from: 'tester', to: 'gate', label: 'result' },
      { from: 'gate', to: 'reviewer', label: 'pass ✓', branch: 'pass' },
      { from: 'gate', to: 'coder', label: 'fail ✗ retry', branch: 'fail' },
    ],
  );
}

/** Independent parallel work, merged by one synthesizer. */
function fanOutFanIn(): FlowGraph {
  return graph(
    'research-fanout',
    'Open-ended research: three agents investigate different angles in parallel, one synthesizer merges their findings into a single answer.',
    [
      agent('splitter', 'splitter', 'Break the question into three independent angles, one per investigator. State each angle explicitly.', COL(0), ROW),
      agent('angle-a', 'angle-a', 'Investigate the FIRST angle from the splitter. Report findings with file:line evidence.', COL(1), ROW - 150),
      agent('angle-b', 'angle-b', 'Investigate the SECOND angle from the splitter. Report findings with file:line evidence.', COL(1), ROW),
      agent('angle-c', 'angle-c', 'Investigate the THIRD angle from the splitter. Report findings with file:line evidence.', COL(1), ROW + 150),
      agent('synthesizer', 'synthesizer', 'Merge all three investigations. Resolve contradictions explicitly; do not just concatenate.', COL(2), ROW),
    ],
    [
      { from: 'splitter', to: 'angle-a', label: 'angle 1' },
      { from: 'splitter', to: 'angle-b', label: 'angle 2' },
      { from: 'splitter', to: 'angle-c', label: 'angle 3' },
      { from: 'angle-a', to: 'synthesizer', label: 'findings' },
      { from: 'angle-b', to: 'synthesizer', label: 'findings' },
      { from: 'angle-c', to: 'synthesizer', label: 'findings' },
    ],
  );
}

/** A supervisor delegates, an integrator merges, and a gate holds the bar. */
function supervisor(): FlowGraph {
  return graph(
    'supervisor-loop',
    'A supervisor splits the work across two workers, an integrator merges it, and a quality gate sends the integration back until it meets the brief.',
    [
      agent('supervisor', 'supervisor', 'Split the task into two independent work packages and write a crisp brief for each.', COL(0), ROW),
      agent('worker-a', 'worker-a', 'Implement work package A exactly as briefed.', COL(1), ROW - 110, 'interactive'),
      agent('worker-b', 'worker-b', 'Implement work package B exactly as briefed.', COL(1), ROW + 110, 'interactive'),
      agent('integrator', 'integrator', 'Merge both work packages into one coherent change. Resolve conflicts and keep the whole thing building.', COL(2), ROW),
      {
        id: 'gate',
        kind: 'gate',
        role: 'meets brief?',
        rolePrompt: '',
        cliId: 'claude',
        mode: 'headless',
        condition: "The integrated change satisfies the supervisor's brief and builds cleanly.",
        maxRetries: 2,
        x: COL(3),
        y: ROW - 5,
      },
      agent('reporter', 'reporter', 'Summarize the shipped change for the user in plain language.', COL(3) + 240, ROW),
    ],
    [
      { from: 'supervisor', to: 'worker-a', label: 'package A' },
      { from: 'supervisor', to: 'worker-b', label: 'package B' },
      { from: 'worker-a', to: 'integrator', label: 'work' },
      { from: 'worker-b', to: 'integrator', label: 'work' },
      { from: 'integrator', to: 'gate', label: 'result' },
      { from: 'gate', to: 'reporter', label: 'pass ✓', branch: 'pass' },
      { from: 'gate', to: 'integrator', label: 'fail ✗ retry', branch: 'fail' },
    ],
  );
}

export interface FlowTemplate {
  id: string;
  title: string;
  glyph: string;
  blurb: string;
  build: () => FlowGraph;
}

export const FLOW_TEMPLATES: FlowTemplate[] = [
  {
    id: 'pipeline',
    title: 'Pipeline + gate',
    glyph: '○─▶○─▶◇─▶○',
    blurb: 'Sequential handoff, retries on failing tests',
    build: pipelineWithGate,
  },
  {
    id: 'fanout',
    title: 'Fan-out / Fan-in',
    glyph: '○─▶(○ ○ ○)─▶○',
    blurb: 'Parallel research, merged result',
    build: fanOutFanIn,
  },
  {
    id: 'supervisor',
    title: 'Supervisor',
    glyph: '○─▶(○ ○)─▶◇',
    blurb: 'Delegate, integrate, hold the bar',
    build: supervisor,
  },
];
