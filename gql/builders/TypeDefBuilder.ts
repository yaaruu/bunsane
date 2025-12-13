import { logger } from "../../core/Logger";

export interface OperationField {
  name: string;
  fieldDef: string;
}

export class TypeDefBuilder {
  private queryFields: string[] = [];
  private mutationFields: string[] = [];
  private subscriptionFields: string[] = [];

  /**
   * Add a query field
   */
  addQueryField(field: OperationField): void {
    this.queryFields.push(field.fieldDef);
    logger.trace(`Added query field: ${field.fieldDef}`);
  }

  /**
   * Add a mutation field
   */
  addMutationField(field: OperationField): void {
    this.mutationFields.push(field.fieldDef);
    logger.trace(`Added mutation field: ${field.fieldDef}`);
  }

  /**
   * Add a subscription field
   */
  addSubscriptionField(field: OperationField): void {
    this.subscriptionFields.push(field.fieldDef);
    logger.trace(`Added subscription field: ${field.fieldDef}`);
  }

  /**
   * Build the Query type definition
   */
  buildQueryType(): string {
    if (this.queryFields.length === 0) {
      return '';
    }

    const sortedFields = this.queryFields.sort();
    return `type Query {\n${sortedFields.map(f => `  ${f}`).join('\n')}\n}\n`;
  }

  /**
   * Build the Mutation type definition
   */
  buildMutationType(): string {
    if (this.mutationFields.length === 0) {
      return '';
    }

    const sortedFields = this.mutationFields.sort();
    return `type Mutation {\n${sortedFields.map(f => `  ${f}`).join('\n')}\n}\n`;
  }

  /**
   * Build the Subscription type definition
   */
  buildSubscriptionType(): string {
    if (this.subscriptionFields.length === 0) {
      return '';
    }

    const sortedFields = this.subscriptionFields.sort();
    return `type Subscription {\n${sortedFields.map(f => `  ${f}`).join('\n')}\n}\n`;
  }

  /**
   * Build all operation types
   */
  buildAllOperationTypes(): string {
    let typeDefs = '';

    typeDefs += this.buildQueryType();
    typeDefs += this.buildMutationType();
    typeDefs += this.buildSubscriptionType();

    return typeDefs;
  }

  /**
   * Clear all fields (for reuse)
   */
  clear(): void {
    this.queryFields = [];
    this.mutationFields = [];
    this.subscriptionFields = [];
  }

  /**
   * Get statistics
   */
  getStats(): { queries: number; mutations: number; subscriptions: number } {
    return {
      queries: this.queryFields.length,
      mutations: this.mutationFields.length,
      subscriptions: this.subscriptionFields.length
    };
  }
}