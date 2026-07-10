import { ClientServiceManager } from './client-service-manager';
import { clientServicesFixture } from '@/lib/fixtures';
import {
	fetchClientServiceDetailsList,
	isAdminFixtureFallbackEnabled,
	type ClientServiceItem,
} from '@/lib/telemetry-api';

export function ServicesPageContent({
	services,
	errorMessage,
}: {
	services: ClientServiceItem[];
	errorMessage?: string;
}) {
	return (
		<main className="page-shell">
			<section className="hero">
				<div>
					<h1>서비스 레지스트리</h1>
					<p>
						파일 서버를 사용하는 서비스, API key, lifecycle 구독, 이미지
						리사이징 정책을 관리합니다.
					</p>
				</div>
			</section>
			{errorMessage ? (
				<p className="error-state" role="status">
					{errorMessage}
				</p>
			) : null}
			<ClientServiceManager initialServices={services} />
		</main>
	);
}

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
