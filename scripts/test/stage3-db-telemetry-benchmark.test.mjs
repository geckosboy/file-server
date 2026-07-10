import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	createApplicationOperations,
	evaluateGates,
	parseArgs,
	percentile,
	sanitizeDatabaseUrl,
} from '../stage3-db-telemetry-benchmark.mjs';

describe('stage3 DB telemetry benchmark contract', () => {
	it('defaults to the required 1M fixture and a stable sample configuration', () => {
		assert.deepEqual(parseArgs([]), {
			rows: 1_000_000,
			samples: 20,
			warmups: 5,
			output: undefined,
			reset: true,
			cleanup: false,
			help: false,
		});
	});

	it('uses the same nearest-rank p95 contract as telemetry responses', () => {
		assert.equal(percentile([10, 20, 30, 40, 50], 0.95), 50);
		assert.equal(percentile([], 0.95), null);
	});

	it('fails when either list, dashboard, or RSS gate is exceeded', () => {
		const passing = measurementFixture();
		assert.equal(evaluateGates(passing).passed, true);

		const failing = measurementFixture();
		failing.middlePage.p95Ms = 301;
		assert.deepEqual(evaluateGates(failing), {
			checks: {
				firstPageP95: true,
				middlePageP95: false,
				dashboardP95: true,
				rssDelta: true,
			},
			passed: false,
		});
	});

	it('redacts credentials from evidence metadata', () => {
		assert.equal(
			sanitizeDatabaseUrl('postgresql://user:secret@db.example:5544/files'),
			'postgresql://db.example:5544/files',
		);
	});

	it('executes the application Prisma list predicates used by the repository', async () => {
		const calls = [];
		const prisma = {
			telemetryEvent: {
				findMany: async (query) => {
					calls.push(query);
					return [];
				},
			},
			$queryRawUnsafe: async (...query) => {
				calls.push(query);
				return [];
			},
		};
		const occurredAt = new Date('2026-07-01T00:00:00.000Z');
		const operations = createApplicationOperations(prisma, {
			clientServiceId: 'service-03',
			cursor: { occurred_at: occurredAt, event_id: 'evt-100' },
			dashboardParameters: [occurredAt, occurredAt],
		});

		await operations.firstPage();
		await operations.middlePage();
		await operations.dashboard24h();

		assert.deepEqual(calls[0], {
			where: { clientServiceId: 'service-03' },
			orderBy: [{ occurredAt: 'desc' }, { eventId: 'desc' }],
			take: 51,
		});
		assert.deepEqual(calls[1].where.AND[1].OR, [
			{ occurredAt: { lt: occurredAt } },
			{ occurredAt, eventId: { lt: 'evt-100' } },
		]);
		assert.equal(typeof calls[2][0], 'string');
	});

	it('rejects invalid or unknown CLI options', () => {
		assert.throws(() => parseArgs(['--rows=0']), /positive integer/);
		assert.throws(() => parseArgs(['--unknown']), /Unknown argument/);
	});
});

function measurementFixture() {
	return {
		firstPage: { p95Ms: 100, maxRssDeltaBytes: 1024 },
		middlePage: { p95Ms: 200, maxRssDeltaBytes: 2048 },
		dashboard24h: { p95Ms: 900, maxRssDeltaBytes: 4096 },
	};
}
