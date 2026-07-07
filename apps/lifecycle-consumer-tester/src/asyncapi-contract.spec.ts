import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	IMAGE_LIFECYCLE_SCHEMA_VERSION,
	IMAGE_LIFECYCLE_TOPIC,
	ImageLifecycleEnvironment,
	ImageLifecycleEventType,
	ImageLifecycleFormat,
	ImageLifecycleSourceApp,
	ImageLifecycleStatus,
} from '@file/telemetry-contracts/lifecycle';

describe('file image lifecycle AsyncAPI contract', () => {
	const asyncApiDocument = readFileSync(
		resolve(
			__dirname,
			'../../..',
			'docs/asyncapi/file-image-lifecycle.asyncapi.yaml',
		),
		'utf8',
	);

	it('공통 lifecycle contract 상수와 같은 topic/event/schema 값을 문서화한다', () => {
		expect(asyncApiDocument).toContain('asyncapi: 3.1.0');
		expect(asyncApiDocument).toContain(`address: ${IMAGE_LIFECYCLE_TOPIC}`);
		expect(asyncApiDocument).toContain(
			`enum: [${IMAGE_LIFECYCLE_SCHEMA_VERSION}]`,
		);

		for (const value of Object.values(ImageLifecycleEventType)) {
			expect(asyncApiDocument).toContain(value);
		}
		for (const value of Object.values(ImageLifecycleSourceApp)) {
			expect(asyncApiDocument).toContain(value);
		}
		for (const value of Object.values(ImageLifecycleEnvironment)) {
			expect(asyncApiDocument).toContain(value);
		}
		for (const value of Object.values(ImageLifecycleStatus)) {
			expect(asyncApiDocument).toContain(value);
		}
		for (const value of Object.values(ImageLifecycleFormat)) {
			expect(asyncApiDocument).toContain(value);
		}
	});
});
