import type {
	ClientServiceItem,
	ImageResizeRecommendationsResponse,
} from '@/lib/telemetry-api';
import {
	ResizeRecommendationManager,
	type ResizeRecommendationFilters,
} from './resize-recommendation-manager';

type ResizeRecommendationsPageContentProps = {
	data: ImageResizeRecommendationsResponse;
	services: ClientServiceItem[];
	filters: ResizeRecommendationFilters;
	errorMessage?: string;
};

export function ResizeRecommendationsPageContent({
	data,
	services,
	filters,
	errorMessage,
}: ResizeRecommendationsPageContentProps) {
	return (
		<main className="page-shell">
			<section className="hero">
				<div>
					<h1>리사이징 정책 추천</h1>
					<p>
						Client Service별 on-demand resize 사용량을 보고 pre-generate로
						전환할 후보 사이즈를 관리합니다.
					</p>
				</div>
			</section>
			{errorMessage ? (
				<p className="error-state" role="status">
					{errorMessage}
				</p>
			) : null}
			<ResizeRecommendationManager
				data={data}
				filters={filters}
				services={services}
			/>
		</main>
	);
}
