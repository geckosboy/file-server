import { Injectable } from '@nestjs/common';
import { rm } from 'fs/promises';
import { SharpStrategy } from '.';

@Injectable()
export class JpegStrategy extends SharpStrategy {
	async compressAndSave(info: { from: string; to: string }) {
		let outputWritten = false;
		try {
			const { from, to } = info;

			const compressResult = await this.createPipeline(from)
				.jpeg({ quality: 60 })
				.toFile(to);
			outputWritten = true;
			this.assertOutputSize(compressResult.size);

			return compressResult;
		} catch (error) {
			if (outputWritten) {
				await rm(info.to, { force: true });
			}
			throw this.toHttpException(error);
		}
	}
}
