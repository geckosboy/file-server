import { Type } from 'class-transformer';
import {
	IsArray,
	IsBoolean,
	IsEnum,
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
	RESIZING_SERVER!: string;

	@IsString()
	KAFKA_CLIENT_BROKERS!: string;

	@IsString()
	DATABASE_URL!: string;

	@IsString()
	CLIENT_API_KEY_PEPPER!: string;

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
