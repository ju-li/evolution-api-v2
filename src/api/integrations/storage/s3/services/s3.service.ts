import { InstanceDto } from '@api/dto/instance.dto';
import { MediaDto } from '@api/integrations/storage/s3/dto/media.dto';
import { getObjectUrl } from '@api/integrations/storage/s3/libs/minio.server';
import { PrismaRepository } from '@api/repository/repository.service';
import { Logger } from '@config/logger.config';
import { BadRequestException } from '@exceptions';

export class S3Service {
  constructor(private readonly prismaRepository: PrismaRepository) {}

  private readonly logger = new Logger('S3Service');

  public async getMedia(instance: InstanceDto, query?: MediaDto) {
    try {
      // Resolve the instance id server-side: the route only provides instanceName, and an
      // undefined instanceId would make Prisma drop the tenant filter entirely.
      const instanceId = instance?.instanceName
        ? (
            await this.prismaRepository.instance.findUnique({
              where: { name: instance.instanceName },
              select: { id: true },
            })
          )?.id
        : undefined;

      if (!instanceId) {
        throw 'Instance not found';
      }

      // Only whitelisted filters from the caller; the tenant binding is set last.
      const where: any = {};
      if (query?.id) where.id = query.id;
      if (query?.type) where.type = query.type;
      if (query?.messageId) where.messageId = query.messageId;
      where.instanceId = instanceId;

      const media = await this.prismaRepository.media.findMany({
        where,
        select: {
          id: true,
          fileName: true,
          type: true,
          mimetype: true,
          createdAt: true,
          Message: true,
        },
      });

      if (!media || media.length === 0) {
        throw 'Media not found';
      }

      return media;
    } catch (error) {
      throw new BadRequestException(error);
    }
  }

  public async getMediaUrl(instance: InstanceDto, data: MediaDto) {
    const media = (await this.getMedia(instance, { id: data.id }))[0];
    const mediaUrl = await getObjectUrl(media.fileName, data.expiry);
    return {
      mediaUrl,
      ...media,
    };
  }
}
