import { Injectable } from '@nestjs/common';
import * as path from 'path';
import { Root } from 'src/enum';
import { normalizeSafeRelativePath, resolveInside } from '../path.utils';

@Injectable()
export abstract class AbstractStrategy<T> {
	private mainDir = 'assets';
	private tempDir = 'temp';

	abstract compressAndSave(...args: unknown[]): Promise<unknown>;
	abstract getToolInstance(): T;
	abstract getFileName(file: unknown): string | false;

	getMainDirectory(additionalPath?: string) {
		const root = path.resolve(Root, this.mainDir);
		const safePath = additionalPath
			? normalizeSafeRelativePath(additionalPath, 'main path')
			: undefined;

		return resolveInside(root, safePath);
	}

	getTempDirectory(additionalPath?: string) {
		const root = path.resolve(Root, this.tempDir);
		const safePath = additionalPath
			? normalizeSafeRelativePath(additionalPath, 'temp path')
			: undefined;

		return resolveInside(root, safePath);
	}
}
