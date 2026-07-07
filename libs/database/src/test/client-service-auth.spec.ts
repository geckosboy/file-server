import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import {
	CLIENT_SERVICE_API_KEY_HEADER,
	CLIENT_SERVICE_REQUEST_ID_HEADER,
	CLIENT_SERVICE_TRACE_ID_HEADER,
	INTERNAL_API_KEY_HEADER,
	INTERNAL_CLIENT_CONTEXT_HEADER,
	INTERNAL_CLIENT_CONTEXT_SIGNATURE_HEADER,
	ClientServiceApiKeyGuard,
	ClientServiceAuthService,
	ClientServiceAuthenticatedRequest,
	InternalServiceGuard,
	createClientServiceForwardHeaders,
	createInternalServiceForwardHeaders,
	createClientServiceTelemetryFields,
} from '.././client-service-auth';
import {
	extractClientApiKeyPrefix,
	generateClientApiKey,
} from '.././client-api-key';
import { PrismaService } from '.././prisma.service';

type PrismaMock = {
	clientServiceKey: {
		findUnique: jest.Mock;
		update: jest.Mock;
	};
};

const createPrismaMock = (): PrismaMock => ({
	clientServiceKey: {
		findUnique: jest.fn(),
		update: jest.fn().mockResolvedValue(undefined),
	},
});

const createKeyRecord = (overrides: Record<string, unknown> = {}) => {
	const generated = generateClientApiKey();
	return {
		generated,
		record: {
			id: 'key-1',
			clientServiceId: 'service-1',
			name: 'local key',
			keyPrefix: generated.keyPrefix,
			keyHash: generated.keyHash,
			scopes: null,
			expiresAt: null,
			revokedAt: null,
			lastUsedAt: null,
			createdAt: new Date('2026-01-01T00:00:00.000Z'),
			clientService: {
				id: 'service-1',
				slug: 'local-demo',
				name: 'Local Demo',
				description: null,
				owner: null,
				status: 'ACTIVE',
				createdAt: new Date('2026-01-01T00:00:00.000Z'),
				updatedAt: new Date('2026-01-01T00:00:00.000Z'),
			},
			...overrides,
		},
	};
};

const createContext = (
	request: Partial<ClientServiceAuthenticatedRequest>,
): ExecutionContext =>
	({
		switchToHttp: () => ({
			getRequest: () => request,
		}),
	}) as ExecutionContext;

const createRequest = (
	headers: Record<string, string> = {},
): ClientServiceAuthenticatedRequest =>
	({
		headers: { ...headers },
		header: (name: string) => headers[name.toLowerCase()],
		get: (name: string) => headers[name.toLowerCase()],
	}) as ClientServiceAuthenticatedRequest;

describe('클라이언트 서비스 API 키 인증 서비스', () => {
	const originalPepper = process.env.CLIENT_API_KEY_PEPPER;
	let prisma: PrismaMock;
	let service: ClientServiceAuthService;

	beforeEach(() => {
		process.env.CLIENT_API_KEY_PEPPER = 'test-pepper';
		prisma = createPrismaMock();
		service = new ClientServiceAuthService(prisma as unknown as PrismaService);
	});

	afterEach(() => {
		process.env.CLIENT_API_KEY_PEPPER = originalPepper;
		jest.restoreAllMocks();
	});

	it('활성 서비스의 유효한 API 키를 인증하고 사용 시각을 갱신한다', async () => {
		const { generated, record } = createKeyRecord();
		prisma.clientServiceKey.findUnique.mockResolvedValue(record);

		const result = await service.authenticate(generated.apiKey);

		expect(prisma.clientServiceKey.findUnique).toHaveBeenCalledWith({
			where: { keyPrefix: generated.keyPrefix },
			include: { clientService: true },
		});
		expect(prisma.clientServiceKey.update).toHaveBeenCalledWith({
			where: { id: 'key-1' },
			data: { lastUsedAt: expect.any(Date) },
		});
		expect(result).toEqual({
			clientService: {
				id: 'service-1',
				slug: 'local-demo',
				name: 'Local Demo',
				status: 'ACTIVE',
			},
			key: {
				id: 'key-1',
				keyPrefix: generated.keyPrefix,
				expiresAt: undefined,
			},
		});
	});

	it('폐기, 만료, 비활성 서비스 키는 인증하지 않는다', async () => {
		const revoked = createKeyRecord({ revokedAt: new Date() });
		prisma.clientServiceKey.findUnique.mockResolvedValue(revoked.record);
		await expect(
			service.authenticate(revoked.generated.apiKey),
		).resolves.toBeNull();

		const expired = createKeyRecord({
			expiresAt: new Date('2020-01-01T00:00:00.000Z'),
		});
		prisma.clientServiceKey.findUnique.mockResolvedValue(expired.record);
		await expect(
			service.authenticate(expired.generated.apiKey),
		).resolves.toBeNull();

		const inactive = createKeyRecord({
			clientService: {
				...createKeyRecord().record.clientService,
				status: 'DISABLED',
			},
		});
		prisma.clientServiceKey.findUnique.mockResolvedValue(inactive.record);
		await expect(
			service.authenticate(inactive.generated.apiKey),
		).resolves.toBeNull();

		expect(prisma.clientServiceKey.update).not.toHaveBeenCalled();
	});

	it('prefix가 없거나 hash가 맞지 않는 키는 인증하지 않는다', async () => {
		await expect(service.authenticate('broken-key')).resolves.toBeNull();
		expect(prisma.clientServiceKey.findUnique).not.toHaveBeenCalled();

		const { generated, record } = createKeyRecord({ keyHash: '0'.repeat(64) });
		prisma.clientServiceKey.findUnique.mockResolvedValue(record);
		await expect(service.authenticate(generated.apiKey)).resolves.toBeNull();
		expect(prisma.clientServiceKey.update).not.toHaveBeenCalled();
	});

	it('API key prefix 안에 구분자 문자가 있어도 고정 길이 prefix를 추출한다', () => {
		expect(extractClientApiKeyPrefix('fs_ab_cd123_secret_value')).toBe(
			'ab_cd123',
		);
	});

	it('같은 앱 인스턴스에서도 DB에 새로 등록된 서비스 키를 즉시 다시 조회한다', async () => {
		const { generated, record } = createKeyRecord({
			id: 'key-dynamic',
			clientServiceId: 'service-dynamic',
			clientService: {
				...createKeyRecord().record.clientService,
				id: 'service-dynamic',
				slug: 'dynamic-demo',
				name: 'Dynamic Demo',
			},
		});
		const recordsByPrefix = new Map<string, unknown>();
		prisma.clientServiceKey.findUnique.mockImplementation(({ where }) =>
			Promise.resolve(recordsByPrefix.get(where.keyPrefix) ?? null),
		);

		await expect(service.authenticate(generated.apiKey)).resolves.toBeNull();

		recordsByPrefix.set(generated.keyPrefix, record);

		await expect(service.authenticate(generated.apiKey)).resolves.toEqual({
			clientService: {
				id: 'service-dynamic',
				slug: 'dynamic-demo',
				name: 'Dynamic Demo',
				status: 'ACTIVE',
			},
			key: {
				id: 'key-dynamic',
				keyPrefix: generated.keyPrefix,
				expiresAt: undefined,
			},
		});
		expect(prisma.clientServiceKey.findUnique).toHaveBeenCalledTimes(2);
		expect(prisma.clientServiceKey.update).toHaveBeenCalledWith({
			where: { id: 'key-dynamic' },
			data: { lastUsedAt: expect.any(Date) },
		});
	});
});

describe('클라이언트 서비스 API 키 가드', () => {
	let authService: jest.Mocked<Pick<ClientServiceAuthService, 'authenticate'>>;
	let guard: ClientServiceApiKeyGuard;

	beforeEach(() => {
		authService = {
			authenticate: jest.fn().mockResolvedValue({
				clientService: {
					id: 'service-1',
					slug: 'local-demo',
					name: 'Local Demo',
					status: 'ACTIVE',
				},
				key: {
					id: 'key-1',
					keyPrefix: 'prefix-1',
				},
			}),
		};
		guard = new ClientServiceApiKeyGuard(
			authService as unknown as ClientServiceAuthService,
		);
	});

	it('API 키가 없으면 요청을 거부한다', async () => {
		await expect(
			guard.canActivate(createContext(createRequest())),
		).rejects.toBeInstanceOf(UnauthorizedException);
	});

	it('유효한 API 키이면 요청 컨텍스트와 요청 ID를 붙인다', async () => {
		const request = createRequest({
			[CLIENT_SERVICE_API_KEY_HEADER]: 'fs_prefix_secret',
			[CLIENT_SERVICE_REQUEST_ID_HEADER]: 'req-1',
			[CLIENT_SERVICE_TRACE_ID_HEADER]: 'trace-1',
		});

		await expect(guard.canActivate(createContext(request))).resolves.toBe(true);

		expect(authService.authenticate).toHaveBeenCalledWith('fs_prefix_secret');
		expect(request.clientServiceContext).toEqual({
			clientServiceId: 'service-1',
			clientServiceSlug: 'local-demo',
			clientServiceName: 'Local Demo',
			clientServiceKeyId: 'key-1',
			keyPrefix: 'prefix-1',
			requestId: 'req-1',
			traceId: 'trace-1',
			apiKey: 'fs_prefix_secret',
		});
		expect(request.reqId).toBe('req-1');
		expect(request.requestLogContext).toEqual({
			requestId: 'req-1',
			traceId: 'trace-1',
			clientServiceId: 'service-1',
			clientServiceSlug: 'local-demo',
			clientServiceName: 'Local Demo',
			clientServiceKeyId: 'key-1',
		});
		expect(JSON.stringify(request.requestLogContext)).not.toContain(
			'fs_prefix_secret',
		);
		expect(
			createClientServiceTelemetryFields(request.clientServiceContext),
		).toEqual({
			clientServiceId: 'service-1',
			clientServiceSlug: 'local-demo',
			requestId: 'req-1',
			traceId: 'trace-1',
		});
		expect(
			createClientServiceForwardHeaders(request.clientServiceContext),
		).toEqual({
			[CLIENT_SERVICE_API_KEY_HEADER]: 'fs_prefix_secret',
			[CLIENT_SERVICE_REQUEST_ID_HEADER]: 'req-1',
			[CLIENT_SERVICE_TRACE_ID_HEADER]: 'trace-1',
		});
	});

	it('기존 requestLogContext가 있으면 같은 객체에 서비스 정보를 합친다', async () => {
		const request = createRequest({
			[CLIENT_SERVICE_API_KEY_HEADER]: 'fs_prefix_secret',
			[CLIENT_SERVICE_REQUEST_ID_HEADER]: 'req-1',
		});
		const existingLogContext = {
			requestId: 'req-1',
			method: 'GET',
		};
		request.requestLogContext = existingLogContext;

		await expect(guard.canActivate(createContext(request))).resolves.toBe(true);

		expect(request.requestLogContext).toBe(existingLogContext);
		expect(request.requestLogContext).toMatchObject({
			requestId: 'req-1',
			method: 'GET',
			clientServiceId: 'service-1',
			clientServiceSlug: 'local-demo',
			clientServiceName: 'Local Demo',
			clientServiceKeyId: 'key-1',
		});
	});

	it('요청 ID가 없으면 새 요청 ID를 생성한다', async () => {
		const request = createRequest({
			authorization: 'Bearer fs_prefix_secret',
		});

		await expect(guard.canActivate(createContext(request))).resolves.toBe(true);

		expect(authService.authenticate).toHaveBeenCalledWith('fs_prefix_secret');
		expect(request.clientServiceContext?.requestId).toEqual(expect.any(String));
		expect(request.headers[CLIENT_SERVICE_REQUEST_ID_HEADER]).toBe(
			request.clientServiceContext?.requestId,
		);
	});
});

describe('내부 서비스 가드와 서명된 컨텍스트 전달', () => {
	const originalInternalApiKey = process.env.INTERNAL_API_KEY;
	const internalApiKey = 'internal-test-key';
	const clientServiceContext = {
		clientServiceId: 'service-1',
		clientServiceSlug: 'local-demo',
		clientServiceName: 'Local Demo',
		clientServiceKeyId: 'key-1',
		keyPrefix: 'prefix-1',
		requestId: 'req-internal-1',
		traceId: 'trace-internal-1',
		apiKey: 'fs_prefix_secret',
	};

	beforeEach(() => {
		process.env.INTERNAL_API_KEY = internalApiKey;
	});

	afterEach(() => {
		if (originalInternalApiKey === undefined) {
			delete process.env.INTERNAL_API_KEY;
		} else {
			process.env.INTERNAL_API_KEY = originalInternalApiKey;
		}
	});

	it('내부 호출 헤더는 내부 API key와 서명된 컨텍스트만 포함하고 원본 client API key는 제외한다', () => {
		const headers = createInternalServiceForwardHeaders(
			clientServiceContext,
			internalApiKey,
		);

		expect(headers).toEqual({
			[INTERNAL_API_KEY_HEADER]: internalApiKey,
			[INTERNAL_CLIENT_CONTEXT_HEADER]: expect.any(String),
			[INTERNAL_CLIENT_CONTEXT_SIGNATURE_HEADER]: expect.any(String),
		});
		expect(JSON.stringify(headers)).not.toContain('fs_prefix_secret');
	});

	it('올바른 내부 API key와 컨텍스트 서명이 있으면 요청 컨텍스트를 복원한다', () => {
		const headers = createInternalServiceForwardHeaders(
			clientServiceContext,
			internalApiKey,
		);
		const request = createRequest(headers);
		const guard = new InternalServiceGuard();

		expect(guard.canActivate(createContext(request))).toBe(true);
		expect(request.clientServiceContext).toEqual({
			clientServiceId: 'service-1',
			clientServiceSlug: 'local-demo',
			clientServiceName: 'Local Demo',
			clientServiceKeyId: 'key-1',
			keyPrefix: 'prefix-1',
			requestId: 'req-internal-1',
			traceId: 'trace-internal-1',
		});
		expect(request.requestLogContext).toEqual({
			requestId: 'req-internal-1',
			traceId: 'trace-internal-1',
			clientServiceId: 'service-1',
			clientServiceSlug: 'local-demo',
			clientServiceName: 'Local Demo',
			clientServiceKeyId: 'key-1',
		});
	});

	it('내부 API key가 없거나 서명이 변조되면 요청을 거부한다', () => {
		const guard = new InternalServiceGuard();
		const headers = createInternalServiceForwardHeaders(
			clientServiceContext,
			internalApiKey,
		);

		expect(() => guard.canActivate(createContext(createRequest()))).toThrow(
			UnauthorizedException,
		);
		expect(() =>
			guard.canActivate(
				createContext(
					createRequest({
						...headers,
						[INTERNAL_CLIENT_CONTEXT_SIGNATURE_HEADER]: 'tampered',
					}),
				),
			),
		).toThrow(UnauthorizedException);
	});
});
