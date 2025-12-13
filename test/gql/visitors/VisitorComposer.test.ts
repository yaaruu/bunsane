import { describe, it, expect, beforeEach, mock } from "bun:test";
import { VisitorComposer } from "../../../gql/visitors/VisitorComposer";
import { GraphVisitor } from "../../../gql/visitors/GraphVisitor";
import { TypeNode, OperationNode, GraphQLTypeKind, OperationType } from "../../../gql/graph/GraphNode";
import { SchemaGraph } from "../../../gql/graph/SchemaGraph";

// Mock visitor implementations
class MockVisitor extends GraphVisitor {
  public visitOrder: string[] = [];
  public results = { visited: [] };

  beforeVisit(): void {
    this.visitOrder.push("beforeVisit");
  }

  visitTypeNode(node: TypeNode): void {
    this.visitOrder.push(`visitTypeNode-${node.name}`);
    this.results.visited.push(node.name);
  }

  visitOperationNode(node: OperationNode): void {
    this.visitOrder.push(`visitOperationNode-${node.name}`);
    this.results.visited.push(node.name);
  }

  getResults(): any {
    return this.results;
  }
}

describe("VisitorComposer", () => {
  let composer: VisitorComposer;
  let visitor1: MockVisitor;
  let visitor2: MockVisitor;
  let visitor3: MockVisitor;

  beforeEach(() => {
    composer = new VisitorComposer();
    visitor1 = new MockVisitor();
    visitor2 = new MockVisitor();
    visitor3 = new MockVisitor();
  });

  describe("addVisitor", () => {
    it("should add visitors to the composition", () => {
      composer.addVisitor(visitor1);
      composer.addVisitor(visitor2);

      expect(composer.getVisitors()).toContain(visitor1);
      expect(composer.getVisitors()).toContain(visitor2);
      expect(composer.getVisitors().length).toBe(2);
    });

    it("should allow chaining addVisitor calls", () => {
      composer
        .addVisitor(visitor1)
        .addVisitor(visitor2)
        .addVisitor(visitor3);

      expect(composer.getVisitors().length).toBe(3);
    });
  });

  describe("removeVisitor", () => {
    it("should remove a specific visitor", () => {
      composer.addVisitor(visitor1);
      composer.addVisitor(visitor2);
      composer.addVisitor(visitor3);

      composer.removeVisitor(visitor2);

      expect(composer.getVisitors()).toContain(visitor1);
      expect(composer.getVisitors()).toContain(visitor3);
      expect(composer.getVisitors()).not.toContain(visitor2);
      expect(composer.getVisitors().length).toBe(2);
    });

    it("should do nothing if visitor not found", () => {
      composer.addVisitor(visitor1);
      composer.removeVisitor(visitor2); // visitor2 not added

      expect(composer.getVisitors().length).toBe(1);
    });
  });

  describe("clearVisitors", () => {
    it("should remove all visitors", () => {
      composer.addVisitor(visitor1);
      composer.addVisitor(visitor2);

      composer.clearVisitors();

      expect(composer.getVisitors().length).toBe(0);
    });
  });

  describe("visitGraph", () => {
    it("should call beforeVisit on all visitors", () => {
      composer.addVisitor(visitor1);
      composer.addVisitor(visitor2);

      const mockGraph = new SchemaGraph();

      composer.visitGraph(mockGraph);

      expect(visitor1.visitOrder).toContain("beforeVisit");
      expect(visitor2.visitOrder).toContain("beforeVisit");
    });

    it("should visit all nodes in the graph with all visitors", () => {
      composer.addVisitor(visitor1);
      composer.addVisitor(visitor2);

      const mockGraph = new SchemaGraph();
      const typeNode = new TypeNode(
        "user-type",
        "User",
        GraphQLTypeKind.OBJECT,
        "type User { id: ID! }"
      );
      const operationNode = new OperationNode(
        "get-user",
        "getUser",
        "Query",
        "getUser(id: ID!): User"
      );

      mockGraph.addNode(typeNode);
      mockGraph.addNode(operationNode);

      composer.visitGraph(mockGraph);

      // Each visitor should have visited both nodes
      expect(visitor1.results.visited).toContain("User");
      expect(visitor1.results.visited).toContain("getUser");
      expect(visitor2.results.visited).toContain("User");
      expect(visitor2.results.visited).toContain("getUser");
    });

    it("should visit nodes in the correct order", () => {
      composer.addVisitor(visitor1);

      const mockGraph = new SchemaGraph();
      const typeNode = new TypeNode(
        "user-type",
        "User",
        GraphQLTypeKind.OBJECT,
        "type User { id: ID! }"
      );
      const operationNode = new OperationNode(
        "get-user",
        "getUser",
        OperationType.QUERY,
        "getUser(id: ID!): User"
      );

      mockGraph.addNode(typeNode);
      mockGraph.addNode(operationNode);

      composer.visitGraph(mockGraph);

      // beforeVisit should be called first, then node visits
      expect(visitor1.visitOrder[0]).toBe("beforeVisit");
      expect(visitor1.visitOrder).toContain("visitTypeNode-User");
      expect(visitor1.visitOrder).toContain("visitOperationNode-getUser");
    });
  });

  describe("visitNodes", () => {
    it("should visit a list of nodes with all visitors", () => {
      composer.addVisitor(visitor1);
      composer.addVisitor(visitor2);

      const typeNode = new TypeNode(
        "user-type",
        "User",
        GraphQLTypeKind.OBJECT,
        "type User { id: ID! }"
      );
      const operationNode = new OperationNode(
        "get-user",
        "getUser",
        OperationType.QUERY,
        "getUser(id: ID!): User"
      );

      composer.visitNodes([typeNode, operationNode]);

      expect(visitor1.results.visited).toContain("User");
      expect(visitor1.results.visited).toContain("getUser");
      expect(visitor2.results.visited).toContain("User");
      expect(visitor2.results.visited).toContain("getUser");
    });

    it("should not call beforeVisit when visiting individual nodes", () => {
      composer.addVisitor(visitor1);

      const typeNode = new TypeNode(
        "user-type",
        "User",
        GraphQLTypeKind.OBJECT,
        "type User { id: ID! }"
      );

      composer.visitNodes([typeNode]);

      expect(visitor1.visitOrder).not.toContain("beforeVisit");
      expect(visitor1.visitOrder).toContain("visitTypeNode-User");
    });
  });

  describe("getResults", () => {
    it("should return results from all visitors", () => {
      composer.addVisitor(visitor1);
      composer.addVisitor(visitor2);

      const mockGraph = new SchemaGraph();
      const typeNode = new TypeNode(
        "user-type",
        "User",
        GraphQLTypeKind.OBJECT,
        "type User { id: ID! }"
      );

      mockGraph.addNode(typeNode);
      composer.visitGraph(mockGraph);

      const results = composer.getResults();

      expect(results).toHaveProperty("visitor-0");
      expect(results).toHaveProperty("visitor-1");
      expect(results["visitor-0"].visited).toContain("User");
      expect(results["visitor-1"].visited).toContain("User");
    });
  });

  describe("getVisitors", () => {
    it("should return a copy of the visitors array", () => {
      composer.addVisitor(visitor1);

      const visitors = composer.getVisitors();
      expect(visitors).toEqual([visitor1]);

      // Modifying the returned array shouldn't affect the composer
      visitors.pop();
      expect(composer.getVisitors().length).toBe(1);
    });
  });

  describe("error handling", () => {
    it("should handle visitors that throw errors gracefully", () => {
      const errorVisitor = new class extends GraphVisitor {
        visitTypeNode(node: TypeNode): void {
          throw new Error("Visitor error");
        }
        getResults(): any { return {}; }
      }();

      composer.addVisitor(errorVisitor);
      composer.addVisitor(visitor1);

      const typeNode = new TypeNode(
        "user-type",
        "User",
        GraphQLTypeKind.OBJECT,
        "type User { id: ID! }"
      );

      expect(() => composer.visitNodes([typeNode])).toThrow("Visitor error");
    });
  });
});