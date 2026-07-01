import { PickType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
import {
	IsInt,
	IsNotEmpty,
	IsNumber,
	IsOptional,
	IsString,
	Max,
	MaxLength,
	Min,
} from 'class-validator';

/** Cache/Resize 앱에서 공유하는 이미지 조회 계약입니다. */
export class ImageEntity {
	@Type(() => Number)
	@IsNumber()
	@IsInt()
	@Min(1)
	@Max(4096)
	@IsOptional()
	width?: number;

	@Type(() => Number)
	@IsNumber()
	@IsInt()
	@Min(1)
	@Max(4096)
	@IsOptional()
	height?: number;

	@IsString()
	@IsNotEmpty()
	path!: string;

	@IsString()
	@IsNotEmpty()
	name!: string;
}

export class ImageParamDto extends PickType(ImageEntity, ['name', 'path']) {}
export class ImageQueryDto extends PickType(ImageEntity, ['height', 'width']) {}

class StorageImageDto {
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

export class GetImageDto extends PickType(StorageImageDto, ['path', 'name']) {}

export class UploadImageDto extends PickType(StorageImageDto, ['id', 'path']) {
	@IsOptional()
	@IsString()
	@IsNotEmpty()
	@MaxLength(128)
	beforeName?: string;
}

export class DeleteImageDto extends PickType(StorageImageDto, [
	'id',
	'path',
	'beforeName',
]) {}
