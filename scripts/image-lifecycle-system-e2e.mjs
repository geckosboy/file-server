import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	access,
	mkdir,
	readFile,
	readdir,
	rename,
	rm,
	utimes,
	writeFile,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { Kafka, logLevel } from 'kafkajs';
import pg from 'pg';

import {
	createInfrastructureConfig,
	fetchJson,
	getFreePort,
	migrateDatabase,
	poll,
	printChildLogs,
	repoRoot,
	run,
	runCapture,
	sleep,
	spawnService,
	stopChild,
	stopInfrastructure,
	startInfrastructure,
	waitForHttp,
} from './system-test-utils.mjs';
import {
	IMAGE_LIFECYCLE_UPLOAD_VARIANT_BUCKETS,
	assertVariantIndependentLatency,
	parseLastJsonLine,
	imageLifecycleFixtureId,
} from './image-lifecycle-system-e2e-helpers.mjs';

const { Pool } = pg;
const fixturePrefix = imageLifecycleFixtureId('system');
const infrastructure = await createInfrastructureConfig(
	'image-lifecycle-system-e2e',
);
const children = [];
// The production bundle resolves the storage application's Root from its compiled
// enum directory, so production-process filesystem assertions must use that same
// root rather than the TypeScript source directory.
const storageRuntimeRoot = resolve(repoRoot, 'apps/storage/dist/apps/storage');
const storageAssetRoot = resolve(storageRuntimeRoot, 'assets');
const storageTempRoot = resolve(storageRuntimeRoot, 'temp');
const ports = {
	telemetry: await getFreePort(),
	storage: await getFreePort(),
	resize: await getFreePort(),
	cacheA: await getFreePort(),
	cacheB: await getFreePort(),
	faultStorage: await getFreePort(),
};
const urls = Object.fromEntries(
	Object.entries(ports).map(([name, port]) => [
		name,
		`http://127.0.0.1:${port}`,
	]),
);
const adminToken = `${fixturePrefix}-admin`;
const internalApiKey = `${fixturePrefix}-internal`;
const clientApiKeyPepper = `${fixturePrefix}-pepper`;
const imagePath = `${fixturePrefix}/image`;
const variantTopic = 'file.image.variant.jobs.v1';
const variantDlqTopic = `${variantTopic}.dlq`;
const invalidationTopic = 'file.image.cache-invalidation.v1';
const invalidationDlqTopic = `${invalidationTopic}.dlq`;
const stages = new Set(
	(
		process.env.IMAGE_LIFECYCLE_E2E_PHASES ??
		'migration,backfill,reconciliation,apps,kafka,delete'
	)
		.split(',')
		.map((value) => value.trim())
		.filter(Boolean),
);
const uploadSamples = readPositiveInteger(
	process.env.IMAGE_LIFECYCLE_E2E_UPLOAD_SAMPLES,
	12,
);
const pool = new Pool({ connectionString: infrastructure.databaseUrl, max: 8 });
let cleanupStarted = false;

const commonAppEnv = {
	NODE_ENV: 'production',
	HOST: '127.0.0.1',
	ORIGIN_LIST_STR: 'http://127.0.0.1:43999',
	DATABASE_URL: infrastructure.databaseUrl,
	KAFKA_CLIENT_BROKERS: infrastructure.kafkaBroker,
	CLIENT_API_KEY_PEPPER: clientApiKeyPepper,
	INTERNAL_API_KEY: internalApiKey,
};
const adminHeaders = {
	'content-type': 'application/json',
	'x-admin-token': adminToken,
	'x-admin-actor': 'image-lifecycle-system-e2e',
	'x-request-id': `${fixturePrefix}-admin-request`,
};

const cleanup = async () => {
	if (cleanupStarted) return;
	cleanupStarted = true;
	for (const child of children.reverse()) await stopChild(child);
	await pool.end().catch(() => undefined);
	await rm(resolve(storageAssetRoot, fixturePrefix), {
		recursive: true,
		force: true,
	}).catch(() => undefined);
	await rm(resolve(storageTempRoot, `${fixturePrefix}-inbound.tmp`), {
		force: true,
	}).catch(() => undefined);
	await stopInfrastructure(infrastructure);
	await assertDockerResourcesRemoved(infrastructure.project);
};

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.once(signal, () => {
		void cleanup().finally(() =>
			process.exit(128 + (signal === 'SIGINT' ? 2 : 15)),
		);
	});
}

let failed = false;
try {
	await assertStaticPrerequisites();
	if (process.env.IMAGE_LIFECYCLE_E2E_SKIP_BUILD !== '1') {
		await run('pnpm', ['db:generate']);
		await run('pnpm', [
			'turbo',
			'run',
			'build',
			'--filter=@file/storage',
			'--filter=@file/resize',
			'--filter=@file/cache',
			'--filter=@file/telemetry-api',
		]);
	}
	await startInfrastructure(infrastructure);
	await migrateDatabase(infrastructure);
	await assertImageAssetMigrations();
	if (stages.has('migration')) await assertMigrationIdempotency();
	if (stages.has('backfill')) await assertBackfillIdempotency();
	const reconciliationFixture = stages.has('reconciliation')
		? await prepareReconciliationFixtureAndAssertLease()
		: undefined;
	if (stages.has('apps')) {
		await startApplications();
		if (reconciliationFixture) {
			await assertProductionReconciliation(reconciliationFixture);
		}
		const tenant = await provisionTenant();
		await assertProcessBoundaryRecovery(tenant);
		const latency = await assertUploadLatency(tenant);
		await assertAuthoritativeAdminReads(tenant);
		if (stages.has('kafka'))
			await assertKafkaDeliverySemantics(tenant, latency);
		if (stages.has('delete'))
			await assertDeleteCleanup(tenant, latency.deleteTarget);
	}
	console.log(
		JSON.stringify({
			event: 'image_lifecycle_system_e2e_passed',
			project: infrastructure.project,
			stages: [...stages],
		}),
	);
} catch (error) {
	failed = true;
	console.error(error);
	printChildLogs(children);
} finally {
	await cleanup();
}

if (failed) process.exitCode = 1;

async function assertStaticPrerequisites() {
	for (const path of [
		'prisma/migrations/000010_add_authoritative_image_assets/migration.sql',
		'scripts/image-asset-backfill.mjs',
	]) {
		await access(resolve(repoRoot, path)).catch(() => {
			throw new Error(
				`Image lifecycle integration prerequisite missing: ${path}. Run this harness only after worker integration.`,
			);
		});
	}
	const indexMigration = await readFile(
		resolve(
			repoRoot,
			'prisma/migrations/000011_add_image_asset_backfill_indexes/migration.sql',
		),
		'utf8',
	);
	for (const indexName of [
		'telemetry_events_image_asset_backfill_idx',
		'image_lifecycle_events_image_asset_backfill_idx',
	]) {
		assert.match(
			indexMigration,
			new RegExp(
				`CREATE INDEX CONCURRENTLY IF NOT EXISTS[\\s\\S]*"${indexName}"`,
			),
			`${indexName} migration must use online index creation`,
		);
	}
}

async function assertImageAssetMigrations() {
	const { rows } = await pool.query(`
		SELECT to_regclass('public.image_assets') AS assets,
			to_regclass('public.image_variants') AS variants,
			to_regclass('public.image_variant_jobs') AS jobs,
			to_regclass('public.image_reconciliation_leases') AS leases,
			to_regclass('public.image_reconciliation_metrics') AS metrics
	`);
	for (const [name, value] of Object.entries(rows[0])) {
		assert.ok(value, `Image asset migration table missing: ${name}`);
	}
	const indexes = await pool.query(`
		SELECT index_class.relname AS name, index_meta.indisvalid, index_meta.indisready
		FROM pg_index AS index_meta
		JOIN pg_class AS index_class ON index_class.oid = index_meta.indexrelid
		WHERE index_class.relname IN (
			'telemetry_events_image_asset_backfill_idx',
			'image_lifecycle_events_image_asset_backfill_idx'
		)
		ORDER BY index_class.relname
	`);
	assert.equal(
		indexes.rows.length,
		2,
		'Image asset backfill indexes must both exist',
	);
	for (const index of indexes.rows) {
		assert.equal(index.indisvalid, true, `${index.name} must be valid`);
		assert.equal(index.indisready, true, `${index.name} must be ready`);
	}
}

async function assertMigrationIdempotency() {
	const first = await runCapture('pnpm', ['db:migrate:deploy'], {
		env: { ...process.env, DATABASE_URL: infrastructure.databaseUrl },
		includeStderr: true,
	});
	const second = await runCapture('pnpm', ['db:migrate:deploy'], {
		env: { ...process.env, DATABASE_URL: infrastructure.databaseUrl },
		includeStderr: true,
	});
	const { rows } = await pool.query(`
		SELECT migration_name, COUNT(*)::int AS count
		FROM _prisma_migrations
		WHERE migration_name IN (
			'000010_add_authoritative_image_assets',
			'000011_add_image_asset_backfill_indexes'
		)
			AND finished_at IS NOT NULL AND rolled_back_at IS NULL
		GROUP BY migration_name
		ORDER BY migration_name
	`);
	assert.deepEqual(rows, [
		{
			migration_name: '000010_add_authoritative_image_assets',
			count: 1,
		},
		{
			migration_name: '000011_add_image_asset_backfill_indexes',
			count: 1,
		},
	]);
	assert.match(`${first}\n${second}`, /000010|000011|No pending migrations/i);
}

async function assertBackfillIdempotency() {
	await seedBackfillFixtures();
	const before = await scalar('SELECT COUNT(*)::int FROM image_assets');
	const dry = await runBackfill({ dryRun: true });
	assert.equal(dry.dryRun, true);
	assert.equal(await scalar('SELECT COUNT(*)::int FROM image_assets'), before);
	const incomplete = await runBackfill({
		dryRun: true,
		maxBatches: 1,
		expectedExitCode: 2,
	});
	assert.equal(incomplete.event, 'image_asset_backfill_incomplete');
	assert.equal(incomplete.snapshotComplete, false);
	assert.equal(incomplete.selected, 1);
	assert.equal(incomplete.remaining, 2);
	assert.equal(await scalar('SELECT COUNT(*)::int FROM image_assets'), before);
	const first = await runBackfill({ dryRun: false });
	await insertSuccessfulDeleteFixture({
		suffix: 'backfill-delete-after-snapshot',
		source: 'lifecycle',
	});
	const second = await runBackfill({ dryRun: false });
	const zeroBeforeDrain = await runBackfill({
		dryRun: false,
		cutoverAudit: true,
		expectedExitCode: 2,
	});
	await insertLifecycleUploadFixture({ suffix: 'backfill-delayed-ingest' });
	const cutoverAudit = await runBackfill({
		dryRun: false,
		cutoverAudit: true,
		ingestionDrainConfirmed: true,
	});
	assert.equal(first.inserted, 3);
	assert.ok(
		first.batches >= 2,
		'backfill must execute multiple bounded batches',
	);
	assert.equal(second.inserted, 0);
	assert.equal(second.tombstoned, 1);
	assert.equal(
		zeroBeforeDrain.event,
		'image_asset_backfill_cutover_incomplete',
	);
	assert.equal(zeroBeforeDrain.auditCandidates, 0);
	assert.equal(zeroBeforeDrain.ingestionDrainConfirmed, false);
	assert.equal(zeroBeforeDrain.cutoverReady, false);
	assert.equal(cutoverAudit.event, 'image_asset_backfill_cutover_ready');
	assert.equal(cutoverAudit.inserted, 1);
	assert.equal(cutoverAudit.ingestionDrainConfirmed, true);
	assert.equal(cutoverAudit.cutoverReady, true);
	assert.equal(cutoverAudit.auditCandidates, 0);
	assert.equal(cutoverAudit.auditTombstoneGaps, 0);
	assert.equal(
		await scalar(`
			SELECT COUNT(*)::int FROM image_assets
			WHERE source_event_id IN (
				'${fixturePrefix}-backfill-ready',
				'${fixturePrefix}-backfill-lifecycle-only'
			)
				AND status = 'Ready'
		`),
		2,
		'telemetry and lifecycle-only uploads must both be backfilled',
	);
	assert.equal(
		await scalar(`
			SELECT COUNT(*)::int FROM image_assets
			WHERE source_event_id IN (
				'${fixturePrefix}-backfill-deleted-telemetry',
				'${fixturePrefix}-backfill-deleted-lifecycle'
			)
		`),
		0,
		'later successful delete events must prevent legacy upload resurrection',
	);
	assert.equal(
		await scalar(`
			SELECT COUNT(*)::int FROM image_assets
			WHERE source_event_id = '${fixturePrefix}-backfill-delete-after-snapshot'
				AND status = 'Deleted'
		`),
		1,
		'a delete committed after the first snapshot must tombstone its backfilled asset',
	);
	assert.equal(
		await scalar(`
			SELECT COUNT(*)::int FROM image_assets
			WHERE source_event_id = '${fixturePrefix}-backfill-delayed-ingest'
				AND status = 'Ready'
		`),
		1,
		'a lifecycle event ingested after the first zero audit must be drained before cutover',
	);
	assert.equal(
		await scalar(`
			SELECT COUNT(*)::int FROM (
				SELECT storage_key FROM image_assets
				WHERE storage_key LIKE '${fixturePrefix}/%'
				GROUP BY storage_key HAVING COUNT(*) > 1
			) duplicates
		`),
		0,
	);
}

async function seedBackfillFixtures() {
	await pool.query(
		`INSERT INTO client_services (id, slug, name, owner, status, created_at, updated_at)
		 VALUES ($1, $2, 'Image lifecycle system E2E', 'ci', 'ACTIVE', NOW(), NOW())
		 ON CONFLICT (id) DO NOTHING`,
		[`${fixturePrefix}-service`, `${fixturePrefix}-service`],
	);
	for (const suffix of [
		'ready',
		'deleted-telemetry',
		'deleted-lifecycle',
		'delete-after-snapshot',
	]) {
		await insertTelemetryFixture({ suffix: `backfill-${suffix}` });
	}
	await insertLifecycleUploadFixture({ suffix: 'backfill-lifecycle-only' });
	await pool.query(
		`UPDATE telemetry_events
		 SET occurred_at = NOW() - INTERVAL '1 minute'
		 WHERE event_id LIKE $1`,
		[`${fixturePrefix}-backfill-%`],
	);
	await pool.query(
		`UPDATE image_lifecycle_events
		 SET occurred_at = NOW() - INTERVAL '1 minute'
		 WHERE event_id = $1`,
		[`${fixturePrefix}-backfill-lifecycle-only`],
	);
	await insertSuccessfulDeleteFixture({
		suffix: 'backfill-deleted-telemetry',
		source: 'telemetry',
	});
	await insertSuccessfulDeleteFixture({
		suffix: 'backfill-deleted-lifecycle',
		source: 'lifecycle',
	});
}

async function insertLifecycleUploadFixture({ suffix }) {
	const eventId = `${fixturePrefix}-${suffix}`;
	const name = `${suffix}.png`;
	await pool.query(
		`INSERT INTO image_lifecycle_events (
			id, event_id, event_type, source_app, environment, status, occurred_at,
			client_service_id, client_service_slug, path, name, image_key, format,
			input_bytes, output_bytes, duration_ms, raw_payload
		) VALUES (
			$1, $1, 'image.upload.completed', 'storage', 'test', 'success', NOW(),
			$2, $3, $4, $5, $6, 'png', 68, 68, 1, $7::jsonb
		) ON CONFLICT (event_id) DO NOTHING`,
		[
			eventId,
			`${fixturePrefix}-service`,
			`${fixturePrefix}-service`,
			imagePath,
			name,
			`${imagePath}/${name}`,
			JSON.stringify({ originalName: name, contentType: 'image/png' }),
		],
	);
}

async function insertSuccessfulDeleteFixture({ suffix, source }) {
	const table =
		source === 'telemetry' ? 'telemetry_events' : 'image_lifecycle_events';
	const eventId = `${fixturePrefix}-${suffix}-delete`;
	const name = `${suffix}.png`;
	await pool.query(
		`INSERT INTO ${table} (
			id, event_id, event_type, source_app, environment, status, occurred_at,
			client_service_id, client_service_slug, path, name, image_key, format,
			duration_ms, raw_payload
		) VALUES (
			$1, $1, 'image.delete.completed', 'storage', 'test', 'success', NOW(),
			$2, $3, $4, $5, $6, 'png', 1, '{}'::jsonb
		) ON CONFLICT (event_id) DO NOTHING`,
		[
			eventId,
			`${fixturePrefix}-service`,
			`${fixturePrefix}-service`,
			imagePath,
			name,
			`${imagePath}/${name}`,
		],
	);
}

async function insertTelemetryFixture({ suffix }) {
	const eventId = `${fixturePrefix}-${suffix}`;
	const name = `${suffix}.png`;
	await pool.query(
		`INSERT INTO telemetry_events (
			id, event_id, event_type, source_app, environment, status, occurred_at,
			client_service_id, client_service_slug, path, name, image_key, format,
			input_bytes, output_bytes, duration_ms, raw_payload
		) VALUES (
			$1, $1, 'image.upload.completed', 'storage', 'test', 'success', NOW(),
			$2, $3, $4, $5, $6, 'png', 68, 68, 1, $7::jsonb
		) ON CONFLICT (event_id) DO NOTHING`,
		[
			eventId,
			`${fixturePrefix}-service`,
			`${fixturePrefix}-service`,
			imagePath,
			name,
			`${imagePath}/${name}`,
			JSON.stringify({ originalName: name, contentType: 'image/png' }),
		],
	);
	return { eventId, imageKey: `${imagePath}/${name}` };
}

async function runBackfill({
	dryRun,
	maxBatches,
	cutoverAudit = false,
	ingestionDrainConfirmed = false,
	expectedExitCode = 0,
}) {
	const env = {
		...process.env,
		DATABASE_URL: infrastructure.databaseUrl,
		IMAGE_ASSET_BACKFILL_ENABLED: 'true',
		IMAGE_ASSET_BACKFILL_DRY_RUN: String(dryRun),
		IMAGE_ASSET_BACKFILL_CUTOVER_AUDIT: String(cutoverAudit),
		IMAGE_ASSET_BACKFILL_INGESTION_DRAIN_CONFIRMED: String(
			ingestionDrainConfirmed,
		),
		IMAGE_ASSET_BACKFILL_BATCH_SIZE: '1',
		IMAGE_ASSET_BACKFILL_SLEEP_MS: '0',
		...(maxBatches === undefined
			? {}
			: { IMAGE_ASSET_BACKFILL_MAX_BATCHES: String(maxBatches) }),
	};
	const output =
		expectedExitCode === 0
			? await runCapture('pnpm', ['db:backfill:image-assets'], {
					env,
					includeStderr: true,
				})
			: await runCaptureWithExitCode(
					'pnpm',
					['db:backfill:image-assets'],
					env,
					expectedExitCode,
				);
	return parseLastJsonLine(output);
}

function runCaptureWithExitCode(command, args, env, expectedExitCode) {
	return new Promise((resolveRun, rejectRun) => {
		const stdout = [];
		const stderr = [];
		const child = spawn(command, args, {
			cwd: repoRoot,
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		child.stdout.on('data', (chunk) => stdout.push(chunk));
		child.stderr.on('data', (chunk) => stderr.push(chunk));
		child.once('error', rejectRun);
		child.once('exit', (code, signal) => {
			const output = Buffer.concat(stdout).toString('utf8').trim();
			const errorOutput = Buffer.concat(stderr).toString('utf8').trim();
			if (code === expectedExitCode) {
				resolveRun(output);
				return;
			}
			rejectRun(
				new Error(
					`${command} ${args.join(' ')} expected code ${expectedExitCode}, got code=${code ?? 'null'}, signal=${signal ?? 'none'}: ${errorOutput}`,
				),
			);
		});
	});
}

async function prepareReconciliationFixtureAndAssertLease() {
	const serviceId = `${fixturePrefix}-service`;
	const assetId = `${fixturePrefix}-stale-pending`;
	const assetDirectory = resolve(storageAssetRoot, imagePath);
	const sourcePath = resolve(assetDirectory, 'stale.png');
	const orphanPath = resolve(assetDirectory, 'orphan.png');
	const stagePath = resolve(assetDirectory, '.staging', 'stale.stage');
	const inboundTempPath = resolve(
		storageTempRoot,
		`${fixturePrefix}-inbound.tmp`,
	);
	await Promise.all([
		mkdir(resolve(assetDirectory, '.staging'), { recursive: true }),
		mkdir(storageTempRoot, { recursive: true }),
	]);
	const image = Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR42mP8z8AARAwMjDAGAAANHQEDasKb6QAAAABJRU5ErkJggg==',
		'base64',
	);
	await Promise.all([
		writeFile(sourcePath, image),
		writeFile(orphanPath, image),
		writeFile(stagePath, image),
		writeFile(inboundTempPath, image),
	]);
	const staleAt = new Date(Date.now() - 5 * 60_000);
	await Promise.all([
		utimes(orphanPath, staleAt, staleAt),
		utimes(stagePath, staleAt, staleAt),
		utimes(inboundTempPath, staleAt, staleAt),
	]);
	await pool.query(
		`INSERT INTO image_assets (
			asset_id, client_service_id, idempotency_key, logical_path, name,
			original_name, storage_key, content_type, input_bytes, status, created_at, updated_at
		) VALUES ($1, $2, $1, $3, 'stale.png', 'stale.png', $4, 'image/png', $5, 'Pending',
			NOW() - INTERVAL '5 minutes', NOW() - INTERVAL '5 minutes')
		ON CONFLICT (asset_id) DO UPDATE SET status='Pending', input_bytes=EXCLUDED.input_bytes,
			updated_at=EXCLUDED.updated_at`,
		[assetId, serviceId, imagePath, `${imagePath}/stale.png`, image.length],
	);
	const candidates = await scalar(
		`SELECT COUNT(*)::int FROM image_assets
		 WHERE asset_id=$1 AND status='Pending'
			AND updated_at <= NOW() - INTERVAL '4 minutes'`,
		[assetId],
	);
	assert.equal(
		candidates,
		1,
		'default 4m stale threshold must detect within 5m SLA',
	);
	const results = await Promise.all([
		tryAcquireLease(`${fixturePrefix}-owner-a`),
		tryAcquireLease(`${fixturePrefix}-owner-b`),
	]);
	assert.equal(
		results.filter(Boolean).length,
		1,
		'only one reconciliation owner may acquire the DB lease',
	);
	await pool.query(
		`DELETE FROM image_reconciliation_leases WHERE lease_name='image-asset-reconciliation'`,
	);
	return {
		assetId,
		sourcePath,
		orphanPath,
		stagePath,
		inboundTempPath,
		startedAt: Date.now(),
	};
}

async function tryAcquireLease(owner) {
	const token = `${owner}-token`;
	const { rows } = await pool.query(
		`INSERT INTO image_reconciliation_leases (
			lease_name, owner, token, expires_at, created_at, updated_at
		) VALUES ('image-asset-reconciliation', $1, $2, NOW() + INTERVAL '30 seconds', NOW(), NOW())
		ON CONFLICT (lease_name) DO UPDATE SET
			owner=EXCLUDED.owner, token=EXCLUDED.token, expires_at=EXCLUDED.expires_at, updated_at=NOW()
		WHERE image_reconciliation_leases.expires_at <= NOW()
		RETURNING token`,
		[owner, token],
	);
	return rows[0]?.token === token;
}

async function assertProductionReconciliation(fixture) {
	await poll(
		async () => {
			assert.equal(
				await scalar(
					"SELECT COUNT(*)::int FROM image_assets WHERE asset_id=$1 AND status='Ready'",
					[fixture.assetId],
				),
				1,
			);
			await access(fixture.sourcePath);
			for (const removed of [
				fixture.orphanPath,
				fixture.stagePath,
				fixture.inboundTempPath,
			]) {
				await assert.rejects(access(removed));
			}
			const { rows } = await pool.query(
				`SELECT repaired_count, failed_count, last_run_at
				 FROM image_reconciliation_metrics
				 WHERE id='image-asset-reconciliation'`,
			);
			assert.ok(rows[0]?.last_run_at);
			assert.ok(Number(rows[0]?.repaired_count) >= 4);
			assert.equal(Number(rows[0]?.failed_count), 0);
		},
		{ timeoutMs: 30_000, intervalMs: 200 },
	);
	const recoveredInMs = Date.now() - fixture.startedAt;
	assert.ok(
		recoveredInMs <= 5 * 60_000,
		`reconciliation exceeded 5 minute SLA: ${recoveredInMs}ms`,
	);
	const before = await pool.query(
		`SELECT status, source_event_id FROM image_assets WHERE asset_id=$1`,
		[fixture.assetId],
	);
	await sleep(750);
	const after = await pool.query(
		`SELECT status, source_event_id FROM image_assets WHERE asset_id=$1`,
		[fixture.assetId],
	);
	assert.deepEqual(
		after.rows,
		before.rows,
		'reconciliation replay must converge',
	);
	const health = await fetchJson(`${urls.storage}/health/ready`);
	assert.equal(health.ok, true);
	assert.equal(
		health.operationalMetrics.imageLifecycle.reconciliation.supported,
		true,
	);
	assert.ok(
		health.operationalMetrics.imageLifecycle.reconciliation.repairedCount >= 4,
	);
	console.log(
		JSON.stringify({
			event: 'image_reconciliation_recovered',
			recoveredInMs,
			repairedCount:
				health.operationalMetrics.imageLifecycle.reconciliation.repairedCount,
		}),
	);
}

async function startApplications() {
	await startTelemetry({ dualRead: true });
	const storage = spawnService({
		name: 'image-lifecycle-storage',
		entry: 'apps/storage/dist/apps/storage/src/main.js',
		env: {
			...commonAppEnv,
			PORT: String(ports.storage),
			CACHE_SERVER: urls.cacheA,
			LIFECYCLE_OUTBOX_PUBLISH_INTERVAL_MS: '100',
			IMAGE_VARIANT_KAFKA_ENABLED: 'true',
			IMAGE_VARIANT_KAFKA_GROUP_ID: `${fixturePrefix}-variant-worker`,
			IMAGE_VARIANT_KAFKA_RETRY_BACKOFF_MS: '500',
			IMAGE_VARIANT_OUTBOX_PUBLISH_INTERVAL_MS: '100',
			IMAGE_RECONCILIATION_ENABLED: 'true',
			IMAGE_RECONCILIATION_INTERVAL_MS: '250',
			IMAGE_RECONCILIATION_BATCH_SLEEP_MS: '250',
			IMAGE_RECONCILIATION_STALE_AFTER_MS: '60000',
			IMAGE_RECONCILIATION_LEASE_MS: '5000',
			IMAGE_RECONCILIATION_BATCH_SIZE: '100',
			IMAGE_RECONCILIATION_ORPHAN_DELETE_ENABLED: 'true',
			IMAGE_RECONCILIATION_READINESS_MAX_STALENESS_MS: '5000',
			IMAGE_ASSET_FAILED_READINESS_THRESHOLD: '100',
			IMAGE_VARIANT_FAILED_READINESS_THRESHOLD: '100',
			IMAGE_VARIANT_JOB_FAILED_READINESS_THRESHOLD: '100',
			IMAGE_PREGENERATION_SYNC_COMPAT_ENABLED: 'false',
		},
	});
	children.push(storage);
	await waitForHttp(`${urls.storage}/health/ready`, {
		child: storage,
		timeoutMs: 60_000,
	});
	const resize = spawnService({
		name: 'image-lifecycle-resize',
		entry: 'apps/resize/dist/apps/resize/src/main.js',
		env: {
			...commonAppEnv,
			PORT: String(ports.resize),
			STORAGE_SERVER: urls.storage,
		},
	});
	children.push(resize);
	await waitForHttp(`${urls.resize}/health/ready`, {
		child: resize,
		timeoutMs: 45_000,
	});
	for (const [name, port, group] of [
		['cache-a', ports.cacheA, `${fixturePrefix}-cache-a`],
		['cache-b', ports.cacheB, `${fixturePrefix}-cache-b`],
	]) {
		const child = spawnService({
			name: `image-lifecycle-${name}`,
			entry: 'apps/cache/dist/apps/cache/src/main.js',
			env: {
				...commonAppEnv,
				PORT: String(port),
				RESIZING_SERVER: urls.resize,
				CACHE_INVALIDATION_KAFKA_ENABLED: 'true',
				CACHE_INVALIDATION_KAFKA_GROUP_ID: group,
			},
		});
		children.push(child);
		await waitForHttp(`http://127.0.0.1:${port}/health/ready`, {
			child,
			timeoutMs: 45_000,
		});
	}
}

async function startTelemetry({ dualRead }) {
	const child = spawnService({
		name: `image-lifecycle-telemetry-${dualRead ? 'dual' : 'authoritative'}`,
		entry: 'apps/telemetry-api/dist/apps/telemetry-api/src/main.js',
		env: {
			...commonAppEnv,
			PORT: String(ports.telemetry),
			TELEMETRY_ADMIN_TOKEN: adminToken,
			TELEMETRY_STORAGE_DRIVER: 'prisma',
			CLIENT_SERVICE_REGISTRY_DRIVER: 'prisma',
			TELEMETRY_KAFKA_CONSUMER_ENABLED: 'true',
			TELEMETRY_KAFKA_GROUP_ID: `${fixturePrefix}-telemetry`,
			LIFECYCLE_KAFKA_CONSUMER_ENABLED: 'true',
			LIFECYCLE_KAFKA_GROUP_ID: `${fixturePrefix}-lifecycle`,
			LIFECYCLE_TOPIC_PROVISIONING_ENABLED: 'false',
			IMAGE_ASSET_DUAL_READ_ENABLED: String(dualRead),
		},
	});
	children.push(child);
	await waitForHttp(`${urls.telemetry}/health/ready`, {
		child,
		timeoutMs: 45_000,
	});
	return child;
}

async function provisionTenant() {
	const service = await fetchJson(
		`${urls.telemetry}/api/admin/client-services`,
		{
			method: 'POST',
			headers: adminHeaders,
			body: JSON.stringify({
				slug: `${fixturePrefix}-http`,
				name: 'Image lifecycle HTTP E2E',
				owner: 'ci',
			}),
		},
		201,
	);
	await fetchJson(
		`${urls.telemetry}/api/admin/client-services/${service.id}/policies`,
		{
			method: 'POST',
			headers: adminHeaders,
			body: JSON.stringify({
				pathPattern: imagePath,
				canRead: true,
				canUpload: true,
				canDelete: true,
				maxUploadBytes: 1_048_576,
				rateLimitPerMin: 100_000,
			}),
		},
		201,
	);
	await fetchJson(
		`${urls.telemetry}/api/admin/client-services/${service.id}/image-resize-policy`,
		{
			method: 'PATCH',
			headers: adminHeaders,
			body: JSON.stringify({ mode: 'PRE_GENERATE' }),
		},
	);
	const key = await fetchJson(
		`${urls.telemetry}/api/admin/client-services/${service.id}/keys`,
		{
			method: 'POST',
			headers: adminHeaders,
			body: JSON.stringify({ name: 'image-lifecycle-system-e2e' }),
		},
		201,
	);
	return { service, headers: { 'x-client-api-key': key.apiKey } };
}

async function assertProcessBoundaryRecovery(tenant) {
	const failpoints = [
		'after-pending',
		'after-stage-write',
		'after-stage-checksum',
		'before-promote',
		'after-promote',
		'before-ready-transaction',
		'after-ready-transaction',
	];
	const promotedBoundaries = new Set([
		'after-promote',
		'before-ready-transaction',
		'after-ready-transaction',
	]);
	const results = [];

	for (const failpoint of failpoints) {
		const idempotencyKey = `${fixturePrefix}-crash-${failpoint}`;
		const storedIdempotencyKey = createStoredUploadIdempotencyKey(
			tenant.service.id,
			idempotencyKey,
		);
		const originalName = `crash-${failpoint}.png`;
		const tempRoot = storageTempRoot;
		const tempBefore = new Set(await readDirectoryOrEmpty(tempRoot));
		const child = spawnService({
			name: `image-lifecycle-fault-${failpoint}`,
			entry: 'apps/storage/dist/apps/storage/src/main.js',
			env: {
				...commonAppEnv,
				NODE_ENV: 'test',
				PORT: String(ports.faultStorage),
				CACHE_SERVER: urls.cacheA,
				IMAGE_LIFECYCLE_TEST_FAILPOINTS_ENABLED: 'true',
				IMAGE_LIFECYCLE_TEST_FAILPOINT: failpoint,
				IMAGE_LIFECYCLE_TEST_FAILPOINT_ACTION: 'exit',
				IMAGE_RECONCILIATION_ENABLED: 'false',
				IMAGE_VARIANT_KAFKA_ENABLED: 'false',
				IMAGE_VARIANT_OUTBOX_PUBLISH_INTERVAL_MS: '0',
				LIFECYCLE_OUTBOX_PUBLISH_INTERVAL_MS: '0',
				LIFECYCLE_OUTBOX_CLEANUP_INTERVAL_MS: '0',
			},
		});
		children.push(child);
		await waitForHttp(`${urls.faultStorage}/health/live`, {
			child,
			timeoutMs: 45_000,
		});
		await assert.rejects(
			requestImageUpload(
				urls.faultStorage,
				tenant.headers,
				idempotencyKey,
				originalName,
			),
		);
		await poll(async () => {
			assert.notEqual(child.exitCode, null);
			assert.equal(child.exitCode, 86);
		});

		const { rows } = await pool.query(
			`SELECT asset_id, storage_key FROM image_assets
			 WHERE client_service_id=$1 AND idempotency_key=$2`,
			[tenant.service.id, storedIdempotencyKey],
		);
		assert.equal(rows.length, 1);
		const asset = rows[0];
		const storageFile = resolve(storageAssetRoot, asset.storage_key);
		const assetDirectory = resolve(storageFile, '..');
		const staleAt = new Date(Date.now() - 5 * 60_000);
		await pool.query(
			`UPDATE image_assets
			 SET updated_at=NOW() - INTERVAL '5 minutes'
			 WHERE asset_id=$1`,
			[asset.asset_id],
		);
		assert.equal(
			await scalar(
				`SELECT COUNT(*)::int FROM image_assets
				 WHERE asset_id=$1
					AND updated_at <= NOW() - INTERVAL '4 minutes'`,
				[asset.asset_id],
			),
			1,
			'crash fixture must be old enough for production reconciliation',
		);
		for (const stageName of await readDirectoryOrEmpty(
			resolve(assetDirectory, '.staging'),
		)) {
			await utimes(
				resolve(assetDirectory, '.staging', stageName),
				staleAt,
				staleAt,
			);
		}
		const tempAfter = await readDirectoryOrEmpty(tempRoot);
		for (const tempName of tempAfter.filter((name) => !tempBefore.has(name))) {
			await utimes(resolve(tempRoot, tempName), staleAt, staleAt);
		}
		if (promotedBoundaries.has(failpoint)) {
			await utimes(storageFile, staleAt, staleAt).catch(() => undefined);
		}

		const expectedStatus = promotedBoundaries.has(failpoint)
			? 'Ready'
			: 'Failed';
		await poll(
			async () => {
				const { rows: statusRows } = await pool.query(
					`SELECT status FROM image_assets WHERE asset_id=$1`,
					[asset.asset_id],
				);
				assert.equal(statusRows[0]?.status, expectedStatus);
			},
			{ timeoutMs: 30_000, intervalMs: 200 },
		);
		const retried = await uploadImage(
			tenant.headers,
			tenant.service.id,
			idempotencyKey,
			originalName,
		);
		assert.equal(retried.assetId, asset.asset_id);
		await poll(async () => {
			assert.equal(
				await scalar(
					`SELECT COUNT(*)::int FROM image_lifecycle_outbox
					 WHERE event_id=$1
						AND payload->>'eventType'='image.upload.completed'`,
					[retried.eventId],
				),
				1,
				'failed upload retry must persist a distinct completion outbox event',
			);
		});
		assert.equal(
			await scalar(
				`SELECT COUNT(*)::int FROM image_assets
				 WHERE client_service_id=$1 AND idempotency_key=$2`,
				[tenant.service.id, storedIdempotencyKey],
			),
			1,
		);
		results.push({ failpoint, recoveredStatus: expectedStatus });
	}
	console.log(
		JSON.stringify({
			event: 'image_lifecycle_process_boundary_recovery',
			results,
		}),
	);
}

async function assertUploadLatency(tenant) {
	const samplesByVariantCount = {};
	const uploads = [];
	let configured = 0;
	for (const variantCount of IMAGE_LIFECYCLE_UPLOAD_VARIANT_BUCKETS) {
		for (; configured < variantCount; configured += 1) {
			await fetchJson(
				`${urls.telemetry}/api/admin/client-services/${tenant.service.id}/image-resize-policy/variants`,
				{
					method: 'POST',
					headers: adminHeaders,
					body: JSON.stringify({
						width: 32 + configured,
						height: 32 + configured,
						format: configured % 2 === 0 ? 'webp' : 'png',
						isEnabled: true,
					}),
				},
				201,
			);
		}
		const samples = [];
		for (let sample = 0; sample < uploadSamples; sample += 1) {
			const idempotencyKey = `${fixturePrefix}-${variantCount}-${sample}`;
			const started = performance.now();
			const upload = await uploadImage(
				tenant.headers,
				tenant.service.id,
				idempotencyKey,
				`${variantCount}-${sample}.png`,
			);
			samples.push(performance.now() - started);
			uploads.push({ ...upload, variantCount });
		}
		samplesByVariantCount[variantCount] = samples;
	}
	const summary = assertVariantIndependentLatency(samplesByVariantCount, {
		fixedBudgetMs: readPositiveInteger(
			process.env.IMAGE_LIFECYCLE_E2E_UPLOAD_FIXED_BUDGET_MS,
			750,
		),
		maxRatio: Number(process.env.IMAGE_LIFECYCLE_E2E_UPLOAD_MAX_RATIO ?? 2),
	});
	for (const bucket of IMAGE_LIFECYCLE_UPLOAD_VARIANT_BUCKETS.filter(
		(value) => value > 0,
	)) {
		const ids = uploads
			.filter((upload) => upload.variantCount === bucket)
			.map((upload) => upload.assetId);
		const jobs = await scalar(
			'SELECT COUNT(*)::int FROM image_variant_jobs WHERE asset_id = ANY($1::text[])',
			[ids],
		);
		assert.equal(
			jobs,
			ids.length * bucket,
			`unexpected durable job count for ${bucket} variants`,
		);
	}
	console.log(
		JSON.stringify({ event: 'image_lifecycle_upload_latency', summary }),
	);
	return {
		uploads,
		summary,
		deleteTarget: uploads.find((upload) => upload.variantCount === 20),
	};
}

async function uploadImage(
	headers,
	clientServiceId,
	idempotencyKey,
	originalName,
	baseUrl = urls.storage,
) {
	const { response, body } = await requestImageUpload(
		baseUrl,
		headers,
		idempotencyKey,
		originalName,
	);
	assert.equal(response.status, 201, JSON.stringify(body));
	assert.equal(typeof body.imageKey, 'string');
	assert.equal(typeof body.assetId, 'string');
	assert.ok(
		['Pending', 'Ready', 'Failed', 'NotConfigured'].includes(
			body.variantStatus,
		),
		`unexpected variantStatus: ${body.variantStatus}`,
	);
	let assetId;
	await poll(async () => {
		const { rows } = await pool.query(
			`SELECT asset_id FROM image_assets
			 WHERE client_service_id=$1 AND storage_key=$2 AND status='Ready'`,
			[clientServiceId, body.imageKey],
		);
		assert.equal(
			rows.length,
			1,
			'upload must commit one authoritative Ready asset',
		);
		assetId = rows[0].asset_id;
	});
	assert.equal(body.assetId, assetId);
	return { ...body, assetId };
}

async function requestImageUpload(
	baseUrl,
	headers,
	idempotencyKey,
	originalName,
) {
	const image = Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR42mP8z8AARAwMjDAGAAANHQEDasKb6QAAAABJRU5ErkJggg==',
		'base64',
	);
	const form = new FormData();
	form.set('path', imagePath);
	form.set('file', new Blob([image], { type: 'image/png' }), originalName);
	const response = await fetch(`${baseUrl}/image`, {
		method: 'POST',
		headers: { ...headers, 'idempotency-key': idempotencyKey },
		body: form,
	});
	const body = await response.json();
	return { response, body };
}

async function assertAuthoritativeAdminReads(tenant) {
	const legacy = await insertTelemetryFixture({ suffix: 'legacy-only' });
	const dual = await fetchJson(`${urls.telemetry}/api/admin/images?limit=100`, {
		headers: adminHeaders,
	});
	assert.ok(dual.items.some((item) => item.imageKey === legacy.imageKey));
	assert.ok(
		!dual.items.some(
			(item) =>
				item.imageKey.endsWith('/backfill-deleted-telemetry.png') ||
				item.imageKey.endsWith('/backfill-deleted-lifecycle.png') ||
				item.imageKey.endsWith('/backfill-delete-after-snapshot.png'),
		),
	);
	for (const deletedName of [
		'backfill-deleted-telemetry.png',
		'backfill-deleted-lifecycle.png',
		'backfill-delete-after-snapshot.png',
	]) {
		const deletedKey = `${imagePath}/${deletedName}`;
		const response = await fetch(
			`${urls.telemetry}/api/admin/images/${encodeURIComponent(deletedKey)}`,
			{ headers: adminHeaders },
		);
		assert.equal(
			response.status,
			404,
			'delete tombstones must suppress dual-read detail fallback',
		);
	}

	const current = children.findLast(
		(child) => child.serviceName === 'image-lifecycle-telemetry-dual',
	);
	await stopChild(current);
	children.splice(children.indexOf(current), 1);
	await startTelemetry({ dualRead: false });
	const authoritative = await fetchJson(
		`${urls.telemetry}/api/admin/images?limit=100`,
		{
			headers: adminHeaders,
		},
	);
	assert.ok(
		!authoritative.items.some((item) => item.imageKey === legacy.imageKey),
	);
	const {
		rows: [readyAsset],
	} = await pool.query(
		`SELECT storage_key FROM image_assets
		 WHERE client_service_id=$1 AND status='Ready'
		 ORDER BY created_at ASC LIMIT 1`,
		[tenant.service.id],
	);
	assert.ok(readyAsset, 'tenant must have a Ready authoritative upload');
	assert.ok(
		authoritative.items.some(
			(item) => item.imageKey === readyAsset.storage_key,
		),
		'Ready authoritative uploads must remain visible',
	);
}

async function assertKafkaDeliverySemantics(tenant, latency) {
	const variantTargets = latency.uploads.filter(
		(upload) => upload.variantCount === 1,
	);
	const target = variantTargets[0];
	const raceTarget = variantTargets[1];
	const {
		rows: [job],
	} = await pool.query(
		`SELECT j.job_key, j.variant_id, a.asset_id, a.client_service_id,
			a.logical_path, a.name, a.storage_key,
			v.source_checksum, v.width, v.height, v.format
		 FROM image_variant_jobs j
		 JOIN image_assets a ON a.asset_id=j.asset_id
		 JOIN image_variants v ON v.variant_id=j.variant_id
		 WHERE a.asset_id=$1 LIMIT 1`,
		[target.assetId],
	);
	assert.ok(job);
	const event = {
		schemaVersion: 1,
		eventId: job.job_key,
		eventType: 'image.variant.requested',
		occurredAt: new Date().toISOString(),
		jobKey: job.job_key,
		assetId: job.asset_id,
		clientServiceId: job.client_service_id,
		path: job.logical_path,
		name: job.name,
		sourceChecksum: job.source_checksum,
		width: job.width,
		height: job.height,
		format: job.format,
	};
	const kafka = createKafka();
	await assertProductionVariantFailureReplay(job);
	const producer = kafka.producer({ allowAutoTopicCreation: false });
	await producer.connect();
	await poll(async () => {
		assert.equal(
			await scalar(
				`SELECT COUNT(*)::int FROM image_variant_jobs j
				 JOIN image_variants v ON v.variant_id=j.variant_id
				 WHERE j.job_key=$1 AND j.status='Completed' AND v.status='Ready'`,
				[job.job_key],
			),
			1,
		);
		assert.equal(
			await scalar(
				`SELECT COUNT(*)::int FROM image_lifecycle_outbox
				 WHERE event_id=$1 AND topic=$2 AND status='PUBLISHED'`,
				[`variant-ready:${job.job_key}`, invalidationTopic],
			),
			1,
		);
	});
	const healthBefore = await fetchJson(`${urls.storage}/health/ready`);
	const duplicateBefore =
		healthBefore.operationalMetrics.imageLifecycle.runtime.variantJobs
			.duplicateTotal;
	try {
		await producer.send({
			topic: variantTopic,
			acks: -1,
			messages: [
				{ key: job.job_key, value: JSON.stringify(event) },
				{ key: job.job_key, value: JSON.stringify(event) },
				{ key: `${fixturePrefix}-poison`, value: '{not-json' },
				{ key: job.job_key, value: JSON.stringify(event) },
			],
		});
	} finally {
		await producer.disconnect();
	}
	await poll(async () => {
		const health = await fetchJson(`${urls.storage}/health/ready`);
		assert.ok(
			health.operationalMetrics.imageLifecycle.runtime.variantJobs
				.duplicateTotal >=
				duplicateBefore + 3,
			'production worker did not idempotently consume duplicate jobs',
		);
	});
	assert.ok(
		await consumeOne({
			kafka,
			topic: variantDlqTopic,
			groupId: `${fixturePrefix}-dlq-observer`,
			predicate: (value) => value.sourceTopic === variantTopic,
		}),
		'poison variant message must reach DLQ',
	);
	const invalidation = {
		schemaVersion: 1,
		eventId: `${fixturePrefix}-replica-invalidation`,
		eventType: 'image.cache.invalidated',
		occurredAt: new Date().toISOString(),
		clientServiceId: tenant.service.id,
		path: imagePath.replace(/\/image$/, ''),
		name: target.name,
		reason: 'variant-ready',
		assetId: target.assetId,
	};
	const broadcaster = kafka.producer({ allowAutoTopicCreation: false });
	await broadcaster.connect();
	await broadcaster.send({
		topic: invalidationTopic,
		acks: -1,
		messages: [
			{
				key: `${fixturePrefix}-invalidation-poison`,
				value: '{not-json',
			},
			{
				key: `${tenant.service.id}:${invalidation.path}/${invalidation.name}`,
				value: JSON.stringify(invalidation),
			},
		],
	});
	await broadcaster.disconnect();
	const delivered = await Promise.all(
		['a', 'b'].map((replica) =>
			consumeOne({
				kafka,
				topic: invalidationTopic,
				groupId: `${fixturePrefix}-replica-${replica}`,
				predicate: (value) => value.eventId === invalidation.eventId,
			}),
		),
	);
	assert.ok(
		delivered.every(Boolean),
		'distinct replica groups must each receive invalidation',
	);
	assert.ok(
		await consumeOne({
			kafka,
			topic: invalidationDlqTopic,
			groupId: `${fixturePrefix}-invalidation-dlq-observer`,
			predicate: (value) => value.sourceTopic === invalidationTopic,
		}),
		'production cache consumer poison must reach DLQ',
	);
	for (const baseUrl of [urls.cacheA, urls.cacheB]) {
		await poll(async () => {
			const health = await fetchJson(`${baseUrl}/health/ready`);
			assert.ok(
				health.operationalMetrics.cacheInvalidation.processedTotal >= 1,
			);
			assert.ok(health.operationalMetrics.cacheInvalidation.dlqTotal >= 1);
		});
	}
	await assertDeleteWorkerRace(tenant, raceTarget);
}

async function assertProductionVariantFailureReplay(job) {
	const sourcePath = resolve(storageAssetRoot, job.storage_key);
	const heldPath = `${sourcePath}.${fixturePrefix}.hold`;
	await poll(async () => {
		assert.equal(
			await scalar(
				`SELECT COUNT(*)::int FROM image_variant_jobs j
				 JOIN image_variants v ON v.variant_id=j.variant_id
				 WHERE j.job_key=$1 AND j.status='Completed' AND v.status='Ready'`,
				[job.job_key],
			),
			1,
		);
	});
	await rename(sourcePath, heldPath);
	try {
		await pool.query(
			`WITH variant_reset AS (
				UPDATE image_variants SET status='Pending', ready_at=NULL,
					failed_at=NULL, failure_reason=NULL, updated_at=NOW()
				WHERE variant_id=$1 RETURNING variant_id
			)
			UPDATE image_variant_jobs SET status='Pending', attempts=0,
				published_at=NULL, next_publish_at=NOW(), next_attempt_at=NOW(),
				completed_at=NULL, lease_owner=NULL, lease_expires_at=NULL,
				last_error=NULL, updated_at=NOW()
			WHERE job_key=$2 AND EXISTS (SELECT 1 FROM variant_reset)`,
			[job.variant_id, job.job_key],
		);
		await poll(
			async () => {
				assert.equal(
					await scalar(
						`SELECT COUNT(*)::int FROM image_variant_jobs
						 WHERE job_key=$1 AND status='Failed' AND attempts=1
							AND published_at IS NULL`,
						[job.job_key],
					),
					1,
				);
			},
			{ timeoutMs: 30_000, intervalMs: 100 },
		);
	} finally {
		await rename(heldPath, sourcePath).catch(() => undefined);
	}
	await poll(
		async () => {
			assert.equal(
				await scalar(
					`SELECT COUNT(*)::int FROM image_variant_jobs j
					 JOIN image_variants v ON v.variant_id=j.variant_id
					 WHERE j.job_key=$1 AND j.status='Completed' AND v.status='Ready'
						AND j.attempts=1`,
					[job.job_key],
				),
				1,
			);
		},
		{ timeoutMs: 30_000, intervalMs: 100 },
	);
}

async function assertDeleteWorkerRace(tenant, target) {
	const {
		rows: [job],
	} = await pool.query(
		`SELECT j.job_key, j.variant_id, a.storage_key,
			v.storage_key AS variant_storage_key
		 FROM image_variant_jobs j
		 JOIN image_assets a ON a.asset_id=j.asset_id
		 JOIN image_variants v ON v.variant_id=j.variant_id
		 WHERE a.asset_id=$1 LIMIT 1`,
		[target.assetId],
	);
	assert.ok(job);
	await poll(async () => {
		assert.equal(
			await scalar(
				`SELECT COUNT(*)::int FROM image_variant_jobs
				 WHERE job_key=$1 AND status='Completed'`,
				[job.job_key],
			),
			1,
		);
	});
	const sourcePath = resolve(storageAssetRoot, job.storage_key);
	const heldPath = `${sourcePath}.${fixturePrefix}.delete-race`;
	await rename(sourcePath, heldPath);
	try {
		await pool.query(
			`WITH variant_reset AS (
				UPDATE image_variants SET status='Pending', ready_at=NULL,
					failed_at=NULL, failure_reason=NULL, updated_at=NOW()
				WHERE variant_id=$1 RETURNING variant_id
			)
			UPDATE image_variant_jobs SET status='Pending', attempts=0,
				published_at=NULL, next_publish_at=NOW(), next_attempt_at=NOW(),
				completed_at=NULL, lease_owner=NULL, lease_expires_at=NULL,
				last_error=NULL, updated_at=NOW()
			WHERE job_key=$2 AND EXISTS (SELECT 1 FROM variant_reset)`,
			[job.variant_id, job.job_key],
		);
		await poll(
			async () => {
				assert.equal(
					await scalar(
						`SELECT COUNT(*)::int FROM image_variant_jobs
						 WHERE job_key=$1 AND status='Processing'`,
						[job.job_key],
					),
					1,
				);
			},
			{ timeoutMs: 15_000, intervalMs: 20 },
		);
		await fetchJson(
			`${urls.storage}/image?imageKey=${encodeURIComponent(target.imageKey)}`,
			{ method: 'DELETE', headers: tenant.headers },
			200,
		);
	} finally {
		await rm(heldPath, { force: true });
	}
	await sleep(1_500);
	assert.equal(
		await scalar(
			`SELECT COUNT(*)::int FROM image_assets a
			 JOIN image_variants v ON v.asset_id=a.asset_id
			 JOIN image_variant_jobs j ON j.asset_id=a.asset_id
			 WHERE a.asset_id=$1 AND a.status='Deleted' AND v.status='Deleted'
				AND j.status='Cancelled'`,
			[target.assetId],
		),
		1,
		'delete/worker race resurrected a variant or job',
	);
	const lateVariantPath = resolve(storageAssetRoot, job.variant_storage_key);
	await writeFile(lateVariantPath, 'simulated-post-rename-worker-crash');
	const cleanupStartedAt = Date.now();
	await poll(
		async () => {
			await assert.rejects(access(lateVariantPath));
		},
		{ timeoutMs: 30_000, intervalMs: 100 },
	);
	const recoveredInMs = Date.now() - cleanupStartedAt;
	assert.ok(
		recoveredInMs <= 5 * 60_000,
		`Deleted variant cleanup exceeded reconciliation SLA: ${recoveredInMs}ms`,
	);
	console.log(
		JSON.stringify({
			event: 'deleted_variant_crash_cleanup',
			recoveredInMs,
		}),
	);
}

async function consumeOne({ kafka, topic, groupId, predicate }) {
	const consumer = kafka.consumer({ groupId });
	await consumer.connect();
	await consumer.subscribe({ topic, fromBeginning: true });
	let result;
	try {
		result = await new Promise((resolveMessage, rejectMessage) => {
			const timer = setTimeout(
				() => rejectMessage(new Error(`Kafka timeout: ${groupId}/${topic}`)),
				30_000,
			);
			void consumer
				.run({
					autoCommit: false,
					eachMessage: async ({ partition, message }) => {
						let value;
						try {
							value = JSON.parse(message.value?.toString('utf8') ?? '{}');
						} catch {
							// Observer groups verify a later valid delivery. Poison handling is
							// asserted against the production consumer and its DLQ separately.
							return;
						}
						if (!predicate(value)) return;
						await consumer.commitOffsets([
							{ topic, partition, offset: String(BigInt(message.offset) + 1n) },
						]);
						clearTimeout(timer);
						resolveMessage(value);
					},
				})
				.catch(rejectMessage);
		});
	} finally {
		await consumer.disconnect();
	}
	return result;
}

async function assertDeleteCleanup(tenant, target) {
	const { rows: objects } = await pool.query(
		`SELECT storage_key FROM image_assets WHERE asset_id=$1
		 UNION ALL SELECT storage_key FROM image_variants WHERE asset_id=$1`,
		[target.assetId],
	);
	for (const baseUrl of [urls.cacheA, urls.cacheB]) {
		const imageUrl = new URL(
			`/image/${fixturePrefix}/${encodeURIComponent(target.name)}`,
			baseUrl,
		);
		imageUrl.searchParams.set('width', '32');
		imageUrl.searchParams.set('height', '32');
		imageUrl.searchParams.set('format', 'webp');
		const response = await fetch(imageUrl, { headers: tenant.headers });
		assert.equal(response.status, 200);
	}
	const deleteUrl = `${urls.storage}/image?imageKey=${encodeURIComponent(target.imageKey)}`;
	await fetchJson(
		deleteUrl,
		{ method: 'DELETE', headers: tenant.headers },
		200,
	);
	await fetchJson(
		deleteUrl,
		{ method: 'DELETE', headers: tenant.headers },
		200,
	);
	await poll(async () => {
		assert.equal(
			await scalar(
				"SELECT COUNT(*)::int FROM image_assets WHERE asset_id=$1 AND status='Deleted'",
				[target.assetId],
			),
			1,
		);
		assert.equal(
			await scalar(
				"SELECT COUNT(*)::int FROM image_variants WHERE asset_id=$1 AND status <> 'Deleted'",
				[target.assetId],
			),
			0,
		);
		assert.equal(
			await scalar(
				`SELECT COUNT(*)::int FROM image_lifecycle_outbox
				 WHERE status <> 'PUBLISHED'
					AND (
						payload->>'assetId'=$1
						OR payload->>'imageKey'=$2
					)`,
				[target.assetId, target.imageKey],
			),
			0,
			'delete left an unfinished outbox row for the target asset',
		);
	});
	for (const { storage_key: storageKey } of objects) {
		await assert.rejects(access(resolve(storageAssetRoot, storageKey)));
	}
	const { rows: lifecycle } = await pool.query(
		`SELECT event_id FROM image_lifecycle_events
		 WHERE image_key=$1 AND event_type='image.delete.completed'
		 ORDER BY occurred_at DESC LIMIT 1`,
		[target.imageKey],
	);
	assert.ok(lifecycle[0]?.event_id, 'delete lifecycle event must be durable');
	const invalidation = await consumeOne({
		kafka: createKafka(),
		topic: invalidationTopic,
		groupId: `${fixturePrefix}-delete-observer`,
		predicate: (value) =>
			value.assetId === target.assetId && value.reason === 'delete',
	});
	assert.equal(invalidation.eventId, lifecycle[0].event_id);
	for (const baseUrl of [urls.cacheA, urls.cacheB]) {
		await poll(async () => {
			const imageUrl = new URL(
				`/image/${fixturePrefix}/${encodeURIComponent(target.name)}`,
				baseUrl,
			);
			imageUrl.searchParams.set('width', '32');
			imageUrl.searchParams.set('height', '32');
			imageUrl.searchParams.set('format', 'webp');
			const response = await fetch(imageUrl, { headers: tenant.headers });
			assert.equal(
				response.status,
				404,
				`cache replica retained deleted asset: ${baseUrl}`,
			);
		});
	}
	await poll(async () => {
		assert.equal(
			await scalar(
				`SELECT COUNT(*)::int FROM image_lifecycle_outbox
				 WHERE event_id=$1 AND status <> 'PUBLISHED'`,
				[lifecycle[0].event_id],
			),
			0,
			'delete must not leave unfinished outbox rows',
		);
	});
	const admin = await fetchJson(
		`${urls.telemetry}/api/admin/images?limit=100`,
		{ headers: adminHeaders },
	);
	assert.ok(!admin.items.some((item) => item.imageKey === target.imageKey));
}

function createKafka() {
	return new Kafka({
		clientId: `${fixturePrefix}-probe`,
		brokers: [infrastructure.kafkaBroker],
		logLevel: logLevel.NOTHING,
		retry: { retries: 3, initialRetryTime: 100, maxRetryTime: 1_000 },
	});
}

async function scalar(sql, values = []) {
	const { rows } = await pool.query(sql, values);
	return Number(Object.values(rows[0] ?? {})[0] ?? 0);
}

async function assertDockerResourcesRemoved(project) {
	for (const [kind, args] of [
		[
			'containers',
			['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`],
		],
		[
			'volumes',
			[
				'volume',
				'ls',
				'-q',
				'--filter',
				`label=com.docker.compose.project=${project}`,
			],
		],
		[
			'networks',
			[
				'network',
				'ls',
				'-q',
				'--filter',
				`label=com.docker.compose.project=${project}`,
			],
		],
	]) {
		const remaining = await runCapture('docker', args).catch(
			() => 'cleanup-check-failed',
		);
		assert.equal(
			remaining,
			'',
			`Image lifecycle E2E cleanup left ${kind}: ${remaining}`,
		);
	}
}

function readPositiveInteger(value, fallback) {
	const parsed = Number(value ?? fallback);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new Error(`expected positive integer, received ${value}`);
	}
	return parsed;
}

function createStoredUploadIdempotencyKey(clientServiceId, explicitKey) {
	return `image-upload:v1:${createHash('sha256')
		.update(['header', clientServiceId, explicitKey].join('\0'))
		.digest('hex')}`;
}

async function readDirectoryOrEmpty(directory) {
	try {
		return await readdir(directory);
	} catch (error) {
		if (error && typeof error === 'object' && error.code === 'ENOENT')
			return [];
		throw error;
	}
}
