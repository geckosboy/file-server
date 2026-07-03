export default function ResizeRecommendationsLoading() {
	return (
		<main className="page-shell">
			<section className="hero">
				<div>
					<h1>리사이징 정책 추천</h1>
					<p>추천 데이터를 불러오는 중입니다.</p>
				</div>
			</section>
			<section className="panel">
				<p className="empty-state">추천 집계를 불러오고 있습니다…</p>
			</section>
		</main>
	);
}
