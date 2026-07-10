import { ClientServiceSelect } from '@/components/client-service-select';
import { clientServicesFixture, imageListFixture } from '@/lib/fixtures';
import {
	formatDateTime,
	formatMs,
	formatNumber,
	formatPercent,
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
	fetchImages,
	isAdminFixtureFallbackEnabled,
	type ClientServiceItem,
	type ImageListItem,
	type ImageListResponse,
	type ImagesQuery,
} from '@/lib/telemetry-api';

type ImageSort = NonNullable<ImagesQuery['sort']>;
type SortOrder = NonNullable<ImagesQuery['order']>;

type ImagesFilters = {
	range: string;
	clientServiceId?: string;
	q?: string;
	sort: ImageSort;
	order: SortOrder;
};

type ImagesPageContentProps = {
	data: ImageListResponse;
	services: ClientServiceItem[];
	filters: ImagesFilters;
	errorMessage?: string;
};

const sortImages = (
	items: ImageListItem[],
	sort: ImageSort,
	order: SortOrder,
) =>
	[...items].sort((left, right) => {
		const direction = order === 'asc' ? 1 : -1;
		const leftValue = imageSortValue(left, sort);
		const rightValue = imageSortValue(right, sort);
		if (typeof leftValue === 'string' && typeof rightValue === 'string') {
			return leftValue.localeCompare(rightValue) * direction;
		}
		return ((leftValue as number) - (rightValue as number)) * direction;
	});

const imageSortValue = (image: ImageListItem, sort: ImageSort) => {
	if (sort === 'resizes') {
		return image.totalResizes;
	}
	if (sort === 'cacheMisses') {
		return image.totalCacheMisses;
	}
	if (sort === 'failures') {
		return image.totalFailures;
	}
	if (sort === 'lastSeenAt') {
		return image.lastSeenAt;
	}
	return image.totalReads;
};

export function ImagesPageContent({
	data,
	services,
	filters,
	errorMessage,
}: ImagesPageContentProps) {
	const images = sortImages(data.items, filters.sort, filters.order);

	return (
		<main className="page-shell">
			<section className="hero">
				<div>
					<h1>이미지 집계</h1>
					<p>
						서비스별 요청량, 리사이즈량, 캐시 miss, 실패가 많은 이미지를
						비교합니다.
					</p>
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
						<input
							name="q"
							placeholder="path, name, imageKey"
							defaultValue={filters.q ?? ''}
						/>
					</label>
					<ClientServiceSelect
						services={services}
						selectedClientServiceId={filters.clientServiceId}
					/>
					<label>
						정렬
						<select name="sort" defaultValue={filters.sort}>
							<option value="reads">요청 수</option>
							<option value="resizes">리사이즈 수</option>
							<option value="cacheMisses">캐시 miss</option>
							<option value="failures">실패 수</option>
							<option value="lastSeenAt">마지막 관측</option>
						</select>
					</label>
					<label>
						순서
						<select name="order" defaultValue={filters.order}>
							<option value="desc">내림차순</option>
							<option value="asc">오름차순</option>
						</select>
					</label>
					<label>
						기간
						<select name="range" defaultValue={filters.range}>
							<option value="1h">최근 1시간</option>
							<option value="24h">최근 24시간</option>
							<option value="7d">최근 7일</option>
							<option value="30d">최근 30일</option>
						</select>
					</label>
					<button className="button" type="submit">
						필터 적용
					</button>
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

function readSort(params: PageSearchParams): ImageSort {
	const sort = readOptionalSearchParam(params, 'sort');
	return sort === 'resizes' ||
		sort === 'cacheMisses' ||
		sort === 'failures' ||
		sort === 'lastSeenAt'
		? sort
		: 'reads';
}

function readOrder(params: PageSearchParams): SortOrder {
	return readOptionalSearchParam(params, 'order') === 'asc' ? 'asc' : 'desc';
}

function buildImagesFilters(params: PageSearchParams): ImagesFilters {
	return {
		range: readRangePreset(params),
		clientServiceId: readOptionalSearchParam(params, 'clientServiceId'),
		q: readOptionalSearchParam(params, 'q'),
		sort: readSort(params),
		order: readOrder(params),
	};
}

async function fetchImagesPageData(
	params: PageSearchParams,
): Promise<ImagesPageContentProps> {
	const filters = buildImagesFilters(params);
	const query: ImagesQuery = {
		...buildRangeFromPreset(filters.range),
		clientServiceId: filters.clientServiceId,
		q: filters.q,
		sort: filters.sort,
		order: filters.order,
		limit: 50,
	};

	try {
		const [services, data] = await Promise.all([
			fetchClientServices(),
			fetchImages(query),
		]);
		return { data, services, filters };
	} catch {
		if (!isAdminFixtureFallbackEnabled()) {
			return {
				data: { items: [] },
				services: [],
				filters,
				errorMessage:
					'텔레메트리 API에 연결할 수 없습니다. 운영 이미지 대신 빈 상태를 표시합니다.',
			};
		}
		return {
			data: imageListFixture,
			services: clientServicesFixture,
			filters,
			errorMessage:
				'텔레메트리 API를 불러오지 못해 fixture 데이터로 표시합니다.',
		};
	}
}

export default async function ImagesPage({
	searchParams,
}: {
	searchParams?: Promise<PageSearchParams>;
}) {
	const props = await fetchImagesPageData(
		await resolveSearchParams(searchParams),
	);
	return <ImagesPageContent {...props} />;
}
