import {
	DynamicModule,
	Global,
	MiddlewareConsumer,
	Module,
	NestModule,
} from '@nestjs/common';

import { LoggerMiddleware } from './logger.middleware';
import { DEFAULT_SENSITIVE_FIELDS } from './log-data-masker';
import type { RequestLogContextOptions } from './request-log-context';

export interface LoggerConfig extends RequestLogContextOptions {
	/** 로그 context 이름 */
	appName?: string;
	/** 마스킹할 민감한 필드 목록 */
	sensitiveFields?: readonly string[];
	/** 마스킹 문자열 (기본값: '****') */
	mask?: string;
	/** middleware를 적용할 라우트 (기본값: 모든 라우트 '*') */
	routes?: string | string[];
	/** middleware를 제외할 라우트 */
	exclude?: string | string[];
	/** 요청 시작 로그까지 남길지 여부 */
	includeStartLog?: boolean;
}

export const LOGGER_CONFIG = Symbol('LOGGER_CONFIG');
export const LOGGER_ROUTES = Symbol('LOGGER_ROUTES');
export const LOGGER_EXCLUDE = Symbol('LOGGER_EXCLUDE');

export type ResolvedLoggerConfig = LoggerConfig &
	Required<Pick<LoggerConfig, 'sensitiveFields' | 'mask' | 'includeStartLog'>>;

@Global()
@Module({})
export class LoggerModule implements NestModule {
	private static routes: string | string[] | undefined;
	private static exclude: string | string[] | undefined;

	static forRoot(config?: LoggerConfig): DynamicModule {
		const mergedConfig: ResolvedLoggerConfig = {
			...config,
			sensitiveFields: config?.sensitiveFields
				? [...new Set([...DEFAULT_SENSITIVE_FIELDS, ...config.sensitiveFields])]
				: DEFAULT_SENSITIVE_FIELDS,
			mask: config?.mask ?? '****',
			includeStartLog: config?.includeStartLog ?? true,
		};

		LoggerModule.routes = config?.routes ?? '*';
		LoggerModule.exclude = config?.exclude;

		return {
			module: LoggerModule,
			providers: [
				{
					provide: LOGGER_CONFIG,
					useValue: mergedConfig,
				},
				LoggerMiddleware,
			],
			exports: [LoggerMiddleware],
			global: true,
		};
	}

	configure(consumer: MiddlewareConsumer) {
		const middleware = consumer.apply(LoggerMiddleware);

		if (LoggerModule.exclude) {
			const excludeRoutes = Array.isArray(LoggerModule.exclude)
				? LoggerModule.exclude
				: [LoggerModule.exclude];
			middleware.exclude(...excludeRoutes);
		}

		if (LoggerModule.routes) {
			const routes = Array.isArray(LoggerModule.routes)
				? LoggerModule.routes
				: [LoggerModule.routes];
			middleware.forRoutes(...routes);
		}
	}
}
