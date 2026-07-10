import sharp from 'sharp';
import {
	HttpException,
	Injectable,
	InternalServerErrorException,
	PayloadTooLargeException,
} from '@nestjs/common';

import { AbstractStrategy } from '../abstract.strategy';
import { type PngStrategy } from './png.strategy';
import { type JpegStrategy } from './jpeg.strategy';

export type TFile =
	| Buffer
	| ArrayBuffer
	| Uint8Array
	| Uint8ClampedArray
	| Int8Array
	| Uint16Array
	| Int16Array
	| Uint32Array
	| Int32Array
	| Float32Array
	| Float64Array
	| string;

export type TSharpStrategyInfo = PngStrategy | JpegStrategy;

@Injectable()
export class SharpStrategy extends AbstractStrategy<typeof sharp> {
	private readonly maxInputPixels: number;
	private readonly maxOutputBytes: number;

	constructor() {
		super();
		this.maxInputPixels = readPositiveInteger(
			process.env.IMAGE_MAX_INPUT_PIXELS,
			40_000_000,
		);
		this.maxOutputBytes = readPositiveInteger(
			process.env.IMAGE_MAX_OUTPUT_BYTES,
			20 * 1024 * 1024,
		);
		sharp.concurrency(readPositiveInteger(process.env.SHARP_CONCURRENCY, 2));
	}

	async compressAndSave(..._args: unknown[]): Promise<sharp.OutputInfo> {
		throw new Error('Overriding error.');
	}

	createPipeline(file: TFile) {
		return sharp(file, { limitInputPixels: this.maxInputPixels });
	}

	assertOutputSize(size: number) {
		if (size > this.maxOutputBytes) {
			throw new PayloadTooLargeException('이미지가 허용 크기를 초과했습니다.');
		}
	}

	toHttpException(error: unknown): HttpException {
		if (error instanceof HttpException) {
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
		return new InternalServerErrorException(
			error instanceof Error ? error.message : String(error),
		);
	}

	getToolInstance() {
		return sharp;
	}

	getFileName(file: TFile): string | false {
		return typeof file === 'string' ? file : false;
	}
}

function readPositiveInteger(value: string | undefined, fallback: number) {
	const parsed = value === undefined ? fallback : Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
