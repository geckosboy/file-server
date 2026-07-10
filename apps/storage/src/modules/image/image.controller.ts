import {
	BadRequestException,
	Body,
	Controller,
	Delete,
	Get,
	HttpStatus,
	Param,
	ParseFilePipe,
	Post,
	Query,
	Res,
	UploadedFile,
	UseGuards,
	UseInterceptors,
} from '@nestjs/common';
import {
	ClientServiceAction,
	ClientServiceApiKeyGuard,
	ClientServiceAuthContext,
	ClientServiceAuthorizationService,
	ClientServiceContext,
	InternalServiceAccess,
	InternalServiceGuard,
} from '@file/database';
import { Response } from 'express';
import { lookup } from 'mime-types';
import { ImageService } from './image.service';
import {
	DeleteImageDto,
	GetImageDto,
	ImageQueryDto,
	UploadImageDto,
	normalizeImageStoragePath,
	normalizeSafeFileName,
	normalizeSafeRelativePath,
	splitAndNormalizeImageKey,
	toImageStoragePath,
} from '@file/image-contracts';
import { PolicyAwareImageUploadInterceptor } from './policy-aware-image-upload.interceptor';

@Controller('image')
export class ImageController {
	constructor(
		private readonly imageService: ImageService,
		private readonly authorization: ClientServiceAuthorizationService,
	) {}

	@Get(':path/:name')
	@UseGuards(InternalServiceGuard)
	@InternalServiceAccess('storage', 'image.read')
	async getFile(
		@Param() imageDto: GetImageDto,
		@Query() imageQuery: ImageQueryDto,
		@ClientServiceContext() clientServiceContext: ClientServiceAuthContext,
		@Res() res: Response,
	) {
		const path = normalizeSafeRelativePath(imageDto.path, 'image path');
		const normalizedName = normalizeSafeFileName(imageDto.name);
		await this.authorization.authorize({
			context: clientServiceContext,
			action: ClientServiceAction.Read,
			normalizedPath: toImageStoragePath(path),
			consumeRateLimit: false,
		});
		const { image, name, preGeneratedVariant } =
			await this.imageService.getImage(
				{
					path,
					name: normalizedName,
					...imageQuery,
				},
				clientServiceContext,
			);
		res.set({
			'Content-Type': lookup(name) || 'application/octet-stream',
		});
		if (preGeneratedVariant) {
			res.set({
				'x-file-server-pregenerated-variant': 'true',
				'x-file-server-variant-format': preGeneratedVariant.format,
				'x-file-server-variant-name': name,
			});
		}

		res.send(image);
	}

	@Post()
	@UseGuards(ClientServiceApiKeyGuard)
	@UseInterceptors(PolicyAwareImageUploadInterceptor)
	async uploadFile(
		@Res()
		res: Response,
		@ClientServiceContext() clientServiceContext: ClientServiceAuthContext,
		@Body() imageDto: UploadImageDto,
		@UploadedFile(new ParseFilePipe()) file: Express.Multer.File,
	) {
		const result = await this.imageService.uploadFile({
			file,
			apiInfo: { ...imageDto },
			clientServiceContext,
		});

		res.status(HttpStatus.CREATED).json(result);
	}

	@Delete()
	@UseGuards(ClientServiceApiKeyGuard)
	async deleteFile(
		@Res()
		res: Response,
		@ClientServiceContext() clientServiceContext: ClientServiceAuthContext,
		@Query() imageDto: DeleteImageDto,
	) {
		const target = resolveDeleteImageTarget(imageDto);
		await this.authorization.authorize({
			context: clientServiceContext,
			action: ClientServiceAction.Delete,
			normalizedPath: target.path,
			consumeRateLimit: true,
		});
		await this.imageService.deleteImage({
			name: target.name,
			path: target.path,
			clientServiceContext,
		});

		res.sendStatus(HttpStatus.OK);
	}
}

function resolveDeleteImageTarget(imageDto: DeleteImageDto) {
	if (imageDto.imageKey) {
		return splitAndNormalizeImageKey(imageDto.imageKey);
	}

	if (!imageDto.path || !imageDto.name) {
		throw new BadRequestException('path/name 또는 imageKey가 필요합니다.');
	}

	return {
		path: normalizeImageStoragePath(imageDto.path),
		name: normalizeSafeFileName(imageDto.name),
	};
}
