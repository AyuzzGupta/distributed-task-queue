import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { getConfig } from '../../config';

const LoginSchema = z.object({
    username: z.string().min(1).max(50),
    password: z.string().min(1),
    role: z.enum(['admin', 'employee']),
});

// Pre-hash passwords at startup for fast comparison
let adminHash: string;
let employeeHash: string;
let initialized = false;

async function initHashes() {
    if (initialized) return;
    const config = getConfig();
    adminHash = await bcrypt.hash(config.ADMIN_PASSWORD, 10);
    employeeHash = await bcrypt.hash(config.EMPLOYEE_PASSWORD, 10);
    initialized = true;
}

/**
 * Authentication route — password-based login.
 * Validates username + password against role-specific passwords from env vars.
 */
export default async function authRoutes(fastify: FastifyInstance): Promise<void> {
    await initHashes();

    fastify.post('/auth/login', async (request, reply) => {
        const body = LoginSchema.parse(request.body || {});

        // Validate password based on role
        const expectedHash = body.role === 'admin' ? adminHash : employeeHash;
        const valid = await bcrypt.compare(body.password, expectedHash);

        if (!valid) {
            return reply.status(401).send({
                error: 'UNAUTHORIZED',
                message: 'Invalid credentials',
            });
        }

        const token = fastify.jwt.sign({
            sub: body.username,
            role: body.role,
        });

        return reply.send({ token, user: { name: body.username, role: body.role } });
    });
}
