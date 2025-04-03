import { TypeNode, Kind } from "graphql";

const invariantPreffix = "Invariant failed";
// Throw an error if the condition fails
// > Not providing an inline default argument for message as the result is smaller
export function invariant(
  condition: unknown,
  // Can provide a string, or a function that returns a string for cases where
  // the message takes a fair amount of effort to compute
  message?: string | (() => string),
): asserts condition {
  if (condition) {
    return;
  }
  // Condition not passed

  // We allow the message to pass through
  const provided: string | undefined =
    typeof message === "function" ? message() : message;

  // Options:
  // 1. message provided: `${prefix}: ${provided}`
  // 2. message not provided: prefix
  const value: string = provided
    ? `${invariantPreffix}: ${provided}`
    : invariantPreffix;
  throw new Error(value);
}

export function isListTypeNode(typeNode: TypeNode): boolean {
  if (typeNode.kind === Kind.LIST_TYPE) {
    return true;
  }

  if (typeNode.kind === Kind.NON_NULL_TYPE) {
    return isListTypeNode(typeNode.type);
  }

  return false;
}

export function resolveTypeNodeName(typeNode: TypeNode): string {
  switch (typeNode.kind) {
    case Kind.NAMED_TYPE:
      return typeNode.name.value;
    case Kind.NON_NULL_TYPE:
      return resolveTypeNodeName(typeNode.type);
    case Kind.LIST_TYPE:
      return resolveTypeNodeName(typeNode.type);
  }
}
