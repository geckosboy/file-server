#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const DEFAULT_SAMPLES = 20;
const DEFAULT_WARMUPS = 5;
const LIST_P95_GATE_MS = 300;
const DASHBOARD_P95_GATE_MS = 1_000;
const RSS_GATE_BYTES = 100 * 1024 * 1024;

async function main() {
	const databaseUrl = process.env.STAGE3_BENCHMARK_DATABASE_URL;
	if (!databaseUrl) {
		throw new Error(
			'STAGE3_BENCHMARK_DATABASE_URL is required; run against the disposable 1M benchmark database.',
		);
	}

	const samples = parsePositiveInteger(
		process.env.STAGE3_APP_BENCHMARK_SAMPLES,
		DEFAULT_SAMPLES,
	);
	const warmups = parseNonNegativeInteger(
		process.env.STAGE3_APP_BENCHMARK_WARMUPS,
		DEFAULT_WARMUPS,
	);
	const output = resolve(
		process.env.STAGE3_APP_BENCHMARK_OUTPUT ??
			'artifacts/stage3-db-telemetry/app-probe-1m.json',
	);

	// The benchmark fixture is isolated in its own schema. URL-level options
	// apply search_path to every pooled Prisma connection, unlike SET LOCAL.
	process.env.DATABASE_URL = withSearchPath(databaseUrl);
	const { PrismaService } =
		await import('../libs/database/dist/prisma.service.js');
	const { PrismaAdminAnalyticsRepository } =
		await import('../apps/telemetry-api/dist/apps/telemetry-api/src/modules/admin/prisma-admin-analytics.repository.js');
	const prisma = new PrismaService();
	await prisma.$connect();

	try {
		const repository = new PrismaAdminAnalyticsRepository(prisma);
		const now = new Date();
		const range = {
			from: new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString(),
			to: now.toISOString(),
		};
		const measurements = {
			summary: await measure(
				() => repository.getSummary(range),
				warmups,
				samples,
			),
			timeseries: await measure(
				() => repository.getTimeseries({ ...range, interval: 'hour' }),
				warmups,
				samples,
			),
			topImages: await measure(
				() =>
					repository.listTopImages({
						...range,
						clientServiceSlug: 'service-03',
						limit: 50,
					}),
				warmups,
				samples,
			),
		};

		const checks = {
			topImagesP95: measurements.topImages.p95Ms <= LIST_P95_GATE_MS,
			summaryP95: measurements.summary.p95Ms <= DASHBOARD_P95_GATE_MS,
			timeseriesP95: measurements.timeseries.p95Ms <= DASHBOARD_P95_GATE_MS,
			rssDelta:
				Math.max(
					measurements.summary.maxRssDeltaBytes,
					measurements.timeseries.maxRssDeltaBytes,
					measurements.topImages.maxRssDeltaBytes,
				) <= RSS_GATE_BYTES,
		};
		const evidence = {
			schemaVersion: 1,
			benchmark: 'stage3-db-telemetry-application-probe',
			database: sanitizeDatabaseUrl(databaseUrl),
			queryScope: {
				mode: 'built-prisma-repository',
				implementation:
					'apps/telemetry-api/dist/.../prisma-admin-analytics.repository.js',
				note: 'This probe measures the actual compiled PrismaAdminAnalyticsRepository path over the 1M fixture. EXPLAIN (ANALYZE, BUFFERS) for equivalent bounded SQL is in benchmark-1m.json.',
			},
			run: {
				rows: 1_000_000,
				warmups,
				samples,
				node: process.version,
				nodeGcExposed: typeof global.gc === 'function',
			},
			gates: {
				thresholds: {
					topImagesP95Ms: LIST_P95_GATE_MS,
					summaryP95Ms: DASHBOARD_P95_GATE_MS,
					timeseriesP95Ms: DASHBOARD_P95_GATE_MS,
					rssDeltaBytes: RSS_GATE_BYTES,
				},
				checks,
				passed: Object.values(checks).every(Boolean),
			},
			measurements,
		};

		await mkdir(dirname(output), { recursive: true });
		await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
		process.stdout.write(
			`${JSON.stringify({ output, ...evidence.gates }, null, 2)}\n`,
		);
		if (!evidence.gates.passed) process.exitCode = 1;
	} finally {
		await prisma.$disconnect();
	}
}

async function measure(operation, warmups, samples) {
	for (let index = 0; index < warmups; index += 1) {
		await operation();
	}
	const durationsMs = [];
	const rssDeltaBytes = [];
	let resultRows = null;
	for (let index = 0; index < samples; index += 1) {
		if (typeof global.gc === 'function') global.gc();
		const beforeRss = process.memoryUsage().rss;
		const started = performance.now();
		const result = await operation();
		durationsMs.push(performance.now() - started);
		rssDeltaBytes.push(Math.max(0, process.memoryUsage().rss - beforeRss));
		resultRows = Array.isArray(result?.items)
			? result.items.length
			: Array.isArray(result?.points)
				? result.points.length
				: 1;
	}
	return {
		resultRows,
		p50Ms: round(percentile(durationsMs, 0.5)),
		p95Ms: round(percentile(durationsMs, 0.95)),
		maxMs: round(Math.max(...durationsMs)),
		maxRssDeltaBytes: Math.max(...rssDeltaBytes),
		durationsMs: durationsMs.map(round),
	};
}

function withSearchPath(databaseUrl) {
	const url = new URL(databaseUrl);
	url.searchParams.set('options', '-c search_path=stage3_telemetry_benchmark');
	return url.toString();
}

function sanitizeDatabaseUrl(databaseUrl) {
	const url = new URL(databaseUrl);
	return `${url.protocol}//${url.hostname}:${url.port || '5432'}${url.pathname}`;
}

function percentile(values, quantile) {
	const sorted = [...values].sort((left, right) => left - right);
	const index = Math.ceil(sorted.length * quantile) - 1;
	return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

function parsePositiveInteger(value, fallback) {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error('benchmark sample count must be a positive integer');
	}
	return parsed;
}

function parseNonNegativeInteger(value, fallback) {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new Error('benchmark warmup count must be a non-negative integer');
	}
	return parsed;
}

function round(value) {
	return Math.round(value * 100) / 100;
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	main().catch((error) => {
		process.stderr.write(`${error.stack ?? error.message}\n`);
		process.exitCode = 1;
	});
}
