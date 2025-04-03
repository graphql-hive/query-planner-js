import { DirectiveNode, Kind } from "graphql";
import { invariant } from "./utils";

const _joinTypeDirectiveDefinition = /* GraphQL */ `
  directive @join__type(
    graph: join__Graph!
    # if it's an entity, the value represents a selection set (the key)
    key: join__FieldSet
    # tells the gateway if it's a type extension or @extends was applied
    extension: Boolean! = false
    # in some cases an entity cannot be resolved via Query._entities
    resolvable: Boolean! = true
    # tells the gateway that an interface
    # is in fact an object type with @interfaceObject
    isInterfaceObject: Boolean! = false
  ) repeatable on OBJECT | INTERFACE | UNION | ENUM | INPUT_OBJECT | SCALAR
`;
export function parseJoinType(directive: DirectiveNode) {
  invariant(
    directive.name.value === "join__type",
    "Invalid directive. Expected join__type, received: " + directive.name.value,
  );

  let graph: string | null = null;
  let key: string | null = null;
  let extension: boolean = false;
  let resolvable: boolean = true;
  let isInterfaceObject: boolean = false;

  for (const arg of directive.arguments ?? []) {
    if (arg.name.value === "graph") {
      invariant(
        arg.value.kind === Kind.ENUM,
        "Expected join__type(graph:) to be enum value, got: " + arg.value.kind,
      );

      graph = arg.value.value;
    } else if (arg.name.value === "key") {
      invariant(
        arg.value.kind === Kind.STRING,
        "Expected join__type(key:) to be string, got: " + arg.value.kind,
      );
      key = arg.value.value;
    } else if (arg.name.value === "extension") {
      invariant(
        arg.value.kind === Kind.BOOLEAN,
        "Expected join__type(key:) to be boolean, got: " + arg.value.kind,
      );
      extension = arg.value.value;
    } else if (arg.name.value === "resolvable") {
      invariant(
        arg.value.kind === Kind.BOOLEAN,
        "Expected join__type(resolvable:) to be string, got: " + arg.value.kind,
      );
      resolvable = arg.value.value;
    } else if (arg.name.value === "isInterfaceObject") {
      invariant(
        arg.value.kind === Kind.BOOLEAN,
        "Expected join__type(isInterfaceObject:) to be string, got: " +
          arg.value.kind,
      );
      isInterfaceObject = arg.value.value;
    }
  }

  invariant(
    typeof graph === "string",
    "Expected join__type(graph:) to be defined",
  );

  return new JoinType(graph, key, extension, resolvable, isInterfaceObject);
}

export class JoinType {
  constructor(
    /**
     * Ownership
     */
    public graph: string,
    /**
     * if it's an entity, the value represents a selection set (the key)
     */
    public key: string | null,
    /**
     * tells the gateway if it's a type extension or @extends was applied
     */
    public extension: boolean,
    /**
     * in some cases an entity cannot be resolved via Query._entities
     */
    public resolvable: boolean,
    /**
     * tells the gateway that an interface
     * is in fact an object type with @interfaceObject */
    public isInterfaceObject: boolean,
  ) {}
}

const _joinImplementsDirectiveDefinition = /* GraphQL */ `
  # Tells the gateway that an object type from subgraph X implements interface Y
  directive @join__implements(
    graph: join__Graph!
    interface: String!
  ) repeatable on OBJECT | INTERFACE
`;

export function parseJoinImplements(directive: DirectiveNode) {
  invariant(
    directive.name.value === "join__implements",
    "Invalid directive. Expected join__implements, received: " +
      directive.name.value,
  );

  let graph: string | null = null;
  let interfaceName: string | null = null;

  for (const arg of directive.arguments ?? []) {
    if (arg.name.value === "graph") {
      invariant(
        arg.value.kind === Kind.ENUM,
        "Expected join__implements(graph:) to be enum value, got: " +
          arg.value.kind,
      );

      graph = arg.value.value;
    } else if (arg.name.value === "interface") {
      invariant(
        arg.value.kind === Kind.STRING,
        "Expected join__implements(interface:) to be string, got: " +
          arg.value.kind,
      );
      interfaceName = arg.value.value;
    }
  }

  invariant(
    typeof graph === "string",
    "Expected join__implements(graph:) to be defined",
  );

  invariant(
    typeof interfaceName === "string",
    "Expected join__implements(interface:) to be defined",
  );

  return new JoinImplements(graph, interfaceName);
}

export class JoinImplements {
  constructor(
    /**
     * Ownership
     */
    public graph: string,
    /**
     * interface name
     */
    public interfaceName: string,
  ) {}
}

const _joinUnionMemberDirectiveDefinition = /* GraphQL */ `
  # Connects a union member to a subgraph
  directive @join__unionMember(
    graph: join__Graph!
    member: String!
  ) repeatable on UNION
`;

export function parseJoinUnionMember(directive: DirectiveNode) {
  invariant(
    directive.name.value === "join__unionMember",
    "Invalid directive. Expected join__unionMember, received: " +
      directive.name.value,
  );

  let graph: string | null = null;
  let member: string | null = null;

  for (const arg of directive.arguments ?? []) {
    if (arg.name.value === "graph") {
      invariant(
        arg.value.kind === Kind.ENUM,
        "Expected join__unionMember(graph:) to be enum value, got: " +
          arg.value.kind,
      );

      graph = arg.value.value;
    } else if (arg.name.value === "member") {
      invariant(
        arg.value.kind === Kind.STRING,
        "Expected join__unionMember(member:) to be string, got: " +
          arg.value.kind,
      );
      member = arg.value.value;
    }
  }

  invariant(
    typeof graph === "string",
    "Expected join__unionMember(graph:) to be defined",
  );

  invariant(
    typeof member === "string",
    "Expected join__unionMember(member:) to be defined",
  );

  return new JoinUnionMember(graph, member);
}

export class JoinUnionMember {
  constructor(
    /**
     * Ownership
     */
    public graph: string,
    /**
     * member name
     */
    public member: string,
  ) {}
}

const _joinFieldDirectiveDefinition = /* GraphQL */ `
  directive @join__field(
    graph: join__Graph
    # a selection set that has to be provided to Query._entities
    requires: join__FieldSet
    # a selection set that is resolved when visiting the field
    provides: join__FieldSet
    # in case there's a type difference, it holds a printed(AST)
    type: String
    # notifies the gateway that a field cannot be resolved
    external: Boolean
    # tells the gateway when it tries to resolve a field
    # from a subgraph mentioned in the value,
    # it should use this subgraph to do it instead
    override: String
    # to be honest, I don't know, but we have two examples where it's defined
    usedOverridden: Boolean
  ) repeatable on FIELD_DEFINITION | INPUT_FIELD_DEFINITION
`;

export function parseJoinField(directive: DirectiveNode): JoinField {
  invariant(
    directive.name.value === "join__field",
    "Invalid directive. Expected join__field, received: " +
      directive.name.value,
  );

  let graph: string | null = null;
  let requires: string | null = null;
  let provides: string | null = null;
  let type: string | null = null;
  let external: boolean = false;
  let override: string | null = null;
  let usedOverridden: boolean = false;

  for (const arg of directive.arguments ?? []) {
    if (arg.name.value === "graph") {
      invariant(
        arg.value.kind === Kind.ENUM,
        "Expected join__field(graph:) to be enum value, got: " + arg.value.kind,
      );

      graph = arg.value.value;
    } else if (arg.name.value === "requires") {
      invariant(
        arg.value.kind === Kind.STRING,
        "Expected join__field(requires:) to be string, got: " + arg.value.kind,
      );
      requires = arg.value.value;
    } else if (arg.name.value === "provides") {
      invariant(
        arg.value.kind === Kind.STRING,
        "Expected join__field(provides:) to be string, got: " + arg.value.kind,
      );
      provides = arg.value.value;
    } else if (arg.name.value === "type") {
      invariant(
        arg.value.kind === Kind.STRING,
        "Expected join__field(type:) to be string, got: " + arg.value.kind,
      );
      type = arg.value.value;
    } else if (arg.name.value === "external") {
      invariant(
        arg.value.kind === Kind.BOOLEAN,
        "Expected join__field(external:) to be boolean, got: " + arg.value.kind,
      );
      external = arg.value.value;
    } else if (arg.name.value === "override") {
      invariant(
        arg.value.kind === Kind.STRING,
        "Expected join__field(override:) to be string, got: " + arg.value.kind,
      );
      override = arg.value.value;
    } else if (arg.name.value === "usedOverridden") {
      invariant(
        arg.value.kind === Kind.BOOLEAN,
        "Expected join__field(usedOverridden:) to be boolean, got: " +
          arg.value.kind,
      );
      usedOverridden = arg.value.value;
    }
  }

  return new JoinField(
    graph,
    requires,
    provides,
    type,
    external,
    override,
    usedOverridden,
  );
}

export class JoinField {
  constructor(
    /**
     * Ownership
     */
    public graph: string | null,
    /**
     * a selection set that has to be provided to Query._entities
     */
    public requires: string | null,
    /**
     * a selection set that is resolved when visiting the field
     */
    public provides: string | null,
    /**
     * in case there's a type difference, it holds a printed(AST)
     */
    public type: string | null,
    /**
     * notifies the gateway that a field cannot be resolved
     */
    public external: boolean,
    /**
     * tells the gateway when it tries to resolve a field
     * from a subgraph mentioned in the value,
     * it should use this subgraph to do it instead
     */
    public override: string | null,
    /**
     * to be honest, I don't know, but we have two examples where it's defined
     */
    public usedOverridden: boolean,
  ) {}
}

const _joinEnumValueDirectiveDefinition = /* GraphQL */ `
  directive @join__enumValue(graph: join__Graph!) repeatable on ENUM_VALUE
`;

export function parseJoinEnumValue(directive: DirectiveNode) {
  invariant(
    directive.name.value === "join__enumValue",
    "Invalid directive. Expected join__enumValue, received: " +
      directive.name.value,
  );

  let graph: string | null = null;

  for (const arg of directive.arguments ?? []) {
    if (arg.name.value === "graph") {
      invariant(
        arg.value.kind === Kind.ENUM,
        "Expected join__enumValue(graph:) to be enum value, got: " +
          arg.value.kind,
      );

      graph = arg.value.value;
    }
  }

  invariant(
    typeof graph === "string",
    "Expected join__enumValue(graph:) to be defined",
  );

  return new JoinEnumValue(graph);
}

export class JoinEnumValue {
  constructor(
    /**
     * Ownership
     */
    public graph: string,
  ) {}
}
