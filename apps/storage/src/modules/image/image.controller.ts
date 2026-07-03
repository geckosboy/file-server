import {
	Body,
	Controller,
	Delete,
	Get,
	HttpStatus,
	MaxFileSizeValidator,
	Param,
	ParseFilePipe,
	Post,
	Query,
	Res,
	UploadedFile,
	UseGuards,
	UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { File } from '@file/global';
import {
	ClientServiceApiKeyGuard,
	ClientServiceAuthContext,
	ClientServiceContext,
} from '@file/database';
import { Response } from 'express';
import { lookup } from 'mime-types';
import { ImageService } from './image.service';
import imageMulterOptions from './storages/diskStorage';
import {
	DeleteImageDto,
	GetImageDto,
	UploadImageDto,
} from '@file/image-contracts';

@Controller('image')
@UseGuards(ClientServiceApiKeyGuard)
export class ImageController {
	constructor(private readonly imageService: ImageService) {}

	@Get(':path/:name')
	async getFile(
		@Param() imageDto: GetImageDto,
		@ClientServiceContext() clientServiceContext: ClientServiceAuthContext,
		@Res() res: Response,
	) {
		const { image, name } = await this.imageService.getImage(
			imageDto,
			clientServiceContext,
		);
		res.set({
			'Content-Type': lookup(name) || 'application/octet-stream',
		});

		res.send(image);
	}

	@Post()
	@UseInterceptors(FileInterceptor('file', imageMulterOptions))
	async uploadFile(
		@Res()
		res: Response,
		@ClientServiceContext() clientServiceContext: ClientServiceAuthContext,
		@Body() imageDto: UploadImageDto,
		@UploadedFile(
			new ParseFilePipe({
				validators: [
					new MaxFileSizeValidator({ maxSize: File.FileMaximumSize.Image }),
				],
			}),
		)
		file: Express.Multer.File,
	) {
		await this.imageService.uploadFile({
			file,
			apiInfo: { ...imageDto },
			clientServiceContext,
		});

		res.sendStatus(HttpStatus.CREATED);
	}

	@Delete()
	async deleteFile(
		@Res()
		res: Response,
		@ClientServiceContext() clientServiceContext: ClientServiceAuthContext,
		@Query() imageDto: DeleteImageDto,
	) {
		await this.imageService.deleteImage({
			name: imageDto.beforeName,
			path: imageDto.path,
			clientServiceContext,
		});

		res.sendStatus(HttpStatus.OK);
	}
}
