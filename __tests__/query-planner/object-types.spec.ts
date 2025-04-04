import { describe, expect, test } from "vitest";
import { assertCompositionSuccess, graphql } from "../shared/testkit";
import { OperationTypeNode, parse } from "graphql";
import { composeServices } from "../../src/compose.js";
import { parseSupergraph } from "../../src/query-planner/parse";
import { OperationPath, walkQuery } from "../../src/query-planner/walker";
import {
  generateQueryPlan,
  prettyPrintQueryPlan,
} from "../../src/query-planner/plan";

function printPath(path: OperationPath) {
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
}

describe("Object Types Entities", () => {
  test("single key field", () => {
    const result = composeServices([
      {
        name: "a",
        typeDefs: graphql`
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
        `,
      },
      {
        name: "b",
        typeDefs: graphql`
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
        `,
      },
    ]);

    assertCompositionSuccess(result);

    const supergraph = parseSupergraph(result.supergraphSdl);
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
    expect(path).not.toBeNull();

    const plan = generateQueryPlan(path!);
    expect(plan).toMatchInlineSnapshot(`
      {
        "kind": "QueryPlan",
        "node": {
          "kind": "Sequence",
          "nodes": [
            {
              "kind": "Fetch",
              "operation": "{
      users {
        __typename

        id
        }
      }
      ",
              "operationKind": "query",
              "serviceName": "B",
              "variableUsages": [],
            },
            {
              "kind": "Flatten",
              "node": {
                "kind": "Fetch",
                "operation": "query ($representations : [_Any!]!  ){
        _entities(representations: $representations) {
          ... on User {
            age
          }
        }
      }",
                "operationKind": "query",
                "requires": {
                  "kind": "fragment",
                  "selectionSet": [
                    {
                      "fieldName": "id",
                      "kind": "field",
                      "selectionSet": null,
                      "typeName": "User",
                    },
                  ],
                  "typeName": "User",
                },
                "serviceName": "A",
                "variableUsages": [],
              },
              "path": [
                "users",
                "@",
              ],
            },
          ],
        },
      }
    `);
  });
  test.only("complex-entity-call", () => {
    const result = composeServices([
      {
        name: "link",
        typeDefs: graphql`
          extend schema
            @link(
              url: "https://specs.apollo.dev/federation/v2.0"
              import: ["@key"]
            )

          type Product @key(fields: "id") @key(fields: "id pid") {
            id: String!
            pid: String!
          }
        `,
      },
      {
        name: "list",
        typeDefs: graphql`
          extend schema
            @link(
              url: "https://specs.apollo.dev/federation/v2.0"
              import: ["@key", "@shareable"]
            )

          type ProductList @key(fields: "products{id pid}") {
            products: [Product!]!
            first: Product @shareable
            selected: Product @shareable
          }

          type Product @key(fields: "id pid") {
            id: String!
            pid: String
          }
        `,
      },
      {
        name: "price",
        typeDefs: graphql`
          extend schema
            @link(
              url: "https://specs.apollo.dev/federation/v2.0"
              import: ["@key", "@shareable"]
            )

          type ProductList
            @key(fields: "products{id pid category{id tag}} selected{id}") {
            products: [Product!]!
            first: Product @shareable
            selected: Product @shareable
          }

          type Product @key(fields: "id pid category{id tag}") {
            id: String!
            price: Price
            pid: String
            category: Category
          }

          type Category @key(fields: "id tag") {
            id: String!
            tag: String
          }

          type Price {
            price: Float!
          }
        `,
      },
      {
        name: "products",
        typeDefs: graphql`
          extend schema
            @link(
              url: "https://specs.apollo.dev/federation/v2.0"
              import: ["@key", "@external", "@extends", "@shareable"]
            )

          type Query {
            topProducts: ProductList!
          }

          type ProductList @key(fields: "products{id}") {
            products: [Product!]!
          }

          type Product @extends @key(fields: "id") {
            id: String! @external
            category: Category @shareable
          }

          type Category @key(fields: "id") {
            mainProduct: Product! @shareable
            id: String!
            tag: String @shareable
          }
        `,
      },
    ]);
    assertCompositionSuccess(result);
    const supergraph = parseSupergraph(result.supergraphSdl);
    const path = walkQuery(supergraph, OperationTypeNode.QUERY, [
      {
        kind: "Field",
        name: "topProducts",
      },
      {
        kind: "Field",
        name: "products",
      },
      {
        kind: "Field",
        name: "price",
      },
      {
        kind: "Field",
        name: "price",
      },
    ]);
    expect(path).not.toBeNull();

    printPath(path!);

    const plan = generateQueryPlan(path!);
    expect(plan).toMatchInlineSnapshot(`
      {
        "kind": "QueryPlan",
        "node": {
          "kind": "Sequence",
          "nodes": [
            {
              "kind": "Fetch",
              "operation": "{
      topProducts {
        __typename

        products {
          __typename

          category {
            id
            tag
          }
          id
          pid
          }
        }
      }
      ",
              "operationKind": "query",
              "serviceName": "PRODUCTS",
              "variableUsages": [],
            },
            {
              "kind": "Flatten",
              "node": {
                "kind": "Fetch",
                "operation": "query ($representations : [_Any!]!  ){
        _entities(representations: $representations) {
          ... on Product {
            price
          }
        }
      }",
                "operationKind": "query",
                "requires": {
                  "kind": "fragment",
                  "selectionSet": [
                    {
                      "fieldName": "category",
                      "kind": "field",
                      "selectionSet": [
                        {
                          "fieldName": "id",
                          "kind": "field",
                          "selectionSet": null,
                          "typeName": "Category",
                        },
                        {
                          "fieldName": "tag",
                          "kind": "field",
                          "selectionSet": null,
                          "typeName": "Category",
                        },
                      ],
                      "typeName": "Product",
                    },
                    {
                      "fieldName": "id",
                      "kind": "field",
                      "selectionSet": null,
                      "typeName": "Product",
                    },
                    {
                      "fieldName": "pid",
                      "kind": "field",
                      "selectionSet": null,
                      "typeName": "Product",
                    },
                  ],
                  "typeName": "Product",
                },
                "serviceName": "PRICE",
                "variableUsages": [],
              },
              "path": [
                "topProducts",
                "products",
                "@",
              ],
            },
          ],
        },
      }
    `);

    expect(prettyPrintQueryPlan(plan)).toMatchInlineSnapshot(`
      "QueryPlan {
        Sequence {
          Fetch(service: "PRODUCTS") {
            {
              topProducts{
                __typename
                products{
                  __typename
                  category{
                    id
                    tag
                  }
                  id
                  pid
                }
              }
            }
          },
          Flatten(path: "topProducts.products.@") {
            Fetch(service: "PRICE") {
              {
                ... on Product {
                  category {
                    id
                    tag
                  }
                  id
                  pid
                }
              } =>
              {
                ... on Product {
                  price
                }
              }
            }
          }
        }
      }"
    `);
  });
});
