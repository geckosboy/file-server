import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { ImageParamDto, ImageQueryDto } from '@file/image-contracts';
import { ImageService } from './image.service';

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
}
