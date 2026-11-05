import { clientServicesFixture, dashboardDataFixture } from '@/lib/fixtures';
import {
	buildRangeFromPreset,
	readOptionalSearchParam,
	readRangePreset,
	resolveSearchParams,
	type PageSearchParams,
} from '@/lib/search-params';
import {
	fetchClientServices,
	fetchDashboardSummary,
	fetchDashboardTimeseries,
	fetchImages,
	isAdminFixtureFallbackEnabled,
	type DashboardQuery,
} from '@/lib/telemetry-api';
import {
	DashboardPageContent,
	type DashboardFilters,
	type DashboardPageContentProps,
} from './page-content';

function buildDashboardFilters(params: PageSearchParams): DashboardFilters {
	return {
		range: readRangePreset(params),
		clientServiceId: readOptionalSearchParam(params, 'clientServiceId'),
	};
}

async function fetchDashboardData(
	params: PageSearchParams,
): Promise<DashboardPageContentProps> {
	const filters = buildDashboardFilters(params);
	const query: DashboardQuery = {
		...buildRangeFromPreset(filters.range),
		clientServiceId: filters.clientServiceId,
	};

	try {
		const [services, summary, timeseries, images] = await Promise.all([
			fetchClientServices(),
			fetchDashboardSummary(query),
			fetchDashboardTimeseries({ ...query, interval: 'hour' }),
			fetchImages({ ...query, sort: 'reads', order: 'desc', limit: 10 }),
		]);

		return {
			data: {
				summary,
				timeseries: timeseries.points,
				topImages: images.items,
			},
			services,
			filters,
		};
	} catch {
		if (!isAdminFixtureFallbackEnabled()) {
			return {
				data: {
					summary: {
						range: { from: query.from!, to: query.to! },
						totalEvents: 0,
						totalReads: 0,
						totalUploads: 0,
						totalResizes: 0,
						cacheHitRate: null,
						cacheMissRate: null,
						failureRate: null,
						avgDurationMs: null,
						p95DurationMs: null,
						totalInputBytes: 0,
						totalOutputBytes: 0,
					},
					timeseries: [],
					topImages: [],
				},
				services: [],
				filters,
				errorMessage:
					'텔레메트리 API에 연결할 수 없습니다. 운영 데이터 대신 빈 상태를 표시합니다.',
			};
		}
		return {
			data: dashboardDataFixture,
			services: clientServicesFixture,
			filters,
			errorMessage:
				'텔레메트리 API를 불러오지 못해 fixture 데이터로 표시합니다.',
		};
	}
}

export default async function DashboardPage({
	searchParams,
}: {
	searchParams?: Promise<PageSearchParams>;
}) {
	const props = await fetchDashboardData(
		await resolveSearchParams(searchParams),
	);
	return <DashboardPageContent {...props} />;
}
