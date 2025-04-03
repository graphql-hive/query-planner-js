import {
  AbstractMove,
  Edge,
  EntityMove,
  FieldMove,
  Graph,
  InterfaceObjectMove,
  Node,
  Selection,
} from "./graph.js";
import { OperationTypeNode } from "graphql";
import { invariant } from "./utils.js";

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
  const initialPaths = graph
    .nodesOf(operationTypeToTypeName(operationType))
    .map((node) => new OperationPath(node));
  const stepsCloned = steps.slice();
  const stack: [Step, OperationPath[]][] = [
    [stepsCloned.shift()!, initialPaths],
  ];

  while (stack.length > 0) {
    const [step, paths] = stack.pop()!;

    console.log("Processing step:", step);

    if (step.kind !== "Field") {
      throw new Error(`Unsupported step kind: ${(step as any).kind}`);
    }

    const nextPaths: OperationPath[] = [];

    for (const path of paths) {
      const directPaths = findDirectPaths(graph, path, step);

      if (directPaths.length) {
        nextPaths.push(...directPaths);
      }

      const indirectPaths = findIndirectPaths(graph, path, step);
      if (indirectPaths.length) {
        nextPaths.push(...indirectPaths);
      }
    }

    const nextStep = stepsCloned.shift();

    if (nextPaths.length && nextStep) {
      console.log("Found", nextPaths.length, "paths for", step);
      stack.push([nextStep, nextPaths]);
    }

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

function findDirectPaths(
  graph: Graph,
  path: OperationPath,
  step: Step,
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

    if (edge.move.fieldName === step.name) {
      nextPaths.push(path.advance(edge));
    }
  }

  return nextPaths;
}

function findIndirectPaths(
  graph: Graph,
  path: OperationPath,
  step: Step,
): OperationPath[] {
  const nextPaths: OperationPath[] = [];
  const tail = path.tail();
  const sourceGraphId = tail.subgraphId;

  const queue: [string[], Selection[], OperationPath][] = [[[], [], path]];

  while (queue.length > 0) {
    const item = queue.pop();
    invariant(!!item, "Unexpected end of queue");

    const [visitedGraphs, visitedKeyFields, path] = item;
    const tail = path.tail();
    const edges = graph.edgesOfHead(tail);

    for (const edge of edges) {
      if (visitedGraphs.includes(edge.tail.subgraphId)) {
        // Already visited graph
        continue;
      }

      if (edge.tail.subgraphId === sourceGraphId) {
        // Prevent a situation where we are going back to the same graph
        // The only exception is when we are moving to an abstract type
        continue;
      }

      if (!(edge.move instanceof EntityMove)) {
        // We don't want to visit field edges as we're looking for indirect paths
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
        continue;
      }

      // TODO: check if the requirement can be satisfied by the current path
      if (edge.requirement) {
        //
      }

      const newPath = path.advance(edge);

      const directPaths = findDirectPaths(graph, newPath, step);

      if (directPaths.length) {
        nextPaths.push(...directPaths);
        continue;
      }

      queue.push([
        concatIfNotExistsString(visitedGraphs, edge.tail.subgraphId),
        !!edge.requirement
          ? concatIfNotExistsFields(visitedKeyFields, edge.requirement)
          : visitedKeyFields,
        newPath,
      ]);
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
}
