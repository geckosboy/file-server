import {
	ImageLifecycleFailpoint,
	ImageLifecycleFailpointService,
	ImageLifecycleInjectedFailure,
} from '../image-lifecycle.failpoints';

describe('Image lifecycle deterministic failpoints', () => {
	const originalNodeEnv = process.env.NODE_ENV;
	const originalEnabled = process.env.IMAGE_LIFECYCLE_TEST_FAILPOINTS_ENABLED;
	const originalFailpoint = process.env.IMAGE_LIFECYCLE_TEST_FAILPOINT;
	const originalAction = process.env.IMAGE_LIFECYCLE_TEST_FAILPOINT_ACTION;

	afterEach(() => {
		process.env.NODE_ENV = originalNodeEnv;
		restore('IMAGE_LIFECYCLE_TEST_FAILPOINTS_ENABLED', originalEnabled);
		restore('IMAGE_LIFECYCLE_TEST_FAILPOINT', originalFailpoint);
		restore('IMAGE_LIFECYCLE_TEST_FAILPOINT_ACTION', originalAction);
		jest.restoreAllMocks();
	});

	it('fails closed when a failpoint leaks outside the explicit test gate', () => {
		process.env.NODE_ENV = 'production';
		process.env.IMAGE_LIFECYCLE_TEST_FAILPOINT =
			ImageLifecycleFailpoint.AfterPending;
		delete process.env.IMAGE_LIFECYCLE_TEST_FAILPOINTS_ENABLED;

		expect(() =>
			new ImageLifecycleFailpointService().trigger(
				ImageLifecycleFailpoint.AfterPending,
			),
		).toThrow(
			'IMAGE_LIFECYCLE_TEST_FAILPOINT is configured outside the explicit test-only gate',
		);
	});

	it('injects only the exact named boundary under the test-only gate', () => {
		process.env.NODE_ENV = 'test';
		process.env.IMAGE_LIFECYCLE_TEST_FAILPOINTS_ENABLED = 'true';
		process.env.IMAGE_LIFECYCLE_TEST_FAILPOINT =
			ImageLifecycleFailpoint.AfterStageChecksum;
		const service = new ImageLifecycleFailpointService();

		expect(() =>
			service.trigger(ImageLifecycleFailpoint.AfterStageWrite),
		).not.toThrow();
		expect(() =>
			service.trigger(ImageLifecycleFailpoint.AfterStageChecksum),
		).toThrow(ImageLifecycleInjectedFailure);
	});

	it('can terminate a test process at an exact crash boundary', () => {
		process.env.NODE_ENV = 'test';
		process.env.IMAGE_LIFECYCLE_TEST_FAILPOINTS_ENABLED = 'true';
		process.env.IMAGE_LIFECYCLE_TEST_FAILPOINT =
			ImageLifecycleFailpoint.AfterPending;
		process.env.IMAGE_LIFECYCLE_TEST_FAILPOINT_ACTION = 'exit';
		const exit = jest.spyOn(process, 'exit').mockImplementation((() => {
			throw new Error('process-exit-86');
		}) as never);

		expect(() =>
			new ImageLifecycleFailpointService().trigger(
				ImageLifecycleFailpoint.AfterPending,
			),
		).toThrow('process-exit-86');
		expect(exit).toHaveBeenCalledWith(86);
	});
});

function restore(name: string, value: string | undefined) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}
