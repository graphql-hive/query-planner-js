import { OperationTypeNode, parse } from "graphql";
import { parseSupergraph } from "./src/query-planner/parse.js";
import { walkQuery } from "./src/query-planner/walker.js";
import { composeServices } from "./src/compose.js";
import {
  generateQueryPlan,
  prettyPrintQueryPlan,
} from "./src/query-planner/plan.js";

const result = composeServices([
  {
    name: "a",
    typeDefs: parse(/* GraphQL */ `
      extend schema
        @link(
          url: "https://specs.apollo.dev/federation/v2.3"
          import: ["@key", "@shareable"]
        )

      type User @key(fields: "id") {
        id: ID!
        name: String @shareable
        age: Int
      }
    `),
  },
  {
    name: "b",
    typeDefs: parse(/* GraphQL */ `
      extend schema
        @link(
          url: "https://specs.apollo.dev/federation/v2.3"
          import: ["@key", "@shareable"]
        )

      type User @key(fields: "id") {
        id: ID!
        name: String @shareable
      }

      type Query {
        users: [User] @shareable
      }
    `),
  },
]);

if (!result.supergraphSdl) {
  throw new Error("Failed to compose services");
}

const supergraph = parseSupergraph(result.supergraphSdl);

console.log(supergraph.print(true));

const path = walkQuery(supergraph, OperationTypeNode.QUERY, [
  {
    kind: "Field",
    name: "users",
  },
  {
    kind: "Field",
    name: "age",
  },
]);

if (!path) {
  throw new Error("Failed to find path");
}

console.log("\n\n");
console.log("Best found path:");

console.log(path.edges.map((edge) => edge.toString()).join(" -> "));
let i = 0;
for (const requiredPathsOfEdge of path.requiredPathsForEdges) {
  if (requiredPathsOfEdge.length) {
    console.log(" edge " + path.edges[i++].toString() + "depends on: ");
    for (const requiredPath of requiredPathsOfEdge) {
      console.log(
        "  " + requiredPath.edges.map((edge) => edge.toString()).join(" -> "),
      );
    }
  }
}

const plan = generateQueryPlan(path);

console.log("\n\n");
console.log("Generating a query plan\n");
console.log(JSON.stringify(plan, null, 2));

console.log("\n\n");
console.log("Pretty format\n");

console.log(prettyPrintQueryPlan(plan));
