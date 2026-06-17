import { Type } from 'class-transformer';
import {
	IsInt,
	IsNotEmpty,
	IsNumber,
	IsOptional,
	IsString,
	Max,
	Min,
} from 'class-validator';

/**
 * Image Resizing을 위한 Entity.
 * 추후 fit형식에 따라 클래스 이름을 변경해야 할 수도 있음
 */
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
