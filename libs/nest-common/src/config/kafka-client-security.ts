import { readFileSync } from 'fs';

export const KafkaSaslMechanism = {
	Plain: 'plain',
	ScramSha256: 'scram-sha-256',
	ScramSha512: 'scram-sha-512',
} as const;

export type KafkaSaslMechanism =
	(typeof KafkaSaslMechanism)[keyof typeof KafkaSaslMechanism];

export type KafkaClientSaslOptions =
	| {
			mechanism: typeof KafkaSaslMechanism.Plain;
			username: string;
			password: string;
	  }
	| {
			mechanism: typeof KafkaSaslMechanism.ScramSha256;
			username: string;
			password: string;
	  }
	| {
			mechanism: typeof KafkaSaslMechanism.ScramSha512;
			username: string;
			password: string;
	  };

export interface KafkaClientSecurityOptions {
	ssl?: {
		ca: string[];
		rejectUnauthorized: true;
	};
	sasl?: KafkaClientSaslOptions;
}

type KafkaSecurityEnv = Partial<
	Pick<
		NodeJS.ProcessEnv,
		| 'KAFKA_SSL_ENABLED'
		| 'KAFKA_SSL_CA_FILE'
		| 'KAFKA_SASL_MECHANISM'
		| 'KAFKA_SASL_USERNAME'
		| 'KAFKA_SASL_PASSWORD'
	>
>;

type ReadUtf8File = (path: string, encoding: 'utf8') => string;

const supportedSaslMechanisms = Object.values(KafkaSaslMechanism);

export const readKafkaClientSecurityOptions = (
	env: KafkaSecurityEnv = process.env,
	readUtf8File: ReadUtf8File = readFileSync,
): KafkaClientSecurityOptions => {
	const ssl = readKafkaSsl(env, readUtf8File);
	const sasl = readKafkaSasl(env);

	return {
		...(ssl ? { ssl } : {}),
		...(sasl ? { sasl } : {}),
	};
};

const readKafkaSsl = (
	env: KafkaSecurityEnv,
	readUtf8File: ReadUtf8File,
): KafkaClientSecurityOptions['ssl'] => {
	const enabled = readOptionalBoolean(
		env.KAFKA_SSL_ENABLED,
		'KAFKA_SSL_ENABLED',
	);
	const caFile = readOptionalString(env.KAFKA_SSL_CA_FILE);

	if (caFile && enabled !== true) {
		throw new Error('KAFKA_SSL_CA_FILE requires KAFKA_SSL_ENABLED=true');
	}
	if (enabled !== true) {
		return undefined;
	}
	if (!caFile) {
		throw new Error(
			'KAFKA_SSL_CA_FILE is required when KAFKA_SSL_ENABLED=true',
		);
	}

	return {
		ca: [readUtf8File(caFile, 'utf8')],
		rejectUnauthorized: true,
	};
};

const readKafkaSasl = (
	env: KafkaSecurityEnv,
): KafkaClientSecurityOptions['sasl'] => {
	const rawMechanism = readOptionalString(env.KAFKA_SASL_MECHANISM);
	const username = readOptionalString(env.KAFKA_SASL_USERNAME);
	const password = readOptionalString(env.KAFKA_SASL_PASSWORD, false);
	const hasAnySaslSetting = [
		env.KAFKA_SASL_MECHANISM,
		env.KAFKA_SASL_USERNAME,
		env.KAFKA_SASL_PASSWORD,
	].some((value) => value !== undefined);

	if (!hasAnySaslSetting) {
		return undefined;
	}
	if (!rawMechanism) {
		throw new Error(
			'KAFKA_SASL_MECHANISM is required when Kafka SASL credentials are configured',
		);
	}

	const mechanism = rawMechanism.toLowerCase();
	if (!isSupportedSaslMechanism(mechanism)) {
		throw new Error(`Unsupported Kafka SASL mechanism: ${rawMechanism}`);
	}
	if (!username || !password || password.trim().length === 0) {
		throw new Error(
			'KAFKA_SASL_USERNAME and KAFKA_SASL_PASSWORD are required when Kafka SASL is configured',
		);
	}

	return createKafkaSaslOptions(mechanism, username, password);
};

const createKafkaSaslOptions = (
	mechanism: KafkaSaslMechanism,
	username: string,
	password: string,
): KafkaClientSaslOptions => {
	switch (mechanism) {
		case KafkaSaslMechanism.Plain:
			return { mechanism: KafkaSaslMechanism.Plain, username, password };
		case KafkaSaslMechanism.ScramSha256:
			return { mechanism: KafkaSaslMechanism.ScramSha256, username, password };
		case KafkaSaslMechanism.ScramSha512:
			return { mechanism: KafkaSaslMechanism.ScramSha512, username, password };
	}
};

const readOptionalBoolean = (
	value: string | undefined,
	name: string,
): boolean | undefined => {
	const normalized = value?.trim().toLowerCase();
	if (normalized === undefined || normalized === '') {
		return undefined;
	}
	if (['1', 'true', 'yes', 'on'].includes(normalized)) {
		return true;
	}
	if (['0', 'false', 'no', 'off'].includes(normalized)) {
		return false;
	}
	throw new Error(`${name} must be true or false`);
};

const readOptionalString = (
	value: string | undefined,
	trim = true,
): string | undefined => {
	if (value === undefined) {
		return undefined;
	}
	const normalized = trim ? value.trim() : value;
	return normalized.length > 0 ? normalized : undefined;
};

const isSupportedSaslMechanism = (value: string): value is KafkaSaslMechanism =>
	supportedSaslMechanisms.includes(value as KafkaSaslMechanism);
