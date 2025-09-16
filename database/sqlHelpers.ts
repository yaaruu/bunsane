import { sql } from 'bun';

export function inList<T>(values: T[]): any {
  if (values.length === 0) return sql`()`;
  return sql`(${sql(values)})`;
}