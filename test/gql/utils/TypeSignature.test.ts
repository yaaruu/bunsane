import { describe, it, expect, beforeEach } from 'bun:test';
import { z } from 'zod';
import { 
    generateZodStructuralSignature, 
    normalizeSignature, 
    areStructurallyEquivalent 
} from '../../../gql/utils/TypeSignature';

describe('TypeSignature', () => {
    describe('generateZodStructuralSignature', () => {
        describe('primitive types', () => {
            it('should generate signature for string', () => {
                const schema = z.string();
                expect(generateZodStructuralSignature(schema)).toBe('string');
            });

            it('should generate signature for number', () => {
                const schema = z.number();
                expect(generateZodStructuralSignature(schema)).toBe('number');
            });

            it('should generate signature for boolean', () => {
                const schema = z.boolean();
                expect(generateZodStructuralSignature(schema)).toBe('boolean');
            });

            it('should generate signature for date', () => {
                const schema = z.date();
                expect(generateZodStructuralSignature(schema)).toBe('date');
            });
        });

        describe('object types', () => {
            it('should generate signature for simple object', () => {
                const schema = z.object({
                    name: z.string(),
                    age: z.number(),
                });
                const signature = generateZodStructuralSignature(schema);
                expect(signature).toBe('object:{age:number,name:string}');
            });

            it('should generate consistent signature regardless of field order', () => {
                const schema1 = z.object({
                    name: z.string(),
                    age: z.number(),
                });
                const schema2 = z.object({
                    age: z.number(),
                    name: z.string(),
                });
                expect(generateZodStructuralSignature(schema1)).toBe(generateZodStructuralSignature(schema2));
            });

            it('should exclude __typename from signature', () => {
                const schema1 = z.object({
                    latitude: z.number(),
                    longitude: z.number(),
                });
                const schema2 = z.object({
                    __typename: z.literal('ST_Point').nullish(),
                    latitude: z.number(),
                    longitude: z.number(),
                });
                expect(generateZodStructuralSignature(schema1)).toBe(generateZodStructuralSignature(schema2));
            });

            it('should generate signature for nested objects', () => {
                const schema = z.object({
                    location: z.object({
                        lat: z.number(),
                        lng: z.number(),
                    }),
                });
                const signature = generateZodStructuralSignature(schema);
                expect(signature).toBe('object:{location:object:{lat:number,lng:number}}');
            });
        });

        describe('wrapper types', () => {
            it('should generate signature for optional', () => {
                const schema = z.string().optional();
                expect(generateZodStructuralSignature(schema)).toBe('optional:string');
            });

            it('should generate signature for nullable', () => {
                const schema = z.string().nullable();
                expect(generateZodStructuralSignature(schema)).toBe('nullable:string');
            });

            it('should generate signature for default', () => {
                const schema = z.string().default('test');
                expect(generateZodStructuralSignature(schema)).toBe('default:string');
            });
        });

        describe('array types', () => {
            it('should generate signature for array of primitives', () => {
                const schema = z.array(z.string());
                expect(generateZodStructuralSignature(schema)).toBe('array:string');
            });

            it('should generate signature for array of objects', () => {
                const schema = z.array(z.object({
                    id: z.string(),
                }));
                expect(generateZodStructuralSignature(schema)).toBe('array:object:{id:string}');
            });
        });

        describe('union types', () => {
            it('should generate signature for union', () => {
                const schema = z.union([z.string(), z.number()]);
                const signature = generateZodStructuralSignature(schema);
                // Union options should be sorted
                expect(signature).toBe('union:(number|string)');
            });
        });

        describe('literal types', () => {
            it('should generate signature for string literal', () => {
                const schema = z.literal('test');
                expect(generateZodStructuralSignature(schema)).toBe('literal:"test"');
            });

            it('should generate signature for number literal', () => {
                const schema = z.literal(42);
                expect(generateZodStructuralSignature(schema)).toBe('literal:42');
            });
        });

        describe('ST_Point-like structures', () => {
            it('should generate same signature for structurally equivalent coordinate schemas', () => {
                // This is the core use case - pickup_coordinates and dropoff_coordinates
                // should have the same signature as ST_PointInput
                const stPointSchema = z.object({
                    latitude: z.number(),
                    longitude: z.number(),
                });

                const pickupCoordinatesSchema = z.object({
                    latitude: z.number(),
                    longitude: z.number(),
                });

                const dropoffCoordinatesSchema = z.object({
                    longitude: z.number(),  // Different order
                    latitude: z.number(),
                });

                const sig1 = generateZodStructuralSignature(stPointSchema);
                const sig2 = generateZodStructuralSignature(pickupCoordinatesSchema);
                const sig3 = generateZodStructuralSignature(dropoffCoordinatesSchema);

                expect(sig1).toBe(sig2);
                expect(sig1).toBe(sig3);
            });

            it('should generate different signature when fields differ', () => {
                const stPointSchema = z.object({
                    latitude: z.number(),
                    longitude: z.number(),
                });

                const differentSchema = z.object({
                    lat: z.number(),  // Different field name
                    lng: z.number(),
                });

                expect(generateZodStructuralSignature(stPointSchema))
                    .not.toBe(generateZodStructuralSignature(differentSchema));
            });
        });
    });

    describe('areStructurallyEquivalent', () => {
        it('should return true for equivalent schemas', () => {
            const schema1 = z.object({ a: z.string(), b: z.number() });
            const schema2 = z.object({ b: z.number(), a: z.string() });
            expect(areStructurallyEquivalent(schema1, schema2)).toBe(true);
        });

        it('should return false for different schemas', () => {
            const schema1 = z.object({ a: z.string() });
            const schema2 = z.object({ a: z.number() });
            expect(areStructurallyEquivalent(schema1, schema2)).toBe(false);
        });
    });

    describe('normalizeSignature', () => {
        it('should return signature as-is', () => {
            const signature = 'object:{a:string,b:number}';
            expect(normalizeSignature(signature)).toBe(signature);
        });
    });
});
