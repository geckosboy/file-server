import { eventListFixture } from '@/lib/fixtures';
import {
	formatBytes,
	formatDateTime,
	formatMs,
	statusLabel,
} from '@/lib/format';
import {
	fetchEvents,
	type EventListItem,
	type EventListResponse,
} from '@/lib/telemetry-api';

const sortEventsByOccurredAtDesc = (items: EventListItem[]) =>
	[...items].sort(
		(left, right) =>
			new Date(right.occurredAt).getTime() -
			new Date(left.occurredAt).getTime(),
	);

type EventsPageContentProps = {
	data: EventListResponse;
	errorMessage?: string;
};

export function EventsPageContent({
	data,
	errorMessage,
}: EventsPageContentProps) {
	const sortedEvents = sortEventsByOccurredAtDesc(data.items);

	return (
		<main className="page-shell">
			<section className="hero">
				<div>
					<h1>이미지 이벤트 로그</h1>
					<p>
						기간, 이벤트 타입, source app, status, path/name으로 원본 telemetry
						이벤트를 검색합니다.
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
						<select name="range" defaultValue="24h">
							<option value="1h">최근 1시간</option>
							<option value="24h">최근 24시간</option>
							<option value="7d">최근 7일</option>
						</select>
					</label>
					<label>
						이벤트 타입
						<select name="eventType" defaultValue="">
							<option value="">전체</option>
							<option value="image.cache.hit">image.cache.hit</option>
							<option value="image.cache.miss">image.cache.miss</option>
							<option value="image.resize.failed">image.resize.failed</option>
						</select>
					</label>
					<label>
						source app
						<select name="sourceApp" defaultValue="">
							<option value="">전체</option>
							<option value="storage">storage</option>
							<option value="resize">resize</option>
							<option value="cache">cache</option>
						</select>
					</label>
					<label>
						status
						<select name="status" defaultValue="">
							<option value="">전체</option>
							<option value="success">success</option>
							<option value="failed">failed</option>
						</select>
					</label>
					<label>
						path/name
						<input name="q" placeholder="products/main 또는 hero.png" />
					</label>
				</form>

				{sortedEvents.length === 0 ? (
					<p className="empty-state">조건에 맞는 이벤트가 없습니다.</p>
				) : (
					<table>
						<thead>
							<tr>
								<th>발생 시각</th>
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

async function fetchEventsPageData(): Promise<EventsPageContentProps> {
	try {
		return { data: await fetchEvents({ limit: 50 }) };
	} catch {
		return {
			data: eventListFixture,
			errorMessage:
				'텔레메트리 API를 불러오지 못해 fixture 데이터로 표시합니다.',
		};
	}
}

export default async function EventsPage() {
	const props = await fetchEventsPageData();
	return <EventsPageContent {...props} />;
}
