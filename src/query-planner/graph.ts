import { TypeKind } from "./schema";
import { SelectionResolver } from "./selection-resolver";
import { invariant } from "./utils";

interface Display {
  toString(): string;
}

export class Node implements Display {
  constructor(
    /**
     * Unique index in the graph
     */
    public index: number,
    public subgraphId: string,
    public typeName: string,
    public typeKind: TypeKind,
  ) {}

  toString() {
    return `${this.typeName}/${this.subgraphId}`;
  }
}

type Move = (FieldMove | EntityMove | AbstractMove | InterfaceObjectMove) &
  Display;

export class FieldMove implements Display {
  constructor(
    public fieldName: string,
    public typeName: string,
    public typeKind: TypeKind,
  ) {}

  toString() {
    return `${this.fieldName}`;
  }
}

export class EntityMove implements Display {
  toString() {
    return "🔑";
  }
}

export class AbstractMove implements Display {
  constructor(
    public fromTypeName: string,
    public fromTypeKind: TypeKind,
    public toTypeName: string,
    public toTypeKind: TypeKind,
  ) {}

  toString() {
    return `... on ${this.toTypeName}`;
  }
}

export class InterfaceObjectMove implements Display {
  constructor(
    public fromTypeName: string,
    public fromTypeKind: TypeKind,
    public toTypeName: string,
  ) {}

  toString() {
    return `... on ${this.toTypeName}`;
  }
}

export class Edge<T = Move> implements Display {
  constructor(
    public head: Node,
    public tail: Node,
    public move: T,
    public requirement: Selection | null,
  ) {}

  toString(): string {
    return `${this.head.toString()} -(${(this.move as Display).toString()} ${this.requirement?.toString() ?? ""})- ${this.tail.toString()}`;
  }
}

export class Graph {
  public id: string;
  // We do it for two reasons:
  // 1. We want to be able to quickly find all nodes/edges of a given type
  // 2. We want to avoid array length limit
  private nodesByTypeIndex: Node[][] = [];
  // We have two indexes of edges:
  // 1. By head type
  // 2. By tail type
  // We do it to quickly pick edges by head/tail type, without iterating over all edges.
  private edgesByHeadTypeIndex: Edge[][] = [];
  private edgesByTailTypeIndex: Edge[][] = [];
  // To quickly find all nodes of a given type
  private typeNameToNodeIndexes = new Map<string, number[]>();

  constructor(id: string) {
    this.id = id;
  }

  ensureNonOrSingleNode(typeName: string) {
    const indexes = this.typeNameToNodeIndexes.get(typeName);

    if (!Array.isArray(indexes)) {
      return;
    }

    if (indexes.length > 1) {
      throw new Error(
        `Expected only one node for ${typeName} in graph ${this.id}`,
      );
    }

    return this.nodesByTypeIndex[indexes[0]][0];
  }

  createTypeNode(typeName: string, typeKind: TypeKind) {
    if (this.typeNameToNodeIndexes.has(typeName)) {
      throw new Error(
        `Node for ${typeName} already exists in subgraph ${this.id}`,
      );
    }

    return this.createNode(this.id, typeName, typeKind);
  }

  private createNode(graphId: string, typeName: string, typeKind: TypeKind) {
    const index = this.nodesByTypeIndex.push([]) - 1;
    const node = new Node(index, graphId, typeName, typeKind);
    this.nodesByTypeIndex[node.index].push(node);
    this.edgesByHeadTypeIndex.push([]);
    this.edgesByTailTypeIndex.push([]);

    const existing = this.typeNameToNodeIndexes.get(typeName);

    if (Array.isArray(existing)) {
      existing.push(index);
    } else {
      this.typeNameToNodeIndexes.set(typeName, [index]);
    }

    return node;
  }

  addEdge(edge: Edge) {
    const edgeIndex = this.edgesByHeadTypeIndex[edge.head.index].push(edge) - 1;
    this.edgesByTailTypeIndex[edge.tail.index].push(edge);
    return edge;
  }

  addNode(node: Node) {
    const newIndex = this.nodesByTypeIndex.push([]) - 1;
    node.index = newIndex;

    this.nodesByTypeIndex[node.index].push(node);
    this.edgesByHeadTypeIndex.push([]);
    this.edgesByTailTypeIndex.push([]);

    const existing = this.typeNameToNodeIndexes.get(node.typeName);

    if (Array.isArray(existing)) {
      existing.push(newIndex);
    } else {
      this.typeNameToNodeIndexes.set(node.typeName, [newIndex]);
    }

    return node;
  }

  copyFrom(graph: Graph) {
    for (const nodes of graph.nodesByTypeIndex) {
      for (const node of nodes) {
        this.addNode(node);
      }
    }

    for (const edges of graph.edgesByHeadTypeIndex) {
      for (const edge of edges) {
        this.addEdge(edge);
      }
    }
  }

  joinByKeys(
    entities: Map<
      string,
      Array<{
        key: string;
        graphId: string;
        typeName: string;
      }>
    >,
    selectionResolvers: Map<string, SelectionResolver>,
  ) {
    // for each entity type, we want to assign one entity node to a matching entity node in other subgraphs
    const edgesToAdd: Edge[] = [];

    for (let i = 0; i < this.nodesByTypeIndex.length; i++) {
      const typeNode = this.nodesByTypeIndex[i][0];
      const entitiesOfType = entities.get(typeNode.typeName);

      if (!Array.isArray(entitiesOfType)) {
        continue; // no entities of this type
      }

      const otherNodesIndexes = this.typeNameToNodeIndexes.get(
        typeNode.typeName,
      );

      if (!Array.isArray(otherNodesIndexes)) {
        continue;
      }

      if (typeNode.typeKind !== TypeKind.OBJECT_TYPE) {
        // We will only support objects for now
        continue;
      }

      this.connectEntities(
        i,
        otherNodesIndexes,
        edgesToAdd,
        entitiesOfType,
        selectionResolvers,
      );
    }

    while (edgesToAdd.length > 0) {
      const edge = edgesToAdd.pop();

      if (!edge) {
        throw new Error("Expected edge to be defined");
      }

      this.addEdge(edge);
    }
  }

  print(asLink = false) {
    let str = "digraph G {";

    if (this.typeNameToNodeIndexes.has("Query")) {
      str += "\n root -> Query";
    }

    for (const edge of this.edgesByHeadTypeIndex.flat()) {
      if (edge.head.typeName === "Query") {
        str += `\n  "Query" -> "${edge.head}";`;
      } else if (edge.head.typeName === "Mutation") {
        str += `\n  "Mutation" -> "${edge.head}";`;
      } else if (edge.head.typeName === "Subscription") {
        str += `\n  "Subscription" -> "${edge.head}";`;
      }

      const label = edge.move.toString() + " " + edge.requirement?.toString();
      str += `\n  "${edge.head}" -> "${edge.tail}" [label="${label}"];`;
    }

    str += "\n}";

    if (asLink) {
      return `https://dreampuf.github.io/GraphvizOnline/#${encodeURIComponent(str)}`;
    }

    return str;
  }

  private connectEntities(
    nodeIndex: number,
    sameTypeNameNodeIndexes: number[],
    edgesToAdd: Edge[],
    entitiesOfType: Array<{
      key: string;
      graphId: string;
      typeName: string;
    }>,
    selectionResolvers: Map<string, SelectionResolver>,
  ) {
    for (const headNode of this.nodesByTypeIndex[nodeIndex]) {
      for (const otherNodeIndex of sameTypeNameNodeIndexes) {
        if (nodeIndex === otherNodeIndex) {
          continue;
        }

        for (const tailNode of this.nodesByTypeIndex[otherNodeIndex]) {
          if (!entitiesOfType.some((t) => t.graphId === tailNode.subgraphId)) {
            continue;
          }

          for (const { key } of entitiesOfType.filter(
            (t) => t.graphId === tailNode.subgraphId,
          )) {
            const selectionResolver = selectionResolvers.get(
              tailNode.subgraphId,
            );
            invariant(selectionResolver, "keyFieldsResolver is not defined");

            edgesToAdd.push(
              new Edge(
                headNode,
                tailNode,
                new EntityMove(),
                selectionResolver.resolve(headNode.typeName, key),
              ),
            );
          }
        }
      }
    }
  }

  private getIndexesOfType(typeName: string) {
    return this.typeNameToNodeIndexes.get(typeName);
  }

  nodesOf(typeName: string, failIfMissing = true) {
    const indexes = this.getIndexesOfType(typeName);

    if (!Array.isArray(indexes)) {
      if (failIfMissing) {
        throw new Error(
          `Expected TypeNode(${typeName}) to be inserted first in graph ${this.id}`,
        );
      }

      return [];
    }

    const nodes: Node[] = [];

    for (const i of indexes) {
      for (const node of this.nodesByTypeIndex[i]) {
        nodes.push(node);
      }
    }

    return nodes;
  }

  nodeOf(typeName: string): Node;
  nodeOf(typeName: string, failIfMissing: true): Node;
  nodeOf(typeName: string, failIfMissing?: false): Node | undefined;
  nodeOf(typeName: string, failIfMissing = true) {
    const indexes = this.getIndexesOfType(typeName);

    if (!Array.isArray(indexes)) {
      if (failIfMissing) {
        throw new Error(
          `Expected TypeNode(${typeName}) to be inserted first in graph ${this.id}`,
        );
      }

      return undefined;
    }

    if (indexes.length > 1) {
      throw new Error(
        `Expected only one node for ${typeName} in graph ${this.id}`,
      );
    }

    return this.nodesByTypeIndex[indexes[0]][0];
  }

  edgesOfHead(head: Node) {
    const filtered = this.edgesByHeadTypeIndex[head.index]?.filter(
      (e) => e.head === head,
    );

    if (filtered.length !== this.edgesByHeadTypeIndex[head.index].length) {
      throw new Error("poop");
    }

    return this.edgesByHeadTypeIndex[head.index];
  }
}

export type Field = {
  kind: "field";
  typeName: string;
  fieldName: string;
  selectionSet: null | Array<SelectionNode>;
};

export type Fragment = {
  kind: "fragment";
  typeName: string;
  selectionSet: Array<SelectionNode>;
};

export type SelectionNode = Field | Fragment;

export class Selection {
  constructor(
    private typeName: string,
    private keyFieldsString: string,
    public selectionSet: SelectionNode[],
  ) {}

  contains(typeName: string, fieldName: string) {
    return this._contains(typeName, fieldName, this.selectionSet);
  }

  equals(other: Selection) {
    if (this.typeName !== other.typeName) {
      return false;
    }

    if (this.keyFieldsString === other.keyFieldsString) {
      return true;
    }

    return this._selectionSetEqual(this.selectionSet, other.selectionSet);
  }

  private _selectionSetEqual(
    selectionSet: SelectionNode[],
    otherSelectionSet: SelectionNode[],
  ): boolean {
    if (selectionSet.length !== otherSelectionSet.length) {
      return false;
    }

    for (let i = 0; i < selectionSet.length; i++) {
      // Fields are sorted by typeName and fieldName, so we can compare them directly.
      // See: SelectionResolver#sort
      const selectionNode = selectionSet[i];
      const otherSelectionNode = otherSelectionSet[i];

      if (selectionNode.kind !== otherSelectionNode.kind) {
        return false;
      }

      // Compare typeName and fieldName
      if (selectionNode.typeName !== otherSelectionNode.typeName) {
        return false;
      }

      if (
        selectionNode.kind === "field" &&
        otherSelectionNode.kind === "field" &&
        selectionNode.fieldName !== otherSelectionNode.fieldName
      ) {
        return false;
      }

      const areEqual =
        // Compare selectionSet if both are arrays
        // Otherwise, compare nullability of selectionSet
        Array.isArray(selectionNode.selectionSet) &&
        Array.isArray(otherSelectionNode.selectionSet)
          ? this._selectionSetEqual(
              selectionNode.selectionSet,
              otherSelectionNode.selectionSet,
            )
          : selectionNode.selectionSet === otherSelectionNode.selectionSet;

      // Avoid unnecessary iterations if we already know that fields are not equal
      if (!areEqual) {
        return false;
      }
    }

    return true;
  }

  private _contains(
    typeName: string,
    fieldName: string,
    selectionSet: SelectionNode[],
  ): boolean {
    return selectionSet.some(
      (s) =>
        (s.kind === "field" &&
          s.typeName === typeName &&
          s.fieldName === fieldName) ||
        (s.selectionSet
          ? this._contains(typeName, fieldName, s.selectionSet)
          : false),
    );
  }

  toString() {
    return this.keyFieldsString;
  }
}
