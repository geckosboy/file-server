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
const BENCHMARK_SCHEMA = 'stage3_telemetry_benchmark';
const AUTHORITATIVE_CLIENT_SERVICE_ID = 'service-03';

export function authoritativeFixtureStatements() {
	const schema = `"${BENCHMARK_SCHEMA}"`;
	return [
		`DROP TABLE IF EXISTS ${schema}."image_lifecycle_events", ${schema}."image_assets", ${schema}."client_services" CASCADE`,
		`CREATE UNLOGGED TABLE ${schema}."client_services" (LIKE public."client_services" INCLUDING ALL)`,
		`CREATE UNLOGGED TABLE ${schema}."image_assets" (LIKE public."image_assets" INCLUDING ALL)`,
		`CREATE UNLOGGED TABLE ${schema}."image_lifecycle_events" (LIKE public."image_lifecycle_events" INCLUDING ALL)`,
		`INSERT INTO ${schema}."client_services" (
			"id", "slug", "name", "owner", "status", "created_at", "updated_at"
		) VALUES (
			'${AUTHORITATIVE_CLIENT_SERVICE_ID}', '${AUTHORITATIVE_CLIENT_SERVICE_ID}',
			'Stage 3 authoritative benchmark', 'completion-audit', 'ACTIVE', NOW(), NOW()
		)`,
		`INSERT INTO ${schema}."image_assets" (
			"asset_id", "client_service_id", "idempotency_key", "external_image_id",
			"logical_path", "name", "original_name", "storage_key", "content_type",
			"input_bytes", "bytes", "checksum", "width", "height", "format",
			"status", "ready_at", "created_at", "updated_at"
		)
		SELECT DISTINCT ON ("event"."image_key")
			'benchmark-asset-' || md5("event"."image_key"),
			'${AUTHORITATIVE_CLIENT_SERVICE_ID}',
			'benchmark:' || md5("event"."image_key"),
			"event"."image_id", "event"."path", "event"."name", "event"."name",
			"event"."image_key", 'image/jpeg', "event"."input_bytes",
			"event"."output_bytes", md5("event"."image_key"),
			"event"."width", "event"."height", "event"."format",
			'Ready'::public."ImageAssetState", "event"."occurred_at",
			"event"."occurred_at", "event"."occurred_at"
		FROM ${schema}."telemetry_events" AS "event"
		WHERE "event"."client_service_id" = '${AUTHORITATIVE_CLIENT_SERVICE_ID}'
			AND "event"."event_type" = 'image.upload.completed'
			AND "event"."status" = 'success'
		ORDER BY "event"."image_key", "event"."occurred_at" DESC, "event"."event_id" DESC`,
		`ANALYZE ${schema}."client_services"`,
		`ANALYZE ${schema}."image_assets"`,
		`ANALYZE ${schema}."image_lifecycle_events"`,
	];
}

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
		for (const statement of authoritativeFixtureStatements()) {
			await prisma.$executeRawUnsafe(statement);
		}
		const fixture = await readAuthoritativeFixture(prisma);
		const repository = new PrismaAdminAnalyticsRepository(prisma);
		const now = new Date();
		const range = {
			from: new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString(),
			to: now.toISOString(),
		};
		const representative = await repository.listTopImages({
			...range,
			clientServiceSlug: AUTHORITATIVE_CLIENT_SERVICE_ID,
			limit: 50,
		});
		if (representative.items.length === 0) {
			throw new Error(
				'authoritative benchmark returned no representative ImageAsset results',
			);
		}
		if (
			representative.items.some(
				(item) => !item.assetId || item.assetStatus !== 'Ready',
			)
		) {
			throw new Error(
				'authoritative benchmark returned a legacy or non-Ready image result',
			);
		}
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
						clientServiceSlug: AUTHORITATIVE_CLIENT_SERVICE_ID,
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
			schemaVersion: 2,
			benchmark: 'stage3-db-telemetry-application-probe',
			database: sanitizeDatabaseUrl(databaseUrl),
			queryScope: {
				mode: 'built-prisma-repository',
				assetMode: 'authoritative-ImageAsset-with-dual-read-compatible',
				implementation:
					'apps/telemetry-api/dist/.../prisma-admin-analytics.repository.js',
				note: 'This probe measures the actual compiled PrismaAdminAnalyticsRepository path over the 1M fixture. EXPLAIN (ANALYZE, BUFFERS) for equivalent bounded SQL is in benchmark-1m.json.',
			},
			fixture: {
				schema: BENCHMARK_SCHEMA,
				tables: [
					'telemetry_events',
					'client_services',
					'image_assets',
					'image_lifecycle_events',
				],
				authoritativeClientServiceId: AUTHORITATIVE_CLIENT_SERVICE_ID,
				assetDualReadEnabled:
					process.env.IMAGE_ASSET_DUAL_READ_ENABLED !== 'false',
				...fixture,
				representativeResultCount: representative.items.length,
				representativeAssetStatuses: [
					...new Set(representative.items.map((item) => item.assetStatus)),
				],
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

export function withSearchPath(databaseUrl) {
	const url = new URL(databaseUrl);
	url.searchParams.set('options', `-c search_path=${BENCHMARK_SCHEMA},public`);
	return url.toString();
}

async function readAuthoritativeFixture(prisma) {
	const [row] = await prisma.$queryRawUnsafe(`
		SELECT
			(SELECT COUNT(*)::int FROM "image_assets") AS "assetCount",
			(SELECT COUNT(*)::int FROM "client_services") AS "clientServiceCount",
			(SELECT COUNT(DISTINCT "image_key")::int
			 FROM "telemetry_events"
			 WHERE "client_service_id" = '${AUTHORITATIVE_CLIENT_SERVICE_ID}'
				AND "event_type" = 'image.upload.completed'
				AND "status" = 'success'
			) AS "sourceUploadImageCount",
			(SELECT COUNT(*)::int
			 FROM "image_assets" AS "asset"
			 JOIN "telemetry_events" AS "event"
				ON "event"."image_key" = "asset"."storage_key"
				AND "event"."client_service_id" = "asset"."client_service_id"
			 WHERE "event"."occurred_at" >= NOW() - INTERVAL '24 hours'
			) AS "representativeEventMatches"
	`);
	const fixture = {
		assetCount: Number(row?.assetCount ?? 0),
		clientServiceCount: Number(row?.clientServiceCount ?? 0),
		sourceUploadImageCount: Number(row?.sourceUploadImageCount ?? 0),
		representativeEventMatches: Number(row?.representativeEventMatches ?? 0),
	};
	if (
		fixture.assetCount !== fixture.sourceUploadImageCount ||
		fixture.clientServiceCount !== 1 ||
		fixture.representativeEventMatches === 0
	) {
		throw new Error(
			`authoritative benchmark fixture is not representative: ${JSON.stringify(fixture)}`,
		);
	}
	return fixture;
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
