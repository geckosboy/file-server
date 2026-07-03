import type { ClientServiceItem } from '@/lib/telemetry-api';

export interface ClientServiceSelectProps {
	services: ClientServiceItem[];
	selectedClientServiceId?: string;
}

export function ClientServiceSelect({
	services,
	selectedClientServiceId,
}: ClientServiceSelectProps) {
	return (
		<label>
			client service
			<select
				name="clientServiceId"
				defaultValue={selectedClientServiceId ?? 'all'}
			>
				<option value="all">전체 서비스</option>
				{services.map((service) => (
					<option key={service.id} value={service.id}>
						{service.name} ({service.slug})
					</option>
				))}
			</select>
		</label>
	);
}
