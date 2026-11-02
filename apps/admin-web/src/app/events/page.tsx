import { clientServicesFixture, eventListFixture } from '@/lib/fixtures';
import {
	buildRangeFromPreset,
	readOptionalSearchParam,
	readRangePreset,
	resolveSearchParams,
	type PageSearchParams,
} from '@/lib/search-params';
import {
	fetchClientServices,
	fetchEvents,
	isAdminFixtureFallbackEnabled,
	type EventsQuery,
} from '@/lib/telemetry-api';
import {
	EventsPageContent,
	type EventsFilters,
	type EventsPageContentProps,
} from './page-content';

function buildEventsFilters(params: PageSearchParams): EventsFilters {
	return {
		range: readRangePreset(params),
		clientServiceId: readOptionalSearchParam(params, 'clientServiceId'),
		eventType: readOptionalSearchParam(params, 'eventType'),
		sourceApp: readOptionalSearchParam(
			params,
			'sourceApp',
		) as EventsFilters['sourceApp'],
		status: readOptionalSearchParam(
			params,
			'status',
		) as EventsFilters['status'],
		path: readOptionalSearchParam(params, 'path'),
		requestId: readOptionalSearchParam(params, 'requestId'),
	};
}

async function fetchEventsPageData(
	params: PageSearchParams,
): Promise<EventsPageContentProps> {
	const filters = buildEventsFilters(params);
	const query: EventsQuery = {
		...buildRangeFromPreset(filters.range),
		clientServiceId: filters.clientServiceId,
		eventType: filters.eventType,
		sourceApp: filters.sourceApp,
		status: filters.status,
		path: filters.path,
		requestId: filters.requestId,
		limit: 50,
	};

	try {
		const [services, data] = await Promise.all([
			fetchClientServices(),
			fetchEvents(query),
		]);
		return { data, services, filters };
	} catch {
		if (!isAdminFixtureFallbackEnabled()) {
			return {
				data: { items: [] },
				services: [],
				filters,
				errorMessage:
					'텔레메트리 API에 연결할 수 없습니다. 운영 이벤트 대신 빈 상태를 표시합니다.',
			};
		}
		return {
			data: eventListFixture,
			services: clientServicesFixture,
			filters,
			errorMessage:
				'텔레메트리 API를 불러오지 못해 fixture 데이터로 표시합니다.',
		};
	}
}

export default async function EventsPage({
	searchParams,
}: {
	searchParams?: Promise<PageSearchParams>;
}) {
	const props = await fetchEventsPageData(
		await resolveSearchParams(searchParams),
	);
	return <EventsPageContent {...props} />;
}
