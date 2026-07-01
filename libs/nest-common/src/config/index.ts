import { resolve } from 'path';
import { Type } from '@nestjs/common';
import {
	TypedConfigModule,
	dotenvLoader,
	selectConfig,
} from 'nest-typed-config';

export type EnvFilePathResolver = (
	filename: string,
	isBuild?: boolean,
) => string;

export const createAppPathTools = (dirname: string) => {
	const Root = resolve(dirname, '../../');
	const BuildRoot = resolve(dirname, '../../../../../');
	const getFilePath: EnvFilePathResolver = (filename, isBuild) => {
		const root = isBuild ? BuildRoot : Root;
		return resolve(root, filename);
	};

	return { Root, BuildRoot, getFilePath };
};

export const createEnvConfig = <TConfig extends object>(
	schema: Type<TConfig>,
	getFilePath: EnvFilePathResolver,
) => {
	const envFilePath =
		process.env.NODE_ENV === 'production'
			? getFilePath('.env', true)
			: getFilePath('.env.local', true);
	const ConfigModule = TypedConfigModule.forRoot({
		schema,
		load: dotenvLoader({
			ignoreEnvFile: process.env.NODE_ENV === 'production',
			envFilePath,
		}),
		isGlobal: true,
	});
	const envConfig = selectConfig(ConfigModule, schema);

	return { ConfigModule, envConfig };
};
