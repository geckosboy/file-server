import {
	Body,
	Controller,
	Delete,
	FileTypeValidator,
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
import { Response } from 'express';
import { lookup } from 'mime-types';
import { ImageService } from './image.service';
import imageMulterOptions from './storages/diskStorage';
import { InternalApiKeyGuard } from './internal-api-key.guard';
import { DeleteImageDto, GetImageDto, UploadImageDto } from 'src/dto/image.dto';

@Controller('image')
export class ImageController {
	constructor(private readonly imageService: ImageService) {}

	@Get(':path/:name')
	async getFile(@Param() imageDto: GetImageDto, @Res() res: Response) {
		const { image, name } = await this.imageService.getImage(imageDto);
		res.set({
			'Content-Type': lookup(name) || 'application/octet-stream',
		});

		res.send(image);
	}

	@Post()
	@UseGuards(InternalApiKeyGuard)
	@UseInterceptors(FileInterceptor('file', imageMulterOptions))
	async uploadFile(
		@Res()
		res: Response,
		@Body() imageDto: UploadImageDto,
		@UploadedFile(
			new ParseFilePipe({
				validators: [
					new MaxFileSizeValidator({ maxSize: File.FileMaximumSize.Image }),
					new FileTypeValidator({
						fileType: `${File.ImageFileMimeList.join('|')}`,
					}),
				],
			}),
		)
		file: Express.Multer.File,
	) {
		await this.imageService.uploadFile({ file, apiInfo: { ...imageDto } });

		res.sendStatus(HttpStatus.CREATED);
	}

	@Delete()
	@UseGuards(InternalApiKeyGuard)
	async deleteFile(
		@Res()
		res: Response,
		@Query() imageDto: DeleteImageDto,
	) {
		await this.imageService.deleteImage({
			name: imageDto.beforeName,
			path: imageDto.path,
		});

		res.sendStatus(HttpStatus.OK);
	}
}
