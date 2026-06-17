import * as sharp from 'sharp';
import { Injectable } from '@nestjs/common';

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
	async compressAndSave(..._args: unknown[]): Promise<sharp.OutputInfo> {
		throw new Error('Overriding error.');
	}

	getToolInstance() {
		return sharp;
	}

	getFileName(file: TFile): string | false {
		return typeof file === 'string' ? file : false;
	}
}
