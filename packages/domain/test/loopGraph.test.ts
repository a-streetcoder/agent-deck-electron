import { describe, expect, it } from "vitest";
import {
  loopDefinitionValidationError,
  loopGraph,
  loopGraphColumns,
  loopRequiredAgentRoles,
  type LoopDefinition,
  type LoopGraph,
} from "../src/loops.ts";

const ids = (graph: LoopGraph): string[][] => {
  const checked = loopGraphColumns(graph);
  if ("error" in checked) throw new Error(checked.error);
  return checked.columns.map((column) => column.map((node) => node.id));
};
const error = (graph: LoopGraph): string | undefined => {
  const checked = loopGraphColumns(graph);
  return "error" in checked ? checked.error : undefined;
};

describe("loopGraph: the six structures normalise to builtin templates", () => {
  it("singleAgent: maker then evaluator, CONTINUE back to the maker", () => {
    const graph = loopGraph({ structure: "singleAgent", agentName: "Solo" });
    expect(graph).toEqual({
      nodes: [
        { id: "maker", kind: "maker", agentName: "Solo" },
        { id: "evaluator", kind: "evaluator" },
      ],
      edges: [
        { from: "maker", to: "evaluator" },
        { from: "evaluator", to: "maker", when: "CONTINUE", budgeted: true },
      ],
    });
    expect(ids(graph)).toEqual([["maker"], ["evaluator"]]);
  });

  it("makerChecker: a checker FAIL edge and an evaluator CONTINUE edge, both budgeted", () => {
    const graph = loopGraph({ structure: "makerChecker", makerName: "M", checkerName: "C" });
    expect(graph.nodes.map((node) => [node.kind, node.agentName])).toEqual([
      ["maker", "M"],
      ["checker", "C"],
      ["evaluator", undefined],
    ]);
    expect(graph.edges.filter((edge) => edge.budgeted)).toEqual([
      { from: "checker", to: "maker", when: "FAIL", budgeted: true },
      { from: "evaluator", to: "maker", when: "CONTINUE", budgeted: true },
    ]);
    expect(ids(graph)).toEqual([["maker"], ["checker"], ["evaluator"]]);
  });

  it("agentPipeline: ordered stages (repeats kept) in one chain", () => {
    const graph = loopGraph({ structure: "agentPipeline", pipelineStages: ["A", "B", "A"] });
    expect(ids(graph)).toEqual([["stage-1"], ["stage-2"], ["stage-3"], ["evaluator"]]);
    expect(graph.nodes.map((node) => node.agentName)).toEqual(["A", "B", "A", undefined]);
  });

  it("parallelAgents: normalised branches share the first column", () => {
    const graph = loopGraph({
      structure: "parallelAgents",
      parallelBranches: [" A ", "", "B", "A"],
    });
    expect(ids(graph)).toEqual([["branch-1", "branch-2"], ["evaluator"]]);
    expect(graph.nodes.map((node) => node.agentName)).toEqual(["A", "B", undefined]);
  });

  it("discoveryTriage and humanApproval", () => {
    expect(ids(loopGraph({ structure: "discoveryTriage", triageAgent: "T" }))).toEqual([
      ["triage"],
      ["evaluator"],
    ]);
    expect(ids(loopGraph({ structure: "humanApproval" }))).toEqual([["human"]]);
  });

  it("a hand-written graph wins over the flat fields", () => {
    const graph: LoopGraph = { nodes: [{ id: "e", kind: "evaluator" }], edges: [] };
    expect(loopGraph({ structure: "makerChecker", graph })).toBe(graph);
  });
});

const PIPELINE_WITH_CHECKER: LoopGraph = {
  nodes: [
    { id: "plan", kind: "stage", agentName: "Planner" },
    { id: "build", kind: "stage", agentName: "Builder" },
    { id: "review", kind: "checker", agentName: "Reviewer" },
    { id: "judge", kind: "evaluator" },
  ],
  edges: [
    { from: "plan", to: "build" },
    { from: "build", to: "review" },
    { from: "review", to: "judge" },
    { from: "review", to: "plan", when: "FAIL", budgeted: true },
    { from: "judge", to: "plan", when: "CONTINUE", budgeted: true },
  ],
};

describe("loopGraphColumns: graph validation", () => {
  it("accepts a pipeline with a checker after stage two", () => {
    expect(ids(PIPELINE_WITH_CHECKER)).toEqual([["plan"], ["build"], ["review"], ["judge"]]);
  });

  it("places a node by its longest path", () => {
    const graph: LoopGraph = {
      nodes: [
        { id: "a", kind: "stage" },
        { id: "b", kind: "stage" },
        { id: "e", kind: "evaluator" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "e" },
        { from: "b", to: "e" },
      ],
    };
    expect(ids(graph)).toEqual([["a"], ["b"], ["e"]]);
  });

  it("rejects a cycle that is not budgeted", () => {
    const edges = PIPELINE_WITH_CHECKER.edges.map((edge) =>
      edge.from === "judge" ? { from: "build", to: "plan" } : edge,
    );
    expect(error({ ...PIPELINE_WITH_CHECKER, edges })).toMatch(/exactly one entry node/);
    const loop: LoopGraph = {
      nodes: [
        { id: "a", kind: "maker" },
        { id: "b", kind: "stage" },
        { id: "c", kind: "stage" },
        { id: "e", kind: "evaluator" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "c", to: "b" },
        { from: "c", to: "e" },
      ],
    };
    expect(error(loop)).toBe("A loop graph may cycle only through budgeted edges.");
  });

  it("rejects two entries and an unreachable node", () => {
    const graph: LoopGraph = {
      nodes: [...PIPELINE_WITH_CHECKER.nodes, { id: "orphan", kind: "maker", agentName: "M" }],
      edges: PIPELINE_WITH_CHECKER.edges,
    };
    expect(error(graph)).toBe(
      "A loop graph needs exactly one entry node; every node must be reachable from it.",
    );
  });

  it("rejects budgeted edges that skip the entry or leave the wrong node", () => {
    const toBuild = PIPELINE_WITH_CHECKER.edges.map((edge) =>
      edge.from === "judge" ? { ...edge, to: "build" } : edge,
    );
    expect(error({ ...PIPELINE_WITH_CHECKER, edges: toBuild })).toBe(
      "A budgeted edge must lead back to the entry.",
    );
    const fromStage = [
      ...PIPELINE_WITH_CHECKER.edges,
      { from: "build", to: "plan", when: "CONTINUE" as const, budgeted: true },
    ];
    expect(error({ ...PIPELINE_WITH_CHECKER, edges: fromStage })).toMatch(/budgeted edge leaves/);
  });

  it("rejects conditions on forward edges, unknown nodes, and duplicate ids", () => {
    const conditional = PIPELINE_WITH_CHECKER.edges.map((edge) =>
      edge.from === "plan" ? { ...edge, when: "APPROVE" as const } : edge,
    );
    expect(error({ ...PIPELINE_WITH_CHECKER, edges: conditional })).toMatch(/Only budgeted/);
    expect(error({ ...PIPELINE_WITH_CHECKER, edges: [{ from: "plan", to: "nowhere" }] })).toMatch(
      /unknown node/,
    );
    expect(
      error({ nodes: [...PIPELINE_WITH_CHECKER.nodes, { id: "plan", kind: "stage" }], edges: [] }),
    ).toMatch(/unique/);
  });

  it("needs one evaluator that ends the iteration", () => {
    expect(error({ nodes: [{ id: "m", kind: "maker" }], edges: [] })).toBe(
      "A loop graph needs exactly one evaluator.",
    );
    const evaluatorFirst: LoopGraph = {
      nodes: [
        { id: "e", kind: "evaluator" },
        { id: "m", kind: "maker" },
      ],
      edges: [{ from: "e", to: "m" }],
    };
    expect(error(evaluatorFirst)).toMatch(/evaluator must end/);
  });

  it("keeps human checkpoints on their own and branches at the start", () => {
    expect(
      error({
        nodes: [
          { id: "h", kind: "human" },
          { id: "e", kind: "evaluator" },
        ],
        edges: [{ from: "h", to: "e" }],
      }),
    ).toMatch(/human checkpoint/);
    expect(
      error({
        nodes: [
          { id: "m", kind: "maker" },
          { id: "b", kind: "branch" },
          { id: "e", kind: "evaluator" },
        ],
        edges: [
          { from: "m", to: "b" },
          { from: "b", to: "e" },
        ],
      }),
    ).toMatch(/Parallel branches start/);
  });
});

describe("hand-written graphs in definition validation and preflight", () => {
  const loop = {
    name: "graph",
    goal: "Ship it.",
    structure: "agentPipeline",
    checkerRubric: "Evidence.",
    writeTarget: "artifactMarkdown",
    graph: PIPELINE_WITH_CHECKER,
  } satisfies Partial<LoopDefinition>;

  it("validates the graph instead of the flat fields", () => {
    expect(loopDefinitionValidationError(loop)).toBeUndefined();
    expect(loopDefinitionValidationError({ ...loop, checkerRubric: "" })).toBe(
      "A checker rubric is required.",
    );
    const blank = {
      ...PIPELINE_WITH_CHECKER,
      nodes: PIPELINE_WITH_CHECKER.nodes.map((node) =>
        node.id === "build" ? { ...node, agentName: " " } : node,
      ),
    };
    expect(loopDefinitionValidationError({ ...loop, graph: blank })).toBe(
      'Graph node "build" needs an agent.',
    );
  });

  it("lists the graph's agent roles for preflight", () => {
    expect(loopRequiredAgentRoles(loop)).toEqual([
      { role: "stage", position: 1, agentName: "Planner" },
      { role: "stage", position: 2, agentName: "Builder" },
      { role: "checker", agentName: "Reviewer" },
    ]);
  });
});
