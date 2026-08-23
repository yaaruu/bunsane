/**
 * SEC-08: error verbosity fails closed.
 *
 * The old gates were split: gql masked only when NODE_ENV === 'production'
 * (unset/staging leaked stacks), ResolverBuilder exposed originalError when
 * !== 'production' (wider than everything else). All verbose decisions now
 * flow through isVerboseErrors() — only exact 'development' is verbose.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { GraphQLError } from 'graphql';
import { maskError } from '../../../gql/index';
import { isVerboseErrors } from '../../../core/envMode';
import { ResolverBuilder } from '../../../gql/builders/ResolverBuilder';

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
});

function rawError(): GraphQLError {
    return new GraphQLError('SELECT * FROM secret_table failed: relation does not exist', {
        extensions: { code: 'INTERNAL', internalDetail: 'pg_stack_frame' },
        originalError: new Error('deep pg internals'),
    });
}

describe('isVerboseErrors matrix', () => {
    const cases: Array<[string | undefined, boolean]> = [
        ['development', true],
        ['production', false],
        ['test', false],
        ['staging', false],
        ['Development', false], // case-sensitive on purpose
        [undefined, false],
        ['', false],
    ];

    for (const [env, expected] of cases) {
        test(`NODE_ENV=${JSON.stringify(env)} → ${expected}`, () => {
            if (env === undefined) delete process.env.NODE_ENV;
            else process.env.NODE_ENV = env;
            expect(isVerboseErrors()).toBe(expected);
        });
    }
});

describe('maskError fail-closed matrix', () => {
    const leakyEnvs = ['production', 'staging', 'test', undefined, ''];

    for (const env of leakyEnvs) {
        test(`NODE_ENV=${JSON.stringify(env)} masks internals`, () => {
            if (env === undefined) delete process.env.NODE_ENV;
            else process.env.NODE_ENV = env;

            const masked = maskError(rawError(), rawError().message);
            expect(masked.message).toBe('Internal server error');
            const json = JSON.stringify(masked);
            expect(json).not.toContain('secret_table');
            expect(json).not.toContain('pg_stack_frame');
        });
    }

    test('NODE_ENV=development keeps the original message', () => {
        process.env.NODE_ENV = 'development';
        const masked = maskError(rawError(), rawError().message);
        // Known application codes pass through; this one carries an unknown
        // code, so in verbose mode the original GraphQLError survives intact.
        expect(masked.message).toContain('secret_table');
    });

    test('known application codes pass through in ALL environments', () => {
        delete process.env.NODE_ENV;
        const friendly = new GraphQLError('Not yours', {
            extensions: { code: 'FORBIDDEN' },
        });
        const masked = maskError(friendly, friendly.message);
        expect(masked.message).toBe('Not yours');
        expect((masked.extensions as any).code).toBe('FORBIDDEN');
    });

    test('a thrown non-Error cannot crash the masker', () => {
        delete process.env.NODE_ENV;
        const masked = maskError({ noMessageHere: true }, 'fallback');
        expect(masked.message).toBe('Internal server error');
    });
});

describe('ResolverBuilder verbosity gate', () => {
    function makeResolver(rb: ResolverBuilder): Function {
        rb.addResolver({
            name: 'boom',
            type: 'Mutation',
            service: { boom: async () => { throw new Error('sql: relation "x" missing'); } },
            propertyKey: 'boom',
            hasInput: false,
        });
        return rb.getResolvers().Mutation!['boom']!;
    }

    test('NODE_ENV unset → originalError NOT attached (fail closed)', async () => {
        delete process.env.NODE_ENV;
        const resolver = makeResolver(new ResolverBuilder());
        const err = await resolver(null, {}, {}, {}).catch((e: any) => e);
        expect(err?.extensions?.originalError).toBeUndefined();
    });

    test('NODE_ENV=staging → originalError NOT attached', async () => {
        process.env.NODE_ENV = 'staging';
        const resolver = makeResolver(new ResolverBuilder());
        const err = await resolver(null, {}, {}, {}).catch((e: any) => e);
        expect(err?.extensions?.originalError).toBeUndefined();
    });

    test('NODE_ENV=development → originalError attached', async () => {
        process.env.NODE_ENV = 'development';
        const resolver = makeResolver(new ResolverBuilder());
        const err = await resolver(null, {}, {}, {}).catch((e: any) => e);
        expect(err?.extensions?.originalError).toBeDefined();
        expect(String(err.extensions.originalError.message)).toContain('relation "x"');
    });
});
