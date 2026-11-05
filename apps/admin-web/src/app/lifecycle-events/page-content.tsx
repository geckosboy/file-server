import { ClientServiceSelect } from '@/components/client-service-select';
import {
	formatBytes,
	formatDateTime,
	formatMs,
	statusLabel,
} from '@/lib/format';
import {
	readOptionalSearchParam,
	type PageSearchParams,
} from '@/lib/search-params';
import type {
	ClientServiceItem,
	LifecycleEventListItem,
	LifecycleEventListResponse,
	LifecycleEventsQuery,
} from '@/lib/telemetry-api';

const lifecycleEventTypes = [
	'image.upload.completed',
	'image.upload.failed',
	'image.delete.completed',
	'image.delete.failed',
] as const;

const lifecycleStatuses = ['success', 'failed'] as const;

const sortLifecycleEventsByOccurredAtDesc = (items: LifecycleEventListItem[]) =>
	[...items].sort(
		(left, right) =>
			new Date(right.occurredAt).getTime() -
			new Date(left.occurredAt).getTime(),
	);

export type LifecycleEventsFilters = {
	range: string;
	clientServiceId?: string;
	eventType?: LifecycleEventsQuery['eventType'];
	status?: LifecycleEventsQuery['status'];
	imageKey?: string;
};

export type LifecycleEventsPageContentProps = {
	data: LifecycleEventListResponse;
	services: ClientServiceItem[];
	filters: LifecycleEventsFilters;
	errorMessage?: string;
};

export function LifecycleEventsPageContent({
	data,
	services,
	filters,
	errorMessage,
}: LifecycleEventsPageContentProps) {
	const events = sortLifecycleEventsByOccurredAtDesc(data.items);

	return (
		<main className="page-shell">
			<section className="hero">
				<div>
					<h1>이미지 lifecycle 이벤트</h1>
					<p>
						Client Service가 소비할 upload/delete completed/failed 업무 이벤트를
						서비스, 이벤트 타입, status, imageKey, 기간별로 조회합니다.
					</p>
				</div>
			</section>
			{errorMessage ? (
				<p className="error-state" role="status">
					{errorMessage}
				</p>
			) : null}

			<section className="panel">
				<form className="filter-panel" aria-label="lifecycle 이벤트 필터">
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
							<option value="image.upload.completed">
								image.upload.completed
							</option>
							<option value="image.upload.failed">image.upload.failed</option>
							<option value="image.delete.completed">
								image.delete.completed
							</option>
							<option value="image.delete.failed">image.delete.failed</option>
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
						imageKey
						<input
							name="imageKey"
							placeholder="products/main/hero.png"
							defaultValue={filters.imageKey ?? ''}
						/>
					</label>
					<button className="button" type="submit">
						필터 적용
					</button>
				</form>

				{events.length === 0 ? (
					<p className="empty-state">
						조건에 맞는 lifecycle 이벤트가 없습니다.
					</p>
				) : (
					<table>
						<thead>
							<tr>
								<th>발생 시각</th>
								<th>service</th>
								<th>eventType</th>
								<th>status</th>
								<th>imageKey</th>
								<th>imageId</th>
								<th>duration</th>
								<th>bytes</th>
								<th>request / detail</th>
							</tr>
						</thead>
						<tbody>
							{events.map((event) => (
								<tr key={event.eventId}>
									<td>{formatDateTime(event.occurredAt)}</td>
									<td>
										{event.clientServiceSlug ?? event.clientServiceId ?? '-'}
									</td>
									<td>{event.eventType}</td>
									<td>
										<span className={`badge badge-${event.status}`}>
											{statusLabel(event.status)}
										</span>
									</td>
									<td>
										<strong>{event.imageKey}</strong>
										<br />
										<small>
											{event.path}/{event.name}
										</small>
									</td>
									<td>{event.imageId ?? '-'}</td>
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
										<LifecycleEventDetail event={event} />
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

function LifecycleEventDetail({ event }: { event: LifecycleEventListItem }) {
	return (
		<details className="event-detail">
			<summary>상세 보기</summary>
			<dl className="details-grid">
				<div>
					<dt>eventId</dt>
					<dd>{event.eventId}</dd>
				</div>
				<div>
					<dt>receivedAt</dt>
					<dd>{event.receivedAt ? formatDateTime(event.receivedAt) : '-'}</dd>
				</div>
				<div>
					<dt>environment</dt>
					<dd>{event.environment ?? '-'}</dd>
				</div>
				<div>
					<dt>format</dt>
					<dd>{event.format ?? '-'}</dd>
				</div>
				<div>
					<dt>traceId</dt>
					<dd>{event.traceId ?? '-'}</dd>
				</div>
				<div>
					<dt>rawPayload</dt>
					<dd>
						<pre className="raw-json">
							{JSON.stringify(event.rawPayload ?? {}, null, 2)}
						</pre>
					</dd>
				</div>
			</dl>
		</details>
	);
}

export function readLifecycleEventType(
	params: PageSearchParams,
): LifecycleEventsFilters['eventType'] {
	const eventType = readOptionalSearchParam(params, 'eventType');
	return lifecycleEventTypes.some((value) => value === eventType)
		? (eventType as LifecycleEventsFilters['eventType'])
		: undefined;
}

export function readLifecycleStatus(
	params: PageSearchParams,
): LifecycleEventsFilters['status'] {
	const status = readOptionalSearchParam(params, 'status');
	return lifecycleStatuses.some((value) => value === status)
		? (status as LifecycleEventsFilters['status'])
		: undefined;
}
