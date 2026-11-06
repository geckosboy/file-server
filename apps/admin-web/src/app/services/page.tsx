import { clientServicesFixture } from '@/lib/fixtures';
import {
	fetchClientServiceDetailsList,
	isAdminFixtureFallbackEnabled,
} from '@/lib/telemetry-api';
import { ServicesPageContent } from './page-content';

// The API URL/token exist only at runtime. Never prerender a build-time fallback.
export const dynamic = 'force-dynamic';

async function fetchServicesPageData() {
	try {
		return { services: await fetchClientServiceDetailsList() };
	} catch {
		if (!isAdminFixtureFallbackEnabled()) {
			return {
				services: [],
				errorMessage:
					'텔레메트리 API에 연결할 수 없습니다. fixture 없이 빈 상태를 표시합니다.',
			};
		}
		return {
			services: clientServicesFixture,
			errorMessage:
				'텔레메트리 API를 불러오지 못해 fixture 데이터로 표시합니다.',
		};
	}
}

export default async function ServicesPage() {
	const props = await fetchServicesPageData();
	return <ServicesPageContent {...props} />;
}
