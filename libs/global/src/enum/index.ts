import { resolve } from 'path';

import FileEnum from './file';

export const Environment = {
	Development: 'development',
	Production: 'production',
	Test: 'test',
} as const;

export const Root = resolve(__dirname, '../../');
export const BuildRoot = resolve(__dirname, '../../../../../');
export const getFilePath = (filename: string, isBuild?: boolean) => {
	const root = isBuild ? BuildRoot : Root;
	return resolve(root, filename);
};

export const File = FileEnum;

export default {
	File,
	Environment,
	Root,
};
