import type { ClientServiceItem } from '@/lib/telemetry-api';
import { ClientServiceManager } from './client-service-manager';

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
