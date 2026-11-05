import { resolve } from 'path';
import { Type } from '@nestjs/common';
import {
	TypedConfigModule,
	dotenvLoader,
	selectConfig,
} from 'nest-typed-config';

export {
	KafkaSaslMechanism,
	readKafkaClientSecurityOptions,
} from './kafka-client-security';
export type {
	KafkaClientSaslOptions,
	KafkaClientSecurityOptions,
} from './kafka-client-security';

export type EnvFilePathResolver = (
	filename: string,
	isBuild?: boolean,
) => string;

export interface AppEnvLoadOptions {
	envFilePath?: string;
	ignoreEnvFile?: boolean;
	overrideProcessEnv?: boolean;
	nodeEnv?: string;
}

export const createAppPathTools = (dirname: string) => {
	const Root = resolve(dirname, '../../');
	const BuildRoot = resolve(dirname, '../../../../../');
	const getFilePath: EnvFilePathResolver = (filename, isBuild) => {
		const root = isBuild ? BuildRoot : Root;
		return resolve(root, filename);
	};

	return { Root, BuildRoot, getFilePath };
};

export const resolveAppEnvFilePath = (
	getFilePath: EnvFilePathResolver,
	nodeEnv = process.env.NODE_ENV,
) =>
	nodeEnv === 'production'
		? getFilePath('.env', true)
		: getFilePath('.env.local', true);

export const loadAppEnvIntoProcessEnv = (
	getFilePath: EnvFilePathResolver,
	options: AppEnvLoadOptions = {},
): Record<string, string> => {
	const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
	const ignoreEnvFile =
		options.ignoreEnvFile ?? (nodeEnv === 'production' || nodeEnv === 'test');
	if (ignoreEnvFile) {
		return {};
	}

	const envFilePath =
		options.envFilePath ?? resolveAppEnvFilePath(getFilePath, nodeEnv);
	const loaded = dotenvLoader({
		envFilePath,
		ignoreEnvVars: true,
	})();
	const loadedEnv = Object.fromEntries(
		Object.entries(loaded).map(([key, value]) => [key, String(value)]),
	);

	Object.entries(loadedEnv).forEach(([key, value]) => {
		if (options.overrideProcessEnv || process.env[key] === undefined) {
			process.env[key] = value;
		}
	});

	return loadedEnv;
};

export const createEnvConfig = <TConfig extends object>(
	schema: Type<TConfig>,
	getFilePath: EnvFilePathResolver,
) => {
	const envFilePath = resolveAppEnvFilePath(getFilePath);
	loadAppEnvIntoProcessEnv(getFilePath, { envFilePath });

	const ConfigModule = TypedConfigModule.forRoot({
		schema,
		load: dotenvLoader({
			ignoreEnvFile: process.env.NODE_ENV === 'production',
			envFilePath,
		}),
		normalize: (config) => ({
			...config,
			PORT: config.PORT === undefined ? config.PORT : Number(config.PORT),
		}),
		isGlobal: true,
	});
	const envConfig = selectConfig(ConfigModule, schema);

	return { ConfigModule, envConfig };
};
