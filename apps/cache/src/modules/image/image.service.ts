import { NotFoundException, Injectable, Logger } from '@nestjs/common';
import { lookup } from 'mime-types';
import { URLSearchParams } from 'url';

import { ImageEntity } from 'src/entity/image.entity';
import { CacheService } from '../node-cache/cache.service';
import { envConfig } from 'src/config';

@Injectable()
export class ImageService {
	private readonly logger = new Logger(ImageService.name);

	constructor(private readonly cacheService: CacheService) {}

	/** Object 형식 QueryString으로 변환 */
	private objectToQueryString(obj: Record<string, string | number>) {
		const convertedObj = Object.entries(obj).reduce(
			(acc: Record<string, string>, [key, value]) => {
				if (value) {
					acc[key] = String(value);
				}
				return acc;
			},
			{},
		);
		return new URLSearchParams(convertedObj).toString();
	}

	/** Name, path 등으로 CacheKey 생성 */
	private convertToCacheKey({ name, path, height, width }: ImageEntity) {
		return `${path}_${width ?? 'x'}/${height ?? 'x'}${name}`;
	}

	private getImageUrl({ name, path, ...size }: ImageEntity) {
		const queryStr = this.objectToQueryString(size);
		const encodedPath = encodeURIComponent(path);
		const encodedName = encodeURIComponent(name);
		return `${envConfig.RESIZING_SERVER}/image/${encodedPath}/${encodedName}?${queryStr}`;
	}

	/** 리사이징 서버에 이미지 요청 */
	private async getImageFromMain(image: ImageEntity) {
		const response = await fetch(this.getImageUrl(image));
		if (!response.ok) {
			throw new NotFoundException('존재하지 않는 이미지 파일입니다.');
		}

		const imageArrayBuffer = await response.arrayBuffer();
		const imageBuffer = Buffer.from(imageArrayBuffer);
		const contentType =
			response.headers.get('content-type') ||
			lookup(image.name) ||
			'application/octet-stream';

		return { imageBuffer, contentType };
	}

	async getCacheImage(params: ImageEntity) {
		const cacheKey = this.convertToCacheKey(params);

		const cachedImage = this.cacheService.getCachedImage(cacheKey);
		/** Caching된 이미지 있으면 그대로 반환 */
		if (cachedImage) {
			this.logger.log(`cache hit: ${JSON.stringify(params)}`);
			return cachedImage;
		}

		/** 없다면 리사이징 서버로부터 데이터 가져옴 */
		try {
			const { imageBuffer, contentType } = await this.getImageFromMain(params);
			/** 리사이징 결과물 캐싱 */
			this.cacheService.cacheImage(cacheKey, { imageBuffer, contentType });

			this.logger.log(`cache not hit: ${JSON.stringify(params)}`);
			return {
				imageBuffer,
				contentType,
			};
		} catch (err) {
			this.logger.error(err);
			throw err;
		}
	}
}
