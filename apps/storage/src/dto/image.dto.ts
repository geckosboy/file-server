import { PickType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
import {
	IsInt,
	IsNotEmpty,
	IsNumber,
	IsOptional,
	IsString,
	MaxLength,
} from 'class-validator';

export class ImageDto {
	@IsString()
	@IsNotEmpty()
	@MaxLength(128)
	name!: string;

	@IsString()
	@IsNotEmpty()
	@MaxLength(256)
	path!: string;

	@Type(() => Number)
	@IsNumber()
	@IsInt()
	@IsNotEmpty()
	id!: number;

	@IsString()
	@IsNotEmpty()
	@MaxLength(128)
	beforeName!: string;
}

export class GetImageDto extends PickType(ImageDto, ['path', 'name']) {}

export class UploadImageDto extends PickType(ImageDto, ['id', 'path']) {
	@IsOptional()
	@IsString()
	@IsNotEmpty()
	@MaxLength(128)
	beforeName?: string;
}

export class DeleteImageDto extends PickType(ImageDto, [
	'id',
	'path',
	'beforeName',
]) {}
