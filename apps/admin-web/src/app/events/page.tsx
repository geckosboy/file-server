import { ClientServiceSelect } from '@/components/client-service-select';
import { clientServicesFixture, eventListFixture } from '@/lib/fixtures';
import {
	formatBytes,
	formatDateTime,
	formatMs,
	statusLabel,
} from '@/lib/format';
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
	type ClientServiceItem,
	type EventListItem,
	type EventListResponse,
	type EventsQuery,
} from '@/lib/telemetry-api';

const sortEventsByOccurredAtDesc = (items: EventListItem[]) =>
	[...items].sort(
		(left, right) =>
			new Date(right.occurredAt).getTime() -
			new Date(left.occurredAt).getTime(),
	);

type EventsFilters = {
	range: string;
	clientServiceId?: string;
	eventType?: string;
	sourceApp?: EventsQuery['sourceApp'];
	status?: EventsQuery['status'];
	path?: string;
	requestId?: string;
};

type EventsPageContentProps = {
	data: EventListResponse;
	services: ClientServiceItem[];
	filters: EventsFilters;
	errorMessage?: string;
};

export function EventsPageContent({
	data,
	services,
	filters,
	errorMessage,
}: EventsPageContentProps) {
	const sortedEvents = sortEventsByOccurredAtDesc(data.items);

	return (
		<main className="page-shell">
			<section className="hero">
				<div>
					<h1>이미지 이벤트 로그</h1>
					<p>
						기간, client service, 이벤트 타입, source app, status,
						path/requestId로 원본 telemetry 이벤트를 검색합니다.
					</p>
				</div>
			</section>
			{errorMessage ? (
				<p className="error-state" role="status">
					{errorMessage}
				</p>
			) : null}

			<section className="panel">
				<form className="filter-panel" aria-label="이벤트 필터">
					<label>
						기간
						<select name="range" defaultValue={filters.range}>
							<option value="1h">최근 1시간</option>
							<option value="24h">최근 24시간</option>
							<option value="7d">최근 7일</option>
							<option value="30d">최근 30일</option>
						</select>
					</label>
					<ClientServiceSelect
						services={services}
						selectedClientServiceId={filters.clientServiceId}
					/>
					<label>
						이벤트 타입
						<select name="eventType" defaultValue={filters.eventType ?? ''}>
							<option value="">전체</option>
							<option value="image.cache.hit">image.cache.hit</option>
							<option value="image.cache.miss">image.cache.miss</option>
							<option value="image.resize.completed">
								image.resize.completed
							</option>
							<option value="image.resize.failed">image.resize.failed</option>
							<option value="image.upload.completed">
								image.upload.completed
							</option>
						</select>
					</label>
					<label>
						source app
						<select name="sourceApp" defaultValue={filters.sourceApp ?? ''}>
							<option value="">전체</option>
							<option value="storage">storage</option>
							<option value="resize">resize</option>
							<option value="cache">cache</option>
						</select>
					</label>
					<label>
						status
						<select name="status" defaultValue={filters.status ?? ''}>
							<option value="">전체</option>
							<option value="success">success</option>
							<option value="failed">failed</option>
						</select>
					</label>
					<label>
						path/name
						<input
							name="path"
							placeholder="products/main 또는 hero.png"
							defaultValue={filters.path ?? ''}
						/>
					</label>
					<label>
						requestId
						<input
							name="requestId"
							placeholder="req-cache-101"
							defaultValue={filters.requestId ?? ''}
						/>
					</label>
					<button className="button" type="submit">
						필터 적용
					</button>
				</form>

				{sortedEvents.length === 0 ? (
					<p className="empty-state">조건에 맞는 이벤트가 없습니다.</p>
				) : (
					<table>
						<thead>
							<tr>
								<th>발생 시각</th>
								<th>service</th>
								<th>eventType</th>
								<th>source</th>
								<th>status</th>
								<th>path/name</th>
								<th>크기</th>
								<th>duration</th>
								<th>bytes</th>
								<th>requestId / error</th>
							</tr>
						</thead>
						<tbody>
							{sortedEvents.map((event) => (
								<tr key={event.eventId}>
									<td>{formatDateTime(event.occurredAt)}</td>
									<td>
										{event.clientServiceSlug ?? event.clientServiceId ?? '-'}
									</td>
									<td>{event.eventType}</td>
									<td>{event.sourceApp}</td>
									<td>
										<span className={`badge badge-${event.status}`}>
											{statusLabel(event.status)}
										</span>
									</td>
									<td>
										<strong>{event.path}</strong>
										<br />
										{event.name}
									</td>
									<td>
										{event.width ?? '-'} × {event.height ?? '-'}
									</td>
									<td>{formatMs(event.durationMs)}</td>
									<td>
										{formatBytes(event.inputBytes)} /{' '}
										{formatBytes(event.outputBytes)}
									</td>
									<td>
										{event.requestId ?? '-'}
										{event.errorMessage ? (
											<small>
												<br />
												{event.errorCode}: {event.errorMessage}
											</small>
										) : null}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}

				<div className="pagination">
					<button disabled={!data.nextCursor} type="button">
						다음 페이지
					</button>
				</div>
			</section>
		</main>
	);
}

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
