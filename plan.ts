import { OperationTypeNode } from "graphql";
import { graphql } from "./__tests__/shared/utils.js";
import { parseSupergraph } from "./src/query-planner/parse.js";
import {
  OperationPath,
  walkQuery,
  pathsToGraphviz,
} from "./src/query-planner/walker.js";
import { composeServices } from "./src/compose.js";
import {
  generateQueryPlan,
  prettyPrintQueryPlan,
} from "./src/query-planner/plan.js";

const result = composeServices([
  {
    name: "link",
    typeDefs: graphql`
      extend schema
        @link(url: "https://specs.apollo.dev/federation/v2.0", import: ["@key"])

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

if (!result.supergraphSdl) {
  throw new Error("Failed to compose services");
}

const supergraph = parseSupergraph(result.supergraphSdl);

console.log(supergraph.print(true));

performance.mark("plan-start");
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
performance.mark("plan-end");
console.log(performance.measure("plan", "plan-start", "plan-end").duration);

if (!path) {
  throw new Error("Failed to find path");
}

console.log("\n\n");
console.log("Best found path:");

console.log(path.edges.map((edge) => edge.toString()).join(" -> "));

printRequiredEdges(path, 4);

function printRequiredEdges(path: OperationPath, indent: number) {
  const spaces = " ".repeat(indent);
  let i = 0;
  for (const requiredPathsOfEdge of path.requiredPathsForEdges) {
    if (requiredPathsOfEdge.length) {
      console.log(
        spaces + "edge " + path.edges[i++].toString() + " depends on: ",
      );
      for (const requiredPath of requiredPathsOfEdge) {
        console.log(
          spaces +
            "    " +
            requiredPath.edges.map((edge) => edge.toString()).join(" -> "),
        );
        printRequiredEdges(requiredPath, indent + 8);
      }
    }
  }
}

console.log(pathsToGraphviz([path], true));

// const plan = generateQueryPlan(path);

// console.log("\n\n");
// console.log("Generating a query plan\n");
// console.log(JSON.stringify(plan, null, 2));

// console.log("\n\n");
// console.log("Pretty format\n");

// console.log(prettyPrintQueryPlan(plan));
//

// KAMIL: WE'RE INTO SOMETHING
// I looked at the edges their dependencies
// I made a graphviz (diagram G)
// I removed duplicated lines (head -> tail [label="edge"])
// Then I grouped them all by subgraphs
// Then I turned them into selection sets
// I noticed that "Product/PRODUCTS" -> "Product/LIST" [label="🔑 id pid"] and "Product/PRODUCTS" -> "Product/LINK" [label="🔑 id"]
//   are fetching exact same data
//   the PRODUCTS -> LINK has shorter key field set so we can pick this one
//
//
//
// digraph G {
//   root -> "Query/PRODUCTS"
//   "Query/PRODUCTS" -> "ProductList/PRODUCTS" [label="topProducts"]
//     "ProductList/PRODUCTS" -> "Product/PRODUCTS" [label="products"]
//         "Product/PRODUCTS" -> "String/PRODUCTS" [label="id"]
//         "Product/PRODUCTS" -> "Category/PRODUCTS" [label="category"]
//             "Category/PRODUCTS" -> "String/PRODUCTS" [label="id"]
//             "Category/PRODUCTS" -> "String/PRODUCTS" [label="tag"]
//
// // From: products
// // To:   price
//   "Product/PRODUCTS" -> "Product/PRICE" [label="(🔑 id pid category{id tag})"]
// //   selection
//   "Product/PRICE" -> "Price/PRICE" [label="price"]
//     "Price/PRICE" -> "Float/PRICE" [label="price"]
//
// // From: products
// // To:   list
//   "Product/PRODUCTS" -> "Product/LIST" [label="🔑 id pid"]
// //   selection
//     "Product/LIST" -> "String/LIST" [label="id"]
//     "Product/LIST" -> "String/LIST" [label="pid"]
//
// //   From: products
// //   To:   link
//   "Product/PRODUCTS" -> "Product/LINK" [label="🔑 id"]
// //   selection
//     "Product/LINK" -> "String/LINK" [label="pid"]
//     "Product/LINK" -> "String/LINK" [label="id"]
// }
//
// Apollo's
//
// QueryPlan {
//   Sequence {
//     Fetch(service: "products") {
//       {
//         topProducts {
//           products {
//             __typename
//             id
//             category {
//               id
//               tag
//             }
//           }
//         }
//       }
//     },
//     Flatten(path: "topProducts.products.@") {
//       Fetch(service: "link") {
//         {
//           ... on Product {
//             __typename
//             id
//           }
//         } =>
//         {
//           ... on Product {
//             pid
//           }
//         }
//       },
//     },
//     Flatten(path: "topProducts.products.@") {
//       Fetch(service: "price") {
//         {
//           ... on Product {
//             __typename
//             id
//             pid
//             category {
//               id
//               tag
//             }
//           }
//         } =>
//         {
//           ... on Product {
//             price {
//               price
//             }
//           }
//         }
//       },
//     },
//   },
// }
