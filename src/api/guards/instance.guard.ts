import { InstanceDto } from '@api/dto/instance.dto';
import { matchedRoute, ROUTE_CREATE_INSTANCE, ROUTE_FETCH_INSTANCES } from '@api/guards/auth.guard';
import { cache, prismaRepository, waMonitor } from '@api/server.module';
import { CacheConf, configService } from '@config/env.config';
import { BadRequestException, ForbiddenException, InternalServerErrorException, NotFoundException } from '@exceptions';
import { NextFunction, Request, Response } from 'express';

async function getInstance(instanceName: string) {
  try {
    const cacheConf = configService.get<CacheConf>('CACHE');

    const exists = !!waMonitor.waInstances[instanceName];

    if (cacheConf.REDIS.ENABLED && cacheConf.REDIS.SAVE_INSTANCES) {
      const keyExists = await cache.has(instanceName);

      return exists || keyExists;
    }

    return exists || (await prismaRepository.instance.findMany({ where: { name: instanceName } })).length > 0;
  } catch (error) {
    throw new InternalServerErrorException(error?.toString());
  }
}

export async function instanceExistsGuard(req: Request, _: Response, next: NextFunction) {
  const route = matchedRoute(req);
  if (route === ROUTE_CREATE_INSTANCE || route === ROUTE_FETCH_INSTANCES) {
    return next();
  }

  const param = req.params as unknown as InstanceDto;
  if (!param?.instanceName) {
    throw new BadRequestException('"instanceName" not provided.');
  }

  if (!(await getInstance(param.instanceName))) {
    throw new NotFoundException(`The "${param.instanceName}" instance does not exist`);
  }

  next();
}

export async function instanceLoggedGuard(req: Request, _: Response, next: NextFunction) {
  if (matchedRoute(req) === ROUTE_CREATE_INSTANCE) {
    const instance = req.body as InstanceDto;
    if (await getInstance(instance.instanceName)) {
      throw new ForbiddenException(`This name "${instance.instanceName}" is already in use.`);
    }

    if (waMonitor.waInstances[instance.instanceName]) {
      delete waMonitor.waInstances[instance.instanceName];
    }
  }

  next();
}
