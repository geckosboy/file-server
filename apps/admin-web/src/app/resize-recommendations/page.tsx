import {
	clientServicesFixture,
	imageResizeRecommendationsFixture,
} from '@/lib/fixtures';
import {
	buildRangeFromPreset,
	readOptionalSearchParam,
	readRangePreset,
	resolveSearchParams,
	type PageSearchParams,
} from '@/lib/search-params';
import {
	fetchClientServiceDetailsList,
	fetchImageResizeRecommendations,
	isAdminFixtureFallbackEnabled,
} from '@/lib/telemetry-api';
import type { ResizeRecommendationFilters } from './resize-recommendation-manager';
import { ResizeRecommendationsPageContent } from './page-content';

async function fetchResizeRecommendationsPageData(
	params: PageSearchParams | undefined,
) {
	const rangePreset = readRangePreset(params);
	const range = buildRangeFromPreset(rangePreset);
	const minRequests = readMinRequests(params);
	const filters = {
		range: rangePreset,
		clientServiceId: readOptionalSearchParam(params, 'clientServiceId'),
		minRequests,
	} satisfies ResizeRecommendationFilters;

	try {
		const [services, data] = await Promise.all([
			fetchClientServiceDetailsList(),
			fetchImageResizeRecommendations({
				...range,
				clientServiceId: filters.clientServiceId,
				minRequests,
				limit: 50,
			}),
		]);
		return { services, data, filters };
	} catch {
		if (!isAdminFixtureFallbackEnabled()) {
			return {
				services: [],
				data: { threshold: { minRequests }, items: [] },
				filters,
				errorMessage:
					'텔레메트리 API에 연결할 수 없습니다. 운영 추천 대신 빈 상태를 표시합니다.',
			};
		}
		return {
			services: clientServicesFixture,
			data: imageResizeRecommendationsFixture,
			filters,
			errorMessage:
				'텔레메트리 API를 불러오지 못해 fixture 데이터로 표시합니다.',
		};
	}
}

function readMinRequests(params: PageSearchParams | undefined) {
	const value = readOptionalSearchParam(params, 'minRequests');
	if (!value) {
		return 3;
	}
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 100_000) : 3;
}

export default async function ResizeRecommendationsPage({
	searchParams,
}: {
	searchParams?: Promise<PageSearchParams>;
}) {
	const props = await fetchResizeRecommendationsPageData(
		await resolveSearchParams(searchParams),
	);
	return <ResizeRecommendationsPageContent {...props} />;
}
