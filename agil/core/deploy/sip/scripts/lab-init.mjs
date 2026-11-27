#!/usr/bin/env node
/**
 * Local SIP lab — create (or reuse) the LiveKit SIP trunks.
 *
 *   node agil/core/deploy/sip/scripts/lab-init.mjs
 *
 * Run after `docker compose up -d` (and after the LiveKit SIP worker has
 * connected to Redis). Idempotent: an outbound/inbound trunk with the same
 * name and address is reused, so re-running the lab does not pile up trunks.
 *
 * The app itself has no trunk CRUD (trunks are external infrastructure), so
 * this operator script talks to the same Twirp API with `sip.admin`. Copy the
 * printed outbound trunk id (`ST_...`) into `scale.sip.trunkId` — the e2e
 * script does that automatically.
 *
 * Also creates a default inbound trunk + "individual" dispatch rule for manual
 * testing (a softphone dials 600/601/602 and lands in a fresh room). The e2e
 * script creates its own ephemeral direct rule for the app room.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LAB_DIR, resolveLabEnv, requireLiveKitKeys } from './lib/env.mjs';
import {
  createIndividualDispatchRule,
  createInboundTrunk,
  deleteDispatchRule,
  deleteTrunk,
  ensureOutboundTrunk,
  listDispatchRules,
  listInboundTrunks,
  probe,
} from './lib/livekit.mjs';

const TRUNKS_FILE = path.join(LAB_DIR, '.lab-trunks.json');

function log(message) {
  process.stdout.write(`${message}\n`);
}

async function main() {
  const config = requireLiveKitKeys(resolveLabEnv());
  log('AgilFrame — local SIP lab trunk setup');
  log(`  LiveKit Twirp : ${config.livekitUrl}`);
  log(`  outbound trunk: ${config.outboundTrunk.name} -> ${config.outboundTrunk.address}`);
  log(`  inbound trunk : ${config.inboundTrunk.name} numbers=${config.inboundTrunk.numbers.join(',')}`);

  if (!existsSync(config.recordingsDir)) {
    mkdirSync(config.recordingsDir, { recursive: true });
    log(`  created recordings dir: ${config.recordingsDir}`);
  }

  const rooms = await probe(config);
  log(`  LiveKit reachable (ListRooms: ${rooms} room(s))`);

  const outbound = await ensureOutboundTrunk(config, config.outboundTrunk);
  log(
    outbound.created
      ? `  created outbound trunk ${outbound.id}`
      : `  reusing outbound trunk ${outbound.id}`,
  );

  const inboundName = config.inboundTrunk.name;
  const ruleName = `${inboundName}-default`;
  const wanted = JSON.stringify(config.inboundTrunk.numbers);
  const inboundNameMatches = (await listInboundTrunks(config)).filter((entry) => entry.name === inboundName);
  const exact = inboundNameMatches.find((entry) => JSON.stringify(entry.numbers ?? []) === wanted);
  let inbound = exact;
  if (!exact && inboundNameMatches.length > 0) {
    // LiveKit rejects two inbound trunks that share a number, so a changed
    // number list needs the old trunk (and its rules) removed first.
    const staleIds = new Set(inboundNameMatches.map((entry) => entry.sip_trunk_id));
    for (const rule of await listDispatchRules(config)) {
      if ((rule.trunk_ids ?? []).some((id) => staleIds.has(id))) {
        await deleteDispatchRule(config, rule.sip_dispatch_rule_id);
        log(`  deleted stale dispatch rule ${rule.sip_dispatch_rule_id}`);
      }
    }
    for (const id of staleIds) {
      await deleteTrunk(config, id);
      log(`  deleted stale inbound trunk ${id}`);
    }
  }
  if (!inbound) {
    const id = await createInboundTrunk(config, {
      name: inboundName,
      numbers: config.inboundTrunk.numbers,
      allowed_addresses: config.inboundTrunk.allowedAddresses,
      hide_phone_number: true,
    });
    log(`  created inbound trunk ${id}`);
    inbound = { sip_trunk_id: id };
  } else {
    log(`  reusing inbound trunk ${inbound.sip_trunk_id}`);
  }

  const rules = await listDispatchRules(config);
  const existingRule = rules.find((entry) => entry.name === ruleName);
  let ruleId = existingRule?.sip_dispatch_rule_id;
  if (!existingRule) {
    ruleId = await createIndividualDispatchRule(config, {
      name: ruleName,
      trunkIds: [inbound.sip_trunk_id],
      numbers: config.inboundTrunk.numbers,
      // Individual rule => a fresh room per call; good for a manual softphone.
      roomPrefix: `${inboundName}-room`,
    });
    log(`  created default dispatch rule ${ruleId}`);
  } else {
    log(`  reusing default dispatch rule ${ruleId}`);
  }

  const info = {
    createdAt: new Date().toISOString(),
    livekitUrl: config.livekitUrl,
    outboundTrunkId: outbound.id,
    outboundTrunkName: config.outboundTrunk.name,
    inboundTrunkId: inbound.sip_trunk_id,
    inboundTrunkName: inboundName,
    inboundNumbers: config.inboundTrunk.numbers,
    callerId: config.outboundTrunk.numbers[0],
    testNumbers: config.numbers,
    tenant: config.tenant,
  };
  writeFileSync(TRUNKS_FILE, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
  log(`  wrote ${TRUNKS_FILE}`);

  log('');
  log('Next steps:');
  log('  1) start the app with the same LiveKit keys:');
  log(`       AGIL_SIP_ENABLED=1 AGIL_SIP_URL=${config.livekitUrl} \\`);
  log('       AGIL_SIP_API_KEY=<key> AGIL_SIP_API_SECRET=<secret> npm start');
  log('  2) enable SIP for the tenant (the e2e script does this automatically):');
  log(`       scale.sip = { enabled: true, trunkId: "${outbound.id}", callerId: "${info.callerId}" }`);
  log('  3) run the lab checks: node agil/core/deploy/sip/scripts/e2e.mjs');
}

main().catch((error) => {
  process.stderr.write(`lab-init failed: ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
