import { logger } from "./Logger";
export function log(target: any, propertyKey: string, descriptor: PropertyDescriptor) {
  const originalMethod = descriptor.value;

  descriptor.value = function(...args: any[]) {
    console.log(`Calling ${propertyKey} with:`, args);
    return originalMethod.apply(this, args);
  };
}

export function timed(hint?: string) {
  return function(target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;

    descriptor.value = async function(...args: any[]) {
      if(process.env.NODE_ENV !== 'production') {
        const start = performance.now();
        const result = await originalMethod.apply(this, args);
        const end = performance.now();
        logger.trace(`Execution time for ${propertyKey}${hint ? ` (${hint})` : ''}: ${end - start} ms`);
        return result;
      } else {
        return await originalMethod.apply(this, args);
      }
    };
  };
}