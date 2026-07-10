import { PickType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
import {
	IsInt,
	IsIn,
	IsNotEmpty,
	IsNumber,
	IsOptional,
	IsString,
	Max,
	MaxLength,
	Min,
	ValidateIf,
} from 'class-validator';

export {
	createBoundedImageVariantName,
	getMaxImageFileNameLengthForPath,
	MAX_IMAGE_STORAGE_KEY_LENGTH,
	MAX_SAFE_FILE_NAME_LENGTH,
	matchesClientServicePathPattern,
	normalizeClientServicePathPattern,
	normalizeImageStoragePath,
	normalizeSafeFileName,
	normalizeSafeRelativePath,
	resolveInside,
	splitAndNormalizeImageKey,
	toImageStoragePath,
} from './path-security';

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

	@IsString()
	@IsIn(['png', 'jpeg', 'webp'])
	@IsOptional()
	format?: 'png' | 'jpeg' | 'webp';
}

export class ImageParamDto extends PickType(ImageEntity, ['name', 'path']) {}
export class ImageQueryDto extends PickType(ImageEntity, [
	'height',
	'width',
	'format',
]) {}

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
	@Min(1)
	@IsOptional()
	externalImageId?: number;

	@IsString()
	@IsNotEmpty()
	@MaxLength(128)
	beforeName!: string;

	@IsString()
	@IsNotEmpty()
	@MaxLength(384)
	imageKey!: string;
}

export class GetImageDto extends PickType(StorageImageDto, ['path', 'name']) {}

export class UploadImageDto extends PickType(StorageImageDto, ['path']) {
	@IsOptional()
	@IsString()
	@IsNotEmpty()
	@MaxLength(128)
	beforeName?: string;

	@Type(() => Number)
	@IsOptional()
	@IsNumber()
	@IsInt()
	@Min(1)
	externalImageId?: number;
}

export class DeleteImageDto {
	@ValidateIf((dto: DeleteImageDto) => !dto.imageKey)
	@IsString()
	@IsNotEmpty()
	@MaxLength(256)
	path!: string;

	@ValidateIf((dto: DeleteImageDto) => !dto.imageKey)
	@IsString()
	@IsNotEmpty()
	@MaxLength(128)
	name!: string;

	@ValidateIf((dto: DeleteImageDto) => !dto.path || !dto.name)
	@IsString()
	@IsNotEmpty()
	@MaxLength(384)
	imageKey!: string;
}
