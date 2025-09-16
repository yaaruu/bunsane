import { sql } from 'bun';

export function inList<T>(values: T[], paramIndex: number): { sql: string, params: any[], newParamIndex: number } {
  if (values.length === 0) return { sql: '()', params: [], newParamIndex: paramIndex };
  const placeholders = Array.from({length: values.length}, (_, i) => `$${paramIndex + i}`).join(', ');
  return { sql: `(${placeholders})`, params: values, newParamIndex: paramIndex + values.length };
}