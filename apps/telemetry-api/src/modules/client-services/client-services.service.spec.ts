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

	it('lifecycle subscription을 등록하고 서비스 상세에서 반환한다', async () => {
		const created = await service.createService(createPayload);
		const subscription = await service.createLifecycleSubscription(created.id, {
			eventType: 'image.upload.completed',
			consumerGroup: 'catalog-image-consumer',
			description: '상품 서비스가 업로드 완료 이벤트를 소비합니다.',
		});
		const detail = await service.getService(created.id);

		expect(subscription).toMatchObject({
			clientServiceId: created.id,
			eventType: 'image.upload.completed',
			consumerGroup: 'catalog-image-consumer',
			isEnabled: true,
			description: '상품 서비스가 업로드 완료 이벤트를 소비합니다.',
		});
		expect(detail.subscriptionCount).toBe(1);
		expect(detail.activeSubscriptionCount).toBe(1);
		expect(detail.lifecycleSubscriptions).toEqual([
			expect.objectContaining({
				eventType: 'image.upload.completed',
				consumerGroup: 'catalog-image-consumer',
			}),
		]);
	});

	it('lifecycle subscription을 수정하고 비활성화한다', async () => {
		const created = await service.createService(createPayload);
		const subscription = await service.createLifecycleSubscription(created.id, {
			eventType: 'image.upload.completed',
			consumerGroup: 'catalog-image-consumer',
		});

		const updated = await service.updateLifecycleSubscription(
			created.id,
			subscription.id,
			{
				eventType: 'image.upload.failed',
				consumerGroup: 'catalog-image-failure-consumer',
				isEnabled: false,
				description: '실패 이벤트만 임시 소비합니다.',
			},
		);
		const detail = await service.getService(created.id);

		expect(updated).toMatchObject({
			eventType: 'image.upload.failed',
			consumerGroup: 'catalog-image-failure-consumer',
			isEnabled: false,
			description: '실패 이벤트만 임시 소비합니다.',
		});
		expect(detail.activeSubscriptionCount).toBe(0);
	});

	it('같은 서비스의 eventType/consumerGroup 중복 subscription은 409로 매핑한다', async () => {
		const created = await service.createService(createPayload);
		const payload = {
			eventType: 'image.upload.completed',
			consumerGroup: 'catalog-image-consumer',
		};

		await service.createLifecycleSubscription(created.id, payload);

		await expect(
			service.createLifecycleSubscription(created.id, payload),
		).rejects.toBeInstanceOf(ConflictException);
	});

	it('이미지 리사이징 정책을 기본 on-demand로 만들고 pre-generate로 전환한다', async () => {
		const created = await service.createService(createPayload);

		const initialPolicy = await service.getImageResizePolicy(created.id);
		expect(initialPolicy).toMatchObject({
			clientServiceId: created.id,
			mode: 'ON_DEMAND',
			variants: [],
		});

		const updatedPolicy = await service.updateImageResizePolicy(created.id, {
			mode: 'PRE_GENERATE',
		});

		expect(updatedPolicy.mode).toBe('PRE_GENERATE');
	});

	it('pre-generate 대상 variant를 등록, 수정, 삭제한다', async () => {
		const created = await service.createService(createPayload);

		const variant = await service.createImageResizeVariant(created.id, {
			width: 400,
			height: 400,
			format: 'webp',
			description: '상품 썸네일',
		});
		expect(variant).toMatchObject({
			width: 400,
			height: 400,
			format: 'webp',
			isEnabled: true,
			description: '상품 썸네일',
		});

		const disabled = await service.updateImageResizeVariant(
			created.id,
			variant.id,
			{
				isEnabled: false,
				description: '임시 비활성화',
			},
		);
		expect(disabled).toMatchObject({
			isEnabled: false,
			description: '임시 비활성화',
		});

		const policy = await service.getImageResizePolicy(created.id);
		expect(policy.variants).toEqual([
			expect.objectContaining({
				id: variant.id,
				isEnabled: false,
			}),
		]);

		const deleted = await service.deleteImageResizeVariant(
			created.id,
			variant.id,
		);
		expect(deleted.id).toBe(variant.id);
		await expect(
			service.updateImageResizeVariant(created.id, variant.id, {
				isEnabled: true,
			}),
		).rejects.toBeInstanceOf(NotFoundException);
	});

	it('같은 서비스의 width/height/format 중복 variant는 409로 매핑한다', async () => {
		const created = await service.createService(createPayload);
		const payload = { width: 800, height: 600, format: 'webp' };

		await service.createImageResizeVariant(created.id, payload);

		await expect(
			service.createImageResizeVariant(created.id, payload),
		).rejects.toBeInstanceOf(ConflictException);
	});
});
