import {
	Controller,
	Delete,
	Get,
	Param,
	Query,
	Res,
	UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { ImageParamDto, ImageQueryDto } from '@file/image-contracts';
import { ImageService } from './image.service';
import { InternalApiKeyGuard } from './internal-api-key.guard';

@Controller('image')
export class ImageController {
	constructor(private readonly imageService: ImageService) {}

	@Get(':path/:name')
	async getImage(
		@Param() imageParams: ImageParamDto,
		@Query() imageQuery: ImageQueryDto,
		@Res() res: Response,
	) {
		const result = await this.imageService.getCacheImage({
			...imageParams,
			...imageQuery,
		});
		res.set('Content-Type', result.contentType);

		res.send(result.imageBuffer);
	}

	@Delete(':path/:name/cache')
	@UseGuards(InternalApiKeyGuard)
	deleteImageCache(@Param() imageParams: ImageParamDto) {
		return this.imageService.deleteCacheImage(imageParams);
	}
}
