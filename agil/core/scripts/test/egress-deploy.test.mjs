/**
 * Static deployment contract for the egress S3/MinIO path.
 *
 * There is no Docker daemon in this environment, so these tests are the gate
 * that the lab/production compose files and config templates actually contain
 * the required services, pins, healthchecks, private-bucket bootstrap and S3
 * keys — and that no real secret is committed.
 *
 * Run: node --test agil/core/scripts/test/egress-deploy.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const EGRESS = path.join(ROOT, 'agil', 'core', 'deploy', 'egress');

function read(relative) {
  const full = path.join(ROOT, relative);
  assert.ok(existsSync(full), `missing file: ${relative}`);
  return readFileSync(full, 'utf8');
}

const prodCompose = read('agil/core/deploy/egress/docker-compose.yml');
const labCompose = read('agil/core/deploy/egress/docker-compose.lab.yml');
const egressYaml = read('agil/core/deploy/egress/egress.yaml');
const workerEnv = read('agil/core/deploy/egress/.env.example');
const labEnv = read('agil/core/deploy/egress/.env.lab.example');
const livekitLab = read('agil/core/deploy/egress/livekit.lab.yaml');
const renderScript = read('agil/core/deploy/egress/render-config.sh');
const docs = read('agil/core/docs/egress-production-s3.md');

test('production worker compose: pinned image, host network, healthcheck, S3 env, private MinIO init', () => {
  assert.match(prodCompose, /image:\s*livekit\/egress:v1\.15\.0/);
  assert.match(prodCompose, /network_mode:\s*host/);
  assert.match(prodCompose, /healthcheck:/);
  assert.match(prodCompose, /127\.0\.0\.1:8080/);
  assert.match(prodCompose, /shm_size:\s*"1gb"/);
  assert.match(prodCompose, /cap_add:\s*\n\s*-\s*SYS_ADMIN/);
  // Upload credentials reach egress through the environment, not the YAML.
  for (const name of ['EGRESS_S3_ACCESS_KEY', 'EGRESS_S3_SECRET_KEY', 'EGRESS_S3_REGION', 'EGRESS_S3_BUCKET']) {
    assert.ok(prodCompose.includes(name), `worker compose mentions ${name}`);
  }
  assert.match(prodCompose, /AWS_ACCESS_KEY_ID/);
  assert.match(prodCompose, /AWS_SECRET_ACCESS_KEY/);
  // Optional MinIO bootstrap: private + lifecycle, waits for healthy.
  assert.match(prodCompose, /profiles:\s*\["minio"\]/);
  assert.match(prodCompose, /mc anonymous set none/);
  assert.match(prodCompose, /mc ilm rule add --expire-days/);
  assert.match(prodCompose, /MINIO_RETENTION_DAYS/);
  assert.match(prodCompose, /minio\/health\/live/);
  assert.match(prodCompose, /condition:\s*service_healthy/);
  // A one-shot init must fail loudly instead of looping forever on bad creds.
  assert.ok(prodCompose.includes('attempts=$$((attempts + 1))'), 'minio init counts retries');
  assert.match(prodCompose, /after 30 attempts/);
  assert.match(prodCompose, /minio\/minio:RELEASE\./);
  assert.match(prodCompose, /minio\/mc:RELEASE\./);
});

test('worker config template: S3 upload, retries, limits and non-durable backup', () => {
  assert.match(egressYaml, /^storage:\s*$/m);
  assert.match(egressYaml, /^\s+s3:\s*$/m);
  for (const key of ['region', 'endpoint', 'bucket', 'force_path_style', 'max_retries', 'min_retry_delay', 'max_retry_delay']) {
    assert.match(egressYaml, new RegExp(`^\\s+${key}:`, 'm'), `egress.yaml has storage.s3.${key}`);
  }
  assert.match(egressYaml, /max_retries:\s*5/);
  assert.match(egressYaml, /backup:\s*\n\s+prefix:\s*\/out\/backup/);
  assert.match(egressYaml, /session_limits:/);
  assert.match(egressYaml, /file_output_max_duration/);
  assert.match(egressYaml, /health_port:\s*8080/);
  assert.doesNotMatch(egressYaml, /api_secret:/, 'API secret is not in the rendered template');
  // The template may *mention* AWS_SECRET_ACCESS_KEY in a comment (it tells the
  // operator to pass the credential through the environment); what must never
  // exist is an actual YAML field holding the secret.
  const yamlFields = egressYaml
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  assert.doesNotMatch(yamlFields, /aws_secret_access_key/i, 'no S3 secret key YAML field');
});

test('render script substitutes every S3 variable and never evaluates .env', () => {
  for (const variable of [
    'EGRESS_S3_REGION',
    'EGRESS_S3_ENDPOINT',
    'EGRESS_S3_BUCKET',
    'EGRESS_S3_FORCE_PATH_STYLE',
  ]) {
    assert.ok(renderScript.includes(`${variable}`), `render-config.sh handles ${variable}`);
  }
  assert.match(renderScript, /envsubst/);
  assert.doesNotMatch(renderScript, /^\s*\.\s+"?\$ENV_FILE/m, '.env is parsed literally, not sourced');
  assert.match(renderScript, /chmod|install -m 640/);
});

test('local lab compose: LiveKit + shared Redis + MinIO + egress + app with healthchecks', () => {
  for (const service of ['redis:', 'livekit:', 'minio:', 'minio-init:', 'egress:', 'app:']) {
    assert.match(labCompose, new RegExp(`^  ${service}`, 'm'), `lab service ${service}`);
  }
  assert.match(labCompose, /image:\s*livekit\/livekit-server:v1\.13\.11/);
  assert.match(labCompose, /image:\s*livekit\/egress:v1\.15\.0/);
  assert.match(labCompose, /network_mode:\s*host/g);
  // LiveKit and egress must share one Redis: the SFU uses the compose DNS name,
  // the host-networked worker uses the published loopback port.
  assert.match(livekitLab, /redis:\s*\n\s+address:\s*redis:6379/);
  assert.match(labCompose, /address:\s*127\.0\.0\.1:\$\{LAB_REDIS_PORT:-6380\}/);
  assert.match(labCompose, /EGRESS_CONFIG_BODY:/);
  assert.match(labCompose, /endpoint:\s*http:\/\/127\.0\.0\.1:9000/);
  assert.match(labCompose, /force_path_style:\s*true/);
  assert.match(labCompose, /mc anonymous set none/);
  assert.match(labCompose, /mc ilm rule add --expire-days/);
  assert.ok(labCompose.includes('attempts=$$((attempts + 1))'), 'lab minio init counts retries');
  assert.match(labCompose, /after 30 attempts/);
  assert.match(labCompose, /AGIL_EGRESS_S3_ENDPOINT/);
  assert.match(labCompose, /AGIL_EGRESS_PLAYBACK_ENABLED/);
  assert.match(labCompose, /AGIL_EGRESS_HEALTH_URL/);
  assert.match(labCompose, /minio\/health\/live/);
  assert.match(labCompose, /\/v1\/health/);
  assert.match(labCompose, /service_completed_successfully/);
});

test('env templates: required names exist and secret values stay blank', () => {
  for (const name of [
    'LIVEKIT_API_KEY',
    'LIVEKIT_API_SECRET',
    'EGRESS_S3_ENDPOINT',
    'EGRESS_S3_REGION',
    'EGRESS_S3_BUCKET',
    'EGRESS_S3_FORCE_PATH_STYLE',
    'EGRESS_S3_ACCESS_KEY',
    'EGRESS_S3_SECRET_KEY',
    'MINIO_ROOT_PASSWORD',
    'MINIO_RETENTION_DAYS',
  ]) {
    assert.ok(workerEnv.includes(`${name}=`), `.env.example documents ${name}`);
  }
  for (const name of ['LIVEKIT_API_SECRET', 'MINIO_ROOT_PASSWORD', 'AGIL_TOKEN_SECRET']) {
    assert.match(labEnv, new RegExp(`^${name}=$`, 'm'), `${name} is empty in the lab template`);
  }
  assert.ok(labEnv.includes('MINIO_RETENTION_DAYS'), 'lab template configures the retention lifecycle');
  assert.ok(labEnv.includes('AGIL_EGRESS_PLAYBACK_TTL_SEC'), 'lab template configures the playback TTL');
  const nonEmptySecret = /^(?:LIVEKIT_API_SECRET|MINIO_ROOT_PASSWORD|AGIL_TOKEN_SECRET|AGIL_EGRESS_S3_SECRET_KEY)=.+/m;
  assert.doesNotMatch(labEnv, nonEmptySecret, 'lab template contains no real secret');
  assert.doesNotMatch(workerEnv, /^EGRESS_S3_SECRET_KEY=.+/m, 'worker template contains no real S3 secret');
  for (const content of [prodCompose, labCompose, egressYaml, workerEnv, labEnv]) {
    assert.doesNotMatch(content, /BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/);
    assert.doesNotMatch(content, /AKIA[0-9A-Z]{16}/, 'no AWS access key id literal');
  }
});

test('docs cover signed playback, bucket policy, retention and production gates', () => {
  for (const marker of [
    'EGRESS_S3_ENDPOINT',
    'AGIL_EGRESS_PLAYBACK_SECRET',
    'playlist?token=',
    'HMAC',
    'private',
    'retention',
    'mc ilm rule',
    'production gates',
    'Blocked',
  ]) {
    assert.ok(docs.toLowerCase().includes(marker.toLowerCase()), `docs mention ${marker}`);
  }
  assert.match(docs, /# 10\. Production gates/);
  assert.match(docs, /# 9\. What was validated/);
});

test('documented npm test commands exist in the root package.json', () => {
  const pkg = JSON.parse(read('package.json'));
  for (const name of ['test:egress', 'test:egress-deploy', 'test:egress-health']) {
    assert.equal(typeof pkg.scripts?.[name], 'string', `npm run ${name} is defined`);
  }
  assert.match(pkg.scripts['test:egress'], /egress\.test\.ts/);
  assert.match(pkg.scripts['test:egress'], /egress-playback\.test\.ts/);
  assert.match(pkg.scripts['test:egress-deploy'], /egress-deploy\.test\.mjs/);
});

test('compose files do not use floating latest tags for media/storage images', () => {
  for (const content of [prodCompose, labCompose]) {
    for (const line of content.split('\n')) {
      const match = /^\s+image:\s*(\S+)/.exec(line);
      if (!match) continue;
      assert.notEqual(match[1], 'latest', `floating tag: ${line.trim()}`);
      assert.doesNotMatch(match[1], /:latest$/, `floating tag: ${line.trim()}`);
    }
  }
});
