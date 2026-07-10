import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import {
	ClientServiceAction,
	ClientServiceAuthContext,
	ClientServiceAuthorizationService,
	InternalServiceAccess,
	InternalServiceGuard,
	ClientServiceContext,
} from '@file/database';
import { Response } from 'express';
import { lookup } from 'mime-types';
import { ImageService } from './image.service';
import {
	ImageParamDto,
	ImageQueryDto,
	normalizeSafeFileName,
	normalizeSafeRelativePath,
	toImageStoragePath,
} from '@file/image-contracts';

@Controller('image')
@UseGuards(InternalServiceGuard)
@InternalServiceAccess('resize', 'image.read')
export class ImageController {
	constructor(
		private readonly imageService: ImageService,
		private readonly authorization: ClientServiceAuthorizationService,
	) {}

	@Get(':path/:name')
	async getFile(
		@Param() imageParam: ImageParamDto,
		@Query() imageQuery: ImageQueryDto,
		@ClientServiceContext() clientServiceContext: ClientServiceAuthContext,
		@Res() res: Response,
	) {
		const path = normalizeSafeRelativePath(imageParam.path, 'image path');
		const name = normalizeSafeFileName(imageParam.name);
		await this.authorization.authorize({
			context: clientServiceContext,
			action: ClientServiceAction.Read,
			normalizedPath: toImageStoragePath(path),
			consumeRateLimit: false,
		});
		let result: { imageBuffer: Buffer; contentType: string };
		/** height, width 둘 중 하나라도 있다면 리사이징 진행 */
		if (imageQuery.height || imageQuery.width) {
			result = await this.imageService.resizeImage(
				{
					path,
					name,
					...imageQuery,
				},
				clientServiceContext,
			);
		} else {
			const fetchedImage = await this.imageService.getImageFromMain(
				{ path, name },
				clientServiceContext,
			);
			result = {
				imageBuffer: fetchedImage.imageBuffer,
				contentType:
					fetchedImage.contentType ||
					lookup(name) ||
					'application/octet-stream',
			};
		}
		res.set({
			'Content-Type': result.contentType,
		});

		res.send(result.imageBuffer);
	}
}
