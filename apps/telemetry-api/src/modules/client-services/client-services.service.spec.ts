import { ConflictException, NotFoundException } from '@nestjs/common';
import { InMemoryClientServicesRepository } from './client-services.repository';
import { ClientServicesService } from './client-services.service';

const createPayload = {
	slug: 'catalog-api',
	name: 'Catalog API',
	description: '상품 서비스',
	owner: 'commerce-team',
};

describe('클라이언트 서비스 관리 서비스', () => {
	let repository: InMemoryClientServicesRepository;
	let service: ClientServicesService;

	beforeEach(() => {
		repository = new InMemoryClientServicesRepository();
		service = new ClientServicesService(repository);
	});

	it('서비스를 등록하고 상세에서 key count를 반환한다', async () => {
		const created = await service.createService(createPayload);
		const detail = await service.getService(created.id);

		expect(created).toMatchObject({
			slug: 'catalog-api',
			name: 'Catalog API',
			status: 'ACTIVE',
			keyCount: 0,
			activeKeyCount: 0,
		});
		expect(detail.keys).toEqual([]);
	});

	it('중복 slug는 409로 매핑한다', async () => {
		await service.createService(createPayload);

		await expect(service.createService(createPayload)).rejects.toBeInstanceOf(
			ConflictException,
		);
	});

	it('API key를 발급할 때 원문은 응답에 한 번만 포함하고 저장 record에는 hash를 노출하지 않는다', async () => {
		const created = await service.createService(createPayload);
		const result = await service.createKey(created.id, {
			name: 'local backend key',
			scopes: { read: true, upload: true },
		});
		const detail = await service.getService(created.id);

		expect(result.apiKey).toMatch(/^fs_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$/);
		expect(result.key).toMatchObject({
			clientServiceId: created.id,
			name: 'local backend key',
			keyPrefix: expect.any(String),
			scopes: { read: true, upload: true },
		});
		expect(result.key).not.toHaveProperty('keyHash');
		expect(detail.keyCount).toBe(1);
		expect(detail.activeKeyCount).toBe(1);
		expect(detail.keys?.[0]).not.toHaveProperty('keyHash');
	});

	it('API key를 폐기하면 activeKeyCount에서 제외한다', async () => {
		const created = await service.createService(createPayload);
		const { key } = await service.createKey(created.id, {});
		const revoked = await service.revokeKey(created.id, key.id);
		const detail = await service.getService(created.id);

		expect(revoked.revokedAt).toEqual(expect.any(String));
		expect(detail.keyCount).toBe(1);
		expect(detail.activeKeyCount).toBe(0);
	});

	it('없는 서비스의 key 발급은 404로 매핑한다', async () => {
		await expect(service.createKey('missing', {})).rejects.toBeInstanceOf(
			NotFoundException,
		);
	});
});
