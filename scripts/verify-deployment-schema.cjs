'use strict';

const { createRequire } = require('node:module');

const REQUIRED_BACKFILL_INDEXES = [
	'telemetry_events_image_asset_backfill_idx',
	'image_lifecycle_events_image_asset_backfill_idx',
];

function validateDeploymentState(migrations, indexes, expectedMigrations) {
	const failures = [];
	for (const name of expectedMigrations) {
		const activeRecords = migrations.filter(
			(migration) =>
				migration.migration_name === name && !migration.rolled_back_at,
		);
		if (activeRecords.length === 0) {
			failures.push(`Migration ${name} is not applied.`);
		} else if (activeRecords.some((migration) => !migration.finished_at)) {
			failures.push(`Migration ${name} is not finished.`);
		}
	}

	const indexByName = new Map(
		indexes.map((index) => [index.index_name, index]),
	);
	for (const name of REQUIRED_BACKFILL_INDEXES) {
		const index = indexByName.get(name);
		if (!index || index.is_valid !== true || index.is_ready !== true) {
			failures.push(`Index ${name} must exist and be valid and ready.`);
		}
	}
	return failures;
}

async function verify() {
	const expectedMigrations = (process.env.EXPECTED_MIGRATIONS || '')
		.split(',')
		.map((name) => name.trim())
		.filter(Boolean);
	if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
	if (expectedMigrations.length === 0) {
		throw new Error('EXPECTED_MIGRATIONS is required.');
	}

	const databaseRequire = createRequire(require.resolve('@file/database'));
	const { PrismaClient } = databaseRequire('@prisma/client');
	const { PrismaPg } = databaseRequire('@prisma/adapter-pg');
	const adapter = new PrismaPg({
		connectionString: process.env.DATABASE_URL,
		connectionTimeoutMillis: 5_000,
		statement_timeout: 5_000,
	});
	const prisma = new PrismaClient({ adapter });
	try {
		const migrations = await prisma.$queryRawUnsafe(`
			SELECT migration_name, finished_at, rolled_back_at
			FROM "_prisma_migrations"
			ORDER BY migration_name
		`);
		const indexes = await prisma.$queryRawUnsafe(`
			SELECT
				indexes.indexname AS index_name,
				pg_index.indisvalid AS is_valid,
				pg_index.indisready AS is_ready
			FROM pg_catalog.pg_indexes AS indexes
			JOIN pg_catalog.pg_namespace
				ON pg_namespace.nspname = indexes.schemaname
			JOIN pg_catalog.pg_class AS index_class
				ON index_class.relnamespace = pg_namespace.oid
				AND index_class.relname = indexes.indexname
			JOIN pg_catalog.pg_index ON pg_index.indexrelid = index_class.oid
			WHERE indexes.schemaname = current_schema()
				AND indexes.indexname IN (
					'telemetry_events_image_asset_backfill_idx',
					'image_lifecycle_events_image_asset_backfill_idx'
				)
		`);
		const failures = validateDeploymentState(
			migrations,
			indexes,
			expectedMigrations,
		);
		if (failures.length > 0) throw new Error(failures.join('\n'));
		console.log(
			`Deployment schema verified: ${expectedMigrations.length} migrations and ${REQUIRED_BACKFILL_INDEXES.length} online indexes are ready.`,
		);
	} finally {
		await prisma.$disconnect();
	}
}

if (require.main === module) {
	verify().catch((error) => {
		const isValidationFailure =
			error instanceof Error &&
			(error.message.startsWith('Migration ') ||
				error.message.startsWith('Index '));
		console.error(
			isValidationFailure
				? `Deployment schema verification failed:\n${error.message}`
				: 'Deployment schema verification failed; database details were suppressed.',
		);
		process.exitCode = 1;
	});
}

module.exports = { REQUIRED_BACKFILL_INDEXES, validateDeploymentState };
