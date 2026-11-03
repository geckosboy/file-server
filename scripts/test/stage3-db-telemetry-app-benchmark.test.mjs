import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	authoritativeFixtureStatements,
	withSearchPath,
} from '../stage3-db-telemetry-app-benchmark.mjs';

describe('stage3 telemetry application benchmark fixture', () => {
	it('resolves benchmark-owned tables before migrated public types and tables', () => {
		const url = new URL(
			withSearchPath(
				'postgresql://benchmark:secret@127.0.0.1:5544/file_server?application_name=probe',
			),
		);

		assert.equal(url.searchParams.get('application_name'), 'probe');
		assert.equal(
			url.searchParams.get('options'),
			'-c search_path=stage3_telemetry_benchmark,public',
		);
	});

	it('builds isolated authoritative ImageAsset fixtures from successful uploads', () => {
		const sql = authoritativeFixtureStatements().join('\n');

		for (const table of [
			'client_services',
			'image_assets',
			'image_lifecycle_events',
		]) {
			assert.match(
				sql,
				new RegExp(
					`CREATE UNLOGGED TABLE "stage3_telemetry_benchmark"\\."${table}" \\(LIKE public\\."${table}" INCLUDING ALL\\)`,
				),
			);
		}
		assert.match(
			sql,
			/INSERT INTO "stage3_telemetry_benchmark"\."image_assets"/,
		);
		assert.match(
			sql,
			/FROM "stage3_telemetry_benchmark"\."telemetry_events" AS "event"/,
		);
		assert.match(sql, /"event"\."event_type" = 'image\.upload\.completed'/);
		assert.match(sql, /"event"\."status" = 'success'/);
		assert.match(sql, /'Ready'::public\."ImageAssetState"/);
		assert.doesNotMatch(sql, /INSERT INTO public\./);
	});
});
