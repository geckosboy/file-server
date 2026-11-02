import {
	clientServicesFixture,
	lifecycleEventListFixture,
} from '@/lib/fixtures';
import {
	buildRangeFromPreset,
	readOptionalSearchParam,
	readRangePreset,
	resolveSearchParams,
	type PageSearchParams,
} from '@/lib/search-params';
import {
	fetchClientServices,
	fetchLifecycleEvents,
	isAdminFixtureFallbackEnabled,
	type LifecycleEventsQuery,
} from '@/lib/telemetry-api';
import {
	LifecycleEventsPageContent,
	readLifecycleEventType,
	readLifecycleStatus,
	type LifecycleEventsFilters,
	type LifecycleEventsPageContentProps,
} from './page-content';

function buildLifecycleEventsFilters(
	params: PageSearchParams,
): LifecycleEventsFilters {
	return {
		range: readRangePreset(params),
		clientServiceId: readOptionalSearchParam(params, 'clientServiceId'),
		eventType: readLifecycleEventType(params),
		status: readLifecycleStatus(params),
		imageKey: readOptionalSearchParam(params, 'imageKey'),
	};
}

async function fetchLifecycleEventsPageData(
	params: PageSearchParams,
): Promise<LifecycleEventsPageContentProps> {
	const filters = buildLifecycleEventsFilters(params);
	const query: LifecycleEventsQuery = {
		...buildRangeFromPreset(filters.range),
		clientServiceId: filters.clientServiceId,
		eventType: filters.eventType,
		status: filters.status,
		imageKey: filters.imageKey,
		limit: 50,
	};

	try {
		const [services, data] = await Promise.all([
			fetchClientServices(),
			fetchLifecycleEvents(query),
		]);
		return { data, services, filters };
	} catch {
		if (!isAdminFixtureFallbackEnabled()) {
			return {
				data: { items: [] },
				services: [],
				filters,
				errorMessage:
					'telemetry-api에 연결할 수 없습니다. 운영 lifecycle 이벤트 대신 빈 상태를 표시합니다.',
			};
		}
		return {
			data: lifecycleEventListFixture,
			services: clientServicesFixture,
			filters,
			errorMessage:
				'telemetry-api lifecycle 이벤트를 불러오지 못해 fixture 데이터로 표시합니다.',
		};
	}
}

export default async function LifecycleEventsPage({
	searchParams,
}: {
	searchParams?: Promise<PageSearchParams>;
}) {
	const props = await fetchLifecycleEventsPageData(
		await resolveSearchParams(searchParams),
	);
	return <LifecycleEventsPageContent {...props} />;
}
