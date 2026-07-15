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
  model?: string,
): NodeSpec => ({
  id,
  kind: 'agent',
  role,
  rolePrompt,
  cliId: 'claude',
  mode,
  ...(model ? { model } : {}),
  x,
  y,
});

const gate = (
  id: string,
  role: string,
  condition: string,
  x: number,
  y: number,
  maxRetries = 3,
): NodeSpec => ({
  id,
  kind: 'gate',
  role,
  rolePrompt: '',
  cliId: 'claude',
  mode: 'headless',
  condition,
  maxRetries,
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

/** Two coders splitting statically by role — no splitter, both are entries. */
function codeFanout(): FlowGraph {
  return graph(
    'code-fanout',
    'Coding work that splits cleanly into two areas done in parallel (e.g. backend + UI). Both coders receive the same task and take the part matching their role; a reviewer merges and reports. NOT for tasks needing one coherent sequence of edits — use feature-pipeline for that.',
    [
      agent('coder-a', 'coder-a', 'From the task, take ONLY the backend/logic/main-process side. Do not touch UI files — coder-b owns those and works in parallel on the same tree. End with the list of files you changed.', COL(0), ROW - 100, 'interactive'),
      agent('coder-b', 'coder-b', 'From the task, take ONLY the UI/renderer side. Do not touch backend files — coder-a owns those and works in parallel on the same tree. End with the list of files you changed.', COL(0), ROW + 100, 'interactive'),
      agent('reviewer', 'reviewer', 'Both coders are done. Read the git diff, verify the halves fit together and cover the whole task, and write a concise completion report per file.', COL(1), ROW, 'headless', 'opus'),
    ],
    [
      { from: 'coder-a', to: 'reviewer', label: 'work' },
      { from: 'coder-b', to: 'reviewer', label: 'work' },
    ],
  );
}

/** Plan first, build in parallel, integrate, then loop on tests until green. */
function bigFeature(): FlowGraph {
  return graph(
    'big-feature',
    'Large multi-area features that need a real plan before code: an architect designs and splits the work with explicit file ownership, two coders implement in parallel, an integrator reconciles the halves, then a test loop (failures re-queue the integrator) until green, and a reviewer writes the final report.',
    [
      agent('architect', 'architect', "Design before code. Read the relevant code, then produce: (1) a short plan, (2) TWO work packages 'PACKAGE A' and 'PACKAGE B' with EXPLICIT file ownership each (no shared files), (3) the integration contract between them (types, signatures, channel names). Do not implement.", COL(0), ROW, 'headless', 'opus'),
      agent('coder-a', 'coder-a', "Implement PACKAGE A exactly within its file ownership, following the integration contract to the letter — the other half is being built against it right now. End with the files you changed.", COL(1), ROW - 100, 'interactive'),
      agent('coder-b', 'coder-b', "Implement PACKAGE B exactly within its file ownership, following the integration contract to the letter. End with the files you changed.", COL(1), ROW + 100, 'interactive'),
      agent('integrator', 'integrator', 'Both packages are in. Fix any seam between them (names, wiring, imports) and make the project typecheck. If a tester reported failures upstream, fix exactly those. Reconcile — do not redesign.', COL(2), ROW),
      agent('tester', 'tester', "Run the project's typecheck, tests, and build. Report every failure verbatim, or state clearly that everything passes.", COL(3), ROW),
      gate('gate', 'tests pass?', "The tester's report shows typecheck, tests, and build ALL passing with zero failures.", COL(4), ROW - 5),
      agent('reviewer', 'reviewer', 'Everything is green. Review the full diff for correctness and safety, then write the completion report.', COL(4) + 240, ROW, 'headless', 'opus'),
    ],
    [
      { from: 'architect', to: 'coder-a', label: 'package A' },
      { from: 'architect', to: 'coder-b', label: 'package B' },
      { from: 'coder-a', to: 'integrator', label: 'work' },
      { from: 'coder-b', to: 'integrator', label: 'work' },
      { from: 'integrator', to: 'tester', label: 'merged' },
      { from: 'tester', to: 'gate', label: 'result' },
      { from: 'gate', to: 'reviewer', label: 'pass ✓', branch: 'pass' },
      { from: 'gate', to: 'integrator', label: 'fail ✗ retry', branch: 'fail' },
    ],
  );
}

/** Root-cause first, code second — the diagnosis drives the fix. */
function debugFirst(): FlowGraph {
  return graph(
    'debug-first',
    "Bug and incident work where the ROOT CAUSE must be found before any code is written (protocol issues, reverse-engineering, 'it fails and nobody knows why'). An investigator diagnoses and writes an exact fix plan, a coder implements ONLY that plan, and a verifier + gate loop re-queues the coder until the fix is confirmed against the original symptom.",
    [
      agent('investigator', 'investigator', 'ROOT CAUSE ONLY — you write no fixes. Trace the reported problem to its origin. Output: (1) symptom, (2) root cause with file:line citations, (3) evidence, (4) an EXACT fix plan, (5) how to verify it. If you cannot pin the cause, say what evidence would settle it — never guess.', COL(0), ROW, 'headless', 'opus'),
      agent('coder', 'coder', "Implement EXACTLY the investigator's fix plan — no refactors, no drive-by cleanups. If the plan is impossible as written, stop and explain instead of improvising. If a verifier reported the fix incomplete, address exactly its findings.", COL(1), ROW, 'interactive'),
      agent('verifier', 'verifier', 'Check the fix against the diagnosis: does the change address the stated ROOT CAUSE (not just the symptom)? Re-run the verification steps from the plan. Report confirmed or not, with evidence and regression risk.', COL(2), ROW),
      gate('gate', 'fix confirmed?', 'The verifier confirms the root cause is addressed and the original failure no longer reproduces.', COL(3), ROW - 5),
      agent('reporter', 'reporter', 'Write the closing report: symptom, root cause, the fix that landed, how it was verified, and anything worth remembering for next time.', COL(3) + 240, ROW),
    ],
    [
      { from: 'investigator', to: 'coder', label: 'fix plan' },
      { from: 'coder', to: 'verifier', label: 'fix' },
      { from: 'verifier', to: 'gate', label: 'check' },
      { from: 'gate', to: 'reporter', label: 'pass ✓', branch: 'pass' },
      { from: 'gate', to: 'coder', label: 'fail ✗ retry', branch: 'fail' },
    ],
  );
}

/** Two investigators cross-check the same question; the answer IS the output. */
function researchDuo(): FlowGraph {
  return graph(
    'research-duo',
    'Research or analysis questions that END WITH A WRITTEN ANSWER — no code changes at all. Two investigators cross-check the same question from opposite angles; a reviewer merges them into one verified answer. If the task also requires implementing code, use research-to-code instead.',
    [
      agent('research-1', 'research-1', 'Primary investigator. Start your report by RESTATING THE TASK verbatim (downstream nodes rely on it), then establish the facts: read the relevant code/docs and cite file:line for every claim.', COL(0), ROW - 100),
      agent('research-2', 'research-2', 'Counter-investigator. Restate the task verbatim, then attack the SAME question from the opposite side: risks, edge cases, alternatives, and what the direct reading would miss. Cite file:line.', COL(0), ROW + 100),
      agent('review', 'review', 'Merge the two investigations into ONE answer: reconcile contradictions (say which side wins and why), keep every load-bearing citation, and finish with a clear verdict.', COL(1), ROW, 'headless', 'opus'),
    ],
    [
      { from: 'research-1', to: 'review', label: 'findings' },
      { from: 'research-2', to: 'review', label: 'findings' },
    ],
  );
}

/** Research feeds two parallel coders — cross edges so BOTH see BOTH reports. */
function researchToCode(): FlowGraph {
  return graph(
    'research-to-code',
    'Work that starts with investigation and ENDS IN CODE: two researchers establish the facts, two coders implement in parallel informed by BOTH reports, a reviewer checks the combined result. If the task is a question with no code to write, use research-duo instead.',
    [
      agent('research-1', 'research-1', 'Primary investigator. Restate the task verbatim, then establish the facts with file:line citations.', COL(0), ROW - 100),
      agent('research-2', 'research-2', 'Counter-investigator. Restate the task verbatim, then cover risks, edge cases, and alternatives with file:line citations.', COL(0), ROW + 100),
      agent('coding-1', 'coding-1', 'You receive BOTH research reports. Implement the backend/logic side of the task they describe. Do NOT touch UI files — coding-2 owns those and works in parallel. End with the files you changed.', COL(1), ROW - 100, 'interactive'),
      agent('coding-2', 'coding-2', 'You receive BOTH research reports. Implement the UI/renderer side. Do NOT touch backend files — coding-1 owns those. End with the files you changed.', COL(1), ROW + 100, 'interactive'),
      agent('review', 'review', "Both coders are done. Read the combined git diff, check it against what they say they did, verify the halves fit and the task is covered, and write the completion report.", COL(2), ROW, 'headless', 'opus'),
    ],
    [
      { from: 'research-1', to: 'coding-1', label: 'facts' },
      { from: 'research-1', to: 'coding-2', label: 'facts' },
      { from: 'research-2', to: 'coding-1', label: 'risks' },
      { from: 'research-2', to: 'coding-2', label: 'risks' },
      { from: 'coding-1', to: 'review', label: 'work' },
      { from: 'coding-2', to: 'review', label: 'work' },
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
    blurb: 'Split a question, investigate in parallel, merge',
    build: fanOutFanIn,
  },
  {
    id: 'supervisor',
    title: 'Supervisor',
    glyph: '○─▶(○ ○)─▶◇',
    blurb: 'Delegate, integrate, hold the bar',
    build: supervisor,
  },
  {
    id: 'code-fanout',
    title: 'Code fan-out',
    glyph: '(○ ○)─▶○',
    blurb: 'Two coders split by role, no splitter',
    build: codeFanout,
  },
  {
    id: 'big-feature',
    title: 'Big feature',
    glyph: '○─▶(○ ○)─▶○─▶◇─▶○',
    blurb: 'Plan, build in parallel, integrate, test loop',
    build: bigFeature,
  },
  {
    id: 'debug-first',
    title: 'Debug first',
    glyph: '○─▶○─▶○─▶◇',
    blurb: 'Root-cause before code, verified fix loop',
    build: debugFirst,
  },
  {
    id: 'research-duo',
    title: 'Research duo',
    glyph: '(○ ○)─▶○',
    blurb: 'Cross-checked answer, no code changes',
    build: researchDuo,
  },
  {
    id: 'research-to-code',
    title: 'Research → code',
    glyph: '(○ ○)⇉(○ ○)─▶○',
    blurb: 'Facts first, then parallel implementation',
    build: researchToCode,
  },
];
