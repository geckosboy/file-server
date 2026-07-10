import { Injectable, PayloadTooLargeException } from '@nestjs/common';
import type { ImageEntity } from '@file/image-contracts';
import sharp from 'sharp';
import { envConfig } from 'src/config';

@Injectable()
export class ImageManager {
	private readonly maxInputPixels = envConfig.IMAGE_MAX_INPUT_PIXELS;
	private readonly maxOutputBytes = envConfig.IMAGE_MAX_OUTPUT_BYTES;

	constructor() {
		sharp.concurrency(envConfig.SHARP_CONCURRENCY);
	}

	async validate(image: Buffer) {
		try {
			await sharp(image, {
				limitInputPixels: this.maxInputPixels,
			}).metadata();
		} catch (error) {
			throw mapSharpLimitError(error);
		}
	}

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
		try {
			const resizedImage = sharp(image, {
				limitInputPixels: this.maxInputPixels,
			}).resize({ ...options, fit: 'fill' });
			const output = size.format
				? await resizedImage.toFormat(size.format).toBuffer()
				: await resizedImage.toBuffer();
			if (output.byteLength > this.maxOutputBytes) {
				throw new PayloadTooLargeException(
					'리사이즈 결과가 허용 크기를 초과했습니다.',
				);
			}
			return output;
		} catch (error) {
			throw mapSharpLimitError(error);
		}
	}
}

function mapSharpLimitError(error: unknown): unknown {
	if (error instanceof PayloadTooLargeException) {
		return error;
	}
	if (
		error instanceof Error &&
		/pixel limit|exceeds pixel/i.test(error.message)
	) {
		return new PayloadTooLargeException(
			'이미지 픽셀 수가 허용 한도를 초과했습니다.',
		);
	}
	return error;
}
