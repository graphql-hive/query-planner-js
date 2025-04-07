import { OperationTypeNode } from "graphql";
import { SelectionNode } from "./graph";

export type QueryPlanNode =
  | FetchNode
  | SequenceNode
  | ParallelNode
  | FlattenNode;

/**
 * Represents a fetch operation in the query plan.
 */
export interface FetchNode {
  kind: "Fetch";
  /**
   * Name of the subgraph to make the fetch request
   */
  serviceName: string;
  /**
   * Selection set required to fetch the data
   */
  requires?: SelectionNode;
  /**
   * Variables used in the operation (ignore for now)
   */
  variableUsages: any[];
  /**
   * The GraphQL operation to execute
   */
  operation: string;
  /**
   * The type of operation (query, mutation, subscription)
   */
  operationKind: OperationTypeNode;
}

/**
 * Represents a sequence of operations in the query plan.
 */
export interface SequenceNode {
  kind: "Sequence";
  nodes: QueryPlanNode[];
}

/**
 * Represents a parallel execution of operations in the query plan.
 */
export interface ParallelNode {
  kind: "Parallel";
  nodes: QueryPlanNode[];
}

/**
 * Represents a flattening operation in the query plan.
 */
export interface FlattenNode {
  kind: "Flatten";
  /**
   * Where to flatten the data
   */
  path: (string | number)[];
  /**
   * What to flatten
   */
  node: QueryPlanNode;
}

/**
 * Starts a new query plan.
 */
export interface QueryPlan {
  kind: "QueryPlan";
  node: QueryPlanNode;
}
