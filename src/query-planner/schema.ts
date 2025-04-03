import { JoinField, JoinType } from "./join-directives";

export enum TypeKind {
  OBJECT_TYPE,
  INTERFACE_TYPE,
  ENUM_TYPE,
  UNION_TYPE,
  INPUT_OBJECT_TYPE,
  SCALAR_TYPE,
}

export class Supergraph {
  public subgraphs = new Map<string, Subgraph>();
}

export class Subgraph {
  graphId: string;
  types: Map<string, ObjectType> = new Map();
  entityTypes = new Set<string>();

  constructor(graphId: string) {
    this.graphId = graphId;
  }
}

export class ObjectType {
  public name: string;
  public fields: ObjectTypeField[] = [];
  public join: JoinType[] = [];

  constructor(name: string, join: JoinType[]) {
    this.name = name;
    this.join = join;
  }

  addField(field: ObjectTypeField) {
    this.fields.push(field);
  }
}

export class ObjectTypeField {
  public name: string;
  public type: string;
  public isList: boolean;
  public join: JoinField;

  constructor(name: string, type: string, isList: boolean, join: JoinField) {
    this.name = name;
    this.type = type;
    this.isList = isList;
    this.join = join;
  }
}
