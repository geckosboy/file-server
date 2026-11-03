#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';

const { Pool } = pg;
const BENCHMARK_SCHEMA = 'stage3_telemetry_benchmark';
const TABLE = `"${BENCHMARK_SCHEMA}"."telemetry_events"`;
const DEFAULT_ROWS = 1_000_000;
const DEFAULT_SAMPLES = 20;
const DEFAULT_WARMUPS = 5;
const APPLICATION_LIST_TAKE = 51;
const MAX_APPLICATION_SCAN_ROWS = APPLICATION_LIST_TAKE * 2;
const GATES = Object.freeze({
	listP95Ms: 300,
	dashboardP95Ms: 1_000,
	rssDeltaBytes: 100 * 1024 * 1024,
});

const baselineIndexes = [
	`CREATE INDEX "telemetry_events_client_service_occurred_at_idx" ON ${TABLE}("client_service_id", "occurred_at")`,
	`CREATE INDEX "telemetry_events_event_type_occurred_at_idx" ON ${TABLE}("event_type", "occurred_at")`,
	`CREATE INDEX "telemetry_events_source_app_occurred_at_idx" ON ${TABLE}("source_app", "occurred_at")`,
	`CREATE INDEX "telemetry_events_status_occurred_at_idx" ON ${TABLE}("status", "occurred_at")`,
];

const stage3Indexes = [
	`CREATE INDEX "telemetry_events_occurred_at_event_id_idx" ON ${TABLE}("occurred_at" DESC, "event_id" DESC)`,
	`CREATE INDEX "telemetry_events_client_service_occurred_event_idx" ON ${TABLE}("client_service_id", "occurred_at" DESC, "event_id" DESC)`,
	`CREATE INDEX "telemetry_events_event_type_occurred_event_idx" ON ${TABLE}("event_type", "occurred_at" DESC, "event_id" DESC)`,
	`CREATE INDEX "telemetry_events_source_app_occurred_event_idx" ON ${TABLE}("source_app", "occurred_at" DESC, "event_id" DESC)`,
	`CREATE INDEX "telemetry_events_status_occurred_event_idx" ON ${TABLE}("status", "occurred_at" DESC, "event_id" DESC)`,
];

const firstPageSql = `
	SELECT "event_id", "occurred_at", "event_type", "status", "image_key"
	FROM ${TABLE}
	WHERE "client_service_id" = $1
	ORDER BY "occurred_at" DESC, "event_id" DESC
	LIMIT 51
`;

const middlePageSql = `
	SELECT "event_id", "occurred_at", "event_type", "status", "image_key"
	FROM ${TABLE}
	WHERE "client_service_id" = $1
		AND ("occurred_at", "event_id") < ($2, $3)
	ORDER BY "occurred_at" DESC, "event_id" DESC
	LIMIT 51
`;

const dashboardSql = `
	SELECT
		COUNT(*)::bigint AS "totalEvents",
		COUNT(*) FILTER (
			WHERE "event_type" IN (
				'image.cache.hit', 'image.cache.miss', 'image.read.failed'
			)
		)::bigint AS "totalReads",
		COUNT(*) FILTER (
			WHERE "event_type" = 'image.upload.completed'
		)::bigint AS "totalUploads",
		COUNT(*) FILTER (
			WHERE "event_type" = 'image.resize.completed'
		)::bigint AS "totalResizes",
		COUNT(*) FILTER (WHERE "event_type" = 'image.cache.hit')::bigint AS "cacheHits",
		COUNT(*) FILTER (WHERE "event_type" = 'image.cache.miss')::bigint AS "cacheMisses",
		COUNT(*) FILTER (WHERE "status" = 'failed')::bigint AS "failures",
		AVG("duration_ms") AS "avgDurationMs",
		percentile_disc(0.95) WITHIN GROUP (ORDER BY "duration_ms")
			FILTER (WHERE "duration_ms" IS NOT NULL) AS "p95DurationMs",
		COALESCE(SUM("input_bytes"), 0)::bigint AS "totalInputBytes",
		COALESCE(SUM("output_bytes"), 0)::bigint AS "totalOutputBytes"
	FROM ${TABLE}
	WHERE "occurred_at" >= $1 AND "occurred_at" <= $2
`;

export function createApplicationOperations(
	prisma,
	{ clientServiceId, cursor, dashboardParameters },
) {
	return {
		firstPage: () =>
			prisma.telemetryEvent.findMany({
				where: { clientServiceId },
				orderBy: [{ occurredAt: 'desc' }, { eventId: 'desc' }],
				take: APPLICATION_LIST_TAKE,
			}),
		middlePage: () =>
			prisma.telemetryEvent.findMany({
				where: {
					AND: [
						{ clientServiceId },
						{ occurredAt: { lte: cursor.occurred_at } },
						{
							OR: [
								{ occurredAt: { lt: cursor.occurred_at } },
								{
									occurredAt: cursor.occurred_at,
									eventId: { lt: cursor.event_id },
								},
							],
						},
					],
				},
				orderBy: [{ occurredAt: 'desc' }, { eventId: 'desc' }],
				take: APPLICATION_LIST_TAKE,
			}),
		dashboard24h: () =>
			prisma.$queryRawUnsafe(dashboardSql, ...dashboardParameters),
	};
}

export function parseArgs(argv) {
	const options = {
		rows: DEFAULT_ROWS,
		samples: DEFAULT_SAMPLES,
		warmups: DEFAULT_WARMUPS,
		output: undefined,
		reset: true,
		cleanup: false,
		help: false,
	};
	for (const argument of argv) {
		if (argument === '--help') options.help = true;
		else if (argument === '--no-reset') options.reset = false;
		else if (argument === '--cleanup') options.cleanup = true;
		else if (argument.startsWith('--rows='))
			options.rows = positiveInteger(argument.slice('--rows='.length), 'rows');
		else if (argument.startsWith('--samples='))
			options.samples = positiveInteger(
				argument.slice('--samples='.length),
				'samples',
			);
		else if (argument.startsWith('--warmups='))
			options.warmups = nonNegativeInteger(
				argument.slice('--warmups='.length),
				'warmups',
			);
		else if (argument.startsWith('--output='))
			options.output = argument.slice('--output='.length);
		else throw new Error(`Unknown argument: ${argument}`);
	}
	return options;
}

export function percentile(values, quantile) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((left, right) => left - right);
	const index = Math.ceil(sorted.length * quantile) - 1;
	return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

export function evaluateGates(measurements, applicationPlanBounds) {
	const checks = {
		firstPageP95: measurements.firstPage.p95Ms <= GATES.listP95Ms,
		middlePageP95: measurements.middlePage.p95Ms <= GATES.listP95Ms,
		dashboardP95: measurements.dashboard24h.p95Ms <= GATES.dashboardP95Ms,
		rssDelta:
			Math.max(
				measurements.firstPage.maxRssDeltaBytes,
				measurements.middlePage.maxRssDeltaBytes,
				measurements.dashboard24h.maxRssDeltaBytes,
			) <= GATES.rssDeltaBytes,
		firstPageRowsBounded: applicationPlanBounds.firstPage.bounded,
		middlePageRowsBounded: applicationPlanBounds.middlePage.bounded,
	};
	return { checks, passed: Object.values(checks).every(Boolean) };
}

export function summarizeTelemetryPlan(explainPlan) {
	const summary = {
		scanNodes: 0,
		indexScanNodes: 0,
		actualRows: 0,
		rowsRemovedByFilter: 0,
		rowsRemovedByIndexRecheck: 0,
		totalRowsVisited: 0,
	};
	const root = Array.isArray(explainPlan) ? explainPlan[0]?.Plan : undefined;
	visitPlan(root, (node) => {
		if (node['Relation Name'] !== 'telemetry_events') return;
		const loops = Number(node['Actual Loops'] ?? 1);
		const actualRows = Number(node['Actual Rows'] ?? 0) * loops;
		const removedByFilter = Number(node['Rows Removed by Filter'] ?? 0) * loops;
		const removedByIndexRecheck =
			Number(node['Rows Removed by Index Recheck'] ?? 0) * loops;
		summary.scanNodes += 1;
		if (String(node['Node Type'] ?? '').includes('Index')) {
			summary.indexScanNodes += 1;
		}
		summary.actualRows += actualRows;
		summary.rowsRemovedByFilter += removedByFilter;
		summary.rowsRemovedByIndexRecheck += removedByIndexRecheck;
	});
	summary.totalRowsVisited =
		summary.actualRows +
		summary.rowsRemovedByFilter +
		summary.rowsRemovedByIndexRecheck;
	return summary;
}

export function evaluateApplicationPlanBounds(plans) {
	const evaluate = (plan) => {
		const summary = summarizeTelemetryPlan(plan);
		return {
			...summary,
			bounded:
				summary.scanNodes > 0 &&
				summary.totalRowsVisited <= MAX_APPLICATION_SCAN_ROWS,
		};
	};
	return {
		maxRowsVisited: MAX_APPLICATION_SCAN_ROWS,
		firstPage: evaluate(plans.firstPage),
		middlePage: evaluate(plans.middlePage),
	};
}

export function sanitizeDatabaseUrl(databaseUrl) {
	const parsed = new URL(databaseUrl);
	return `${parsed.protocol}//${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`;
}

function createPrismaQueryCapture(prisma) {
	let activeCapture = null;
	prisma.$on('query', (event) => {
		if (activeCapture && event.query.includes('"telemetry_events"')) {
			activeCapture.push(event);
		}
	});

	return async (operation) => {
		const events = [];
		activeCapture = events;
		try {
			await operation();
		} finally {
			activeCapture = null;
		}
		if (events.length !== 1) {
			throw new Error(
				`Expected one emitted telemetry Prisma query, received ${events.length}`,
			);
		}
		const event = events[0];
		const parameters = JSON.parse(event.params);
		if (!Array.isArray(parameters)) {
			throw new Error('Emitted Prisma query parameters must be an array');
		}
		return {
			query: event.query,
			parameters,
			emittedDurationMs: event.duration,
		};
	};
}

function visitPlan(node, visitor) {
	if (!node || typeof node !== 'object') return;
	visitor(node);
	for (const child of node.Plans ?? []) visitPlan(child, visitor);
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		printHelp();
		return;
	}

	const connectionString = process.env.STAGE3_BENCHMARK_DATABASE_URL;
	if (!connectionString) {
		throw new Error(
			'STAGE3_BENCHMARK_DATABASE_URL is required; use a disposable PostgreSQL database.',
		);
	}

	const pool = new Pool({
		connectionString,
		max: 1,
		application_name: 'stage3-db-telemetry-benchmark',
	});
	const prisma = new PrismaClient({
		adapter: new PrismaPg({ connectionString }, { schema: BENCHMARK_SCHEMA }),
		log: [{ emit: 'event', level: 'query' }],
	});
	const capturePrismaQuery = createPrismaQueryCapture(prisma);
	const startedAt = new Date();
	try {
		await prisma.$connect();
		await prepareFixture(pool, options);
		const versions = await readVersions(pool);
		const cursor = await readMiddleCursor(pool, options.rows);
		const now = new Date();
		const dashboardParameters = [
			new Date(now.getTime() - 24 * 60 * 60 * 1_000),
			now,
		];
		const queryParameters = ['service-03'];
		const middleParameters = [
			'service-03',
			cursor.occurred_at,
			cursor.event_id,
		];
		const application = createApplicationOperations(prisma, {
			clientServiceId: 'service-03',
			cursor,
			dashboardParameters,
		});

		await dropStage3Indexes(pool);
		await pool.query(`ANALYZE ${TABLE}`);
		const before = {
			firstPage: await explain(pool, firstPageSql, queryParameters),
			middlePage: await explain(pool, middlePageSql, middleParameters),
			dashboard24h: await explain(pool, dashboardSql, dashboardParameters),
		};

		await createIndexes(pool, stage3Indexes);
		await pool.query(`ANALYZE ${TABLE}`);
		const after = {
			firstPage: await explain(pool, firstPageSql, queryParameters),
			middlePage: await explain(pool, middlePageSql, middleParameters),
			dashboard24h: await explain(pool, dashboardSql, dashboardParameters),
		};

		const supplementalDirectSqlMeasurements = {
			firstPage: await measure(pool, firstPageSql, queryParameters, options),
			middlePage: await measure(pool, middlePageSql, middleParameters, options),
			dashboard24h: await measure(
				pool,
				dashboardSql,
				dashboardParameters,
				options,
			),
		};
		const measurements = {
			firstPage: await measureOperation(application.firstPage, options),
			middlePage: await measureOperation(application.middlePage, options),
			dashboard24h: await measureOperation(application.dashboard24h, options),
		};
		const capturedApplicationQueries = {
			firstPage: await capturePrismaQuery(application.firstPage),
			middlePage: await capturePrismaQuery(application.middlePage),
		};
		const applicationExplainAnalyzeBuffers = {};
		for (const [name, capturedQuery] of Object.entries(
			capturedApplicationQueries,
		)) {
			const plan = await explain(
				pool,
				capturedQuery.query,
				capturedQuery.parameters,
			);
			applicationExplainAnalyzeBuffers[name] = {
				...capturedQuery,
				plan,
				scan: summarizeTelemetryPlan(plan),
			};
		}
		const applicationPlanBounds = evaluateApplicationPlanBounds({
			firstPage: applicationExplainAnalyzeBuffers.firstPage.plan,
			middlePage: applicationExplainAnalyzeBuffers.middlePage.plan,
		});
		const gates = evaluateGates(measurements, applicationPlanBounds);
		const evidence = {
			schemaVersion: 1,
			benchmark: 'stage3-db-telemetry',
			startedAt: startedAt.toISOString(),
			completedAt: new Date().toISOString(),
			database: sanitizeDatabaseUrl(connectionString),
			versions,
			fixture: {
				rows: options.rows,
				schema: BENCHMARK_SCHEMA,
				tableKind: 'UNLOGGED (read plans match PostgreSQL heap/index scans)',
				deterministicSeed: 'generate_series(1, rows)',
			},
			queryScope: {
				mode: 'application-prisma',
				note: 'List gates execute the Prisma findMany predicates used by PrismaTelemetryRepository and materialize full event rows. Dashboard executes the parameterized raw aggregate through PrismaClient. Direct SQL remains supplemental for EXPLAIN comparison.',
			},
			applicationProbe: {
				client: '@prisma/client with @prisma/adapter-pg',
				schema: BENCHMARK_SCHEMA,
				listTake: APPLICATION_LIST_TAKE,
				middleCursor: {
					occurredAt: cursor.occurred_at,
					eventId: cursor.event_id,
				},
			},
			run: {
				warmups: options.warmups,
				samples: options.samples,
				nodeGcExposed: typeof global.gc === 'function',
			},
			gates: {
				thresholds: GATES,
				...gates,
			},
			measurements,
			applicationExplainAnalyzeBuffers,
			applicationPlanBounds,
			supplementalDirectSqlMeasurements,
			explainAnalyzeBuffers: { before, after },
			stage3IndexNames: stage3Indexes.map(indexName),
		};

		const output = resolve(
			options.output ??
				`artifacts/stage3-db-telemetry/benchmark-${fileTimestamp(startedAt)}.json`,
		);
		await mkdir(dirname(output), { recursive: true });
		await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
		process.stdout.write(
			`${JSON.stringify({ output, ...evidence.gates }, null, 2)}\n`,
		);

		if (options.cleanup) {
			await pool.query(`DROP SCHEMA IF EXISTS "${BENCHMARK_SCHEMA}" CASCADE`);
		}
		if (!gates.passed) process.exitCode = 1;
	} finally {
		await prisma.$disconnect();
		await pool.end();
	}
}

async function prepareFixture(pool, options) {
	if (options.reset) {
		await pool.query(`DROP SCHEMA IF EXISTS "${BENCHMARK_SCHEMA}" CASCADE`);
	}
	await pool.query(`CREATE SCHEMA IF NOT EXISTS "${BENCHMARK_SCHEMA}"`);
	await pool.query(`
		CREATE UNLOGGED TABLE IF NOT EXISTS ${TABLE} (
			"id" text PRIMARY KEY,
			"event_id" text NOT NULL UNIQUE,
			"event_type" text NOT NULL,
			"source_app" text NOT NULL,
			"environment" text NOT NULL,
			"status" text NOT NULL,
			"occurred_at" timestamptz NOT NULL,
			"received_at" timestamptz NOT NULL DEFAULT now(),
			"client_service_id" text,
			"client_service_slug" text,
			"request_id" text,
			"trace_id" text,
			"image_id" integer,
			"path" text NOT NULL,
			"name" text NOT NULL,
			"image_key" text NOT NULL,
			"cache_key" text,
			"width" integer,
			"height" integer,
			"format" text,
			"input_bytes" integer,
			"output_bytes" integer,
			"duration_ms" double precision,
			"error_code" text,
			"error_message" text,
			"raw_payload" jsonb NOT NULL
		)
	`);

	const count = Number(
		(await pool.query(`SELECT COUNT(*)::bigint AS count FROM ${TABLE}`)).rows[0]
			.count,
	);
	if (count !== options.rows) {
		await pool.query(`TRUNCATE TABLE ${TABLE}`);
		await pool.query(
			`
				INSERT INTO ${TABLE} (
					"id", "event_id", "event_type", "source_app", "environment",
					"status", "occurred_at", "received_at", "client_service_id",
					"client_service_slug", "request_id", "trace_id", "image_id",
					"path", "name", "image_key", "cache_key", "width", "height",
					"format", "input_bytes", "output_bytes", "duration_ms",
					"error_code", "error_message", "raw_payload"
				)
				SELECT
					md5(series::text),
					'evt-' || lpad(series::text, 12, '0'),
					(ARRAY[
						'image.cache.hit', 'image.cache.miss', 'image.read.failed',
						'image.upload.completed', 'image.resize.completed'
					])[1 + (series % 5)],
					(ARRAY['storage', 'cache', 'resize'])[1 + (series % 3)],
					'benchmark',
					CASE WHEN series % 20 = 0 THEN 'failed' ELSE 'success' END,
					now() - ((series % 7776000) * INTERVAL '1 second'),
					now() - ((series % 7776000) * INTERVAL '1 second') + INTERVAL '5 milliseconds',
					'service-' || lpad((series % 20)::text, 2, '0'),
					'service-' || lpad((series % 20)::text, 2, '0'),
					'req-' || series,
					'trace-' || series,
					(series % 100000)::integer,
					'catalog/products/image',
					'image-' || (series % 100000) || '.jpg',
					'catalog/products/image/image-' || (series % 100000) || '.jpg',
					CASE WHEN series % 5 = 4 THEN NULL ELSE 'cache-' || (series % 100000) END,
					CASE WHEN series % 5 = 4 THEN 400 ELSE NULL END,
					CASE WHEN series % 5 = 4 THEN 400 ELSE NULL END,
					CASE WHEN series % 3 = 0 THEN 'webp' ELSE 'jpg' END,
					100000 + (series % 500000)::integer,
					50000 + (series % 250000)::integer,
					1 + (series % 1000)::double precision,
					CASE WHEN series % 20 = 0 THEN 'BENCHMARK_FAILURE' ELSE NULL END,
					CASE WHEN series % 20 = 0 THEN 'deterministic benchmark failure' ELSE NULL END,
					jsonb_build_object('fixture', true, 'sequence', series)
				FROM generate_series(1, $1::integer) AS series
			`,
			[options.rows],
		);
	}

	for (const statement of baselineIndexes) {
		const name = indexName(statement);
		const exists = await pool.query(
			`SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = $2`,
			[BENCHMARK_SCHEMA, name],
		);
		if (exists.rowCount === 0) await pool.query(statement);
	}
	await pool.query(`ANALYZE ${TABLE}`);
}

async function readMiddleCursor(pool, rows) {
	const offset = Math.max(0, Math.floor(rows / 20 / 2));
	const result = await pool.query(
		`
			SELECT "event_id", "occurred_at"
			FROM ${TABLE}
			WHERE "client_service_id" = $1
			ORDER BY "occurred_at" DESC, "event_id" DESC
			OFFSET $2 LIMIT 1
		`,
		['service-03', offset],
	);
	if (result.rowCount !== 1) throw new Error('Unable to derive middle cursor');
	return result.rows[0];
}

async function dropStage3Indexes(pool) {
	for (const statement of stage3Indexes) {
		await pool.query(
			`DROP INDEX IF EXISTS "${BENCHMARK_SCHEMA}"."${indexName(statement)}"`,
		);
	}
}

async function createIndexes(pool, statements) {
	for (const statement of statements) await pool.query(statement);
}

async function explain(pool, sql, parameters) {
	const result = await pool.query(
		`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
		parameters,
	);
	return result.rows[0]['QUERY PLAN'];
}

async function measure(pool, sql, parameters, options) {
	return measureOperation(() => pool.query(sql, parameters), options);
}

async function measureOperation(operation, options) {
	for (let index = 0; index < options.warmups; index += 1) {
		await operation();
	}

	const durationsMs = [];
	const rssDeltaBytes = [];
	let resultRows = null;
	for (let index = 0; index < options.samples; index += 1) {
		if (typeof global.gc === 'function') global.gc();
		const beforeRss = process.memoryUsage().rss;
		const started = performance.now();
		const result = await operation();
		durationsMs.push(performance.now() - started);
		rssDeltaBytes.push(Math.max(0, process.memoryUsage().rss - beforeRss));
		resultRows = Array.isArray(result) ? result.length : result.rowCount;
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

async function readVersions(pool) {
	const serverVersion = await pool.query('SHOW server_version');
	return {
		node: process.version,
		postgresql: serverVersion.rows[0].server_version,
		platform: process.platform,
		arch: process.arch,
	};
}

function indexName(statement) {
	const match = statement.match(/CREATE INDEX\s+"([^"]+)"/);
	if (!match) throw new Error(`Index name not found: ${statement}`);
	return match[1];
}

function positiveInteger(value, name) {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(`${name} must be a positive integer`);
	}
	return parsed;
}

function nonNegativeInteger(value, name) {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new Error(`${name} must be a non-negative integer`);
	}
	return parsed;
}

function round(value) {
	return value === null ? null : Math.round(value * 100) / 100;
}

function fileTimestamp(date) {
	return date
		.toISOString()
		.replace(/[-:]/g, '')
		.replace(/\.\d{3}Z$/, 'Z');
}

function printHelp() {
	process.stdout.write(`
Stage 3 DB telemetry benchmark

Required environment:
  STAGE3_BENCHMARK_DATABASE_URL  Disposable PostgreSQL database URL.

Options:
  --rows=N       Deterministic fixture size (default: 1000000)
  --samples=N    Timed samples per query (default: 20)
  --warmups=N    Warm-up executions per query (default: 5)
  --output=PATH  Evidence JSON path
  --no-reset     Reuse the isolated benchmark schema when row count matches
  --cleanup      Drop the isolated benchmark schema after evidence is written
  --help         Show this help

Run with --expose-gc for less noisy RSS deltas:
  STAGE3_BENCHMARK_DATABASE_URL=postgresql://... \\
    node --expose-gc scripts/stage3-db-telemetry-benchmark.mjs
`);
}

const isMain = process.argv[1]
	? fileURLToPath(import.meta.url) === resolve(process.argv[1])
	: false;

if (isMain) {
	main().catch((error) => {
		process.stderr.write(`${error.stack ?? error.message}\n`);
		process.exitCode = 1;
	});
}
