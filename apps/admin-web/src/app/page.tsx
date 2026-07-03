export default function HomePage() {
	return (
		<main className="page-shell">
			<section className="hero">
				<div>
					<h1>파일서버 관리자</h1>
					<p>대시보드, 이벤트 로그, 이미지 집계 화면으로 이동하세요.</p>
				</div>
			</section>
			<section className="grid metric-grid">
				<a className="panel" href="/dashboard">
					<h2>Dashboard</h2>
					<p>최근 24시간 KPI와 간단한 차트를 봅니다.</p>
				</a>
				<a className="panel" href="/events">
					<h2>Events</h2>
					<p>표준 이미지 telemetry 원본 이벤트를 검색합니다.</p>
				</a>
				<a className="panel" href="/images">
					<h2>Images</h2>
					<p>요청량과 cache miss가 높은 이미지를 찾습니다.</p>
				</a>
				<a className="panel" href="/services">
					<h2>Services</h2>
					<p>서비스 레지스트리와 API key를 관리합니다.</p>
				</a>
			</section>
		</main>
	);
}
