import {
	Controller,
	Delete,
	Get,
	Param,
	Query,
	Res,
	UseGuards,
} from '@nestjs/common';
import {
	ClientServiceApiKeyGuard,
	ClientServiceAuthContext,
	ClientServiceContext,
} from '@file/database';
import { Response } from 'express';
import { ImageParamDto, ImageQueryDto } from '@file/image-contracts';
import { ImageService } from './image.service';

@Controller('image')
@UseGuards(ClientServiceApiKeyGuard)
export class ImageController {
	constructor(private readonly imageService: ImageService) {}

	@Get(':path/:name')
	async getImage(
		@Param() imageParams: ImageParamDto,
		@Query() imageQuery: ImageQueryDto,
		@ClientServiceContext() clientServiceContext: ClientServiceAuthContext,
		@Res() res: Response,
	) {
		const result = await this.imageService.getCacheImage(
			{
				...imageParams,
				...imageQuery,
			},
			clientServiceContext,
		);
		res.set('Content-Type', result.contentType);

		res.send(result.imageBuffer);
	}

	@Delete(':path/:name/cache')
	deleteImageCache(@Param() imageParams: ImageParamDto) {
		return this.imageService.deleteCacheImage(imageParams);
	}
}
