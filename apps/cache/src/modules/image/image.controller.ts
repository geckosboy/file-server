import {
	Controller,
	Delete,
	Get,
	Param,
	Query,
	Req,
	Res,
	UseGuards,
} from '@nestjs/common';
import {
	ClientServiceAction,
	ClientServiceApiKeyGuard,
	ClientServiceAuthContext,
	ClientServiceAuthenticatedRequest,
	ClientServiceAuthorizationService,
	ClientServiceContext,
	InternalServiceAccess,
	InternalServiceGuard,
	getInternalServiceAccess,
} from '@file/database';
import { Response } from 'express';
import {
	ImageParamDto,
	ImageQueryDto,
	normalizeSafeFileName,
	normalizeSafeRelativePath,
	toImageStoragePath,
} from '@file/image-contracts';
import { ImageService } from './image.service';

@Controller('image')
export class ImageController {
	constructor(
		private readonly imageService: ImageService,
		private readonly authorization: ClientServiceAuthorizationService,
	) {}

	@Get(':path/:name')
	@UseGuards(ClientServiceApiKeyGuard)
	async getImage(
		@Param() imageParams: ImageParamDto,
		@Query() imageQuery: ImageQueryDto,
		@ClientServiceContext() clientServiceContext: ClientServiceAuthContext,
		@Res() res: Response,
	) {
		const path = normalizeSafeRelativePath(imageParams.path, 'image path');
		const name = normalizeSafeFileName(imageParams.name);
		await this.authorization.authorize({
			context: clientServiceContext,
			action: ClientServiceAction.Read,
			normalizedPath: toImageStoragePath(path),
			consumeRateLimit: true,
		});
		const result = await this.imageService.getCacheImage(
			{
				path,
				name,
				...imageQuery,
			},
			clientServiceContext,
		);
		res.set('Content-Type', result.contentType);

		res.send(result.imageBuffer);
	}

	@Delete(':path/:name/cache')
	@UseGuards(InternalServiceGuard)
	@InternalServiceAccess('cache', ['image.upload', 'image.delete'])
	async deleteImageCache(
		@Param() imageParams: ImageParamDto,
		@ClientServiceContext() clientServiceContext: ClientServiceAuthContext,
		@Req() request: ClientServiceAuthenticatedRequest,
	) {
		const path = normalizeSafeRelativePath(imageParams.path, 'image path');
		const name = normalizeSafeFileName(imageParams.name);
		const internalAccess = getInternalServiceAccess(request);
		const action =
			internalAccess?.action === 'image.upload'
				? ClientServiceAction.Upload
				: ClientServiceAction.Delete;
		await this.authorization.authorize({
			context: clientServiceContext,
			action,
			normalizedPath: toImageStoragePath(path),
			consumeRateLimit: false,
		});
		return this.imageService.deleteCacheImage({
			clientServiceId: clientServiceContext.clientServiceId,
			path,
			name,
		});
	}
}
