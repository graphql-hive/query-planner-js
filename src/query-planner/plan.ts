import {
  DocumentNode,
  FieldNode,
  InlineFragmentNode,
  Kind,
  OperationTypeNode,
  parse,
} from "graphql";
import {
  Edge,
  EntityMove,
  FieldMove,
  Node,
  Selection,
  SelectionNode,
} from "./graph";
import { OperationPath } from "./walker";
import { print } from "../graphql/printer";
import { TypeKind } from "./schema";
import {
  QueryPlanNode,
  FetchNode,
  FlattenNode,
  ParallelNode,
  SequenceNode,
  QueryPlan,
} from "./plan-nodes";
import { invariant } from "./utils";

/**
 * Generates a query plan from a path with requirement paths
 * @param mainPath The main operation path
 * @returns A query plan structure
 */
export function generateQueryPlan(mainPath: OperationPath): QueryPlan {
  // First, identify the main segments by service
  const mainSegments = groupPathByService(mainPath);

  // Identify entity requirements in the path
  const entityRequirements = findEntityRequirements(mainPath);

  // Build the plan nodes
  const planNodes: QueryPlanNode[] = [];

  // First add the initial fetch from the first service
  if (mainSegments.length > 0) {
    const firstSegment = mainSegments[0];
    planNodes.push(createFetchNode(firstSegment.graphId, firstSegment.edges));
  }

  // Then add flattened entity fetches for each requirement
  for (const req of entityRequirements) {
    planNodes.push(createEntityFetchNode(req));
  }

  return {
    kind: "QueryPlan",
    node:
      planNodes.length === 1
        ? planNodes[0]
        : {
            kind: "Sequence",
            nodes: planNodes,
          },
  };
}

interface DependencyNode {
  path: OperationPath;
  edge?: Edge;
  dependencies: DependencyNode[];
}

function buildDependencyTree(path: OperationPath): DependencyNode {
  const node: DependencyNode = {
    path,
    dependencies: [],
  };

  // For each edge with requirements
  for (let edgeIndex = 0; edgeIndex < path.edges.length; edgeIndex++) {
    const requiredPathsForEdge = path.requiredPathsForEdges[edgeIndex];
    if (!requiredPathsForEdge.length) {
      continue;
    }

    const edge = path.edges[edgeIndex];
    for (const reqPath of requiredPathsForEdge) {
      const depNode: DependencyNode = {
        path: reqPath,
        edge,
        dependencies: [],
      };

      // Recursively build the dependency tree for requirement paths
      const subTree = buildDependencyTree(reqPath);
      depNode.dependencies.push(...subTree.dependencies);
      node.dependencies.push(depNode);
    }
  }

  return node;
}

/**
 * Calculates the path for a Flatten node based on a requirement edge and the target path
 * @param requirementEdge The edge with the requirement (from the requirement path)
 * @param targetPath The main path where we want to flatten the requirement data
 * @returns An array representing the path for the Flatten node
 */
function calculateFlattenPath(
  requirementEdge: Edge,
  targetPath: OperationPath,
): (string | number | "@")[] {
  // Instead of looking for the exact edge object in the path (which won't be found),
  // we need to find the position in the target path where the requirement should be flattened

  const targetTypeName = requirementEdge.head.typeName;
  const flattenPath: (string | number | "@")[] = [];

  // Find the path to the entity that needs the requirement
  let foundEntityPosition = false;

  for (let i = 0; i < targetPath.edges.length; i++) {
    const currentEdge = targetPath.edges[i];

    if (currentEdge.move instanceof FieldMove) {
      flattenPath.push(currentEdge.move.fieldName);

      // If this field returns a list, add '@' to indicate list processing
      if (currentEdge.move.isList) {
        flattenPath.push("@");
      }

      // Check if we've reached the entity type that needs the requirement
      if (currentEdge.tail.typeName === targetTypeName) {
        foundEntityPosition = true;
        break;
      }
    }
  }

  if (!foundEntityPosition) {
    // If we couldn't find the entity type in the path, add a fallback behavior
    // For example, we might want to flatten at the root level
    console.warn(
      `Couldn't find ${targetTypeName} in the target path, using root level flattening`,
    );
    return [];
  }

  return flattenPath;
}

function groupPathByService(path: OperationPath): ServiceSegment[] {
  const result: ServiceSegment[] = [];

  if (path.edges.length === 0) {
    return [
      {
        graphId: path.rootNode.subgraphId,
        edges: [],
        startNode: path.rootNode,
        endNode: path.rootNode,
      },
    ];
  }

  let currentService = path.edges[0].head.subgraphId;
  let currentGroup: Edge[] = [];
  let startNode = path.rootNode;

  for (const edge of path.edges) {
    const edgeService = edge.head.subgraphId;

    if (currentService !== edgeService && currentGroup.length > 0) {
      const lastEdge = currentGroup[currentGroup.length - 1];
      result.push({
        graphId: currentService,
        edges: [...currentGroup],
        startNode,
        endNode: lastEdge.tail,
      });

      currentGroup = [];
      startNode = edge.head;
    }

    currentGroup.push(edge);
    currentService = edgeService;
  }

  if (currentGroup.length > 0) {
    const lastEdge = currentGroup[currentGroup.length - 1];
    result.push({
      graphId: currentService,
      edges: [...currentGroup],
      startNode,
      endNode: lastEdge.tail,
    });
  }

  return result;
}

interface ServiceSegment {
  graphId: string;
  edges: Edge[];
  startNode: Node;
  endNode: Node;
}

interface EntityRequirement {
  graphId: string;
  entityTypeName: string;
  requiredFields: Selection;
  targetGraphId: string;
  targetField: string;
  flattenPath: (string | number | "@")[];
}

function findEntityRequirements(path: OperationPath): EntityRequirement[] {
  const requirements: EntityRequirement[] = [];

  // For each edge in the path
  for (let i = 0; i < path.edges.length; i++) {
    const edge = path.edges[i];

    // If this is an entity move with a requirement
    if (edge.move instanceof EntityMove && edge.requirement) {
      // Find the path to this entity in the result
      let flattenPath: (string | number | "@")[] = [];

      // Build the path to this entity
      for (let j = 0; j < i; j++) {
        const pathEdge = path.edges[j];
        if (pathEdge.move instanceof FieldMove) {
          flattenPath.push(pathEdge.move.fieldName);

          if (pathEdge.move.isList) {
            flattenPath.push("@");
          }
        }
      }

      if (edge.move instanceof FieldMove && edge.move.isList) {
        flattenPath.push("@");
      }

      // Find what field we want from the target service
      let targetField: string | null = null;
      if (
        i + 1 < path.edges.length &&
        path.edges[i + 1].move instanceof FieldMove
      ) {
        targetField = (path.edges[i + 1].move as FieldMove).fieldName;
      }

      if (!targetField) {
        throw new Error("Oopsie poopsie");
      }

      requirements.push({
        graphId: edge.head.subgraphId,
        entityTypeName: edge.head.typeName,
        requiredFields: edge.requirement,
        targetGraphId: edge.tail.subgraphId,
        targetField,
        flattenPath,
      });
    }
  }

  return requirements;
}

function createFetchNode(serviceName: string, edges: Edge[]): FetchNode {
  const operation = buildOperationFromPathSegment(edges);

  return {
    kind: "Fetch",
    serviceName,
    variableUsages: [],
    operation,
    operationKind: OperationTypeNode.QUERY,
  };
}

function createEntityFetchNode(req: EntityRequirement): FlattenNode {
  // const requires = createRequiresSelections(req.requiredFields);
  const operation = buildEntityOperation(req.entityTypeName, req.targetField);

  return {
    kind: "Flatten",
    path: req.flattenPath,
    node: {
      kind: "Fetch",
      serviceName: req.targetGraphId,
      requires: {
        kind: "fragment",
        typeName: req.requiredFields.getTypeName(),
        selectionSet: req.requiredFields.selectionSet,
      },
      variableUsages: [],
      operation,
      operationKind: OperationTypeNode.QUERY,
    },
  };
}

/**
 * Builds an entity operation
 */
function buildEntityOperation(typeName: string, fieldName: string): string {
  return print(
    parse(
      `query($representations:[_Any!]!){_entities(representations:$representations){...on ${typeName}{${fieldName}}}}`,
    ),
  );
}

/**
 * Builds a regular operation from path edges
 */
function buildOperationFromPathSegment(edges: Edge[]): string {
  if (edges.length === 0) {
    return "{}";
  }

  return buildSelectionSetFromPath(edges);
}

///

/**
 * Builds a GraphQL selection set from a path segment
 */
function buildSelectionSetFromPath(pathSegment: Edge[]): string {
  if (pathSegment.length === 0) {
    return "{}";
  }

  // Stack to keep track of the current path in the selection set
  interface StackItem {
    edge: Edge;
    isLast: boolean;
  }

  const stack: StackItem[] = pathSegment.map((edge, index) => ({
    edge,
    isLast: index === pathSegment.length - 1,
  }));

  let depth = 0;
  let currentSelection = "";

  // Process the path from the root to leaf
  while (stack.length > 0) {
    const { edge, isLast } = stack.shift()!;

    if (edge.move instanceof FieldMove) {
      // Add indentation
      const indent = "  ".repeat(depth);

      // Start a new selection level if needed
      if (currentSelection === "") {
        currentSelection = "{\n";
      }

      // Add the field to the selection
      currentSelection += `${indent}${edge.move.fieldName}`;

      // If this field has a selection set, increase depth
      if (isLast) {
        // For the last field, we might need to add __typename
        if (
          edge.tail.typeKind === TypeKind.OBJECT_TYPE ||
          edge.tail.typeKind === TypeKind.INTERFACE_TYPE ||
          edge.tail.typeKind === TypeKind.UNION_TYPE
        ) {
          currentSelection += " {\n";
          currentSelection += `${indent}  __typename\n`;

          // If the edge has a requirement, add those fields too
          if (edge.requirement) {
            currentSelection += addRequirementFields(
              edge.requirement,
              indent + "  ",
            );
          }

          currentSelection += `${indent}}`;
        }
      } else {
        // Not the last field, check if we need a selection set
        if (
          edge.tail.typeKind === TypeKind.OBJECT_TYPE ||
          edge.tail.typeKind === TypeKind.INTERFACE_TYPE ||
          edge.tail.typeKind === TypeKind.UNION_TYPE
        ) {
          currentSelection += " {\n";
          currentSelection += `${indent}  __typename\n`;
          depth++;
        }
      }

      currentSelection += "\n";
    } else if (edge.move instanceof EntityMove) {
      // For entity moves, we might need to add key fields
      if (edge.requirement) {
        const indent = "  ".repeat(depth);
        currentSelection += addRequirementFields(edge.requirement, indent);
      }
    } else {
      throw new Error(`Unsupported edge type: ${edge.move.constructor.name}`);
    }
  }

  // Close all open braces
  for (let i = depth; i >= 0; i--) {
    const indent = "  ".repeat(i);
    currentSelection += `${indent}}\n`;
  }

  return currentSelection;
}

/**
 * Adds fields from a requirement to the selection set
 */
function addRequirementFields(requirement: Selection, indent: string): string {
  let result = "";

  for (const selection of requirement.selectionSet) {
    if (selection.kind === "field") {
      result += `${indent}${selection.fieldName}`;

      // Add nested selection set if needed
      if (selection.selectionSet && selection.selectionSet.length > 0) {
        result += " {\n";

        for (const nestedSelection of selection.selectionSet) {
          result += addRequirementFields(
            new Selection(selection.typeName, "", [nestedSelection]),
            indent + "  ",
          );
        }

        result += `${indent}}\n`;
      } else {
        result += "\n";
      }
    } else if (selection.kind === "fragment") {
      result += `${indent}... on ${selection.typeName} {\n`;

      for (const nestedSelection of selection.selectionSet) {
        result += addRequirementFields(
          new Selection(selection.typeName, "", [nestedSelection]),
          indent + "  ",
        );
      }

      result += `${indent}}\n`;
    }
  }

  return result;
}

//
// Pretty Print
//

/**
 * Pretty prints a query plan structure
 * @param queryPlan The query plan to print
 * @returns A formatted string representation of the query plan
 */
export function prettyPrintQueryPlan(queryPlan: QueryPlan): string {
  return `QueryPlan {\n${printPlanNode(queryPlan.node, 2)}\n}`;
}

/**
 * Recursively prints a plan node with proper indentation
 */
function printPlanNode(node: QueryPlanNode, indent: number): string {
  const spaces = " ".repeat(indent);

  switch (node.kind) {
    case "Sequence":
      return printSequenceNode(node, indent);
    case "Parallel":
      return printParallelNode(node, indent);
    case "Flatten":
      return printFlattenNode(node, indent);
    case "Fetch":
      return printFetchNode(node, indent);
    default:
      return `${spaces}Unknown node type: ${(node as any).kind}`;
  }
}

/**
 * Prints a Sequence node
 */
function printSequenceNode(node: SequenceNode, indent: number): string {
  const spaces = " ".repeat(indent);
  const childIndent = indent + 2;

  const children = node.nodes
    .map((child) => printPlanNode(child, childIndent))
    .join(",\n");

  return `${spaces}Sequence {\n${children}\n${spaces}}`;
}

/**
 * Prints a Parallel node
 */
function printParallelNode(node: ParallelNode, indent: number): string {
  const spaces = " ".repeat(indent);
  const childIndent = indent + 2;

  const children = node.nodes
    .map((child) => printPlanNode(child, childIndent))
    .join(",\n");

  return `${spaces}Parallel {\n${children}\n${spaces}}`;
}

/**
 * Prints a Flatten node
 */
function printFlattenNode(node: FlattenNode, indent: number): string {
  const spaces = " ".repeat(indent);
  const childIndent = indent + 2;

  // Format the path as a string with dots
  const pathStr = node.path.join(".");

  return `${spaces}Flatten(path: "${pathStr}") {\n${printPlanNode(node.node, childIndent)}\n${spaces}}`;
}

/**
 * Prints a Fetch node
 */
function printFetchNode(node: FetchNode, indent: number): string {
  const spaces = " ".repeat(indent);
  const operationIndent = indent + 2;
  const operationSpaces = " ".repeat(operationIndent);

  // Format the operation string for readability
  const formattedOperation = formatOperation(node.operation, operationIndent);

  // Format the requires section if present
  const requiresSection = node.requires
    ? `${operationSpaces}\{\n${formatRequires(node.requires, operationIndent + 2)}\n${operationSpaces}} =>\n`
    : "";

  return `${spaces}Fetch(service: "${node.serviceName}") {\n${requiresSection}${formattedOperation}\n${spaces}}`;
}

/**
 * Formats a GraphQL operation string for readability
 */
function formatOperation(operation: string, indent: number): string {
  const spaces = " ".repeat(indent);

  const isEntityCall = operation.includes(
    "_entities(representations: $representations",
  );

  // Remove the query keyword if present
  const queryLess = print(
    isEntityCall ? dropRepresentations(parse(operation)) : parse(operation),
  ).replace(/^query\s*/, "");

  return queryLess
    .split("\n")
    .map((line) => `${spaces}${line}`)
    .join("\n");
}

/**
 * Formats the requires section
 */
function formatRequires(requires: SelectionNode, indent: number): string {
  const spaces = " ".repeat(indent);

  if (!requires) {
    return "";
  }

  if (requires.kind === "field" && !requires.selectionSet?.length) {
    return `${spaces}${requires.fieldName}`;
  }

  const inner = requires.selectionSet
    ?.map((s) => formatRequires(s, indent + 2))
    .join("\n");

  if (requires.kind === "field") {
    return `${spaces}${requires.fieldName} {\n${inner!}\n${spaces}}`;
  }

  return `${spaces}... on ${requires.typeName} {\n${inner}\n${spaces}}`;
}

function dropRepresentations(query: DocumentNode): DocumentNode {
  const operationDefinition = query.definitions.find(
    (def) => def.kind === Kind.OPERATION_DEFINITION,
  );

  if (!operationDefinition) {
    return query;
  }

  const entityField = operationDefinition.selectionSet.selections.find(
    (sel): sel is FieldNode =>
      sel.kind === Kind.FIELD && sel.name.value === "_entities",
  );
  invariant(!!entityField, "Expected _entities field");

  const entityFragment = entityField.selectionSet?.selections.find(
    (sel): sel is InlineFragmentNode => sel.kind === Kind.INLINE_FRAGMENT,
  );
  invariant(!!entityFragment, "Expected entity fragment");

  return {
    kind: Kind.DOCUMENT,
    definitions: [
      {
        kind: Kind.OPERATION_DEFINITION,
        operation: OperationTypeNode.QUERY,
        variableDefinitions: [],
        directives: [],
        selectionSet: {
          kind: Kind.SELECTION_SET,
          selections: [entityFragment],
        },
      },
    ],
  };
}
