import { InstanceDto } from '@api/dto/instance.dto';
import { prismaRepository } from '@api/server.module';
import { Auth, configService, Database } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { ForbiddenException, UnauthorizedException } from '@exceptions';
import { NextFunction, Request, Response } from 'express';

const logger = new Logger('GUARD');

/**
 * Identifies the route a request actually matched as "METHOD /mount/path".
 * Uses the Express route definition (req.route.path) when the guard runs as
 * route-level middleware, falling back to req.path (never includes the query
 * string). Express matches paths case-insensitively and ignores a trailing
 * slash, so normalise the same way.
 */
export function matchedRoute(req: Request): string {
  const path = `${req.baseUrl || ''}${typeof req.route?.path === 'string' ? req.route.path : req.path}`;
  return `${req.method} ${path.replace(/\/+$/, '').toLowerCase()}`;
}

export const ROUTE_CREATE_INSTANCE = 'POST /instance/create';
export const ROUTE_FETCH_INSTANCES = 'GET /instance/fetchinstances';
const GLOBAL_KEY_ONLY_ROUTES = [ROUTE_CREATE_INSTANCE, 'POST /verify-creds'];

async function apikey(req: Request, _: Response, next: NextFunction) {
  const env = configService.get<Auth>('AUTHENTICATION').API_KEY;
  const key = req.get('apikey');
  const db = configService.get<Database>('DATABASE');

  if (!key) {
    throw new UnauthorizedException();
  }

  if (env.KEY === key) {
    return next();
  }

  const route = matchedRoute(req);

  if (GLOBAL_KEY_ONLY_ROUTES.includes(route)) {
    throw new ForbiddenException('Missing global api key', 'The global api key must be set');
  }
  const param = req.params as unknown as InstanceDto;

  try {
    if (param?.instanceName) {
      const instance = await prismaRepository.instance.findUnique({
        where: { name: param.instanceName },
      });
      if (instance.token === key) {
        return next();
      }
    } else {
      if (route === ROUTE_FETCH_INSTANCES && db.SAVE_DATA.INSTANCE) {
        const instanceByKey = await prismaRepository.instance.findFirst({
          where: { token: key },
        });
        if (instanceByKey) {
          return next();
        }
      }
    }
  } catch (error) {
    logger.error(error);
  }

  throw new UnauthorizedException();
}

export const authGuard = { apikey };
