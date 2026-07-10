import { Pool } from 'pg';

const enabled = process.env.IMAGE_ASSET_BACKFILL_ENABLED === 'true';
const dryRun = process.env.IMAGE_ASSET_BACKFILL_DRY_RUN === 'true';
const cutoverAudit = process.env.IMAGE_ASSET_BACKFILL_CUTOVER_AUDIT === 'true';
const ingestionDrainConfirmed =
	process.env.IMAGE_ASSET_BACKFILL_INGESTION_DRAIN_CONFIRMED === 'true';
const batchSize = readInteger(
	'IMAGE_ASSET_BACKFILL_BATCH_SIZE',
	500,
	1,
	10_000,
);
const maxBatches = readInteger(
	'IMAGE_ASSET_BACKFILL_MAX_BATCHES',
	1_000,
	1,
	100_000,
);
const sleepMs = readInteger('IMAGE_ASSET_BACKFILL_SLEEP_MS', 100, 0, 60_000);
const lockTimeoutMs = readInteger(
	'IMAGE_ASSET_BACKFILL_LOCK_TIMEOUT_MS',
	1_000,
	1,
	60_000,
);
const statementTimeoutMs = readInteger(
	'IMAGE_ASSET_BACKFILL_STATEMENT_TIMEOUT_MS',
	30_000,
	100,
	300_000,
);

if (!enabled) {
	console.log(
		JSON.stringify({
			event: 'image_asset_backfill_skipped',
			reason: 'IMAGE_ASSET_BACKFILL_ENABLED is not true',
		}),
	);
	process.exit(0);
}

if (dryRun && cutoverAudit) {
	throw new Error(
		'IMAGE_ASSET_BACKFILL_CUTOVER_AUDIT requires a committed non-dry-run execution',
	);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const client = await pool.connect();
let insertedTotal = 0;
let batches = 0;
let candidateCount = 0;
let selectedTotal = 0;

try {
	if (dryRun) await client.query('BEGIN');
	await client.query(`SET lock_timeout = '${lockTimeoutMs}ms'`);
	await client.query(`SET statement_timeout = '${statementTimeoutMs}ms'`);

	await client.query(`
		CREATE TEMP TABLE image_asset_backfill_candidates (
			candidate_ordinal BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
			event_id TEXT NOT NULL,
			client_service_id TEXT NOT NULL,
			image_id INTEGER,
			path TEXT NOT NULL,
			name TEXT NOT NULL,
			original_name TEXT NOT NULL,
			image_key TEXT NOT NULL,
			content_type TEXT NOT NULL,
			format TEXT,
			width INTEGER,
			height INTEGER,
			input_bytes INTEGER,
			output_bytes INTEGER,
			occurred_at TIMESTAMP(3) NOT NULL
		) ON COMMIT PRESERVE ROWS
	`);

	await client.query(`
		CREATE TEMP VIEW image_asset_backfill_source AS
		WITH upload_events AS (
			SELECT
				e.event_id,
				e.client_service_id,
				e.image_id,
				e.path,
				e.name,
				COALESCE(e.raw_payload->>'originalName', e.name) AS original_name,
				e.image_key,
				COALESCE(e.raw_payload->>'contentType', 'image/' || COALESCE(NULLIF(e.format, ''), 'unknown')) AS content_type,
				e.format,
				e.width,
				e.height,
				e.input_bytes,
				e.output_bytes,
				e.occurred_at,
				0 AS source_rank
			FROM telemetry_events AS e
			WHERE e.event_type = 'image.upload.completed'
				AND e.status = 'success'
				AND e.client_service_id IS NOT NULL
			UNION ALL
			SELECT
				e.event_id,
				e.client_service_id,
				e.image_id,
				e.path,
				e.name,
				COALESCE(e.raw_payload->>'originalName', e.name) AS original_name,
				e.image_key,
				COALESCE(e.raw_payload->>'contentType', 'image/' || COALESCE(NULLIF(e.format, ''), 'unknown')) AS content_type,
				e.format,
				NULL::integer AS width,
				NULL::integer AS height,
				e.input_bytes,
				e.output_bytes,
				e.occurred_at,
				1 AS source_rank
			FROM image_lifecycle_events AS e
			WHERE e.event_type = 'image.upload.completed'
				AND e.status = 'success'
				AND e.client_service_id IS NOT NULL
		), latest_uploads AS (
			SELECT DISTINCT ON (client_service_id, image_key)
				*
			FROM upload_events
			ORDER BY client_service_id, image_key, occurred_at DESC, source_rank ASC, event_id DESC
		)
		SELECT e.*
		FROM latest_uploads AS e
		WHERE NOT EXISTS (
			SELECT 1
			FROM telemetry_events AS deleted
			WHERE deleted.event_type = 'image.delete.completed'
				AND deleted.status = 'success'
				AND deleted.client_service_id = e.client_service_id
				AND deleted.image_key = e.image_key
				AND deleted.occurred_at >= e.occurred_at
		)
			AND NOT EXISTS (
				SELECT 1
				FROM image_lifecycle_events AS deleted
				WHERE deleted.event_type = 'image.delete.completed'
					AND deleted.status = 'success'
					AND deleted.client_service_id = e.client_service_id
					AND deleted.image_key = e.image_key
					AND deleted.occurred_at >= e.occurred_at
			)
	`);

	const materialized = await client.query(`
		INSERT INTO image_asset_backfill_candidates (
			event_id, client_service_id, image_id, path, name, original_name,
			image_key, content_type, format, width, height, input_bytes,
			output_bytes, occurred_at
		)
		SELECT
			e.event_id, e.client_service_id, e.image_id, e.path, e.name,
			e.original_name, e.image_key, e.content_type, e.format, e.width,
			e.height, e.input_bytes, e.output_bytes, e.occurred_at
		FROM image_asset_backfill_source AS e
		WHERE NOT EXISTS (
				SELECT 1 FROM image_assets AS a
				WHERE a.source_event_id = e.event_id
					OR a.storage_key = e.image_key
					OR (
						a.client_service_id = e.client_service_id
						AND a.logical_path = e.path
						AND a.name = e.name
					)
			)
		ORDER BY e.occurred_at, e.event_id, e.client_service_id, e.image_key
	`);
	candidateCount = Number(materialized.rowCount ?? 0);
	await client.query('ANALYZE image_asset_backfill_candidates');

	let lastOrdinal = 0;
	while (batches < maxBatches && selectedTotal < candidateCount) {
		const result = await client.query(
			`WITH candidates AS MATERIALIZED (
				SELECT *
				FROM image_asset_backfill_candidates
				WHERE candidate_ordinal > $1
				ORDER BY candidate_ordinal
				LIMIT $2
				), eligible AS (
					SELECT e.* FROM candidates AS e
						WHERE NOT EXISTS (
							SELECT 1
							FROM telemetry_events AS deleted
							WHERE deleted.event_type = 'image.delete.completed'
								AND deleted.status = 'success'
								AND deleted.client_service_id = e.client_service_id
								AND deleted.image_key = e.image_key
								AND deleted.occurred_at >= e.occurred_at
						)
							AND NOT EXISTS (
								SELECT 1
								FROM image_lifecycle_events AS deleted
								WHERE deleted.event_type = 'image.delete.completed'
									AND deleted.status = 'success'
									AND deleted.client_service_id = e.client_service_id
									AND deleted.image_key = e.image_key
									AND deleted.occurred_at >= e.occurred_at
							)
						AND NOT EXISTS (
						SELECT 1 FROM image_assets AS a
						WHERE a.source_event_id = e.event_id
							OR a.storage_key = e.image_key
							OR (
								a.client_service_id = e.client_service_id
								AND a.logical_path = e.path
								AND a.name = e.name
							)
					)
			), inserted AS (
				INSERT INTO image_assets (
					asset_id, client_service_id, idempotency_key, source_event_id,
					external_image_id, logical_path, name, original_name, storage_key,
					content_type, input_bytes, bytes, width, height, format, status,
					ready_at, created_at, updated_at
				)
				SELECT
					'legacy-' || md5(client_service_id || ':' || event_id),
					client_service_id,
					'backfill:' || event_id,
					event_id,
					image_id,
					path,
					name,
					original_name,
					image_key,
					content_type,
					input_bytes,
					output_bytes,
					width,
					height,
					format,
					'Ready'::"ImageAssetState",
					occurred_at,
					occurred_at,
					CURRENT_TIMESTAMP
				FROM eligible
				ON CONFLICT DO NOTHING
				RETURNING asset_id
			)
			SELECT
				(SELECT COUNT(*)::integer FROM candidates) AS selected,
				(SELECT COUNT(*)::integer FROM inserted) AS inserted,
				(SELECT MAX(candidate_ordinal) FROM candidates) AS last_ordinal`,
			[lastOrdinal, batchSize],
		);
		const selected = Number(result.rows[0]?.selected ?? 0);
		const inserted = Number(result.rows[0]?.inserted ?? 0);
		if (selected === 0) break;
		lastOrdinal = Number(result.rows[0]?.last_ordinal ?? lastOrdinal);
		selectedTotal += selected;
		insertedTotal += inserted;
		batches += 1;
		if (selectedTotal < candidateCount && sleepMs > 0) await sleep(sleepMs);
	}

	await materializeLatestDeletes(client);
	const tombstoned = await tombstoneDeletedBackfilledAssets(client);
	const remaining = Math.max(0, candidateCount - selectedTotal);
	const snapshotComplete = remaining === 0;
	const auditCandidates =
		cutoverAudit && snapshotComplete
			? await countCurrentBackfillCandidates(client)
			: null;
	const auditTombstoneGaps =
		cutoverAudit && snapshotComplete
			? await countActiveBackfillsWithLaterDelete(client)
			: null;
	const cutoverReady =
		cutoverAudit &&
		ingestionDrainConfirmed &&
		snapshotComplete &&
		auditCandidates === 0 &&
		auditTombstoneGaps === 0;
	const incomplete = !snapshotComplete || (cutoverAudit && !cutoverReady);

	if (dryRun) await client.query('ROLLBACK');
	console.log(
		JSON.stringify({
			event: !snapshotComplete
				? 'image_asset_backfill_incomplete'
				: cutoverAudit
					? cutoverReady
						? 'image_asset_backfill_cutover_ready'
						: 'image_asset_backfill_cutover_incomplete'
					: 'image_asset_backfill_snapshot_completed',
			snapshotComplete,
			cutoverAudit,
			ingestionDrainConfirmed,
			cutoverReady,
			dryRun,
			batchSize,
			sleepMs,
			batches,
			candidates: candidateCount,
			selected: selectedTotal,
			inserted: insertedTotal,
			tombstoned,
			remaining,
			auditCandidates,
			auditTombstoneGaps,
		}),
	);
	if (incomplete) process.exitCode = 2;
} catch (error) {
	if (dryRun) await client.query('ROLLBACK').catch(() => undefined);
	throw error;
} finally {
	client.release();
	await pool.end();
}

function readInteger(name, fallback, min, max) {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
		throw new Error(`${name} must be an integer between ${min} and ${max}`);
	}
	return parsed;
}

function sleep(durationMs) {
	return new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function materializeLatestDeletes(database) {
	await database.query(`
		CREATE TEMP TABLE image_asset_backfill_latest_deletes (
			client_service_id TEXT NOT NULL,
			image_key TEXT NOT NULL,
			event_id TEXT NOT NULL,
			occurred_at TIMESTAMP(3) NOT NULL,
			PRIMARY KEY (client_service_id, image_key)
		) ON COMMIT PRESERVE ROWS
	`);
	await database.query(`
		WITH delete_events AS (
			SELECT
				e.event_id,
				e.client_service_id,
				e.image_key,
				e.occurred_at,
				0 AS source_rank
			FROM telemetry_events AS e
			WHERE e.event_type = 'image.delete.completed'
				AND e.status = 'success'
				AND e.client_service_id IS NOT NULL
			UNION ALL
			SELECT
				e.event_id,
				e.client_service_id,
				e.image_key,
				e.occurred_at,
				1 AS source_rank
			FROM image_lifecycle_events AS e
			WHERE e.event_type = 'image.delete.completed'
				AND e.status = 'success'
				AND e.client_service_id IS NOT NULL
		)
		INSERT INTO image_asset_backfill_latest_deletes (
			event_id, client_service_id, image_key, occurred_at
		)
		SELECT DISTINCT ON (client_service_id, image_key)
			event_id, client_service_id, image_key, occurred_at
		FROM delete_events
		ORDER BY client_service_id, image_key, occurred_at DESC, source_rank ASC, event_id DESC
	`);
	await database.query('ANALYZE image_asset_backfill_latest_deletes');
}

async function tombstoneDeletedBackfilledAssets(database) {
	const result = await database.query(`
		WITH targets AS MATERIALIZED (
			SELECT
				a.asset_id,
				deleted.event_id,
				deleted.occurred_at
			FROM image_assets AS a
			JOIN image_asset_backfill_latest_deletes AS deleted
				ON deleted.client_service_id = a.client_service_id
				AND deleted.image_key = a.storage_key
				AND deleted.occurred_at >= COALESCE(a.ready_at, a.created_at)
			WHERE a.idempotency_key LIKE 'backfill:%'
				AND a.status <> 'Deleted'::"ImageAssetState"
		), cancelled_jobs AS (
			UPDATE image_variant_jobs AS job
			SET
				status = 'Cancelled'::"ImageVariantJobState",
				lease_owner = NULL,
				lease_expires_at = NULL,
				updated_at = CURRENT_TIMESTAMP
			FROM targets
			WHERE job.asset_id = targets.asset_id
				AND job.status IN (
					'Pending'::"ImageVariantJobState",
					'Processing'::"ImageVariantJobState",
					'Failed'::"ImageVariantJobState"
				)
			RETURNING job.job_id
		), deleted_variants AS (
			UPDATE image_variants AS variant
			SET
				status = 'Deleted'::"ImageVariantState",
				deleting_at = COALESCE(variant.deleting_at, targets.occurred_at),
				deleted_at = COALESCE(variant.deleted_at, targets.occurred_at),
				failure_reason = NULL,
				failed_at = NULL,
				updated_at = CURRENT_TIMESTAMP
			FROM targets
			WHERE variant.asset_id = targets.asset_id
				AND variant.status <> 'Deleted'::"ImageVariantState"
			RETURNING variant.variant_id
		), deleted_assets AS (
			UPDATE image_assets AS asset
			SET
				status = 'Deleted'::"ImageAssetState",
				delete_event_id = COALESCE(asset.delete_event_id, targets.event_id),
				deleting_at = COALESCE(asset.deleting_at, targets.occurred_at),
				deleted_at = COALESCE(asset.deleted_at, targets.occurred_at),
				failure_reason = NULL,
				failed_at = NULL,
				updated_at = CURRENT_TIMESTAMP
			FROM targets
			WHERE asset.asset_id = targets.asset_id
			RETURNING asset.asset_id
		)
		SELECT COUNT(*)::integer AS count FROM deleted_assets
	`);
	return Number(result.rows[0]?.count ?? 0);
}

async function countCurrentBackfillCandidates(database) {
	const result = await database.query(`
		SELECT COUNT(*)::integer AS count
		FROM image_asset_backfill_source AS source
		WHERE NOT EXISTS (
			SELECT 1 FROM image_assets AS asset
			WHERE asset.source_event_id = source.event_id
				OR asset.storage_key = source.image_key
				OR (
					asset.client_service_id = source.client_service_id
					AND asset.logical_path = source.path
					AND asset.name = source.name
				)
		)
	`);
	return Number(result.rows[0]?.count ?? 0);
}

async function countActiveBackfillsWithLaterDelete(database) {
	const result = await database.query(`
		SELECT COUNT(*)::integer AS count
		FROM image_assets AS asset
		JOIN image_asset_backfill_latest_deletes AS deleted
			ON deleted.client_service_id = asset.client_service_id
			AND deleted.image_key = asset.storage_key
			AND deleted.occurred_at >= COALESCE(asset.ready_at, asset.created_at)
		WHERE asset.idempotency_key LIKE 'backfill:%'
			AND asset.status <> 'Deleted'::"ImageAssetState"
	`);
	return Number(result.rows[0]?.count ?? 0);
}
