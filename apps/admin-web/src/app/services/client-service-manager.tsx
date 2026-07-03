'use client';

import { useActionState } from 'react';
import { formatDateTime } from '@/lib/format';
import type { ClientServiceItem } from '@/lib/telemetry-api';
import { submitClientServiceAction, type ServicesActionState } from './actions';

export interface ClientServiceManagerProps {
	initialServices: ClientServiceItem[];
}

export function ClientServiceManager({
	initialServices,
}: ClientServiceManagerProps) {
	const [state, formAction, isPending] = useActionState(
		submitClientServiceAction,
		{ services: initialServices } satisfies ServicesActionState,
	);

	return (
		<div className="stack">
			{state.error ? (
				<p className="error-state" role="alert">
					{state.error}
				</p>
			) : null}
			{state.message ? (
				<p className="success-state" role="status">
					{state.message}
				</p>
			) : null}
			{state.generatedKey ? (
				<section className="key-output" aria-label="발급된 API key">
					<strong>{state.generatedKey.serviceName} API key</strong>
					<p>이 값은 지금 한 번만 표시됩니다. 안전한 곳에 복사하세요.</p>
					<code>{state.generatedKey.apiKey}</code>
					<small>key prefix: {state.generatedKey.keyPrefix}</small>
				</section>
			) : null}

			<section className="panel">
				<div className="panel-heading">
					<div>
						<h2>서비스 등록</h2>
						<p>이 파일 서비스를 사용하는 백엔드/앱을 먼저 등록합니다.</p>
					</div>
				</div>
				<form action={formAction} className="filter-panel">
					<input name="intent" type="hidden" value="create-service" />
					<label>
						slug
						<input name="slug" placeholder="catalog-api" required />
					</label>
					<label>
						서비스명
						<input name="name" placeholder="Catalog API" required />
					</label>
					<label>
						owner
						<input name="owner" placeholder="commerce-team" />
					</label>
					<label>
						상태
						<select name="status" defaultValue="ACTIVE">
							<option value="ACTIVE">ACTIVE</option>
							<option value="DISABLED">DISABLED</option>
						</select>
					</label>
					<label>
						설명
						<input name="description" placeholder="어디에서 쓰는 서비스인지" />
					</label>
					<button className="button" disabled={isPending} type="submit">
						서비스 등록
					</button>
				</form>
			</section>

			<section className="grid service-card-grid" aria-label="등록 서비스 목록">
				{state.services.length === 0 ? (
					<p className="empty-state">등록된 서비스가 없습니다.</p>
				) : (
					state.services.map((service) => (
						<ServiceCard
							formAction={formAction}
							isPending={isPending}
							key={service.id}
							service={service}
						/>
					))
				)}
			</section>
		</div>
	);
}

function ServiceCard({
	service,
	formAction,
	isPending,
}: {
	service: ClientServiceItem;
	formAction: (payload: FormData) => void;
	isPending: boolean;
}) {
	return (
		<article className="panel service-card">
			<div className="panel-heading">
				<div>
					<h2>{service.name}</h2>
					<p>
						{service.slug} · {service.owner ?? 'owner 없음'}
					</p>
				</div>
				<span className={`badge badge-${service.status.toLowerCase()}`}>
					{service.status}
				</span>
			</div>

			<div className="metric-grid compact-metrics">
				<div>
					<strong>{service.keyCount}</strong>
					<span>전체 key</span>
				</div>
				<div>
					<strong>{service.activeKeyCount}</strong>
					<span>활성 key</span>
				</div>
				<div>
					<strong>{formatDateTime(service.updatedAt)}</strong>
					<span>최근 수정</span>
				</div>
			</div>

			<form action={formAction} className="sub-form">
				<input name="intent" type="hidden" value="update-service" />
				<input name="serviceId" type="hidden" value={service.id} />
				<label>
					서비스명
					<input name="name" defaultValue={service.name} required />
				</label>
				<label>
					owner
					<input name="owner" defaultValue={service.owner ?? ''} />
				</label>
				<label>
					상태
					<select name="status" defaultValue={service.status}>
						<option value="ACTIVE">ACTIVE</option>
						<option value="DISABLED">DISABLED</option>
					</select>
				</label>
				<label>
					설명
					<input name="description" defaultValue={service.description ?? ''} />
				</label>
				<button
					className="button button-secondary"
					disabled={isPending}
					type="submit"
				>
					저장
				</button>
			</form>

			<form action={formAction} className="sub-form key-form">
				<input name="intent" type="hidden" value="create-key" />
				<input name="serviceId" type="hidden" value={service.id} />
				<input name="serviceName" type="hidden" value={service.name} />
				<label>
					key 이름
					<input name="keyName" placeholder="local backend key" />
				</label>
				<label>
					scopes JSON
					<textarea
						name="scopes"
						defaultValue={'{"telemetry":"write"}'}
						rows={3}
					/>
				</label>
				<label>
					만료 시각
					<input name="expiresAt" type="datetime-local" />
				</label>
				<button className="button" disabled={isPending} type="submit">
					API key 발급
				</button>
			</form>

			<div className="key-list">
				<h3>API keys</h3>
				{service.keys?.length ? (
					<table>
						<thead>
							<tr>
								<th>prefix</th>
								<th>이름</th>
								<th>상태</th>
								<th>생성/폐기</th>
								<th>관리</th>
							</tr>
						</thead>
						<tbody>
							{service.keys.map((key) => (
								<tr key={key.id}>
									<td>{key.keyPrefix}</td>
									<td>{key.name ?? '-'}</td>
									<td>{key.revokedAt ? '폐기됨' : '활성'}</td>
									<td>
										{formatDateTime(key.createdAt)}
										{key.revokedAt ? (
											<small>
												<br />
												폐기: {formatDateTime(key.revokedAt)}
											</small>
										) : null}
									</td>
									<td>
										<form action={formAction}>
											<input name="intent" type="hidden" value="revoke-key" />
											<input
												name="serviceId"
												type="hidden"
												value={service.id}
											/>
											<input name="keyId" type="hidden" value={key.id} />
											<button
												className="button button-danger"
												disabled={isPending || Boolean(key.revokedAt)}
												type="submit"
											>
												폐기
											</button>
										</form>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				) : (
					<p className="empty-state">발급된 API key가 없습니다.</p>
				)}
			</div>
		</article>
	);
}
