import { Injectable } from '@nestjs/common';

@Injectable()
export class TelemetryConfigService {
	readonly nodeEnv = process.env.NODE_ENV ?? 'development';
	readonly adminToken = requiredSecret({
		name: 'TELEMETRY_ADMIN_TOKEN',
		value: process.env.TELEMETRY_ADMIN_TOKEN,
		testFallback: 'test-admin-token',
		nodeEnv: this.nodeEnv,
	});
	readonly corsOrigins = parseCorsOrigins(
		process.env.TELEMETRY_CORS_ORIGINS ?? process.env.ORIGIN_LIST_STR,
	);
	readonly httpIngestionEnabled = readBoolean(
		process.env.TELEMETRY_HTTP_INGESTION_ENABLED,
		this.nodeEnv === 'test',
	);
	readonly ingestionToken = this.httpIngestionEnabled
		? requiredSecret({
				name: 'TELEMETRY_INGESTION_TOKEN',
				value: process.env.TELEMETRY_INGESTION_TOKEN,
				testFallback: 'test-ingestion-token',
				nodeEnv: this.nodeEnv,
			})
		: undefined;
}

function requiredSecret(input: {
	name: string;
	value?: string;
	testFallback: string;
	nodeEnv: string;
}) {
	const value = input.value?.trim();
	if (value) return value;
	if (input.nodeEnv === 'test') return input.testFallback;
	throw new Error(`${input.name} 환경변수가 필요합니다.`);
}

function readBoolean(value: string | undefined, fallback: boolean) {
	if (value === undefined) return fallback;
	if (value === 'true') return true;
	if (value === 'false') return false;
	throw new Error('boolean 환경변수는 true 또는 false여야 합니다.');
}

function parseCorsOrigins(value: string | undefined) {
	if (!value?.trim()) return [];
	return value.split(',').map((item) => {
		const origin = item.trim();
		if (!origin || origin === '*') {
			throw new Error('TELEMETRY_CORS_ORIGINS에는 *를 사용할 수 없습니다.');
		}
		const parsed = new URL(origin);
		if (
			(parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
			parsed.origin !== origin
		) {
			throw new Error(
				'TELEMETRY_CORS_ORIGINS에는 http(s) origin만 사용할 수 있습니다.',
			);
		}
		return origin;
	});
}
