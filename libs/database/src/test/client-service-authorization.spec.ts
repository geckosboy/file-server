import { ForbiddenException, PayloadTooLargeException } from '@nestjs/common';
import {
	ClientServiceAction,
	ClientServiceAuthorizationService,
} from '.././client-service-authorization';
import type { ClientServiceAuthContext } from '.././client-service-auth';
import type { PrismaService } from '.././prisma.service';

const context: ClientServiceAuthContext = {
	clientServiceId: 'service-a',
	clientServiceSlug: 'catalog-api',
	clientServiceName: 'Catalog API',
	clientServiceKeyId: 'key-a',
	keyPrefix: 'prefix-a',
	requestId: 'request-a',
};

const createKey = (overrides: Record<string, unknown> = {}) => ({
	id: 'key-a',
	clientServiceId: 'service-a',
	name: null,
	keyPrefix: 'prefix-a',
	keyHash: 'hash',
	scopes: null,
	expiresAt: null,
	revokedAt: null,
	lastUsedAt: null,
	createdAt: new Date(),
	clientService: {
		id: 'service-a',
		slug: 'catalog-api',
		name: 'Catalog API',
		description: null,
		owner: null,
		status: 'ACTIVE',
		createdAt: new Date(),
		updatedAt: new Date(),
		policies: [
			{
				id: 'policy-a',
				clientServiceId: 'service-a',
				pathPattern: 'catalog/**/image',
				canRead: true,
				canUpload: true,
				canDelete: true,
				maxUploadBytes: 1024,
				rateLimitPerMin: 2,
				metadata: null,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		],
	},
	...overrides,
});

const createPrisma = () => ({
	clientServiceKey: {
		findUnique: jest.fn().mockResolvedValue(createKey()),
	},
	clientServiceRateLimitWindow: {
		deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
	},
	$queryRaw: jest.fn().mockResolvedValue([{ request_count: 1 }]),
});

describe('클라이언트 서비스 정책 평가기', () => {
	it('서비스 정책과 key scope 교집합 안의 경로/동작만 허용한다', async () => {
		const prisma = createPrisma();
		prisma.clientServiceKey.findUnique.mockResolvedValue(
			createKey({ scopes: { read: true, upload: false } }),
		);
		const service = new ClientServiceAuthorizationService(
			prisma as unknown as PrismaService,
		);

		await expect(
			service.authorize({
				context,
				action: ClientServiceAction.Read,
				normalizedPath: 'catalog/products/image',
			}),
		).resolves.toMatchObject({
			allowed: true,
			maxUploadBytes: 1024,
			rateLimitPerMin: 2,
			matchedPolicyIds: ['policy-a'],
		});
		await expect(
			service.authorize({
				context,
				action: ClientServiceAction.Upload,
				normalizedPath: 'catalog/products/image',
			}),
		).rejects.toBeInstanceOf(ForbiddenException);
		await expect(
			service.authorize({
				context,
				action: ClientServiceAction.Read,
				normalizedPath: 'other/products/image',
			}),
		).rejects.toBeInstanceOf(ForbiddenException);
	});

	it('업로드 정책 크기를 초과하면 413을 반환한다', async () => {
		const prisma = createPrisma();
		const service = new ClientServiceAuthorizationService(
			prisma as unknown as PrismaService,
		);

		await expect(
			service.authorize({
				context,
				action: ClientServiceAction.Upload,
				normalizedPath: 'catalog/products/image',
				uploadBytes: 1025,
			}),
		).rejects.toBeInstanceOf(PayloadTooLargeException);
		expect(prisma.$queryRaw).not.toHaveBeenCalled();
	});

	it('key pathPatterns는 service policy를 더 좁히지만 넓히지 못한다', async () => {
		const prisma = createPrisma();
		prisma.clientServiceKey.findUnique.mockResolvedValue(
			createKey({
				scopes: {
					actions: ['read'],
					pathPatterns: ['catalog/public/image'],
				},
			}),
		);
		const service = new ClientServiceAuthorizationService(
			prisma as unknown as PrismaService,
		);

		await expect(
			service.authorize({
				context,
				action: ClientServiceAction.Read,
				normalizedPath: 'catalog/public/image',
				consumeRateLimit: false,
			}),
		).resolves.toMatchObject({ allowed: true });
		await expect(
			service.authorize({
				context,
				action: ClientServiceAction.Read,
				normalizedPath: 'catalog/private/image',
			}),
		).rejects.toBeInstanceOf(ForbiddenException);
	});

	it('원자적 PostgreSQL counter가 갱신되지 않으면 replica 공통 429를 반환한다', async () => {
		const prisma = createPrisma();
		prisma.$queryRaw.mockResolvedValue([]);
		const service = new ClientServiceAuthorizationService(
			prisma as unknown as PrismaService,
		);

		const result = service.authorize({
			context,
			action: ClientServiceAction.Read,
			normalizedPath: 'catalog/products/image',
		});
		await expect(result).rejects.toMatchObject({ status: 429 });
	});

	it.each([
		{ revokedAt: new Date() },
		{ expiresAt: new Date('2020-01-01T00:00:00.000Z') },
		{
			clientService: {
				...createKey().clientService,
				status: 'DISABLED',
			},
		},
	])('폐기/만료/비활성 컨텍스트를 정책 평가에서도 차단한다', async (patch) => {
		const prisma = createPrisma();
		prisma.clientServiceKey.findUnique.mockResolvedValue(createKey(patch));
		const service = new ClientServiceAuthorizationService(
			prisma as unknown as PrismaService,
		);

		await expect(
			service.authorize({
				context,
				action: ClientServiceAction.Read,
				normalizedPath: 'catalog/products/image',
			}),
		).rejects.toBeInstanceOf(ForbiddenException);
	});
});
