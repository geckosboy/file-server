export interface SimpleBarChartPoint {
	label: string;
	value: number;
	secondaryValue?: number;
}

export interface SimpleBarChartProps {
	title: string;
	primaryLabel: string;
	secondaryLabel?: string;
	points: SimpleBarChartPoint[];
}

export function SimpleBarChart({
	title,
	primaryLabel,
	secondaryLabel,
	points,
}: SimpleBarChartProps) {
	const maxValue = Math.max(
		1,
		...points.flatMap((point) => [point.value, point.secondaryValue ?? 0]),
	);

	return (
		<section className="panel">
			<div className="panel-heading">
				<h2>{title}</h2>
				<p>
					{primaryLabel}
					{secondaryLabel ? ` / ${secondaryLabel}` : ''}
				</p>
			</div>
			<div className="bar-chart" role="img" aria-label={title}>
				{points.map((point) => (
					<div className="bar-row" key={point.label}>
						<span className="bar-label">{point.label}</span>
						<div className="bar-track">
							<span
								className="bar bar-primary"
								style={{ width: `${(point.value / maxValue) * 100}%` }}
							>
								{point.value}
							</span>
							{point.secondaryValue !== undefined ? (
								<span
									className="bar bar-secondary"
									style={{
										width: `${(point.secondaryValue / maxValue) * 100}%`,
									}}
								>
									{point.secondaryValue}
								</span>
							) : null}
						</div>
					</div>
				))}
			</div>
		</section>
	);
}
