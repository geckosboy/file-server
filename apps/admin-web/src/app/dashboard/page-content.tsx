import { ClientServiceSelect } from '@/components/client-service-select';
import { MetricCard } from '@/components/metric-card';
import { SimpleBarChart } from '@/components/simple-bar-chart';
import {
	formatDateTime,
	formatMs,
	formatNumber,
	formatPercent,
} from '@/lib/format';
import type {
	ClientServiceItem,
	DashboardData,
	DashboardSummary,
} from '@/lib/telemetry-api';

const isDangerFailureRate = (summary: DashboardSummary) =>
	(summary.failureRate ?? 0) >= 0.02;

export type DashboardFilters = {
	range: string;
	clientServiceId?: string;
};

export type DashboardPageContentProps = {
	data: DashboardData;
	services: ClientServiceItem[];
	filters: DashboardFilters;
	errorMessage?: string;
};

export function DashboardPageContent({
	data,
	services,
	filters,
	errorMessage,
}: DashboardPageContentProps) {
	const { summary, timeseries, topImages } = data;
	const cacheHitDescription =
		summary.cacheHitRate === null
			? '캐시 이벤트 데이터 없음'
			: '선택한 기간 hit / (hit + miss)';
	const failureDescription = isDangerFailureRate(summary)
		? '위험: 실패율 임계값 초과'
		: '전체 이벤트 대비 실패 이벤트';

	return (
		<main className="page-shell">
			<section className="hero">
				<div>
					<h1>파일서버 관리자 대시보드</h1>
					<p>
						서비스별 이미지 요청, 캐시, 리사이즈, 실패 이벤트를 한눈에
						확인합니다.
					</p>
				</div>
				<p className="filter-help">
					기간: {formatDateTime(summary.range.from)} ~{' '}
					{formatDateTime(summary.range.to)}
				</p>
			</section>
			{errorMessage ? (
				<p className="error-state" role="status">
					{errorMessage}
				</p>
			) : null}

			<section className="panel">
				<form className="filter-panel" aria-label="대시보드 필터">
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
					<button className="button" type="submit">
						필터 적용
					</button>
				</form>
			</section>

			<section className="grid metric-grid" aria-label="대시보드 KPI 카드">
				<MetricCard
					label="총 이벤트 수"
					value={formatNumber(summary.totalEvents)}
					description="수집된 표준 image telemetry 이벤트"
				/>
				<MetricCard
					label="캐시 hit율"
					value={formatPercent(summary.cacheHitRate)}
					description={cacheHitDescription}
					intent={summary.cacheHitRate === null ? 'neutral' : 'success'}
				/>
				<MetricCard
					label="리사이즈 완료"
					value={formatNumber(summary.totalResizes)}
					description="image.resize.completed 이벤트"
				/>
				<MetricCard
					label="평균 처리 시간"
					value={formatMs(summary.avgDurationMs)}
					description="durationMs가 있는 이벤트 기준"
				/>
				<MetricCard
					label="p95 처리 시간"
					value={formatMs(summary.p95DurationMs)}
					description="느린 이미지 변환 탐지 지표"
				/>
				<MetricCard
					label="실패율"
					value={formatPercent(summary.failureRate)}
					description={failureDescription}
					intent={isDangerFailureRate(summary) ? 'danger' : 'neutral'}
				/>
			</section>

			<section className="grid two-column-grid">
				<SimpleBarChart
					title="캐시 hit/miss 추이"
					primaryLabel="hit"
					secondaryLabel="miss"
					points={timeseries.map((point) => ({
						label: formatDateTime(point.bucketStart),
						value: point.cacheHits,
						secondaryValue: point.cacheMisses,
					}))}
				/>
				<SimpleBarChart
					title="resize/upload 이벤트 추이"
					primaryLabel="resize"
					secondaryLabel="upload"
					points={timeseries.map((point) => ({
						label: formatDateTime(point.bucketStart),
						value: point.resizeCompleted,
						secondaryValue: point.uploadCompleted,
					}))}
				/>
			</section>

			<section className="panel" style={{ marginTop: '1rem' }}>
				<div className="panel-heading">
					<h2>요청 많은 이미지 Top 10</h2>
					<p>운영 비용과 cache miss 후보를 서비스별로 확인합니다.</p>
				</div>
				<table>
					<thead>
						<tr>
							<th>imageKey</th>
							<th>요청 수</th>
							<th>리사이즈</th>
							<th>캐시 hit율</th>
							<th>실패</th>
						</tr>
					</thead>
					<tbody>
						{topImages.slice(0, 10).map((image) => (
							<tr key={image.imageKey}>
								<td>{image.imageKey}</td>
								<td>{formatNumber(image.totalReads)}</td>
								<td>{formatNumber(image.totalResizes)}</td>
								<td>{formatPercent(image.cacheHitRate)}</td>
								<td>{formatNumber(image.totalFailures)}</td>
							</tr>
						))}
					</tbody>
				</table>
			</section>
		</main>
	);
}
