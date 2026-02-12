import fp from 'fastify-plugin';
import fjwt from '@fastify/jwt';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getConfig } from '../config';

/**
 * JWT authentication plugin for Fastify.
 */
export default fp(async function jwtPlugin(fastify: FastifyInstance) {
    const config = getConfig();

    fastify.register(fjwt, {
        secret: config.JWT_SECRET,
        sign: {
            expiresIn: '24h',
        },
    });

    /**
     * Decorate fastify with an authenticate method usable as a preHandler.
     */
    fastify.decorate('authenticate', async function (request: FastifyRequest, reply: FastifyReply) {
        try {
            await request.jwtVerify();
        } catch (err) {
            reply.status(401).send({
                error: 'UNAUTHORIZED',
                message: 'Invalid or expired token',
            });
        }
    });

    /**
     * Decorate fastify with an authorizeAdmin method — only allows admin role.
     */
    fastify.decorate('authorizeAdmin', async function (request: FastifyRequest, reply: FastifyReply) {
        try {
            await request.jwtVerify();
            if ((request.user as any).role !== 'admin') {
                return reply.status(403).send({
                    error: 'FORBIDDEN',
                    message: 'Admin access required',
                });
            }
        } catch (err) {
            reply.status(401).send({
                error: 'UNAUTHORIZED',
                message: 'Invalid or expired token',
            });
        }
    });
});

// Extend Fastify types
declare module 'fastify' {
    interface FastifyInstance {
        authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
        authorizeAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    }
}

declare module '@fastify/jwt' {
    interface FastifyJWT {
        payload: {
            sub: string;
            role: string;
        };
        user: {
            sub: string;
            role: string;
        };
    }
}
