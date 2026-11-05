import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { ImageAssetMetadataRepository } from './image-asset-metadata.repository';

@Global()
@Module({
	providers: [PrismaService, ImageAssetMetadataRepository],
	exports: [PrismaService, ImageAssetMetadataRepository],
})
export class PrismaModule {}
