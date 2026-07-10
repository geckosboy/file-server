'use client';

import { useActionState } from 'react';
import { formatDateTime } from '@/lib/format';
import type {
	ClientServiceImageResizeVariantItem,
	ClientServiceItem,
	ClientServicePolicyItem,
} from '@/lib/telemetry-api';
import { submitClientServiceAction, type ServicesActionState } from './actions';

const resizeFormats = ['webp', 'jpeg', 'png'] as const;

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
	const resizeMode = service.imageResizePolicy?.mode ?? 'ON_DEMAND';
	const resizeVariants = service.imageResizePolicy?.variants ?? [];
	const activeResizeVariantCount = resizeVariants.filter(
		(variant) => variant.isEnabled,
	).length;

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
					<strong>{service.policyCount}</strong>
					<span>접근 정책</span>
				</div>
				<div>
					<strong>{service.subscriptionCount}</strong>
					<span>전체 subscription</span>
				</div>
				<div>
					<strong>{service.activeSubscriptionCount}</strong>
					<span>활성 subscription</span>
				</div>
				<div>
					<strong>{resizeMode}</strong>
					<span>리사이징 모드</span>
				</div>
				<div>
					<strong>
						{activeResizeVariantCount}/{resizeVariants.length}
					</strong>
					<span>활성 사전 사이즈</span>
				</div>
				<div>
					<strong>{formatDateTime(service.updatedAt)}</strong>
					<span>최근 수정</span>
				</div>
			</div>

			<AccessPolicySection
				formAction={formAction}
				isPending={isPending}
				service={service}
			/>

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
						defaultValue={'{"actions":["read","upload","delete"]}'}
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

			<form action={formAction} className="sub-form">
				<input
					name="intent"
					type="hidden"
					value="create-lifecycle-subscription"
				/>
				<input name="serviceId" type="hidden" value={service.id} />
				<label>
					구독 이벤트 타입
					<select name="eventType" defaultValue="image.upload.completed">
						<option value="image.upload.completed">
							image.upload.completed
						</option>
						<option value="image.upload.failed">image.upload.failed</option>
					</select>
				</label>
				<label>
					consumer group
					<input
						name="consumerGroup"
						placeholder="catalog-image-consumer"
						required
					/>
				</label>
				<label>
					활성화 여부
					<select name="isEnabled" defaultValue="true">
						<option value="true">활성</option>
						<option value="false">비활성</option>
					</select>
				</label>
				<label>
					설명
					<input
						name="description"
						placeholder="이 서비스가 어떤 이벤트를 왜 소비하는지"
					/>
				</label>
				<button className="button" disabled={isPending} type="submit">
					lifecycle subscription 등록
				</button>
			</form>

			<div className="key-list">
				<h3>Lifecycle subscriptions</h3>
				{service.lifecycleSubscriptions?.length ? (
					<table>
						<thead>
							<tr>
								<th>event type</th>
								<th>consumer group</th>
								<th>상태</th>
								<th>설명</th>
								<th>관리</th>
							</tr>
						</thead>
						<tbody>
							{service.lifecycleSubscriptions.map((subscription) => (
								<tr key={subscription.id}>
									<td>{subscription.eventType}</td>
									<td>{subscription.consumerGroup}</td>
									<td>{subscription.isEnabled ? '활성' : '비활성'}</td>
									<td>{subscription.description ?? '-'}</td>
									<td>
										<form action={formAction} className="inline-form">
											<input
												name="intent"
												type="hidden"
												value="update-lifecycle-subscription"
											/>
											<input
												name="serviceId"
												type="hidden"
												value={service.id}
											/>
											<input
												name="subscriptionId"
												type="hidden"
												value={subscription.id}
											/>
											<select
												aria-label="구독 이벤트 타입"
												name="eventType"
												defaultValue={subscription.eventType}
											>
												<option value="image.upload.completed">
													image.upload.completed
												</option>
												<option value="image.upload.failed">
													image.upload.failed
												</option>
											</select>
											<input
												aria-label="consumer group"
												name="consumerGroup"
												defaultValue={subscription.consumerGroup}
												required
											/>
											<select
												aria-label="활성화 여부"
												name="isEnabled"
												defaultValue={String(subscription.isEnabled)}
											>
												<option value="true">활성</option>
												<option value="false">비활성</option>
											</select>
											<input
												aria-label="설명"
												name="description"
												defaultValue={subscription.description ?? ''}
												placeholder="설명"
											/>
											<button
												className="button button-secondary"
												disabled={isPending}
												type="submit"
											>
												저장
											</button>
										</form>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				) : (
					<p className="empty-state">
						등록된 lifecycle subscription이 없습니다.
					</p>
				)}
			</div>

			<ResizePolicySection
				formAction={formAction}
				isPending={isPending}
				service={service}
			/>
		</article>
	);
}

function AccessPolicySection({
	service,
	formAction,
	isPending,
}: {
	service: ClientServiceItem;
	formAction: (payload: FormData) => void;
	isPending: boolean;
}) {
	const policies = service.policies ?? [];
	return (
		<section className="key-list" aria-label={`${service.name} 접근 정책`}>
			<div className="panel-heading">
				<div>
					<h3>Tenant path 접근 정책</h3>
					<p>
						canonical storage path 기준으로 read/upload/delete, 업로드 크기와
						분당 요청 한도를 설정합니다. *는 한 segment, **는 여러
						segment입니다.
					</p>
				</div>
			</div>

			<form action={formAction} className="sub-form">
				<input name="intent" type="hidden" value="create-access-policy" />
				<input name="serviceId" type="hidden" value={service.id} />
				<label>
					path pattern
					<input name="pathPattern" placeholder="catalog/**/image" required />
				</label>
				<PolicyBooleanSelect label="read" name="canRead" value />
				<PolicyBooleanSelect label="upload" name="canUpload" value={false} />
				<PolicyBooleanSelect label="delete" name="canDelete" value={false} />
				<label>
					max upload bytes
					<input min={1} name="maxUploadBytes" type="number" />
				</label>
				<label>
					rate limit / min
					<input min={1} name="rateLimitPerMin" type="number" />
				</label>
				<label>
					metadata JSON
					<textarea
						name="metadata"
						placeholder='{"owner":"commerce"}'
						rows={2}
					/>
				</label>
				<button className="button" disabled={isPending} type="submit">
					접근 정책 등록
				</button>
			</form>

			{policies.length ? (
				<table>
					<thead>
						<tr>
							<th>pattern / permissions</th>
							<th>limits</th>
							<th>관리</th>
						</tr>
					</thead>
					<tbody>
						{policies.map((policy) => (
							<PolicyRow
								formAction={formAction}
								isPending={isPending}
								key={policy.id}
								policy={policy}
								serviceId={service.id}
							/>
						))}
					</tbody>
				</table>
			) : (
				<p className="empty-state">
					접근 정책이 없어 모든 이미지 동작이 기본 거부됩니다.
				</p>
			)}
		</section>
	);
}

function PolicyRow({
	policy,
	serviceId,
	formAction,
	isPending,
}: {
	policy: ClientServicePolicyItem;
	serviceId: string;
	formAction: (payload: FormData) => void;
	isPending: boolean;
}) {
	return (
		<tr>
			<td>
				<strong>{policy.pathPattern}</strong>
				<br />
				R:{String(policy.canRead)} U:{String(policy.canUpload)} D:
				{String(policy.canDelete)}
			</td>
			<td>
				{policy.maxUploadBytes ?? 'global'} bytes /{' '}
				{policy.rateLimitPerMin ?? 'unlimited'} rpm
			</td>
			<td>
				<form action={formAction} className="inline-form">
					<input name="intent" type="hidden" value="update-access-policy" />
					<input name="serviceId" type="hidden" value={serviceId} />
					<input name="policyId" type="hidden" value={policy.id} />
					<input
						aria-label="path pattern"
						defaultValue={policy.pathPattern}
						name="pathPattern"
						required
					/>
					<PolicyBooleanSelect
						label="read"
						name="canRead"
						value={policy.canRead}
					/>
					<PolicyBooleanSelect
						label="upload"
						name="canUpload"
						value={policy.canUpload}
					/>
					<PolicyBooleanSelect
						label="delete"
						name="canDelete"
						value={policy.canDelete}
					/>
					<input
						aria-label="max upload bytes"
						defaultValue={policy.maxUploadBytes ?? ''}
						min={1}
						name="maxUploadBytes"
						type="number"
					/>
					<input
						aria-label="rate limit per minute"
						defaultValue={policy.rateLimitPerMin ?? ''}
						min={1}
						name="rateLimitPerMin"
						type="number"
					/>
					<textarea
						aria-label="policy metadata"
						defaultValue={
							policy.metadata ? JSON.stringify(policy.metadata) : ''
						}
						name="metadata"
						rows={2}
					/>
					<button
						className="button button-secondary"
						disabled={isPending}
						type="submit"
					>
						저장
					</button>
				</form>
				<form action={formAction}>
					<input name="intent" type="hidden" value="delete-access-policy" />
					<input name="serviceId" type="hidden" value={serviceId} />
					<input name="policyId" type="hidden" value={policy.id} />
					<button
						className="button button-danger"
						disabled={isPending}
						type="submit"
					>
						삭제
					</button>
				</form>
			</td>
		</tr>
	);
}

function PolicyBooleanSelect({
	label,
	name,
	value,
}: {
	label: string;
	name: string;
	value: boolean;
}) {
	return (
		<label>
			{label}
			<select defaultValue={String(value)} name={name}>
				<option value="true">허용</option>
				<option value="false">거부</option>
			</select>
		</label>
	);
}

function ResizePolicySection({
	service,
	formAction,
	isPending,
}: {
	service: ClientServiceItem;
	formAction: (payload: FormData) => void;
	isPending: boolean;
}) {
	const policy = service.imageResizePolicy;
	const mode = policy?.mode ?? 'ON_DEMAND';
	const variants = policy?.variants ?? [];

	return (
		<section
			className="key-list"
			aria-label={`${service.name} 이미지 리사이징 정책`}
		>
			<div className="panel-heading">
				<div>
					<h3>이미지 리사이징 정책</h3>
					<p>
						on-demand 또는 pre-generate 모드를 고르고, 미리 생성할 사이즈를
						서비스별로 관리합니다.
					</p>
				</div>
				<span className={`badge badge-${mode.toLowerCase()}`}>{mode}</span>
			</div>

			<form action={formAction} className="sub-form">
				<input name="intent" type="hidden" value="update-image-resize-policy" />
				<input name="serviceId" type="hidden" value={service.id} />
				<label>
					리사이징 모드
					<select name="mode" defaultValue={mode}>
						<option value="ON_DEMAND">ON_DEMAND</option>
						<option value="PRE_GENERATE">PRE_GENERATE</option>
					</select>
				</label>
				<button
					className="button button-secondary"
					disabled={isPending}
					type="submit"
				>
					정책 저장
				</button>
			</form>

			<form action={formAction} className="sub-form">
				<input
					name="intent"
					type="hidden"
					value="create-image-resize-variant"
				/>
				<input name="serviceId" type="hidden" value={service.id} />
				<label>
					width
					<input
						max={10_000}
						min={1}
						name="width"
						placeholder="400"
						type="number"
					/>
				</label>
				<label>
					height
					<input
						max={10_000}
						min={1}
						name="height"
						placeholder="400"
						type="number"
					/>
				</label>
				<label>
					format
					<select name="format" defaultValue="webp">
						{resizeFormats.map((format) => (
							<option key={format} value={format}>
								{format}
							</option>
						))}
					</select>
				</label>
				<label>
					활성화 여부
					<select name="isEnabled" defaultValue="true">
						<option value="true">활성</option>
						<option value="false">비활성</option>
					</select>
				</label>
				<label>
					설명
					<input name="description" placeholder="목록 썸네일" />
				</label>
				<button className="button" disabled={isPending} type="submit">
					사전 생성 사이즈 추가
				</button>
			</form>

			{variants.length ? (
				<table>
					<thead>
						<tr>
							<th>size</th>
							<th>format</th>
							<th>상태</th>
							<th>설명</th>
							<th>관리</th>
						</tr>
					</thead>
					<tbody>
						{variants.map((variant) => (
							<tr key={variant.id}>
								<td>{formatResizeVariantSize(variant)}</td>
								<td>{variant.format}</td>
								<td>{variant.isEnabled ? '활성' : '비활성'}</td>
								<td>{variant.description ?? '-'}</td>
								<td>
									<form action={formAction} className="inline-form">
										<input
											name="intent"
											type="hidden"
											value="update-image-resize-variant"
										/>
										<input name="serviceId" type="hidden" value={service.id} />
										<input name="variantId" type="hidden" value={variant.id} />
										<input
											aria-label="사전 생성 width"
											defaultValue={variant.width ?? ''}
											max={10_000}
											min={1}
											name="width"
											placeholder="width"
											type="number"
										/>
										<input
											aria-label="사전 생성 height"
											defaultValue={variant.height ?? ''}
											max={10_000}
											min={1}
											name="height"
											placeholder="height"
											type="number"
										/>
										<select
											aria-label="사전 생성 format"
											defaultValue={variant.format}
											name="format"
										>
											{resizeFormats.map((format) => (
												<option key={format} value={format}>
													{format}
												</option>
											))}
										</select>
										<select
											aria-label="사전 생성 활성화 여부"
											defaultValue={String(variant.isEnabled)}
											name="isEnabled"
										>
											<option value="true">활성</option>
											<option value="false">비활성</option>
										</select>
										<input
											aria-label="사전 생성 설명"
											defaultValue={variant.description ?? ''}
											name="description"
											placeholder="설명"
										/>
										<button
											className="button button-secondary"
											disabled={isPending}
											type="submit"
										>
											저장
										</button>
									</form>
									<form action={formAction}>
										<input
											name="intent"
											type="hidden"
											value="delete-image-resize-variant"
										/>
										<input name="serviceId" type="hidden" value={service.id} />
										<input name="variantId" type="hidden" value={variant.id} />
										<button
											className="button button-danger"
											disabled={isPending}
											type="submit"
										>
											삭제
										</button>
									</form>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			) : (
				<p className="empty-state">
					등록된 pre-generate 사이즈가 없습니다. on-demand 모드는 기존처럼 요청
					시점에 resize합니다.
				</p>
			)}
		</section>
	);
}

function formatResizeVariantSize(variant: ClientServiceImageResizeVariantItem) {
	return `${variant.width ?? 'auto'}x${variant.height ?? 'auto'}`;
}
