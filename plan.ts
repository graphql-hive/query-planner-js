import { OperationTypeNode, parse } from "graphql";
import { parseSupergraph } from "./src/query-planner/parse.js";
import { walkQuery } from "./src/query-planner/walker.js";
import { composeServices } from "./src/compose.js";

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

const paths = walkQuery(supergraph, OperationTypeNode.QUERY, [
  {
    kind: "Field",
    name: "users",
  },
  {
    kind: "Field",
    name: "age",
  },
]);

console.log("Found", paths.length, "paths");
for (const path of paths) {
  console.log(path.edges.map((edge) => edge.toString()).join(" -> "));
}
