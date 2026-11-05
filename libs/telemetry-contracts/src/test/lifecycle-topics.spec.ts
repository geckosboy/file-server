import {
	createClientLifecyclePrincipal,
	createClientLifecycleTopic,
	isCanonicalLifecycleTopic,
} from '../lifecycle-topics';

describe('client lifecycle Kafka topics', () => {
	it('derives a stable topic and principal from the persisted service id', () => {
		expect(createClientLifecycleTopic('Svc_ABC-123')).toBe(
			'file.image.lifecycle.client.svc_abc-123.v1',
		);
		expect(createClientLifecyclePrincipal('Svc_ABC-123')).toBe(
			'User:file-lifecycle-svc_abc-123',
		);
	});

	it.each(['', 'service.with.dot', '../service', 'service name'])(
		'rejects unsafe service ids instead of accepting caller-controlled topics: %s',
		(clientServiceId) => {
			expect(() => createClientLifecycleTopic(clientServiceId)).toThrow();
		},
	);

	it('distinguishes the internal canonical topic', () => {
		expect(isCanonicalLifecycleTopic('file.image.lifecycle.v1')).toBe(true);
		expect(
			isCanonicalLifecycleTopic('file.image.lifecycle.client.service-1.v1'),
		).toBe(false);
	});
});
