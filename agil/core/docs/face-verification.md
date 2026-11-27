# Face verification (biometric) — design and guardrails

Status: **proposal, not implemented**. Biometric data is a special category in
GDPR/UK GDPR and is regulated separately in several countries; do not enable it
without a DPIA, a lawful basis, a retention policy and a human-review path.

## 1. What the feature is

A company can verify that the person joining a room is the employee they claim
to be:

1. The employee enrolls once: a reference face image/embedding is linked to the
   company user (admin uploads it or the employee captures it with consent).
2. At join, the lobby captures one frame (not continuous video), performs the
   existing liveness challenge, and asks the face adapter for a **similarity
   score** against that employee's template.
3. Policy decides:
   - `advisory`: flag only; the employee joins normally;
   - `approval`: borderline/no-match waits for an admin;
   - `enforce`: no-match is denied, with a fallback to manual verification.
4. An admin can approve a pending entry; the decision and score band are
   audited.

This is **face verification (1:1)** against the company directory, not
surveillance/1:N identification of strangers.

## 2. What not to do

- Do not store raw face images by default. Store an encrypted embedding and a
  template reference; keep the image only if the company explicitly needs it,
  with a short retention and deletion job.
- Do not run face matching for everyone by default. Tenant opt-in, employee
  consent, purpose limitation.
- Do not make a low-confidence score an automatic denial. Offer retry, manual
  review and an accessibility fallback.
- Do not send faces to a cloud provider without a DPA, region choice and
  explicit tenant consent.
- Do not log embeddings, images, scores with identity, or provider payloads in
  plaintext.
- Do not claim “deepfake-proof”. Liveness/integrity is advisory; face matching
  is probabilistic and can be biased.

## 2.1 Policy the user asked for

- **Match above threshold + liveness passed → auto-admit.** No admin click.
- **No match / low score / liveness failed → do not auto-admit**: show a short
  “нужно подтверждение администратора” state and put the entry in the admin
  queue. The admin can allow or deny; allow mints the join token and is audited.
- **Feature is off by default**, per tenant. `security.faceVerification.enabled`
  switches the whole flow; disabling it removes the lobby step and the DB call.
- Manual review is **only for exceptions**, not for every employee.

## 2.2 Company database contract

The product should not invent a second HR database. The company keeps its
directory and AGIL reads a **read-only view**. Supported first: PostgreSQL
(read-only role, TLS); MySQL/MariaDB and a custom HTTP adapter can be added
behind the same interface.

Recommended view (or equivalent):

```sql
CREATE VIEW agil_face_directory AS
SELECT
  company_id::text      AS tenant_id,
  employee_id::text     AS employee_id,
  lower(email)          AS email,
  display_name::text    AS display_name,
  face_template         AS face_template,      -- encrypted blob/text
  template_format       AS template_format,    -- e.g. arcface-512-f32
  consent_at            AS consent_at,
  status                AS status              -- active | revoked
FROM hr.employees
WHERE status = 'active' AND consent_at IS NOT NULL;
```

Lookup query (parameterized, no string interpolation):

```sql
SELECT tenant_id, employee_id, email, display_name,
       face_template, template_format, status
FROM agil_face_directory
WHERE tenant_id = $1
  AND (employee_id = $2 OR lower(email) = lower($3))
LIMIT 1;
```

Config:

```ts
type FaceDirectoryConfig = {
  enabled: boolean;
  adapter: 'postgres' | 'http';
  connectionEnv: string;       // e.g. AGIL_FACE_DB_URL, read-only secret
  query: string;               // allowlisted SELECT with $1/$2/$3 only
  ttlSec: number;              // employee cache, default 300
  timeoutMs: number;           // 1500
  maxRows: 1;
};
```

Guardrails:

- read-only DB user; no writes from AGIL;
- only `SELECT`; no DDL/DML/multiple statements; parameterized identifiers;
- TLS required outside localhost; connection secret only from env/secret store;
- tenant id is always bound from the authenticated session, never from the
  request body;
- no template in logs/audit; cache keyed by tenant+employee, short TTL;
- DB outage → fail closed to **manual approval**, not auto-admit.

If the company cannot expose a DB view, the same adapter can call their HTTP
endpoint with the same response shape; this avoids direct DB credentials.

## 3. Architecture

```
Browser lobby
  ├─ consent + camera preview
  ├─ liveness challenge (existing integrity/liveness)
  └─ POST /v1/rooms/:id/face-check  (one still, nonce)
             │
Core ── FaceVerificationService ── provider adapter
  │        ├─ local: InsightFace / CompreFace (GPU optional)
  │        ├─ cloud: AWS Rekognition / Azure Face (DPA)
  │        └─ custom HTTP
  ├─ score + threshold + liveness result
  ├─ decision: verified | review | no_match | no_face | spoof | error
  ├─ pending approval → dashboard queue
  └─ audit event (no image, no embedding)
```

### Data model

```ts
type FacePolicy = {
  enabled: boolean;
  mode: 'advisory' | 'approval' | 'enforce';
  threshold: number;          // cosine similarity, tenant-tuned
  reviewBand: number;         // e.g. 0.05 around threshold
  retentionDays: number;
  provider: 'local' | 'aws' | 'azure' | 'http';
  allowManualFallback: boolean;
};

type FaceEnrollment = {
  tenantId: string;
  userId: string;
  templateRef: string;        // encrypted embedding / provider id
  consentAt: number;
  retentionUntil: number;
  status: 'active' | 'revoked';
};

type FaceCheck = {
  id: string;
  tenantId: string;
  roomId: string;
  participantId: string;
  scoreBand: 'high' | 'review' | 'low' | 'none' | 'spoof';
  decision: 'verified' | 'review' | 'denied' | 'error';
  liveness: 'passed' | 'failed' | 'unknown';
  reviewerId?: string;
  reviewedAt?: number;
};
```

Never return raw scores to other participants; the joining employee sees a
coarse state, the admin sees the band and audit id.

## 4. Join flow

1. `POST /v1/rooms/:id/join` creates a **pending** participant (no media token).
2. Lobby shows consent + camera capture; liveness challenge runs.
3. `POST /v1/rooms/:id/face-check` with nonce + still; server matches.
4. `verified` → normal token; `review` → lobby waiting state, dashboard alert;
   `denied` → retry/manual fallback; `error` → manual fallback if allowed.
5. Admin approves/denies in the dashboard; approval mints the token and audits
   `face.approved` / `face.denied`.
6. Re-check policy: on every join, or once per day/session; configurable.

## 5. Admin/dashboard

- Company directory: enroll/replace/revoke an employee template; consent status.
- Policy: mode, threshold, retention, provider, fallback, regions.
- Pending queue: employee, room, time, score band, liveness, approve/deny.
- Audit: actor, decision, band, provider, no biometric payload.
- Reports: approval rate, false-reject complaints, provider latency, bias
  monitoring by cohort where lawful.

## 6. Privacy/legal checklist

- DPIA and legitimate-interest/consent assessment per deployment.
- Employee notice, voluntary/alternative path, no detriment for refusal where
  required by law.
- Retention: template until revocation + N days; images deleted immediately
  after matching unless explicitly enabled.
- Data subject rights: access, deletion, correction; processor DPA.
- Region: EU data residency; no US transfer without SCCs.
- Security: encryption at rest, tenant isolation, rate limits, replay nonce,
  liveness, no biometrics in logs/analytics.
- Bias/accessibility: test across skin tones, glasses, hijab, disability;
  manual fallback.

## 7. Phases

| Phase | Scope | Estimate |
|---|---|---|
| 0 | design/DPIA template, provider spike, threshold lab | 3–5 days |
| 1 | protocol + service + local adapter + enrollment API; advisory only | 1–2 weeks |
| 2 | lobby capture/liveness + pending state + dashboard queue | 1–2 weeks |
| 3 | approval/enforce, retention/deletion, audit/reporting | 1 week |
| 4 | cloud provider adapter, bias/accessibility testing, pen test | 1–2 weeks |

Do not ship `enforce` before phase 3 and a legal review.

## 8. Recommendation

Start with **advisory + admin approval**, local adapter, encrypted embeddings,
no raw-image retention. That gives the company the workflow it asked for
(“admin can allow entry”) without turning the product into an automatic
biometric gate. Enforce mode is a separate, contractually explicit opt-in.
