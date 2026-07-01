import { imageListFixture } from '@/lib/fixtures';
import {
	formatDateTime,
	formatMs,
	formatNumber,
	formatPercent,
} from '@/lib/format';
import {
	fetchImages,
	type ImageListItem,
	type ImageListResponse,
} from '@/lib/telemetry-api';

const sortImagesByReadsDesc = (items: ImageListItem[]) =>
	[...items].sort((left, right) => right.totalReads - left.totalReads);

type ImagesPageContentProps = {
	data: ImageListResponse;
	errorMessage?: string;
};

export function ImagesPageContent({
	data,
	errorMessage,
}: ImagesPageContentProps) {
	const images = sortImagesByReadsDesc(data.items);

	return (
		<main className="page-shell">
			<section className="hero">
				<div>
					<h1>이미지 집계</h1>
					<p>요청량, 리사이즈량, 캐시 miss, 실패가 많은 이미지를 비교합니다.</p>
				</div>
			</section>
			{errorMessage ? (
				<p className="error-state" role="status">
					{errorMessage}
				</p>
			) : null}

			<section className="panel">
				<form className="filter-panel" aria-label="이미지 필터">
					<label>
						검색어
						<input name="q" placeholder="path, name, imageKey" />
					</label>
					<label>
						정렬
						<select name="sort" defaultValue="reads">
							<option value="reads">요청 수</option>
							<option value="resizes">리사이즈 수</option>
							<option value="cacheMisses">캐시 miss</option>
							<option value="failures">실패 수</option>
							<option value="lastSeenAt">마지막 관측</option>
						</select>
					</label>
					<label>
						기간
						<select name="range" defaultValue="24h">
							<option value="1h">최근 1시간</option>
							<option value="24h">최근 24시간</option>
							<option value="30d">최근 30일</option>
						</select>
					</label>
				</form>

				{images.length === 0 ? (
					<p className="empty-state">조건에 맞는 이미지가 없습니다.</p>
				) : (
					<table>
						<thead>
							<tr>
								<th>imageKey</th>
								<th>path/name</th>
								<th>요청</th>
								<th>리사이즈</th>
								<th>cache hit율</th>
								<th>cache miss</th>
								<th>실패</th>
								<th>평균/p95</th>
								<th>마지막 관측</th>
							</tr>
						</thead>
						<tbody>
							{images.map((image) => (
								<tr key={image.imageKey}>
									<td>{image.imageKey}</td>
									<td>
										<strong>{image.path}</strong>
										<br />
										{image.name}
									</td>
									<td>{formatNumber(image.totalReads)}</td>
									<td>{formatNumber(image.totalResizes)}</td>
									<td>{formatPercent(image.cacheHitRate)}</td>
									<td>{formatNumber(image.totalCacheMisses)}</td>
									<td>{formatNumber(image.totalFailures)}</td>
									<td>
										{formatMs(image.avgDurationMs)} /{' '}
										{formatMs(image.p95DurationMs)}
									</td>
									<td>{formatDateTime(image.lastSeenAt)}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</section>
		</main>
	);
}

async function fetchImagesPageData(): Promise<ImagesPageContentProps> {
	try {
		return {
			data: await fetchImages({ sort: 'reads', order: 'desc', limit: 50 }),
		};
	} catch {
		return {
			data: imageListFixture,
			errorMessage:
				'텔레메트리 API를 불러오지 못해 fixture 데이터로 표시합니다.',
		};
	}
}

export default async function ImagesPage() {
	const props = await fetchImagesPageData();
	return <ImagesPageContent {...props} />;
}
