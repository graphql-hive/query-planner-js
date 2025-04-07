import {
  Edge,
  EntityMove,
  FieldMove,
  Graph,
  Node,
  Selection,
  SelectionNode,
  Field,
} from "./graph.js";
import { OperationTypeNode } from "graphql";
import { invariant } from "./utils.js";
import { Logger, LoggerContext } from "../utils/logger.js";

type Step = FieldStep;

type FieldStep = {
  kind: "Field";
  /**
   * Name of the field, we want to want to walk to
   */
  name: string;
};

export function walkQuery(
  graph: Graph,
  operationType: OperationTypeNode,
  steps: Step[],
) {
  const logger = new Logger("walker.ts", new LoggerContext("planner", 20));
  const initialPaths = graph
    .nodesOf(operationTypeToTypeName(operationType))
    .map((node) => new OperationPath(node));
  const stepsCloned = steps.slice();
  const stack: [Step, OperationPath[]][] = [
    [stepsCloned.shift()!, initialPaths],
  ];

  while (stack.length > 0) {
    const [step, paths] = stack.pop()!;

    logger.group(() => `Trying to advance to step: ${step.kind} ${step.name}`);

    if (step.kind !== "Field") {
      throw new Error(`Unsupported step kind: ${(step as any).kind}`);
    }

    const nextPaths: OperationPath[] = [];

    for (const path of paths) {
      logger.group(() => "Finding paths from " + path.toString());
      let advanced = false;

      logger.group(() => "Finding direct paths from " + path.toString());
      const directPaths = findDirectPaths(logger, graph, path, step);

      if (directPaths.length) {
        advanced = true;
        nextPaths.push(...directPaths);
      }

      logger.groupEnd(
        () => "Finished finding direct paths. Found " + directPaths.length,
      );

      logger.group(() => "Finding indirect paths from " + path.toString());
      const indirectPaths = findIndirectPaths(logger, graph, path, step);
      if (indirectPaths.length) {
        advanced = true;
        nextPaths.push(...indirectPaths);
      }

      logger.groupEnd(
        () => "Finished finding indirect paths. Found " + indirectPaths.length,
      );

      logger.groupEnd(
        () =>
          (advanced ? "Advanced" : "Failed to advance") +
          " path " +
          path.toString(),
      );
    }

    const nextStep = stepsCloned.shift();

    if (nextPaths.length && nextStep) {
      logger.log(() => "Found " + nextPaths.length + " paths");
      stack.push([nextStep, nextPaths]);
    }

    logger.groupEnd();

    if (!nextStep) {
      return findBestPath(nextPaths);
    }
  }

  // find best path

  return null;
}

function operationTypeToTypeName(operationType: OperationTypeNode): string {
  switch (operationType) {
    case OperationTypeNode.QUERY:
      return "Query";
    case OperationTypeNode.MUTATION:
      return "Mutation";
    case OperationTypeNode.SUBSCRIPTION:
      return "Subscription";
    default:
      throw new Error(`Unsupported operation type: ${operationType}`);
  }
}

type Excluded = {
  graphIds: string[];
  requirements: Selection[];
  edges: Edge[];
};

function findDirectPaths(
  logger: Logger,
  graph: Graph,
  path: OperationPath,
  step: Step,
  excluded: Excluded = {
    graphIds: [],
    requirements: [],
    edges: [],
  },
): OperationPath[] {
  const nextPaths: OperationPath[] = [];
  const edges = graph.edgesOfHead(path.tail());

  if (step.kind !== "Field") {
    // TODO: we do not support non-field steps yet
    return nextPaths;
  }

  for (const edge of edges) {
    if (!(edge.move instanceof FieldMove)) {
      continue;
    }

    if (edge.move.fieldName !== step.name) {
      continue;
    }

    if (path.edges.some((e) => e === edge)) {
      continue;
    }

    logger.log(() => `Checking edge ${edge.toString()}`);

    const result = canSatisfyEdge(logger, graph, edge, path, {
      graphIds: concatIfNotExistsString(
        excluded.graphIds,
        edge.tail.subgraphId,
      ),
      requirements: excluded.requirements,
      edges: [],
    });

    if (result.success) {
      logger.log(
        () => `Advancing path ${path.toString()} with edge ${edge.toString()}`,
      );
      nextPaths.push(path.advance(edge).addRequiredPaths(result.paths));
    }
    logger.log(() => `Edge ${edge.requirement?.toString()} is not satisfied`);
  }

  return nextPaths;
}

function findIndirectPaths(
  logger: Logger,
  graph: Graph,
  path: OperationPath,
  step: Step,
  excluded: Excluded = {
    graphIds: [],
    requirements: [],
    edges: [],
  },
): OperationPath[] {
  const nextPaths: OperationPath[] = [];
  const tail = path.tail();
  const sourceGraphId = tail.subgraphId;

  const queue: [string[], Selection[], OperationPath][] = [
    [excluded.graphIds, excluded.requirements, path],
  ];

  while (queue.length > 0) {
    const item = queue.pop();
    invariant(!!item, "Unexpected end of queue");

    const [visitedGraphs, visitedKeyFields, path] = item;
    const tail = path.tail();
    const edges = graph.edgesOfHead(tail);

    for (const edge of edges) {
      logger.group(() => `Exploring edge ${edge.toString()}`);
      if (visitedGraphs.includes(edge.tail.subgraphId)) {
        // Already visited graph
        logger.groupEnd(() => `Ignoring. Excluded graph`);
        continue;
      }

      if (edge.tail.subgraphId === sourceGraphId) {
        // Prevent a situation where we are going back to the same graph
        // The only exception is when we are moving to an abstract type
        logger.groupEnd(() => `Ignoring. We would go back to the same graph`);
        continue;
      }

      if (!(edge.move instanceof EntityMove)) {
        // We don't want to visit field edges as we're looking for indirect paths
        logger.groupEnd(() => `Ignoring. Not indirect edge`);
        continue;
      }

      // A huge win for performance, is when you do less work :D
      // We can ignore an edge that has already been visited with the same key fields / requirements.
      // The way entity-move edges are created, where every graph points to every other graph:
      //  Graph A: User @key(id) @key(name)
      //  Graph B: User @key(id)
      //  Edges in a merged graph:
      //    - User/A @key(id) -> User/B
      //    - User/B @key(id) -> User/A
      //    - User/B @key(name) -> User/A
      // Allows us to ignore an edge with the same key fields.
      // That's because in some other path, we will or already have checked the other edge.
      if (
        !!edge.requirement &&
        visitedKeyFields.some((f) => f.equals(edge.requirement!))
      ) {
        logger.groupEnd(() => `Ignoring. Already visited similar edge`);
        continue;
      }

      const result = canSatisfyEdge(logger, graph, edge, path, {
        graphIds: concatIfNotExistsString(visitedGraphs, edge.tail.subgraphId),
        requirements: visitedKeyFields,
        edges: [edge],
      });

      if (!result.success) {
        logger.groupEnd(() => `Requirement not satisfied`);
        continue;
      }

      const newPath = path.advance(edge).addRequiredPaths(result.paths);
      logger.log(() => `Advancing path to ${edge.toString()}`);

      const directPaths = findDirectPaths(logger, graph, newPath, step, {
        graphIds: visitedGraphs,
        requirements: visitedKeyFields,
        edges: [],
      });

      if (directPaths.length) {
        nextPaths.push(...directPaths);
        logger.log(
          () =>
            `Found ${directPaths.length} direct paths to ${edge.toString()}`,
        );
        continue;
      }

      logger.log(() => `No direct paths found`);

      queue.push([
        concatIfNotExistsString(visitedGraphs, edge.tail.subgraphId),
        !!edge.requirement
          ? concatIfNotExistsFields(visitedKeyFields, edge.requirement)
          : visitedKeyFields,
        newPath,
      ]);

      logger.groupEnd(() => `Going deeper`);
    }
  }

  // TODO: this should be done in a more efficient way, like I do in the satisfiability checker
  // I set shortest path right after each path is generated
  return findBestPathsPerSubgraph(nextPaths);
}

function concatIfNotExistsString(list: string[], item: string): string[] {
  if (list.includes(item)) {
    return list;
  }

  return list.concat(item);
}

function concatIfNotExistsFields(
  list: Selection[],
  item: Selection,
): Selection[] {
  if (list.some((f) => f.equals(item))) {
    return list;
  }

  return list.concat(item);
}

type MoveRequirement<T = SelectionNode> = {
  paths: OperationPath[];
  selection: T;
};

function canSatisfyEdge(
  parentLogger: Logger,
  graph: Graph,
  edge: Edge,
  path: OperationPath,
  excluded: Excluded = {
    graphIds: [],
    requirements: [],
    edges: [],
  },
): {
  success: boolean;
  paths: OperationPath[];
} {
  if (!edge.requirement) {
    return {
      success: true,
      paths: [],
    };
  }

  const logger = parentLogger.create("Requirements");

  logger.log(
    () =>
      `Checking requirement ${edge.requirement?.toString()} for ${edge.toString()}`,
  );

  const requirements: MoveRequirement[] = [];
  const pathsToRequirements: OperationPath[] = [];

  for (const selection of edge.requirement.selectionSet) {
    requirements.unshift({
      selection,
      paths: [path.clone()],
    });
  }

  while (requirements.length > 0) {
    // it's important to pop from the end as we want to process the last added requirement first
    const requirement = requirements.pop();

    if (!requirement) {
      break;
    }

    if (requirement.selection.kind === "fragment") {
      throw new Error("Fragment is not yet supported");
    }

    const result = validateFieldRequirement(
      logger,
      graph,
      requirement as MoveRequirement<Field>,
      excluded,
    );

    if (result.success === false) {
      return {
        success: false,
        paths: [],
      };
    }

    pathsToRequirements.push(...findBestPathsPerSubgraph(result.paths));

    for (const innerRequirement of result.requirements) {
      requirements.unshift(innerRequirement);
    }
  }

  return {
    success: true,
    paths: pathsToRequirements,
  };
}

type RequirementResult =
  | {
      success: true;
      paths: OperationPath[];
      requirements: MoveRequirement[];
    }
  | {
      success: false;
    };

function validateFieldRequirement(
  logger: Logger,
  graph: Graph,
  requirement: MoveRequirement<Field>,
  excluded: Excluded,
): RequirementResult {
  const { fieldName } = requirement.selection;

  const nextPaths: OperationPath[] = [];

  for (const path of requirement.paths) {
    const directPathsResult = findDirectPaths(
      logger,
      graph,
      path,
      {
        kind: "Field",
        name: fieldName,
      },
      excluded,
    );
    if (directPathsResult.length) {
      nextPaths.push(...directPathsResult);
    }
  }

  // we could add make it lazy
  for (const path of requirement.paths) {
    const indirectPaths = findIndirectPaths(
      logger,
      graph,
      path,
      {
        kind: "Field",
        name: fieldName,
      },
      excluded,
    );

    if (indirectPaths.length) {
      nextPaths.push(...indirectPaths);
    }
  }

  if (nextPaths.length === 0) {
    return {
      success: false,
    };
  }

  if (
    !requirement.selection.selectionSet ||
    requirement.selection.selectionSet.length === 0
  ) {
    // we reached the end of the path
    return {
      success: true,
      requirements: [],
      paths: nextPaths,
    };
  }

  return {
    success: true,
    paths: nextPaths.slice(),
    requirements: requirement.selection.selectionSet.map((selection) => ({
      selection,
      paths: nextPaths.slice(),
    })),
  };
}

export class OperationPath {
  constructor(
    public rootNode: Node,
    public edges: Edge[] = [],
    public requiredPathsForEdges: OperationPath[][] = [],
    public cost: number = 0,
  ) {}

  addRequiredPaths(paths: OperationPath[]) {
    if (this.edges.length !== this.requiredPathsForEdges.length) {
      throw new Error("Looks like advance() was called after addRequiredPaths");
    }
    const requiredPathsForLastEdge =
      this.requiredPathsForEdges[this.requiredPathsForEdges.length - 1];
    requiredPathsForLastEdge.push(...paths);

    // It's so so wrong, because we may end up doing 1 entity call for all the paths,
    // but we now multiple that by the number of edges...
    paths.forEach((path) => {
      this.cost += path.cost;
    });

    return this;
  }

  advance(edge: Edge) {
    return new OperationPath(
      this.rootNode,
      this.edges.concat(edge),
      this.requiredPathsForEdges.concat([[]]),
      this.cost + calculateCost(edge),
    );
  }

  tail(): Node {
    if (this.edges.length) {
      return this.edges[this.edges.length - 1].tail;
    }

    return this.rootNode;
  }

  clone() {
    return new OperationPath(
      this.rootNode,
      this.edges.slice(),
      this.requiredPathsForEdges.slice(),
    );
  }

  toString() {
    return this.edges.length
      ? this.edges.map((edge) => edge.toString()).join(" -> ")
      : this.rootNode.toString();
  }
}

function findBestPathsPerSubgraph(paths: OperationPath[]): OperationPath[] {
  const pathsPerGraph = new Map<string, OperationPath>();

  for (const path of paths) {
    const endedInGraphId = path.tail().subgraphId;
    const existingPath = pathsPerGraph.get(endedInGraphId);
    if (!existingPath || path.cost < existingPath.cost) {
      pathsPerGraph.set(endedInGraphId, path);
    }
  }

  return Array.from(pathsPerGraph.values());
}

function findBestPath(paths: OperationPath[]): OperationPath {
  let bestPath: OperationPath | null = null;

  for (const path of paths) {
    if (!bestPath || path.cost < bestPath.cost) {
      bestPath = path;
    }
  }

  invariant(bestPath, "No best path found");

  return bestPath;
}

function calculateCost(edge: Edge): number {
  if (edge.move instanceof FieldMove) {
    return 1;
  }

  // for the rest
  return 10;
}

export function pathsToGraphviz(
  paths: OperationPath[],
  asLink = false,
): string {
  const colored = `color=blue`;
  const lines = [`digraph G {`];

  for (const path of paths) {
    pathToGraphviz(path, lines, "color=blue");
  }

  function normalizeLine(line: string) {
    return line.replace(/, color=\w+/, "");
  }

  // deduplicate lines, but compare with `, "color=blue"`, to not duplicate colored edges
  const uniqueLines = lines.filter((line, i, all) => {
    return all.findIndex((l) => normalizeLine(l) === normalizeLine(line)) === i;
  });

  const str = uniqueLines.join("\n") + "\n}";

  if (asLink) {
    // return `https://dreampuf.github.io/GraphvizOnline/#${encodeURIComponent(str)}`;
    return `https://magjac.com/graphviz-visual-editor/?dot=${encodeURIComponent(str)}`;
  }

  return str;
}

function pathToGraphviz(
  path: OperationPath,
  lines: string[],
  edgeAttributes: string | null = null,
) {
  for (const edge of path.edges) {
    lines.push(edgeToGraphviz(edge, edgeAttributes));
  }

  for (const dependencyPaths of path.requiredPathsForEdges) {
    for (const dependencyPath of dependencyPaths) {
      pathToGraphviz(dependencyPath, lines);
    }
  }
}

function edgeToGraphviz(edge: Edge, attributes: string | null): string {
  let str = "";

  str += `"${edge.head.typeName}/${edge.head.subgraphId}"`;
  str += " -> ";
  str += `"${edge.tail.typeName}/${edge.tail.subgraphId}"`;

  str += '[label="';

  if (edge.move instanceof FieldMove) {
    str += edge.move.fieldName;
  } else if (edge.move instanceof EntityMove) {
    str += "🔑 ";
  }

  if (edge.requirement) {
    str += edge.requirement.toString();
  }

  str += `"`;

  if (attributes) {
    str += ", " + attributes;
  } else {
    str += ", color=" + pickColor(edge.tail.subgraphId);
  }

  str += `]`;

  return str;
}

const colors = [
  "lime",
  "aqua",
  "aquamarine",
  "darkorchid",
  "darkcyan",
  "deeppink",
  "indigo",
];
function pickColor(subgraphId: string) {
  // Simple hash function: a poor man's consistent hash
  let hash = 0;
  for (let i = 0; i < subgraphId.length; i++) {
    const char = subgraphId.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0; // Convert to 32bit integer
  }

  // Make sure it's positive
  hash = Math.abs(hash);

  // Map to color index
  return colors[hash % colors.length];
}

// function printRequiredEdges(path: OperationPath, indent: number) {
//   const spaces = " ".repeat(indent);
//   let i = 0;
//   for (const requiredPathsOfEdge of path.requiredPathsForEdges) {
//     if (requiredPathsOfEdge.length) {
//       console.log(
//         spaces + " edge " + path.edges[i++].toString() + " depends on: ",
//       );
//       for (const requiredPath of requiredPathsOfEdge) {
//         console.log(
//           spaces +
//             "  " +
//             requiredPath.edges.map((edge) => edge.toString()).join(" -> "),
//         );
//         printRequiredEdges(requiredPath, indent + 4);
//       }
//     }
//   }
// }
