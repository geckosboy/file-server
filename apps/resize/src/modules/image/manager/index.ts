import { Injectable } from '@nestjs/common';
import type { ImageEntity } from '@file/image-contracts';
import * as sharp from 'sharp';

@Injectable()
export class ImageManager {
	/** 리사이징은 요청별 size 인자로만 진행해 singleton 상태 공유를 피함 */
	async resize(
		image: Buffer,
		size: Partial<Pick<ImageEntity, 'height' | 'width' | 'format'>>,
	) {
		const options = {
			...(size.width ? { width: size.width } : {}),
			...(size.height ? { height: size.height } : {}),
		};

		/** 단순히 사진을 리사이징하는 작업이므로 사진의 일부분이 잘리지 않도록 fill설정 */
		const resizedImage = sharp(image).resize({ ...options, fit: 'fill' });

		if (size.format) {
			return resizedImage.toFormat(size.format).toBuffer();
		}

		return resizedImage.toBuffer();
	}
}
