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
      return nextPaths;
    }
  }

  // find best path

  return [];
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

    if (edge.requirement) {
      logger.group(
        () =>
          `Checking requirement ${edge.requirement?.toString()} for ${edge.toString()}`,
      );
      if (
        !canSatisfyRequirement(logger, graph, edge.requirement, path, {
          graphIds: concatIfNotExistsString(
            excluded.graphIds,
            edge.tail.subgraphId,
          ),
          requirements: excluded.requirements,
          edges: [],
        })
      ) {
        logger.groupEnd(
          () => `Requirement ${edge.requirement?.toString()} not satisfied`,
        );
        continue;
      }
      logger.groupEnd(
        () => `Requirement ${edge.requirement?.toString()} satisfied`,
      );
    }

    logger.log(
      () => `Advancing path ${path.toString()} with edge ${edge.toString()}`,
    );
    nextPaths.push(path.advance(edge));
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

      if (edge.requirement) {
        logger.group(
          () => `Checking requirement ${edge.requirement!.toString()}`,
        );
        // TODO: check if the requirement can be satisfied by the current path,
        // for now we assume it can be satisfied.
        if (
          !canSatisfyRequirement(logger, graph, edge.requirement, path, {
            graphIds: concatIfNotExistsString(
              visitedGraphs,
              edge.tail.subgraphId,
            ),
            requirements: visitedKeyFields,
            edges: [edge],
          })
        ) {
          logger.groupEnd(() => `Requirement not satisfied`);
          logger.groupEnd(() => `Ignoring. Can't satisfy requirement`);
          continue;
        } else {
          logger.groupEnd(() => `Requirement satisfied`);
        }
      }

      const newPath = path.advance(edge);
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

  return nextPaths;
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

function canSatisfyRequirement(
  parentLogger: Logger,
  graph: Graph,
  requirement: Selection,
  path: OperationPath,
  excluded: Excluded = {
    graphIds: [],
    requirements: [],
    edges: [],
  },
) {
  const logger = parentLogger.create("Requirements");

  const requirements: MoveRequirement[] = [];

  for (const selection of requirement.selectionSet) {
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
      return result;
    }

    for (const innerRequirement of result.requirements) {
      requirements.unshift(innerRequirement);
    }
  }

  return {
    success: true,
    errors: undefined,
  };
}

type RequirementResult =
  | {
      success: true;
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
    };
  }

  return {
    success: true,
    requirements: requirement.selection.selectionSet.map((selection) => ({
      selection,
      paths: nextPaths.slice(),
    })),
  };
}

class OperationPath {
  constructor(
    public rootNode: Node,
    public edges: Edge[] = [],
  ) {}

  advance(edge: Edge) {
    return new OperationPath(this.rootNode, this.edges.concat(edge));
  }

  tail(): Node {
    if (this.edges.length) {
      return this.edges[this.edges.length - 1].tail;
    }

    return this.rootNode;
  }

  clone() {
    return new OperationPath(this.rootNode, this.edges.slice());
  }

  toString() {
    return this.edges.length
      ? this.edges.map((edge) => edge.toString()).join(" -> ")
      : this.rootNode.toString();
  }
}
