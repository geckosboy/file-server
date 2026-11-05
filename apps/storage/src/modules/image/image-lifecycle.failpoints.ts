import { Injectable } from '@nestjs/common';

export const ImageLifecycleFailpoint = {
	AfterPending: 'after-pending',
	AfterStageWrite: 'after-stage-write',
	BeforeStageChecksum: 'before-stage-checksum',
	AfterStageChecksum: 'after-stage-checksum',
	BeforePromote: 'before-promote',
	AfterPromote: 'after-promote',
	BeforeReadyTransaction: 'before-ready-transaction',
	AfterReadyTransaction: 'after-ready-transaction',
} as const;

export type ImageLifecycleFailpoint =
	(typeof ImageLifecycleFailpoint)[keyof typeof ImageLifecycleFailpoint];

export class ImageLifecycleInjectedFailure extends Error {
	constructor(readonly failpoint: ImageLifecycleFailpoint) {
		super(`Image lifecycle injected failure: ${failpoint}`);
		this.name = ImageLifecycleInjectedFailure.name;
	}
}

@Injectable()
export class ImageLifecycleFailpointService {
	trigger(failpoint: ImageLifecycleFailpoint): void {
		const configured = process.env.IMAGE_LIFECYCLE_TEST_FAILPOINT?.trim();
		if (!configured) return;
		if (
			process.env.NODE_ENV !== 'test' ||
			process.env.IMAGE_LIFECYCLE_TEST_FAILPOINTS_ENABLED !== 'true'
		) {
			throw new Error(
				'IMAGE_LIFECYCLE_TEST_FAILPOINT is configured outside the explicit test-only gate',
			);
		}
		if (configured === failpoint) {
			if (process.env.IMAGE_LIFECYCLE_TEST_FAILPOINT_ACTION === 'exit') {
				process.exit(86);
			}
			throw new ImageLifecycleInjectedFailure(failpoint);
		}
	}
}
