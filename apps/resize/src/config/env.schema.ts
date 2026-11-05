import { Type } from 'class-transformer';
import {
	IsArray,
	IsBoolean,
	IsEnum,
	IsInt,
	IsNumber,
	IsOptional,
	IsString,
	Max,
	Min,
} from 'class-validator';
import { Environment, ValueOf, parseOriginList } from '@file/global';

export class AppConfig {
	@IsEnum(Environment)
	NODE_ENV!: ValueOf<typeof Environment>;

	@IsNumber()
	@Min(0)
	@Max(65535)
	@Type(() => Number)
	PORT!: number;

	@IsString()
	ORIGIN_LIST_STR!: string;

	@IsOptional()
	@IsString()
	HOST?: string;

	@IsString()
	INTERNAL_API_KEY!: string;

	@IsString()
	KAFKA_CLIENT_BROKERS!: string;

	@IsString()
	STORAGE_SERVER!: string;

	@IsOptional()
	@IsInt()
	@Min(100)
	@Max(60_000)
	@Type(() => Number)
	UPSTREAM_HTTP_TIMEOUT_MS = 2_000;

	@IsOptional()
	@IsInt()
	@Min(0)
	@Max(2)
	@Type(() => Number)
	UPSTREAM_HTTP_MAX_RETRIES = 1;

	@IsOptional()
	@IsInt()
	@Min(0)
	@Max(5_000)
	@Type(() => Number)
	UPSTREAM_HTTP_RETRY_BACKOFF_MS = 100;

	@IsOptional()
	@IsInt()
	@Min(1)
	@Max(100 * 1024 * 1024)
	@Type(() => Number)
	UPSTREAM_IMAGE_MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

	@IsOptional()
	@IsInt()
	@Min(1)
	@Max(268_402_689)
	@Type(() => Number)
	IMAGE_MAX_INPUT_PIXELS = 40_000_000;

	@IsOptional()
	@IsInt()
	@Min(1)
	@Max(100 * 1024 * 1024)
	@Type(() => Number)
	IMAGE_MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

	@IsOptional()
	@IsInt()
	@Min(1)
	@Max(16)
	@Type(() => Number)
	SHARP_CONCURRENCY = 2;

	@IsString()
	DATABASE_URL!: string;

	@IsString()
	CLIENT_API_KEY_PEPPER!: string;

	@IsOptional()
	@IsNumber()
	@Min(1)
	@Type(() => Number)
	HEALTH_PROBE_TIMEOUT_MS?: number;

	@IsOptional()
	@IsNumber()
	@Min(0)
	@Type(() => Number)
	HEALTH_PROBE_CACHE_TTL_MS?: number;

	@IsBoolean()
	get isDevelopment() {
		return this.NODE_ENV === Environment.Development;
	}

	@IsBoolean()
	get isProduction() {
		return this.NODE_ENV === Environment.Production;
	}

	@IsArray()
	get originList() {
		return parseOriginList(this.ORIGIN_LIST_STR);
	}

	get kafkaClientBrokerList() {
		return this.KAFKA_CLIENT_BROKERS?.split(',') ?? [];
	}
}
