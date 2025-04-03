import { FieldNode, Kind, SelectionSetNode } from "graphql";
import { parseFields } from "../subgraph/helpers";
import { Selection, SelectionNode } from "./graph";
import type { Subgraph } from "./schema";
import { invariant } from "./utils";

export class SelectionResolver {
  private cache: Map<string, Selection> = new Map();

  constructor(private subgraph: Subgraph) {}

  resolve(typeName: string, keyFields: string): Selection {
    const key = this.keyFactory(typeName, keyFields);

    if (this.cache.has(key)) {
      return this.cache.get(key)!;
    }

    const typeState = this.subgraph.types.get(typeName);
    invariant(
      !!typeState,
      `Expected an object/interface type when resolving keyFields of ${typeName}`,
    );

    const selectionSetNode = parseFields(keyFields);
    invariant(
      !!selectionSetNode,
      `Expected a selection set when resolving keyFields of ${typeName}`,
    );

    const fields = new Selection(
      typeName,
      keyFields,
      this.resolveSelectionSetNode(typeName, selectionSetNode),
    );
    this.cache.set(key, fields);

    return fields;
  }

  private keyFactory(typeName: string, keyFields: string) {
    return `${typeName}/${keyFields}`;
  }

  private resolveFieldNode(
    typeName: string,
    fieldNode: FieldNode,
    selectionSet: SelectionNode[],
  ) {
    if (fieldNode.name.value === "__typename") {
      return;
    }

    const typeState = this.subgraph.types.get(typeName);
    invariant(typeState, `Type "${typeName}" is not defined.`);

    const field = typeState.fields.find((f) => f.name === fieldNode.name.value);
    invariant(field, `Field "${fieldNode.name.value}" is not defined.`);

    if (fieldNode.selectionSet) {
      selectionSet.push({
        kind: "field",
        fieldName: fieldNode.name.value,
        typeName,
        selectionSet: this.resolveSelectionSetNode(
          field.type,
          fieldNode.selectionSet,
        ),
      });
    } else {
      // it's a leaf
      selectionSet.push({
        kind: "field",
        typeName,
        fieldName: fieldNode.name.value,
        selectionSet: null,
      });
    }
  }

  private resolveSelectionSetNode(
    typeName: string,
    selectionSetNode: SelectionSetNode,
    selectionSet: SelectionNode[] = [],
  ): SelectionNode[] {
    for (const selection of selectionSetNode.selections) {
      if (selection.kind === Kind.FIELD) {
        this.resolveFieldNode(typeName, selection, selectionSet);
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        throw new Error(`Inline fragment is not supported.`);
      } else {
        throw new Error(`Fragment spread is not supported.`);
      }
    }

    return this.sort(selectionSet);
  }

  private sort(selectionSet: SelectionNode[]): SelectionNode[] {
    return selectionSet.sort((a, b) => {
      if (a.kind === b.kind) {
        return a.kind === "field" && b.kind === "field"
          ? // sort fields by typeName.fieldName
            `${a.typeName}.${a.fieldName}`.localeCompare(
              `${b.typeName}.${b.fieldName}`,
            )
          : // sort fragments by typeName
            a.typeName.localeCompare(b.typeName);
      }

      // field -> fragment
      return a.kind === "field" ? -1 : 1;
    });
  }
}
