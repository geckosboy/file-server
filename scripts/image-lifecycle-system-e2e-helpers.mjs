import assert from 'node:assert/strict';

export const IMAGE_LIFECYCLE_UPLOAD_VARIANT_BUCKETS = Object.freeze([
	0, 1, 5, 20,
]);

export const parseLastJsonLine = (output) => {
	const lines = String(output)
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		try {
			return JSON.parse(lines[index]);
		} catch {
			// Commands may print non-JSON diagnostics before their result envelope.
		}
	}
	throw new Error(`JSON result line not found: ${String(output).slice(-500)}`);
};

export const percentile = (values, percentileRank) => {
	assert.ok(values.length > 0, 'percentile requires at least one sample');
	assert.ok(
		percentileRank >= 0 && percentileRank <= 1,
		'percentile rank must be between 0 and 1',
	);
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.ceil(percentileRank * sorted.length) - 1] ?? sorted[0];
};

export const summarizeLatencyBuckets = (samplesByVariantCount) =>
	Object.fromEntries(
		Object.entries(samplesByVariantCount).map(([variantCount, samples]) => [
			variantCount,
			{
				count: samples.length,
				p50Ms: percentile(samples, 0.5),
				p95Ms: percentile(samples, 0.95),
				maxMs: Math.max(...samples),
			},
		]),
	);

export const assertVariantIndependentLatency = (
	samplesByVariantCount,
	{
		buckets = IMAGE_LIFECYCLE_UPLOAD_VARIANT_BUCKETS,
		fixedBudgetMs = 750,
		maxRatio = 2,
	} = {},
) => {
	for (const bucket of buckets) {
		assert.ok(
			Array.isArray(samplesByVariantCount[bucket]) &&
				samplesByVariantCount[bucket].length > 0,
			`missing upload latency samples for ${bucket} variants`,
		);
	}
	const summary = summarizeLatencyBuckets(samplesByVariantCount);
	const baseline = summary[0].p95Ms;
	const largest = summary[buckets.at(-1)].p95Ms;
	const allowed = Math.max(baseline + fixedBudgetMs, baseline * maxRatio);
	assert.ok(
		largest <= allowed,
		`upload p95 scaled with variant count: baseline=${baseline}ms largest=${largest}ms allowed=${allowed}ms`,
	);
	return summary;
};

export const imageLifecycleFixtureId = (scope, pid = process.pid) =>
	`image-lifecycle-e2e-${scope}-${pid}`
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, '-');
