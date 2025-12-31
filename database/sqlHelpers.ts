export function inList<T>(values: T[], paramIndex: number): { sql: string, params: any[], newParamIndex: number } {
  if (values.length === 0) return { sql: '()', params: [], newParamIndex: paramIndex };
  
  // Filter out empty strings to prevent PostgreSQL UUID parsing errors
  const filteredValues = values.filter(v => {
    if (v === '' || (typeof v === 'string' && v.trim() === '')) {
      console.error(`[sqlHelpers.inList] Empty string value detected in array, filtering out`);
      return false;
    }
    return true;
  });
  
  if (filteredValues.length === 0) return { sql: '()', params: [], newParamIndex: paramIndex };
  
  const placeholders = Array.from({length: filteredValues.length}, (_, i) => `$${paramIndex + i}`).join(', ');
  return { sql: `(${placeholders})`, params: filteredValues, newParamIndex: paramIndex + filteredValues.length };
}