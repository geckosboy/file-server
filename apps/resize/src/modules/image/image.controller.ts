import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import {
	ClientServiceApiKeyGuard,
	ClientServiceAuthContext,
	ClientServiceContext,
} from '@file/database';
import { Response } from 'express';
import { lookup } from 'mime-types';
import { ImageService } from './image.service';
import { ImageParamDto, ImageQueryDto } from '@file/image-contracts';

@Controller('image')
@UseGuards(ClientServiceApiKeyGuard)
export class ImageController {
	constructor(private readonly imageService: ImageService) {}

	@Get(':path/:name')
	async getFile(
		@Param() imageParam: ImageParamDto,
		@Query() imageQuery: ImageQueryDto,
		@ClientServiceContext() clientServiceContext: ClientServiceAuthContext,
		@Res() res: Response,
	) {
		let result: { imageBuffer: Buffer; contentType: string };
		/** height, width 둘 중 하나라도 있다면 리사이징 진행 */
		if (imageQuery.height || imageQuery.width) {
			result = await this.imageService.resizeImage(
				{
					...imageParam,
					...imageQuery,
				},
				clientServiceContext,
			);
		} else {
			const fetchedImage = await this.imageService.getImageFromMain(
				{ ...imageParam },
				clientServiceContext,
			);
			result = {
				imageBuffer: fetchedImage.imageBuffer,
				contentType:
					fetchedImage.contentType ||
					lookup(imageParam.name) ||
					'application/octet-stream',
			};
		}
		res.set({
			'Content-Type': result.contentType,
		});

		res.send(result.imageBuffer);
	}
}
