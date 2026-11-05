import { clientServicesFixture, imageListFixture } from '@/lib/fixtures';
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
	type ImagesQuery,
} from '@/lib/telemetry-api';
import {
	ImagesPageContent,
	type ImagesFilters,
	type ImagesPageContentProps,
	type ImageSort,
	type SortOrder,
} from './page-content';

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
