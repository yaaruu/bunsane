import { logger } from "../../core/Logger";

export interface InputTypeDefinition {
  name: string;
  fields: string[];
}

export class InputTypeBuilder {
  private inputTypes: Map<string, string[]> = new Map();
  private deduplicationMap: Map<string, string> = new Map();

  /**
   * Add an input type definition
   */
  addInputType(typeDef: InputTypeDefinition): void {
    const existing = this.inputTypes.get(typeDef.name);
    if (existing) {
      // Merge fields if type already exists
      const mergedFields = [...new Set([...existing, ...typeDef.fields])];
      this.inputTypes.set(typeDef.name, mergedFields);
      logger.trace(`Merged input type: ${typeDef.name} with ${mergedFields.length} fields`);
    } else {
      this.inputTypes.set(typeDef.name, [...typeDef.fields]);
      logger.trace(`Added input type: ${typeDef.name} with ${typeDef.fields.length} fields`);
    }
  }

  /**
   * Get or create a deduplicated input type name
   */
  getDeduplicatedName(originalName: string): string {
    // Check if name conflicts with existing types
    let deduplicatedName = originalName;
    let counter = 1;

    // Keep incrementing counter until we find a name that doesn't conflict
    // with existing input types OR previously returned deduplicated names
    while (this.inputTypes.has(deduplicatedName) || this.deduplicationMap.has(deduplicatedName)) {
      deduplicatedName = `${originalName}${counter}`;
      counter++;
    }

    // Mark this name as used
    this.deduplicationMap.set(deduplicatedName, true);
    return deduplicatedName;
  }

  /**
   * Build all input type definitions
   */
  buildInputTypes(): string {
    if (this.inputTypes.size === 0) {
      return '';
    }

    const typeDefs: string[] = [];

    for (const [typeName, fields] of this.inputTypes.entries()) {
      const sortedFields = fields.sort();
      const typeDef = `input ${typeName} {\n${sortedFields.map(f => `  ${f}`).join('\n')}\n}\n`;
      typeDefs.push(typeDef);
    }

    return typeDefs.join('\n');
  }

  /**
   * Check if an input type exists
   */
  hasInputType(name: string): boolean {
    return this.inputTypes.has(name);
  }

  /**
   * Get all input type names
   */
  getInputTypeNames(): string[] {
    return Array.from(this.inputTypes.keys());
  }

  /**
   * Clear all input types (for reuse)
   */
  clear(): void {
    this.inputTypes.clear();
    this.deduplicationMap.clear();
  }

  /**
   * Get statistics
   */
  getStats(): { totalTypes: number; totalFields: number } {
    const totalFields = Array.from(this.inputTypes.values()).reduce((sum, fields) => sum + fields.length, 0);
    return {
      totalTypes: this.inputTypes.size,
      totalFields
    };
  }
}