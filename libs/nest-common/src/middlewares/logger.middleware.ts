import { Inject, Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { LOGGER_CONFIG, type ResolvedLoggerConfig } from './logger.module';
import { maskSensitiveData } from './log-data-masker';
import {
	attachRequestLogContext,
	createRequestLogMeta,
	resolveRequestLogContext,
} from './request-log-context';

@Injectable()
export class LoggerMiddleware implements NestMiddleware {
	private readonly logger: Logger;

	constructor(
		@Inject(LOGGER_CONFIG) private readonly config: ResolvedLoggerConfig,
	) {
		this.logger = new Logger(config.appName ?? LoggerMiddleware.name);
	}

	private maskLogData(value: unknown) {
		return maskSensitiveData(value, {
			sensitiveFields: this.config.sensitiveFields,
			mask: this.config.mask,
		});
	}

	/** null prototype 객체를 일반 객체로 복사 (로그 직렬화 시 [Object: null prototype] 방지) */
	private toPlainObject(obj: object): object {
		return Object.assign({}, obj);
	}

	private getReqData(req: Request) {
		const entries = Object.entries({
			body: req.body,
			query: req.query,
			params: req.params,
		}) as Array<['body' | 'query' | 'params', unknown]>;

		return entries.reduce(
			(acc, [key, value]) => {
				if (!value) return acc;

				if (typeof value === 'object' && Object.keys(value).length) {
					acc[key] = this.maskLogData(this.toPlainObject(value as object));
				}
				return acc;
			},
			{} as Record<'body' | 'query' | 'params', unknown>,
		);
	}

	use(req: Request, res: Response, next: NextFunction) {
		const now = Date.now();
		const context = attachRequestLogContext(
			req,
			res,
			resolveRequestLogContext(req, this.config),
		);
		const apiInfo = `${context.method}-${context.url}`;
		const reqData = this.getReqData(req);

		if (this.config.includeStartLog) {
			this.logger.log(
				`${apiInfo} Start! ${JSON.stringify(
					createRequestLogMeta(context, reqData),
				)}`,
			);
		}

		res.on('finish', () => {
			const durationMs = Date.now() - now;
			this.logger.log(
				`${apiInfo} ${res.statusCode} - ${durationMs}ms ${JSON.stringify(
					createRequestLogMeta(context, {
						statusCode: res.statusCode,
						durationMs,
					}),
				)}`,
			);
		});

		res.on('error', (error) => {
			this.logger.error(
				`${apiInfo} ${res.statusCode} - ${error.message} ${JSON.stringify(
					createRequestLogMeta(context, {
						statusCode: res.statusCode,
						errorName: error.name,
						errorMessage: error.message,
					}),
				)}`,
			);
		});

		next();
	}
}
