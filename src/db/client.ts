import { PrismaClient } from '@prisma/client';
import { getLogger } from '../utils/logger';

const logger = getLogger().child({ module: 'database' });

let _prisma: PrismaClient | null = null;

export function getPrismaClient(): PrismaClient {
    if (!_prisma) {
        _prisma = new PrismaClient({
            log: [
                { level: 'error', emit: 'event' },
                { level: 'warn', emit: 'event' },
            ],
        });

        _prisma.$on('error' as never, (e: any) => {
            logger.error({ err: e }, 'Prisma error');
        });

        _prisma.$on('warn' as never, (e: any) => {
            logger.warn({ warning: e }, 'Prisma warning');
        });

        logger.info('Prisma client initialized');
    }
    return _prisma;
}

export async function disconnectPrisma(): Promise<void> {
    if (_prisma) {
        await _prisma.$disconnect();
        _prisma = null;
        logger.info('Prisma client disconnected');
    }
}
