export interface MetricCardProps {
	label: string;
	value: string;
	description: string;
	intent?: 'neutral' | 'success' | 'danger';
}

export function MetricCard({
	label,
	value,
	description,
	intent = 'neutral',
}: MetricCardProps) {
	return (
		<section className={`metric-card metric-card-${intent}`}>
			<p className="metric-label">{label}</p>
			<strong>{value}</strong>
			<span>{description}</span>
		</section>
	);
}
