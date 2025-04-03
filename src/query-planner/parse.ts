import {
  Kind,
  ObjectTypeDefinitionNode,
  parse,
  specifiedScalarTypes,
} from "graphql";
import { invariant, isListTypeNode, resolveTypeNodeName } from "./utils";
import { Edge, FieldMove, Graph, Node } from "./graph";
import {
  ObjectType,
  ObjectTypeField,
  Subgraph,
  Supergraph,
  TypeKind,
} from "./schema";
import {
  JoinField,
  JoinType,
  parseJoinField,
  parseJoinType,
} from "./join-directives";
import { SelectionResolver } from "./selection-resolver";

export function parseSupergraph(sdl: string) {
  const supergraph = new Supergraph();
  const supergraphDocument = parse(sdl);

  for (const def of supergraphDocument.definitions) {
    if (def.kind === Kind.OBJECT_TYPE_DEFINITION) {
      const objectTypes = parseObjectType(def);

      for (const objectType of objectTypes) {
        for (const joinType of objectType.join) {
          const subgraph = ensureSubgraph(supergraph, joinType.graph);
          subgraph.types.set(objectType.name, objectType);
          if (joinType.resolvable && typeof joinType.key === "string") {
            subgraph.entityTypes.add(objectType.name);
          }
        }
      }
    }
  }

  const graphs: Graph[] = [];
  const entities = new Map<
    string,
    Array<{
      key: string;
      graphId: string;
      typeName: string;
    }>
  >();
  const selectionResolvers = new Map<string, SelectionResolver>();

  for (const [graphId, subgraph] of supergraph.subgraphs) {
    graphs.push(buildGraphFromSubgraph(subgraph));
    selectionResolvers.set(graphId, new SelectionResolver(subgraph));

    for (const [typeName, typeState] of subgraph.types) {
      if (!Array.isArray(entities.get(typeName))) {
        entities.set(typeName, []);
      }

      for (const joinType of typeState.join) {
        if (!joinType.resolvable || typeof joinType.key !== "string") {
          continue;
        }
        entities.get(typeName)!.push({
          key: joinType.key,
          graphId,
          typeName: typeState.name,
        });
      }
    }
  }

  const mergedGraph = new Graph("private");

  for (const graph of graphs) {
    mergedGraph.copyFrom(graph);
  }

  mergedGraph.joinByKeys(entities, selectionResolvers);

  return mergedGraph;
}

function parseObjectType(def: ObjectTypeDefinitionNode): ObjectType[] {
  const joinTypes: JoinType[] = [];
  const fields = def.fields;
  const graphIds = new Set<string>();

  for (const directiveNode of def.directives ?? []) {
    if (directiveNode.name.value === "join__type") {
      const joinType = parseJoinType(directiveNode);
      graphIds.add(joinType.graph);
      joinTypes.push(joinType);
    }
  }

  const objectTypePerGraph = new Map<string, ObjectType>();

  for (const graphId of graphIds) {
    const objectType = new ObjectType(
      def.name.value,
      joinTypes.filter((joinType) => joinType.graph === graphId),
    );
    objectTypePerGraph.set(graphId, objectType);
  }

  if (!fields?.length) {
    return Array.from(objectTypePerGraph.values());
  }

  for (const field of fields) {
    const isList = isListTypeNode(field.type);
    if (!field.directives?.length) {
      // it means that the field belongs to all graphs defining the object type

      for (const [graphId, objectType] of objectTypePerGraph) {
        objectType.addField(
          new ObjectTypeField(
            field.name.value,
            resolveTypeNodeName(field.type),
            isList,
            // TODO: turn it into object...
            new JoinField(graphId, null, null, null, false, null, false),
          ),
        );
      }

      continue;
    }

    const joinFields: JoinField[] = [];

    for (const directiveNode of field.directives ?? []) {
      if (directiveNode.name.value === "join__field") {
        joinFields.push(parseJoinField(directiveNode));
      }
    }

    for (const joinField of joinFields) {
      invariant(
        typeof joinField.graph === "string",
        "No support for fields provided by an interface object yet",
      );
      const objectType = objectTypePerGraph.get(joinField.graph);
      invariant(
        !!objectType,
        "No object type found for graph " + joinField.graph,
      );

      objectType.addField(
        new ObjectTypeField(
          field.name.value,
          resolveTypeNodeName(field.type),
          isList,
          joinField,
        ),
      );
    }
  }

  return Array.from(objectTypePerGraph.values());
}

function buildGraphFromSubgraph(subgraph: Subgraph): Graph {
  const graph = new Graph(subgraph.graphId);

  const queryType = subgraph.types.get("Query");

  // Starts from root
  if (queryType) {
    createNodesAndEdgesForObjectType(graph, subgraph, queryType);
  }

  // Adds entity types
  subgraph.entityTypes.forEach((typeName) => {
    const objectType = subgraph.types.get(typeName);
    invariant(!!objectType, "Type not found: " + typeName);

    createNodesAndEdgesForObjectType(graph, subgraph, objectType);
  });

  return graph;
}

function createNodesAndEdgesForType(
  graph: Graph,
  subgraph: Subgraph,
  typeName: string,
) {
  if (specifiedScalarTypes.some((t) => t.name === typeName)) {
    return createNodeForScalarType(graph, subgraph, typeName);
  }

  const typeState = subgraph.types.get(typeName);
  invariant(!!typeState, "Type not found: " + typeName);
  return createNodesAndEdgesForObjectType(graph, subgraph, typeState);
}

function createNodesAndEdgesForObjectType(
  graph: Graph,
  subgraph: Subgraph,
  objectType: ObjectType,
) {
  const existing = graph.ensureNonOrSingleNode(objectType.name);
  if (existing) {
    return existing;
  }

  const head = graph.createTypeNode(objectType.name, TypeKind.OBJECT_TYPE);

  for (const field of objectType.fields) {
    if (field.join.external) {
      continue;
    }
    createEdgeForObjectTypeField(graph, subgraph, head, field);
  }

  return head;
}

function createEdgeForObjectTypeField(
  graph: Graph,
  subgraph: Subgraph,
  head: Node,
  field: ObjectTypeField,
) {
  const tail = createNodesAndEdgesForType(graph, subgraph, field.type);

  if (!tail) {
    throw new Error(
      `Failed to create Node for ${field.type} in subgraph ${graph.id}`,
    );
  }

  return graph.addEdge(
    new Edge(
      head,
      tail,
      new FieldMove(field.name, head.typeName, head.typeKind, field.isList),
      null,
    ),
  );
}

function createNodeForScalarType(
  graph: Graph,
  subgraph: Subgraph,
  typeName: string,
) {
  const existing = graph.ensureNonOrSingleNode(typeName);
  if (existing) {
    return existing;
  }

  return graph.createTypeNode(typeName, TypeKind.SCALAR_TYPE);
}

function ensureSubgraph(supergraph: Supergraph, graphId: string) {
  const existing = supergraph.subgraphs.get(graphId);

  if (existing) {
    return existing;
  }

  const subgraph = new Subgraph(graphId);
  supergraph.subgraphs.set(graphId, subgraph);
  return subgraph;
}
