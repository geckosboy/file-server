import {
	BadRequestException,
	CallHandler,
	ExecutionContext,
	Injectable,
	NestInterceptor,
	PayloadTooLargeException,
	UnauthorizedException,
} from '@nestjs/common';
import { File } from '@file/global';
import {
	ClientServiceAction,
	ClientServiceAuthenticatedRequest,
	ClientServiceAuthorizationService,
	getClientServiceContext,
} from '@file/database';
import {
	normalizeImageStoragePath,
	normalizeSafeFileName,
} from '@file/image-contracts';
import type { Response } from 'express';
import { mkdir, rm } from 'fs/promises';
import { createWriteStream } from 'fs';
import { extension } from 'mime-types';
import multer, { type StorageEngine } from 'multer';
import { randomUUID } from 'crypto';
import { resolve } from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { finalize, type Observable } from 'rxjs';
import { Root } from 'src/enum';

type MulterCallback = (
	error: Error | null,
	info?: Partial<Express.Multer.File>,
) => void;

const allowedMimeTypes = new Set<string>(File.ImageFileMimeList);

@Injectable()
export class PolicyAwareImageUploadInterceptor implements NestInterceptor {
	constructor(
		private readonly authorization: ClientServiceAuthorizationService,
	) {}

	async intercept(
		context: ExecutionContext,
		next: CallHandler,
	): Promise<Observable<unknown>> {
		const http = context.switchToHttp();
		const request = http.getRequest<ClientServiceAuthenticatedRequest>();
		const response = http.getResponse<Response>();
		const upload = multer({
			storage: new PolicyAwareImageStorage(this.authorization),
			limits: { files: 1, fields: 10 },
			fileFilter: (_request, file, callback) => {
				if (!allowedMimeTypes.has(file.mimetype)) {
					callback(new BadRequestException('허용되지 않는 이미지 형식입니다.'));
					return;
				}
				callback(null, true);
			},
		}).single('file');

		await new Promise<void>((resolveUpload, rejectUpload) => {
			upload(request, response, (error: unknown) => {
				if (error) rejectUpload(error);
				else resolveUpload();
			});
		});
		if (readOptionalMultipartField(request.body, 'beforeName')) {
			try {
				const clientServiceContext = getClientServiceContext(request);
				if (!clientServiceContext) {
					throw new UnauthorizedException(
						'클라이언트 서비스 컨텍스트가 없습니다.',
					);
				}
				await this.authorization.authorize({
					context: clientServiceContext,
					action: ClientServiceAction.Delete,
					normalizedPath: readMultipartField(request.body, 'path'),
					consumeRateLimit: false,
				});
			} catch (error) {
				if (request.file?.path) {
					await rm(request.file.path, { force: true });
				}
				throw error;
			}
		}

		return next.handle().pipe(
			finalize(() => {
				const filePath = request.file?.path;
				if (filePath) void rm(filePath, { force: true });
			}),
		);
	}
}

class PolicyAwareImageStorage implements StorageEngine {
	constructor(
		private readonly authorization: ClientServiceAuthorizationService,
	) {}

	_handleFile(
		request: ClientServiceAuthenticatedRequest,
		file: Express.Multer.File,
		callback: MulterCallback,
	): void {
		void this.store(request, file).then(
			(info) => callback(null, info),
			(error: unknown) =>
				callback(
					error instanceof Error
						? error
						: new Error('업로드 스트림 저장에 실패했습니다.'),
				),
		);
	}

	_removeFile(
		_request: ClientServiceAuthenticatedRequest,
		file: Express.Multer.File,
		callback: (error: Error | null) => void,
	): void {
		void rm(file.path, { force: true }).then(
			() => callback(null),
			(error: unknown) =>
				callback(error instanceof Error ? error : new Error(String(error))),
		);
	}

	private async store(
		request: ClientServiceAuthenticatedRequest,
		file: Express.Multer.File,
	): Promise<Partial<Express.Multer.File>> {
		const context = getClientServiceContext(request);
		if (!context) {
			throw new UnauthorizedException('클라이언트 서비스 컨텍스트가 없습니다.');
		}
		const rawPath = readMultipartField(request.body, 'path');
		const normalizedPath = normalizeImageStoragePath(rawPath);
		request.body.path = normalizedPath;

		const decision = await this.authorization.authorize({
			context,
			action: ClientServiceAction.Upload,
			normalizedPath,
			consumeRateLimit: true,
		});
		const maxBytes = Math.min(
			File.FileMaximumSize.Image,
			decision.maxUploadBytes ?? File.FileMaximumSize.Image,
		);
		const ext = extension(file.mimetype);
		if (!ext) {
			throw new BadRequestException('알 수 없는 이미지 확장자입니다.');
		}
		const destination = resolve(Root, 'temp');
		await mkdir(destination, { recursive: true });
		const filename = normalizeSafeFileName(`${randomUUID()}.${ext}`);
		const filePath = resolve(destination, filename);
		let size = 0;
		const limiter = new Transform({
			transform(chunk: Buffer, _encoding, done) {
				size += chunk.byteLength;
				if (size > maxBytes) {
					done(
						new PayloadTooLargeException(
							`업로드 파일은 ${maxBytes} bytes를 초과할 수 없습니다.`,
						),
					);
					return;
				}
				done(null, chunk);
			},
		});

		try {
			await pipeline(file.stream, limiter, createWriteStream(filePath));
		} catch (error) {
			await rm(filePath, { force: true });
			throw error;
		}

		return { destination, filename, path: filePath, size };
	}
}

function readMultipartField(body: unknown, key: string): string {
	const value = readOptionalMultipartField(body, key);
	if (!value) {
		throw new BadRequestException(
			`${key} multipart field는 file field보다 먼저 전송해야 합니다.`,
		);
	}
	return value;
}

function readOptionalMultipartField(body: unknown, key: string) {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		return undefined;
	}
	const value = (body as Record<string, unknown>)[key];
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
