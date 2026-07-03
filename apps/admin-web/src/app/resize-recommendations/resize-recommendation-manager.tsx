'use client';

import { useActionState } from 'react';
import { ClientServiceSelect } from '@/components/client-service-select';
import {
	formatBytes,
	formatDateTime,
	formatMs,
	formatNumber,
} from '@/lib/format';
import type {
	ClientServiceItem,
	ImageResizeRecommendationItem,
	ImageResizeRecommendationsResponse,
} from '@/lib/telemetry-api';
import {
	applyResizeRecommendationAction,
	type ResizeRecommendationActionState,
} from './actions';

export interface ResizeRecommendationFilters {
	range: string;
	clientServiceId?: string;
	minRequests: number;
}

export interface ResizeRecommendationManagerProps {
	data: ImageResizeRecommendationsResponse;
	services: ClientServiceItem[];
	filters: ResizeRecommendationFilters;
}

export function ResizeRecommendationManager({
	data,
	services,
	filters,
}: ResizeRecommendationManagerProps) {
	const [state, formAction, isPending] = useActionState(
		applyResizeRecommendationAction,
		{} satisfies ResizeRecommendationActionState,
	);
	const serviceMap = new Map(services.map((service) => [service.id, service]));

	return (
		<div className="stack">
			{state.error ? (
				<p className="error-state" role="alert">
					{state.error}
				</p>
			) : null}
			{state.message ? (
				<p className="success-state" role="status">
					{state.message}
				</p>
			) : null}

			<section className="panel">
				<form className="filter-panel" aria-label="리사이징 추천 필터">
					<ClientServiceSelect
						services={services}
						selectedClientServiceId={filters.clientServiceId}
					/>
					<label>
						기간
						<select name="range" defaultValue={filters.range}>
							<option value="1h">최근 1시간</option>
							<option value="24h">최근 24시간</option>
							<option value="7d">최근 7일</option>
							<option value="30d">최근 30일</option>
						</select>
					</label>
					<label>
						추천 임계값
						<input
							max={100_000}
							min={1}
							name="minRequests"
							step={1}
							defaultValue={filters.minRequests}
							type="number"
						/>
					</label>
					<button className="button" type="submit">
						추천 조회
					</button>
				</form>
				<p className="filter-help">
					현재 추천 기준은 기간 내 on-demand resize 성공 이벤트를
					서비스·사이즈·format별로 묶고, 요청{' '}
					{formatNumber(data.threshold.minRequests)}회 이상이면 pre-generate
					후보로 표시합니다.
				</p>
			</section>

			<section className="panel">
				<div className="panel-heading">
					<div>
						<h2>리사이징 정책 추천</h2>
						<p>
							자주 요청된 on-demand resize 사이즈를 확인하고 Client Service의
							pre-generate 정책에 반영합니다.
						</p>
					</div>
				</div>

				{data.items.length === 0 ? (
					<p className="empty-state">
						조건에 맞는 리사이징 추천 데이터가 없습니다.
					</p>
				) : (
					<table>
						<thead>
							<tr>
								<th>client service</th>
								<th>size / format</th>
								<th>추천 여부</th>
								<th>요청/이미지</th>
								<th>평균/p95</th>
								<th>예상 절감</th>
								<th>샘플 imageKey</th>
								<th>반영</th>
							</tr>
						</thead>
						<tbody>
							{data.items.map((item) => (
								<RecommendationRow
									formAction={formAction}
									isPending={isPending}
									item={item}
									key={item.recommendationKey}
									service={
										item.clientServiceId
											? serviceMap.get(item.clientServiceId)
											: undefined
									}
								/>
							))}
						</tbody>
					</table>
				)}
			</section>
		</div>
	);
}

function RecommendationRow({
	item,
	service,
	formAction,
	isPending,
}: {
	item: ImageResizeRecommendationItem;
	service?: ClientServiceItem;
	formAction: (payload: FormData) => void;
	isPending: boolean;
}) {
	const alreadyConfigured = Boolean(
		service?.imageResizePolicy?.variants.some(
			(variant) =>
				variant.isEnabled &&
				variant.width === item.width &&
				variant.height === item.height &&
				variant.format === item.format,
		),
	);
	const canApply = Boolean(service?.id && isSupportedFormat(item.format));

	return (
		<tr>
			<td>
				<strong>
					{service?.name ?? item.clientServiceSlug ?? '미등록 서비스'}
				</strong>
				<br />
				<small>{service?.slug ?? item.clientServiceSlug ?? '-'}</small>
			</td>
			<td>
				<strong>{formatRecommendationSize(item)}</strong>
				<br />
				<small>{item.format ?? 'format 없음'}</small>
			</td>
			<td>
				<span
					className={`badge ${item.recommended ? 'badge-success' : 'badge-disabled'}`}
				>
					{item.recommended ? 'pre-generate 추천' : '관찰 중'}
				</span>
				{alreadyConfigured ? (
					<>
						<br />
						<span className="badge badge-pre_generate">이미 반영됨</span>
					</>
				) : null}
			</td>
			<td>
				{formatNumber(item.requestCount)}회
				<br />
				<small>{formatNumber(item.imageCount)}개 이미지</small>
			</td>
			<td>
				{formatMs(item.avgDurationMs)}
				<br />
				<small>p95 {formatMs(item.p95DurationMs)}</small>
			</td>
			<td>
				{formatMs(item.estimatedSavedResizeMs)}
				<br />
				<small>
					in {formatBytes(item.totalInputBytes)} / out{' '}
					{formatBytes(item.totalOutputBytes)}
				</small>
				<br />
				<small>최근 {formatDateTime(item.lastRequestedAt)}</small>
			</td>
			<td>
				<details className="event-detail">
					<summary>샘플 {formatNumber(item.sampleImageKeys.length)}개</summary>
					<ul>
						{item.sampleImageKeys.map((imageKey) => (
							<li key={imageKey}>{imageKey}</li>
						))}
					</ul>
				</details>
			</td>
			<td>
				<form action={formAction}>
					<input name="serviceId" type="hidden" value={service?.id ?? ''} />
					<input name="width" type="hidden" value={item.width ?? ''} />
					<input name="height" type="hidden" value={item.height ?? ''} />
					<input name="format" type="hidden" value={item.format ?? ''} />
					<input name="requestCount" type="hidden" value={item.requestCount} />
					<input
						name="estimatedSavedResizeMs"
						type="hidden"
						value={Math.round(item.estimatedSavedResizeMs)}
					/>
					<button
						className="button button-secondary"
						disabled={isPending || !canApply || alreadyConfigured}
						type="submit"
					>
						{alreadyConfigured ? '반영 완료' : '정책에 반영'}
					</button>
				</form>
			</td>
		</tr>
	);
}

function formatRecommendationSize(item: ImageResizeRecommendationItem) {
	return `${item.width ?? 'auto'}x${item.height ?? 'auto'}`;
}

function isSupportedFormat(format: string | undefined) {
	return format === 'png' || format === 'jpeg' || format === 'webp';
}
