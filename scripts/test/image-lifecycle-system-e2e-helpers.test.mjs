import assert from 'node:assert/strict';
import test from 'node:test';

import {
	assertVariantIndependentLatency,
	parseLastJsonLine,
	percentile,
	imageLifecycleFixtureId,
} from '../image-lifecycle-system-e2e-helpers.mjs';

test('parses a final JSON envelope after command diagnostics', () => {
	assert.deepEqual(
		parseLastJsonLine('starting\n{"inserted":0,"dryRun":false}'),
		{
			inserted: 0,
			dryRun: false,
		},
	);
});

test('uses deterministic nearest-rank latency percentiles', () => {
	assert.equal(percentile([40, 10, 30, 20], 0.5), 20);
	assert.equal(percentile([40, 10, 30, 20], 0.95), 40);
});

test('accepts bounded fixed upload overhead and rejects linear growth', () => {
	const bounded = {
		0: [100, 110],
		1: [105, 115],
		5: [120, 125],
		20: [140, 150],
	};
	assert.equal(assertVariantIndependentLatency(bounded)[20].p95Ms, 150);
	assert.throws(
		() =>
			assertVariantIndependentLatency(
				{ 0: [100], 1: [200], 5: [600], 20: [2_500] },
				{ fixedBudgetMs: 100, maxRatio: 2 },
			),
		/upload p95 scaled with variant count/,
	);
});

test('normalizes isolated fixture identifiers', () => {
	assert.equal(
		imageLifecycleFixtureId('Kafka ACL', 42),
		'image-lifecycle-e2e-kafka-acl-42',
	);
});
